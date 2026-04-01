import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type {
    PeerRole,
    RelayEndpoint,
    SignalingMessage,
    SignalingRegistered,
    SignalingSessionAck,
    SignalingSessionInit,
    SignalingSessionReady,
} from '../types.js';

export interface SignalingClientEvents {
    connected: [];
    disconnected: [];
    registered: [peerId: string, relay: RelayEndpoint];
    'session-ready': [message: SignalingSessionReady];
    'session-init': [message: SignalingSessionInit];
    'session-ack': [message: SignalingSessionAck];
    'peer-left': [peerId: string];
    error: [error: Error];
}

export class SignalingClient extends EventEmitter {
    private ws: WebSocket | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly url: string;
    private readonly peerId: string;
    private readonly role: PeerRole;
    private readonly publicKey: { kyber: string; x25519: string };
    private connectedState = false;
    private manualClose = false;

    constructor(
        url: string,
        peerId: string,
        role: PeerRole,
        publicKey: { kyber: string; x25519: string },
    ) {
        super();
        this.url = url;
        this.peerId = peerId;
        this.role = role;
        this.publicKey = publicKey;
    }

    get connected(): boolean {
        return this.connectedState;
    }

    connect(): void {
        if (this.ws) {
            return;
        }

        this.manualClose = false;
        this.ws = new WebSocket(this.url);

        this.ws.on('open', () => {
            this.connectedState = true;
            this.emit('connected');
            this.register();
        });

        this.ws.on('close', () => {
            this.connectedState = false;
            this.ws = null;
            this.emit('disconnected');
            if (!this.manualClose) {
                this.scheduleReconnect();
            }
        });

        this.ws.on('error', (error) => {
            this.emit('error', error);
        });

        this.ws.on('message', (raw) => {
            let message: SignalingMessage;
            try {
                message = JSON.parse(raw.toString()) as SignalingMessage;
            } catch {
                return;
            }

            switch (message.type) {
                case 'registered': {
                    const registered = message as SignalingRegistered;
                    this.emit('registered', registered.peerId, registered.relay);
                    break;
                }
                case 'session-ready':
                    this.emit('session-ready', message as SignalingSessionReady);
                    break;
                case 'session-init':
                    this.emit('session-init', message as SignalingSessionInit);
                    break;
                case 'session-ack':
                    this.emit('session-ack', message as SignalingSessionAck);
                    break;
                case 'peer-left':
                    this.emit('peer-left', message.peerId);
                    break;
                case 'error':
                    this.emit('error', new Error(message.message));
                    break;
            }
        });
    }

    private register(): void {
        this.send({
            type: 'register',
            peerId: this.peerId,
            role: this.role,
            publicKey: this.publicKey,
        });
    }

    sendSessionInit(targetPeerId: string, kyberCiphertext: string): void {
        this.send({
            type: 'session-init',
            fromPeerId: this.peerId,
            targetPeerId,
            kyberCiphertext,
        });
    }

    sendSessionAck(targetPeerId: string): void {
        this.send({
            type: 'session-ack',
            fromPeerId: this.peerId,
            targetPeerId,
        });
    }

    private send(message: SignalingMessage): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) {
            return;
        }

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, 3000);
    }

    close(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.manualClose = true;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        this.connectedState = false;
    }
}
