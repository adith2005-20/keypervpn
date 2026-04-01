import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import type { RelayEndpoint, RelayRegistration } from '../types.js';

const RELAY_PACKET_TYPE_REGISTER = 0x10;
const RELAY_PACKET_TYPE_DATA = 0x11;

export interface RelayTransportEvents {
    packet: [packet: Buffer];
    error: [error: Error];
}

export class RelayTransport extends EventEmitter {
    private readonly socket = dgram.createSocket('udp4');
    private readonly relay: RelayEndpoint;
    private readonly registration: RelayRegistration;
    private bytesSentCount = 0;
    private bytesReceivedCount = 0;
    private packetsSentCount = 0;
    private packetsReceivedCount = 0;

    constructor(relay: RelayEndpoint, registration: RelayRegistration) {
        super();
        this.relay = relay;
        this.registration = registration;
    }

    get bytesSent(): number {
        return this.bytesSentCount;
    }

    get bytesReceived(): number {
        return this.bytesReceivedCount;
    }

    get packetsSent(): number {
        return this.packetsSentCount;
    }

    get packetsReceived(): number {
        return this.packetsReceivedCount;
    }

    async bind(): Promise<number> {
        return await new Promise((resolve, reject) => {
            this.socket.once('error', reject);
            this.socket.bind(0, () => {
                this.socket.off('error', reject);
                const address = this.socket.address();
                this.setupSocket();
                resolve(address.port);
            });
        });
    }

    private setupSocket(): void {
        this.socket.on('message', (message) => {
            if (message.length === 0) {
                return;
            }

            const type = message[0];
            if (type !== RELAY_PACKET_TYPE_DATA) {
                return;
            }

            this.packetsReceivedCount += 1;
            this.bytesReceivedCount += message.length;
            this.emit('packet', message.subarray(1));
        });

        this.socket.on('error', (error) => {
            this.emit('error', error);
        });
    }

    register(): void {
        const sessionBuffer = Buffer.from(this.registration.sessionId, 'utf8');
        const peerBuffer = Buffer.from(this.registration.peerId, 'utf8');
        const packet = Buffer.alloc(3 + sessionBuffer.length + peerBuffer.length);
        packet[0] = RELAY_PACKET_TYPE_REGISTER;
        packet[1] = sessionBuffer.length;
        sessionBuffer.copy(packet, 2);
        packet[2 + sessionBuffer.length] = peerBuffer.length;
        peerBuffer.copy(packet, 3 + sessionBuffer.length);
        this.sendRaw(packet);
    }

    send(payload: Buffer): void {
        const packet = Buffer.alloc(1 + payload.length);
        packet[0] = RELAY_PACKET_TYPE_DATA;
        payload.copy(packet, 1);
        this.sendRaw(packet);
    }

    private sendRaw(packet: Buffer): void {
        this.socket.send(packet, this.relay.port, this.relay.host);
        this.packetsSentCount += 1;
        this.bytesSentCount += packet.length;
    }

    close(): void {
        try {
            this.socket.close();
        } catch {
            // Ignore shutdown races.
        }
    }
}
