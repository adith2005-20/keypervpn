// ============================================================
// KeyperVPN — Signaling Client
// WebSocket client for communicating with the signaling server
// ============================================================

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type {
    STUNInfo,
    PeerInfo,
    SignalingMessage,
    SignalingOffer,
    SignalingAnswer,
    SignalingIceCandidate,
    SignalingPeerList,
} from '../types.js';

export interface SignalingClientEvents {
    connected: [];
    disconnected: [];
    registered: [peerId: string];
    'peer-list': [peers: PeerInfo[]];
    offer: [msg: SignalingOffer];
    answer: [msg: SignalingAnswer];
    'ice-candidate': [msg: SignalingIceCandidate];
    error: [err: Error];
}

export class SignalingClient extends EventEmitter {
    private ws: WebSocket | null = null;
    private url: string;
    private peerId: string;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private _connected = false;

    constructor(url: string, peerId: string) {
        super();
        this.url = url;
        this.peerId = peerId;
    }

    get connected(): boolean {
        return this._connected;
    }

    connect(): void {
        if (this.ws) return;

        this.ws = new WebSocket(this.url);

        this.ws.on('open', () => {
            this._connected = true;
            this.emit('connected');
        });

        this.ws.on('message', (raw) => {
            let msg: Record<string, unknown>;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                return;
            }

            switch (msg.type) {
                case 'registered':
                    this.emit('registered', msg.peerId as string);
                    break;
                case 'peer-list':
                    this.emit('peer-list', (msg as unknown as SignalingPeerList).peers);
                    break;
                case 'offer':
                    this.emit('offer', msg as unknown as SignalingOffer);
                    break;
                case 'answer':
                    this.emit('answer', msg as unknown as SignalingAnswer);
                    break;
                case 'ice-candidate':
                    this.emit('ice-candidate', msg as unknown as SignalingIceCandidate);
                    break;
                case 'error':
                    this.emit('error', new Error(msg.message as string));
                    break;
            }
        });

        this.ws.on('close', () => {
            this._connected = false;
            this.ws = null;
            this.emit('disconnected');
            this.scheduleReconnect();
        });

        this.ws.on('error', (err) => {
            this.emit('error', err);
        });
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, 3000);
    }

    register(
        publicKey: { kyber: string; x25519: string },
        stunInfo: STUNInfo,
    ): void {
        this.send({
            type: 'register',
            peerId: this.peerId,
            publicKey,
            stunInfo,
        });
    }

    listPeers(): void {
        this.send({ type: 'list-peers' });
    }

    sendOffer(
        targetPeerId: string,
        sdp: SignalingOffer['sdp'],
    ): void {
        this.send({
            type: 'offer',
            fromPeerId: this.peerId,
            targetPeerId,
            sdp,
        });
    }

    sendAnswer(
        targetPeerId: string,
        sdp: SignalingAnswer['sdp'],
    ): void {
        this.send({
            type: 'answer',
            fromPeerId: this.peerId,
            targetPeerId,
            sdp,
        });
    }

    sendCandidate(
        targetPeerId: string,
        candidate: { ip: string; port: number },
    ): void {
        this.send({
            type: 'ice-candidate',
            fromPeerId: this.peerId,
            targetPeerId,
            candidate,
        });
    }

    private send(msg: unknown): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    close(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this._connected = false;
    }
}
