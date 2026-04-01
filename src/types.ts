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

export interface CryptoKeys {
    kyberPublicKey: Uint8Array;
    kyberSecretKey: Uint8Array;
    x25519PrivateKey: Uint8Array;
    x25519PublicKey: Uint8Array;
}

export interface SessionKeys {
    sendKey: Uint8Array;
    recvKey: Uint8Array;
    sendNonce: bigint;
    recvNonce: bigint;
}

export interface RelayEndpoint {
    host: string;
    port: number;
}

export interface RelayRegistration {
    sessionId: string;
    peerId: string;
}

export interface PeerInfo {
    peerId: string;
    role: PeerRole;
    publicKey: {
        kyber: string;
        x25519: string;
    };
}

export interface SignalingRegister {
    type: 'register';
    peerId: string;
    role: PeerRole;
    publicKey: {
        kyber: string;
        x25519: string;
    };
}

export interface SignalingRegistered {
    type: 'registered';
    peerId: string;
    relay: RelayEndpoint;
}

export interface SignalingSessionReady {
    type: 'session-ready';
    sessionId: string;
    initiatorPeerId: string;
    relay: RelayEndpoint;
    peer: PeerInfo;
}

export interface SignalingSessionInit {
    type: 'session-init';
    fromPeerId: string;
    targetPeerId: string;
    kyberCiphertext: string;
}

export interface SignalingSessionAck {
    type: 'session-ack';
    fromPeerId: string;
    targetPeerId: string;
}

export interface SignalingPeerLeft {
    type: 'peer-left';
    peerId: string;
}

export interface SignalingError {
    type: 'error';
    message: string;
}

export type SignalingMessage =
    | SignalingRegister
    | SignalingRegistered
    | SignalingSessionReady
    | SignalingSessionInit
    | SignalingSessionAck
    | SignalingPeerLeft
    | SignalingError;

export interface VPNConfig {
    role: PeerRole;
    tunName: string;
    tunAddress: string;
    peerTunAddress: string;
    tunNetmask: string;
    tunMTU: number;
    signalingUrl: string;
    relayHost?: string;
    relayPort: number;
    noTun: boolean;
    morphPacketSize: number;
}

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
    transportMode: string;
    morphMode: string;
}
