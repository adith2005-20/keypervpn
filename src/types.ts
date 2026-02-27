// ============================================================
// KeyperVPN — Shared type definitions
// ============================================================

// ── Enums ────────────────────────────────────────────────────

export enum ConnectionState {
    Disconnected = 'disconnected',
    Connecting = 'connecting',
    Handshaking = 'handshaking',
    Connected = 'connected',
    Error = 'error',
}

export enum PeerRole {
    Server = 'server',
    Client = 'client',
}

// ── STUN ─────────────────────────────────────────────────────

export interface STUNInfo {
    publicIp: string;
    publicPort: number;
    localIp: string;
    localPort: number;
    natType: 'full-cone' | 'restricted' | 'port-restricted' | 'symmetric' | 'unknown';
}

// ── Signaling ────────────────────────────────────────────────

export interface SignalingRegister {
    type: 'register';
    peerId: string;
    publicKey: {
        kyber: string;   // base64
        x25519: string;  // base64
    };
    stunInfo: STUNInfo;
}

export interface SignalingListPeers {
    type: 'list-peers';
}

export interface SignalingPeerList {
    type: 'peer-list';
    peers: PeerInfo[];
}

export interface SignalingOffer {
    type: 'offer';
    fromPeerId: string;
    targetPeerId: string;
    sdp: {
        localPort: number;
        candidates: Array<{ ip: string; port: number }>;
        kyberCiphertext?: string; // base64, sent by initiator
    };
}

export interface SignalingAnswer {
    type: 'answer';
    fromPeerId: string;
    targetPeerId: string;
    sdp: {
        localPort: number;
        candidates: Array<{ ip: string; port: number }>;
        kyberCiphertext?: string; // base64, sent by responder
    };
}

export interface SignalingIceCandidate {
    type: 'ice-candidate';
    fromPeerId: string;
    targetPeerId: string;
    candidate: { ip: string; port: number };
}

export type SignalingMessage =
    | SignalingRegister
    | SignalingListPeers
    | SignalingPeerList
    | SignalingOffer
    | SignalingAnswer
    | SignalingIceCandidate;

// ── Peers ────────────────────────────────────────────────────

export interface PeerInfo {
    peerId: string;
    publicKey: {
        kyber: string;
        x25519: string;
    };
    stunInfo: STUNInfo;
}

// ── Crypto ───────────────────────────────────────────────────

export interface CryptoKeys {
    kyberPublicKey: Uint8Array;
    kyberSecretKey: Uint8Array;
    x25519PrivateKey: Uint8Array;
    x25519PublicKey: Uint8Array;
}

export interface SessionKeys {
    sendKey: Uint8Array;   // 32 bytes
    recvKey: Uint8Array;   // 32 bytes
    sendNonce: bigint;
    recvNonce: bigint;
}

// ── VPN Config ───────────────────────────────────────────────

export interface VPNConfig {
    role: PeerRole;
    tunName: string;
    tunAddress: string;       // e.g. 10.8.0.1 or 10.8.0.2
    tunNetmask: string;       // e.g. 255.255.255.0
    tunMTU: number;           // 1420
    signalingUrl: string;     // ws://localhost:8080
    stunServer: string;       // stun.l.google.com
    stunPort: number;         // 19302
    subnet: string;           // 10.8.0.0/24
}

// ── Stats ────────────────────────────────────────────────────

export interface VPNStats {
    state: ConnectionState;
    bytesSent: number;
    bytesReceived: number;
    packetsSent: number;
    packetsReceived: number;
    latencyMs: number;
    connectedAt: Date | null;
    peerId: string | null;
    peerVpnIp: string | null;
    cryptoMode: string;
}
