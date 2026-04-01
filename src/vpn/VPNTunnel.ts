import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
    ConnectionState,
    PeerRole,
    type CryptoKeys,
    type RelayEndpoint,
    type SessionKeys,
    type SignalingSessionReady,
    type VPNConfig,
    type VPNStats,
} from '../types.js';
import { SignalingClient } from '../p2p/SignalingClient.js';
import { RelayTransport } from '../p2p/RelayTransport.js';
import {
    completeKeyExchange,
    encrypt,
    generateKeys,
    getCryptoMode,
    initiateKeyExchange,
    decrypt,
} from './CryptoEngine.js';
import { TunDevice } from './TunDevice.js';

const INNER_TYPE_IP_PACKET = 0x01;
const INNER_TYPE_PING = 0x02;
const INNER_TYPE_PONG = 0x03;
const INNER_TYPE_ECHO = 0x04;
const INNER_TYPE_ECHO_REPLY = 0x05;
const INNER_HEADER_SIZE = 3;
const OUTER_NONCE_SIZE = 12;
const AEAD_TAG_SIZE = 16;
const PING_INTERVAL_MS = 2500;

export interface VPNTunnelEvents {
    'state-change': [state: ConnectionState];
    stats: [stats: VPNStats];
    error: [error: Error];
    log: [message: string];
}

export class VPNTunnel extends EventEmitter {
    private readonly config: VPNConfig;
    private readonly peerId: string;
    private state = ConnectionState.Disconnected;
    private connectedAt: Date | null = null;
    private keys: CryptoKeys | null = null;
    private sessionKeys: SessionKeys | null = null;
    private remotePeerId: string | null = null;
    private remotePeerVpnIp: string | null = null;
    private signalingClient: SignalingClient | null = null;
    private relayTransport: RelayTransport | null = null;
    private relayEndpoint: RelayEndpoint | null = null;
    private sessionReady: SignalingSessionReady | null = null;
    private tun: TunDevice | null = null;
    private statsInterval: ReturnType<typeof setInterval> | null = null;
    private pingInterval: ReturnType<typeof setInterval> | null = null;
    private latencyMs = 0;
    private handshakeConfirmed = false;
    private transportReady = false;

    constructor(config: VPNConfig) {
        super();
        this.config = config;
        this.peerId = crypto.randomUUID().slice(0, 8);
    }

    getPeerId(): string {
        return this.peerId;
    }

    getStats(): VPNStats {
        return {
            state: this.state,
            bytesSent: this.relayTransport?.bytesSent ?? 0,
            bytesReceived: this.relayTransport?.bytesReceived ?? 0,
            packetsSent: this.relayTransport?.packetsSent ?? 0,
            packetsReceived: this.relayTransport?.packetsReceived ?? 0,
            latencyMs: this.latencyMs,
            connectedAt: this.connectedAt,
            peerId: this.remotePeerId,
            peerVpnIp: this.remotePeerVpnIp,
            cryptoMode: getCryptoMode(),
            transportMode: 'UDP relay overlay',
            morphMode: `constant ${this.config.morphPacketSize}B`,
        };
    }

    async start(): Promise<void> {
        try {
            this.setState(ConnectionState.Connecting);
            this.checkPrivileges();
            this.log(`Booting ${this.config.role} node ${this.peerId}`);

            this.keys = await generateKeys();
            const publicKey = {
                kyber: Buffer.from(this.keys.kyberPublicKey).toString('base64'),
                x25519: Buffer.from(this.keys.x25519PublicKey).toString('base64'),
            };

            this.signalingClient = new SignalingClient(
                this.config.signalingUrl,
                this.peerId,
                this.config.role,
                publicKey,
            );

            this.setupSignalingHandlers();
            this.signalingClient.connect();
            await this.waitForRegistered();
            this.startStatsReporting();
        } catch (error) {
            this.setState(ConnectionState.Error);
            this.emit('error', error as Error);
            throw error;
        }
    }

    sendTestData(message?: string): void {
        if (this.state !== ConnectionState.Connected) {
            this.log('Tunnel is not connected yet');
            return;
        }

        const payload = Buffer.from(
            `${message ?? `echo from ${this.peerId}`} @ ${new Date().toISOString()}`,
            'utf8',
        );
        this.sendInnerPacket(INNER_TYPE_ECHO, payload);
        this.log(`Sent encrypted echo probe (${payload.length} bytes before morphing)`);
    }

    async shutdown(): Promise<void> {
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = null;
        }
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }

        this.relayTransport?.close();
        this.signalingClient?.close();
        this.tun?.close();

        this.relayTransport = null;
        this.signalingClient = null;
        this.tun = null;
        this.connectedAt = null;
        this.sessionKeys = null;
        this.handshakeConfirmed = false;
        this.transportReady = false;

        this.setState(ConnectionState.Disconnected);
        this.log('Shutdown complete');
    }

    private checkPrivileges(): void {
        if (!this.config.noTun && process.getuid?.() !== 0) {
            throw new Error('Root privileges are required unless KEYPERVPN_NO_TUN=1 is set.');
        }
    }

    private setupSignalingHandlers(): void {
        if (!this.signalingClient) {
            return;
        }

        this.signalingClient.on('registered', async (_peerId, relay) => {
            this.relayEndpoint = {
                host: this.config.relayHost ?? relay.host,
                port: this.config.relayPort || relay.port,
            };
            this.log(`Connected to control plane. Relay endpoint ${this.relayEndpoint.host}:${this.relayEndpoint.port}`);
        });

        this.signalingClient.on('session-ready', async (message) => {
            this.sessionReady = message;
            this.remotePeerId = message.peer.peerId;
            this.remotePeerVpnIp = this.config.peerTunAddress;
            this.setState(ConnectionState.Handshaking);
            this.log(`Matched with peer ${message.peer.peerId} (${message.peer.role})`);

            await this.ensureRelayTransport(message.sessionId, message.relay);

            if (message.initiatorPeerId === this.peerId && this.keys) {
                const remoteKyber = new Uint8Array(Buffer.from(message.peer.publicKey.kyber, 'base64'));
                const remoteX25519 = new Uint8Array(Buffer.from(message.peer.publicKey.x25519, 'base64'));
                const result = await initiateKeyExchange(this.keys, remoteKyber, remoteX25519);
                this.sessionKeys = result.sessionKeys;
                this.signalingClient?.sendSessionInit(
                    message.peer.peerId,
                    Buffer.from(result.kyberCiphertext ?? new Uint8Array()).toString('base64'),
                );
                this.log('Hybrid key exchange initiated');
            }
        });

        this.signalingClient.on('session-init', async (message) => {
            if (!this.keys || !this.sessionReady || message.fromPeerId !== this.sessionReady.peer.peerId) {
                return;
            }

            const remoteX25519 = new Uint8Array(
                Buffer.from(this.sessionReady.peer.publicKey.x25519, 'base64'),
            );
            const kyberCiphertext = new Uint8Array(Buffer.from(message.kyberCiphertext, 'base64'));
            const result = await completeKeyExchange(this.keys, kyberCiphertext, remoteX25519);
            this.sessionKeys = result.sessionKeys;
            this.signalingClient?.sendSessionAck(message.fromPeerId);
            this.log('Hybrid key exchange completed');
            this.tryEstablishConnected();
        });

        this.signalingClient.on('session-ack', (message) => {
            if (message.fromPeerId !== this.remotePeerId) {
                return;
            }
            this.handshakeConfirmed = true;
            this.log('Peer accepted encrypted session');
            this.tryEstablishConnected();
        });

        this.signalingClient.on('peer-left', (peerId) => {
            if (peerId === this.remotePeerId) {
                this.log('Remote peer disconnected from the control plane');
                void this.shutdown();
            }
        });

        this.signalingClient.on('disconnected', () => {
            this.log('Signaling connection lost; reconnecting');
        });

        this.signalingClient.on('error', (error) => {
            this.log(`Signaling error: ${error.message}`);
            this.emit('error', error);
        });
    }

    private async ensureRelayTransport(sessionId: string, relay: RelayEndpoint): Promise<void> {
        if (this.relayTransport) {
            return;
        }

        const endpoint = {
            host: this.config.relayHost ?? this.relayEndpoint?.host ?? relay.host,
            port: this.config.relayPort || this.relayEndpoint?.port || relay.port,
        };
        this.relayTransport = new RelayTransport(endpoint, { sessionId, peerId: this.peerId });
        this.relayTransport.on('packet', (packet) => this.handleRelayPacket(packet));
        this.relayTransport.on('error', (error) => {
            this.log(`Relay transport error: ${error.message}`);
            this.emit('error', error);
        });
        const localPort = await this.relayTransport.bind();
        this.relayTransport.register();
        this.transportReady = true;
        this.log(`UDP transport bound on ${localPort}, relay registration sent`);
        this.tryEstablishConnected();
    }

    private tryEstablishConnected(): void {
        if (!this.sessionKeys || !this.transportReady) {
            return;
        }

        if (this.config.role === PeerRole.Client) {
            if (!this.handshakeConfirmed) {
                return;
            }
        } else {
            this.handshakeConfirmed = true;
        }

        if (this.state === ConnectionState.Connected) {
            return;
        }

        this.connectedAt = new Date();
        this.setState(ConnectionState.Connected);
        this.log('Encrypted overlay is up');

        if (!this.config.noTun) {
            void this.openTun();
        } else {
            this.log('No-TUN mode enabled for local validation');
        }

        this.startPingLoop();
    }

    private async openTun(): Promise<void> {
        try {
            this.tun = new TunDevice(
                this.config.tunName,
                this.config.tunAddress,
                this.config.tunNetmask,
                this.config.tunMTU,
            );
            await this.tun.open();
            this.tun.setupRouting(this.config.peerTunAddress);
            this.tun.on('data', (packet) => {
                this.sendInnerPacket(INNER_TYPE_IP_PACKET, packet);
            });
            this.tun.on('error', (error) => {
                this.log(`TUN error: ${error.message}`);
            });
            this.log(`TUN ${this.tun.deviceName} online at ${this.config.tunAddress}`);
        } catch (error) {
            this.log(`TUN initialization failed: ${(error as Error).message}`);
            this.emit('error', error as Error);
        }
    }

    private startPingLoop(): void {
        if (this.pingInterval) {
            return;
        }

        this.pingInterval = setInterval(() => {
            const payload = Buffer.alloc(8);
            payload.writeBigUInt64BE(BigInt(Date.now()), 0);
            this.sendInnerPacket(INNER_TYPE_PING, payload);
        }, PING_INTERVAL_MS);
    }

    private handleRelayPacket(packet: Buffer): void {
        if (!this.sessionKeys) {
            return;
        }

        try {
            const { kind, body } = this.decryptFrame(packet);
            switch (kind) {
                case INNER_TYPE_IP_PACKET:
                    this.tun?.write(body);
                    break;
                case INNER_TYPE_PING: {
                    this.sendInnerPacket(INNER_TYPE_PONG, body);
                    break;
                }
                case INNER_TYPE_PONG: {
                    if (body.length >= 8) {
                        this.latencyMs = Date.now() - Number(body.readBigUInt64BE(0));
                    }
                    break;
                }
                case INNER_TYPE_ECHO: {
                    this.sendInnerPacket(INNER_TYPE_ECHO_REPLY, body);
                    break;
                }
                case INNER_TYPE_ECHO_REPLY:
                    this.log(`Encrypted echo reply: ${body.toString('utf8')}`);
                    break;
            }
        } catch (error) {
            this.log(`Dropped undecipherable packet: ${(error as Error).message}`);
        }
    }

    private sendInnerPacket(kind: number, body: Buffer): void {
        if (!this.sessionKeys || !this.relayTransport) {
            return;
        }

        const maxBodyLength = this.getPlaintextCapacity() - INNER_HEADER_SIZE;
        if (body.length > maxBodyLength) {
            this.log(`Packet too large for current morph size (${body.length} > ${maxBodyLength})`);
            return;
        }

        const plaintext = Buffer.alloc(this.getPlaintextCapacity());
        crypto.randomFillSync(plaintext);
        plaintext[0] = kind;
        plaintext.writeUInt16BE(body.length, 1);
        body.copy(plaintext, INNER_HEADER_SIZE);

        const encrypted = encrypt(new Uint8Array(plaintext), this.sessionKeys);
        const frame = Buffer.alloc(OUTER_NONCE_SIZE + encrypted.ciphertext.length);
        Buffer.from(encrypted.nonce).copy(frame, 0);
        Buffer.from(encrypted.ciphertext).copy(frame, OUTER_NONCE_SIZE);
        this.relayTransport.send(frame);
    }

    private decryptFrame(packet: Buffer): { kind: number; body: Buffer } {
        if (packet.length !== this.config.morphPacketSize) {
            throw new Error(`unexpected frame size ${packet.length}`);
        }

        const nonce = packet.subarray(0, OUTER_NONCE_SIZE);
        const ciphertext = packet.subarray(OUTER_NONCE_SIZE);
        const plaintext = Buffer.from(
            decrypt(new Uint8Array(ciphertext), new Uint8Array(nonce), this.sessionKeys!),
        );

        const kind = plaintext[0] ?? 0;
        const bodyLength = plaintext.readUInt16BE(1);
        if (bodyLength > plaintext.length - INNER_HEADER_SIZE) {
            throw new Error('invalid body length');
        }

        return {
            kind,
            body: plaintext.subarray(INNER_HEADER_SIZE, INNER_HEADER_SIZE + bodyLength),
        };
    }

    private getPlaintextCapacity(): number {
        return this.config.morphPacketSize - OUTER_NONCE_SIZE - AEAD_TAG_SIZE;
    }

    private startStatsReporting(): void {
        if (this.statsInterval) {
            return;
        }

        this.statsInterval = setInterval(() => {
            this.emit('stats', this.getStats());
        }, 500);
    }

    private setState(state: ConnectionState): void {
        this.state = state;
        this.emit('state-change', state);
    }

    private log(message: string): void {
        this.emit('log', message);
    }

    private waitForRegistered(): Promise<void> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Timed out connecting to signaling server'));
            }, 10000);

            this.signalingClient?.once('registered', () => {
                clearTimeout(timeout);
                resolve();
            });
            this.signalingClient?.once('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });
        });
    }
}
