// ============================================================
// KeyperVPN — Peer Connection
// Manages UDP hole punching and encrypted data exchange
// ============================================================

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { ConnectionState } from '../types.js';
import type { SessionKeys } from '../types.js';
import { encrypt, decrypt } from '../vpn/CryptoEngine.js';

// Packet types (first byte)
const PACKET_TYPE_PROBE = 0x01;
const PACKET_TYPE_PROBE_ACK = 0x02;
const PACKET_TYPE_DATA = 0x03;
const PACKET_TYPE_PING = 0x04;
const PACKET_TYPE_PONG = 0x05;

const PROBE_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 30_000;
const PING_INTERVAL_MS = 5_000;
const TARGET_PACKET_SIZE = 1420;

export interface PeerConnectionEvents {
    connected: [];
    data: [data: Buffer];
    disconnected: [];
    error: [err: Error];
    latency: [ms: number];
}

export class PeerConnection extends EventEmitter {
    private socket: dgram.Socket;
    private remoteIp: string | null = null;
    private remotePort: number | null = null;
    private candidates: Array<{ ip: string; port: number }> = [];
    private state: ConnectionState = ConnectionState.Disconnected;
    private sessionKeys: SessionKeys | null = null;
    private probeTimer: ReturnType<typeof setInterval> | null = null;
    private probeTimeout: ReturnType<typeof setTimeout> | null = null;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private lastPingSent: number = 0;
    private _latencyMs: number = 0;
    private _bytesSent: number = 0;
    private _bytesReceived: number = 0;
    private _packetsSent: number = 0;
    private _packetsReceived: number = 0;

    get latencyMs() { return this._latencyMs; }
    get bytesSent() { return this._bytesSent; }
    get bytesReceived() { return this._bytesReceived; }
    get packetsSent() { return this._packetsSent; }
    get packetsReceived() { return this._packetsReceived; }
    get connectionState() { return this.state; }

    constructor(private localPort: number) {
        super();
        this.socket = dgram.createSocket('udp4');
        this.setupSocket();
    }

    private setupSocket(): void {
        this.socket.on('message', (msg, rinfo) => {
            this.handleIncoming(msg, rinfo);
        });

        this.socket.on('error', (err) => {
            this.emit('error', err);
        });
    }

    async bind(): Promise<number> {
        return new Promise((resolve, reject) => {
            this.socket.bind(this.localPort, () => {
                const addr = this.socket.address();
                this.localPort = addr.port;
                resolve(addr.port);
            });
            this.socket.once('error', reject);
        });
    }

    setSessionKeys(keys: SessionKeys): void {
        this.sessionKeys = keys;
    }

    /**
     * Start UDP hole punching to the given remote candidates.
     */
    startHolePunch(candidates: Array<{ ip: string; port: number }>): void {
        this.candidates = candidates;
        this.state = ConnectionState.Connecting;

        // Send probe packets to all candidates periodically
        this.probeTimer = setInterval(() => {
            for (const candidate of this.candidates) {
                const probe = Buffer.alloc(4);
                probe[0] = PACKET_TYPE_PROBE;
                probe.writeUInt16BE(this.localPort, 1);
                probe[3] = 0xff; // magic byte
                this.socket.send(probe, candidate.port, candidate.ip);
            }
        }, PROBE_INTERVAL_MS);

        // Timeout if no response
        this.probeTimeout = setTimeout(() => {
            if (this.state !== ConnectionState.Connected) {
                this.stopProbing();
                this.state = ConnectionState.Error;
                this.emit('error', new Error('Hole punching timed out — symmetric NAT may be blocking connectivity'));
            }
        }, PROBE_TIMEOUT_MS);
    }

    private stopProbing(): void {
        if (this.probeTimer) {
            clearInterval(this.probeTimer);
            this.probeTimer = null;
        }
        if (this.probeTimeout) {
            clearTimeout(this.probeTimeout);
            this.probeTimeout = null;
        }
    }

    private handleIncoming(msg: Buffer, rinfo: dgram.RemoteInfo): void {
        if (msg.length === 0) return;

        const packetType = msg[0]!;

        switch (packetType) {
            case PACKET_TYPE_PROBE: {
                // Received a probe — send an ACK back
                const ack = Buffer.alloc(4);
                ack[0] = PACKET_TYPE_PROBE_ACK;
                ack.writeUInt16BE(this.localPort, 1);
                ack[3] = 0xff;
                this.socket.send(ack, rinfo.port, rinfo.address);

                // Also mark as connected if not already
                if (this.state !== ConnectionState.Connected) {
                    this.establishConnection(rinfo.address, rinfo.port);
                }
                break;
            }

            case PACKET_TYPE_PROBE_ACK: {
                if (this.state !== ConnectionState.Connected) {
                    this.establishConnection(rinfo.address, rinfo.port);
                }
                break;
            }

            case PACKET_TYPE_DATA: {
                this._packetsReceived++;
                this._bytesReceived += msg.length;

                if (!this.sessionKeys) return;

                // [type(1) | nonce(12) | ciphertext(rest)]
                if (msg.length < 14) return;
                const nonce = msg.subarray(1, 13);
                const ciphertext = msg.subarray(13);

                try {
                    const plaintext = decrypt(
                        new Uint8Array(ciphertext),
                        new Uint8Array(nonce),
                        this.sessionKeys,
                    );
                    this.emit('data', Buffer.from(plaintext));
                } catch (err) {
                    // Decryption failure — ignore packet
                }
                break;
            }

            case PACKET_TYPE_PING: {
                // Reply with pong
                const pong = Buffer.alloc(9);
                pong[0] = PACKET_TYPE_PONG;
                msg.copy(pong, 1, 1, 9); // Copy timestamp
                this.sendRaw(pong);
                break;
            }

            case PACKET_TYPE_PONG: {
                if (msg.length >= 9) {
                    const sentTime = Number(msg.readBigUInt64BE(1));
                    this._latencyMs = Date.now() - sentTime;
                    this.emit('latency', this._latencyMs);
                }
                break;
            }
        }
    }

    private establishConnection(ip: string, port: number): void {
        this.remoteIp = ip;
        this.remotePort = port;
        this.state = ConnectionState.Connected;
        this.stopProbing();
        this.startPingLoop();
        this.emit('connected');
    }

    private startPingLoop(): void {
        this.pingTimer = setInterval(() => {
            const ping = Buffer.alloc(9);
            ping[0] = PACKET_TYPE_PING;
            ping.writeBigUInt64BE(BigInt(Date.now()), 1);
            this.sendRaw(ping);
        }, PING_INTERVAL_MS);
    }

    /**
     * Send encrypted data to the peer.
     * Pads to TARGET_PACKET_SIZE for constant-size packets.
     */
    sendData(payload: Buffer): void {
        if (this.state !== ConnectionState.Connected || !this.sessionKeys) return;

        const { ciphertext, nonce } = encrypt(
            new Uint8Array(payload),
            this.sessionKeys,
        );

        // Build packet: [type(1) | nonce(12) | ciphertext | padding]
        const header = 1 + 12; // type + nonce
        const dataLen = header + ciphertext.length;
        const packetSize = Math.max(dataLen, TARGET_PACKET_SIZE);
        const packet = Buffer.alloc(packetSize);
        packet[0] = PACKET_TYPE_DATA;
        Buffer.from(nonce).copy(packet, 1);
        Buffer.from(ciphertext).copy(packet, 13);

        // Random padding for remaining bytes
        if (packetSize > dataLen) {
            const padding = Buffer.alloc(packetSize - dataLen);
            for (let i = 0; i < padding.length; i++) {
                padding[i] = Math.floor(Math.random() * 256);
            }
            padding.copy(packet, dataLen);
        }

        this.sendRaw(packet);
        this._packetsSent++;
        this._bytesSent += packet.length;
    }

    private sendRaw(data: Buffer): void {
        if (this.remoteIp && this.remotePort) {
            this.socket.send(data, this.remotePort, this.remoteIp);
        }
    }

    getLocalPort(): number {
        return this.localPort;
    }

    close(): void {
        this.stopProbing();
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        try {
            this.socket.close();
        } catch { /* ignore */ }
        this.state = ConnectionState.Disconnected;
        this.emit('disconnected');
    }
}
