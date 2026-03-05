// ============================================================
// KeyperVPN — VPN Tunnel Orchestrator
// Ties together TUN device, crypto, signaling, and P2P
// ============================================================

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
    ConnectionState,
    PeerRole,
    type VPNConfig,
    type VPNStats,
    type PeerInfo,
    type CryptoKeys,
    type SessionKeys,
    type SignalingOffer,
    type SignalingAnswer,
} from '../types.js';
import { TunDevice } from './TunDevice.js';
import {
    generateKeys,
    initiateKeyExchange,
    completeKeyExchange,
    getCryptoMode,
} from './CryptoEngine.js';
import { discoverPublicEndpoint, getLocalIpAsync } from '../p2p/STUNClient.js';
import { SignalingClient } from '../p2p/SignalingClient.js';
import { PeerConnection } from '../p2p/PeerConnection.js';

export interface VPNTunnelEvents {
    'state-change': [state: ConnectionState];
    stats: [stats: VPNStats];
    error: [err: Error];
    log: [message: string];
}

export class VPNTunnel extends EventEmitter {
    private config: VPNConfig;
    private peerId: string;
    private keys: CryptoKeys | null = null;
    private sessionKeys: SessionKeys | null = null;
    private tun: TunDevice | null = null;
    private signalingClient: SignalingClient | null = null;
    private peerConnection: PeerConnection | null = null;
    private state: ConnectionState = ConnectionState.Disconnected;
    private statsInterval: ReturnType<typeof setInterval> | null = null;
    private connectedAt: Date | null = null;
    private remotePeerId: string | null = null;
    private remotePeerVpnIp: string | null = null;

    constructor(config: VPNConfig) {
        super();
        this.config = config;
        this.peerId = crypto.randomUUID().slice(0, 8);
    }

    private log(msg: string): void {
        this.emit('log', msg);
    }

    private setState(newState: ConnectionState): void {
        this.state = newState;
        this.emit('state-change', newState);
    }

    /**
     * Start the VPN tunnel.
     */
    async start(): Promise<void> {
        try {
            // 1. Check privileges
            this.log('Checking privileges...');
            this.checkPrivileges();

            // 2. Generate crypto keys
            this.log('Generating hybrid post-quantum keys (Kyber-768 + X25519)...');
            this.setState(ConnectionState.Connecting);
            this.keys = await generateKeys();
            this.log('Keys generated successfully');

            // 3. Discover public endpoint via STUN
            this.log('Discovering public endpoint via STUN...');
            let stunInfo;
            try {
                stunInfo = await discoverPublicEndpoint(
                    this.config.stunServer,
                    this.config.stunPort,
                );
                this.log(`Public endpoint: ${stunInfo.publicIp}:${stunInfo.publicPort}`);
            } catch (err) {
                this.log(`STUN discovery failed: ${(err as Error).message}. Using local address.`);
                const localIp = await getLocalIpAsync();
                stunInfo = {
                    publicIp: localIp,
                    publicPort: 0,
                    localIp,
                    localPort: 0,
                    natType: 'unknown' as const,
                };
            }

            // 4. Set up peer connection (UDP socket)
            this.peerConnection = new PeerConnection(0);
            const localPort = await this.peerConnection.bind();
            stunInfo.localPort = localPort;
            this.log(`UDP socket bound on port ${localPort}`);

            // 5. Connect to signaling server
            this.log(`Connecting to signaling server: ${this.config.signalingUrl}`);
            this.signalingClient = new SignalingClient(this.config.signalingUrl, this.peerId);
            this.setupSignalingHandlers();
            this.signalingClient.connect();

            // Wait for signaling connection
            await this.waitForSignaling();

            // 6. Register with signaling server
            this.signalingClient.register(
                {
                    kyber: Buffer.from(this.keys.kyberPublicKey).toString('base64'),
                    x25519: Buffer.from(this.keys.x25519PublicKey).toString('base64'),
                },
                stunInfo,
            );
            this.log(`Registered as peer: ${this.peerId}`);

            // 7. Role-based flow
            if (this.config.role === PeerRole.Client) {
                this.log('Role: Client — searching for server peer...');
                // Small delay to let server register first
                await this.delay(1000);
                this.signalingClient.listPeers();
            } else {
                this.log('Role: Server — waiting for incoming connections...');
            }

            // 8. Setup peer connection events
            this.setupPeerConnectionHandlers();

            // 9. Start stats reporting
            this.startStatsReporting();

        } catch (err) {
            this.setState(ConnectionState.Error);
            this.emit('error', err as Error);
            throw err;
        }
    }

    private checkPrivileges(): void {
        if (process.platform !== 'win32' && process.getuid?.() !== 0) {
            throw new Error(
                'Root privileges required. Please run with sudo:\n' +
                '  sudo npm start server    (for server mode)\n' +
                '  sudo npm start client    (for client mode)',
            );
        }
    }

    private setupSignalingHandlers(): void {
        if (!this.signalingClient) return;

        this.signalingClient.on('peer-list', async (peers: PeerInfo[]) => {
            this.log(`Received peer list: ${peers.length} peer(s) available`);
            if (peers.length === 0) {
                this.log('No peers available. Retrying in 3 seconds...');
                setTimeout(() => this.signalingClient?.listPeers(), 3000);
                return;
            }

            // Connect to the first available peer
            const target = peers[0]!;
            this.remotePeerId = target.peerId;
            this.remotePeerVpnIp = this.config.role === PeerRole.Client ? '10.8.0.1' : '10.8.0.2';
            this.log(`Initiating connection to peer: ${target.peerId}`);

            // Perform key exchange as initiator
            if (this.keys) {
                const remoteKyberPK = new Uint8Array(Buffer.from(target.publicKey.kyber, 'base64'));
                const remoteX25519PK = new Uint8Array(Buffer.from(target.publicKey.x25519, 'base64'));

                const { sessionKeys, kyberCiphertext } = await initiateKeyExchange(
                    this.keys,
                    remoteKyberPK,
                    remoteX25519PK,
                );

                this.sessionKeys = sessionKeys;
                this.peerConnection?.setSessionKeys(sessionKeys);
                this.log('Hybrid key exchange completed (initiator)');

                // Build candidates
                const candidates = [
                    { ip: target.stunInfo.publicIp, port: target.stunInfo.publicPort },
                ];
                if (target.stunInfo.localIp && target.stunInfo.localPort) {
                    candidates.push({ ip: target.stunInfo.localIp, port: target.stunInfo.localPort });
                }

                // Send offer with Kyber ciphertext
                this.signalingClient?.sendOffer(target.peerId, {
                    localPort: this.peerConnection?.getLocalPort() ?? 0,
                    candidates: [
                        {
                            ip: target.stunInfo.localIp || '0.0.0.0',
                            port: this.peerConnection?.getLocalPort() ?? 0,
                        },
                    ],
                    kyberCiphertext: kyberCiphertext
                        ? Buffer.from(kyberCiphertext).toString('base64')
                        : undefined,
                });

                // Start hole punching
                this.peerConnection?.startHolePunch(candidates);
                this.setState(ConnectionState.Handshaking);
            }
        });

        this.signalingClient.on('offer', (msg: SignalingOffer) => {
            this.log(`Received offer from peer: ${msg.fromPeerId}`);
            this.remotePeerId = msg.fromPeerId;
            this.remotePeerVpnIp = '10.8.0.2';

            // Complete key exchange as responder
            if (this.keys && msg.sdp.kyberCiphertext) {
                const kyberCt = new Uint8Array(Buffer.from(msg.sdp.kyberCiphertext, 'base64'));

                // We need the remote X25519 public key — it was shared during registration
                // For now, we'll need to get it from the peer list
                this.signalingClient?.listPeers();

                // Store the offer for processing after we get the peer's X25519 key
                this.once('_remote_x25519_key', async (remoteX25519PK: Uint8Array) => {
                    const { sessionKeys } = await completeKeyExchange(this.keys!, kyberCt, remoteX25519PK);
                    this.sessionKeys = sessionKeys;
                    this.peerConnection?.setSessionKeys(sessionKeys);
                    this.log('Hybrid key exchange completed (responder)');

                    // Send answer
                    this.signalingClient?.sendAnswer(msg.fromPeerId, {
                        localPort: this.peerConnection?.getLocalPort() ?? 0,
                        candidates: msg.sdp.candidates,
                    });

                    // Start hole punching to the offerer
                    const candidates = msg.sdp.candidates.slice();
                    this.peerConnection?.startHolePunch(candidates);
                    this.setState(ConnectionState.Handshaking);
                });

                // Also trigger peer list lookup to get X25519 key
                this.signalingClient?.on('peer-list', (peers: PeerInfo[]) => {
                    const remotePeer = peers.find((p) => p.peerId === msg.fromPeerId);
                    if (remotePeer) {
                        const remoteX25519PK = new Uint8Array(
                            Buffer.from(remotePeer.publicKey.x25519, 'base64'),
                        );
                        this.emit('_remote_x25519_key', remoteX25519PK);
                    }
                });
                this.signalingClient?.listPeers();
            }
        });

        this.signalingClient.on('answer', (msg: SignalingAnswer) => {
            this.log(`Received answer from peer: ${msg.fromPeerId}`);
            // Answer received — hole punching should already be in progress
            // Add any new candidates from the answer
            if (msg.sdp.candidates.length > 0) {
                this.peerConnection?.startHolePunch(msg.sdp.candidates);
            }
        });

        this.signalingClient.on('error', (err: Error) => {
            this.log(`Signaling error: ${err.message}`);
        });

        this.signalingClient.on('disconnected', () => {
            this.log('Signaling server disconnected, will reconnect...');
        });
    }

    private setupPeerConnectionHandlers(): void {
        if (!this.peerConnection) return;

        this.peerConnection.on('connected', async () => {
            this.log('P2P connection established!');
            this.connectedAt = new Date();
            this.setState(ConnectionState.Connected);

            // Open TUN device
            try {
                this.tun = new TunDevice(
                    this.config.tunName,
                    this.config.tunAddress,
                    this.config.tunNetmask,
                    this.config.tunMTU,
                );
                await this.tun.open();
                this.tun.setupRouting(this.config.subnet);
                this.log(`TUN device ${this.config.tunName} opened at ${this.config.tunAddress}`);

                // Start packet relay
                this.startPacketRelay();
            } catch (err) {
                this.log(`TUN setup failed: ${(err as Error).message}`);
                this.log('VPN tunnel running without TUN device (data relay only)');
            }
        });

        this.peerConnection.on('data', (data: Buffer) => {
            // Received decrypted data — inject into TUN
            if (this.tun?.isRunning) {
                this.tun.write(data);
            }
        });

        this.peerConnection.on('disconnected', () => {
            this.log('Peer disconnected');
            this.setState(ConnectionState.Disconnected);
            this.connectedAt = null;
        });

        this.peerConnection.on('error', (err: Error) => {
            this.log(`Peer connection error: ${err.message}`);
            if (err.message.includes('symmetric NAT')) {
                this.log('ERROR: Symmetric NAT detected. Direct P2P connection not possible without a TURN relay.');
                this.setState(ConnectionState.Error);
            }
        });

        this.peerConnection.on('latency', (ms: number) => {
            // Latency updates handled by stats reporting
        });

        this.peerConnection.on('echo-reply', (payload: string, rttMs: number) => {
            this.log(`✅ ECHO REPLY: "${payload}" — round-trip ${rttMs}ms (encrypted end-to-end)`);
        });
    }

    private startPacketRelay(): void {
        if (!this.tun) return;

        this.tun.on('data', (packet: Buffer) => {
            // Read from TUN → encrypt → send to peer
            if (this.peerConnection && this.state === ConnectionState.Connected) {
                this.peerConnection.sendData(packet);
            }
        });

        this.tun.on('error', (err: Error) => {
            this.log(`TUN error: ${err.message}`);
        });
    }

    private startStatsReporting(): void {
        this.statsInterval = setInterval(() => {
            this.emit('stats', this.getStats());
        }, 500);
    }

    getStats(): VPNStats {
        return {
            state: this.state,
            bytesSent: this.peerConnection?.bytesSent ?? 0,
            bytesReceived: this.peerConnection?.bytesReceived ?? 0,
            packetsSent: this.peerConnection?.packetsSent ?? 0,
            packetsReceived: this.peerConnection?.packetsReceived ?? 0,
            latencyMs: this.peerConnection?.latencyMs ?? 0,
            connectedAt: this.connectedAt,
            peerId: this.remotePeerId,
            peerVpnIp: this.remotePeerVpnIp,
            cryptoMode: getCryptoMode(),
        };
    }

    getPeerId(): string {
        return this.peerId;
    }

    /**
     * Send a test echo through the encrypted tunnel.
     * The remote peer decrypts, then re-encrypts and sends back.
     * Proves end-to-end encrypted data relay works.
     */
    sendTestData(message?: string): void {
        if (this.state !== ConnectionState.Connected) {
            this.log('Cannot send test data — not connected to a peer yet');
            return;
        }
        const msg = message ?? `Hello from ${this.peerId} @ ${new Date().toLocaleTimeString()}`;
        this.log(`📤 Sending echo test: "${msg}"`);
        this.peerConnection?.sendEcho(msg);
    }

    /**
     * Gracefully shut down the VPN tunnel.
     */
    async shutdown(): Promise<void> {
        this.log('Shutting down KeyperVPN...');

        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = null;
        }

        this.peerConnection?.close();
        this.signalingClient?.close();
        this.tun?.close();

        this.setState(ConnectionState.Disconnected);
        this.log('KeyperVPN shut down cleanly.');
    }

    // ── Helpers ──────────────────────────────────────────────

    private waitForSignaling(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.signalingClient?.connected) {
                resolve();
                return;
            }

            const timeout = setTimeout(() => {
                reject(new Error('Signaling server connection timeout'));
            }, 10_000);

            this.signalingClient?.once('connected', () => {
                clearTimeout(timeout);
                this.log('Connected to signaling server');
                resolve();
            });

            this.signalingClient?.once('error', (err: Error) => {
                clearTimeout(timeout);
                reject(new Error(`Signaling connection failed: ${err.message}`));
            });
        });
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
