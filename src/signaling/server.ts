import dgram from 'node:dgram';
import { WebSocketServer, WebSocket } from 'ws';
import { PeerRole, type PeerInfo, type SignalingMessage } from '../types.js';

const SIGNAL_PORT = Number(process.env.SIGNAL_PORT ?? 8080);
const RELAY_PORT = Number(process.env.RELAY_PORT ?? 8081);
const RELAY_HOST = process.env.RELAY_HOST ?? process.env.PUBLIC_HOST ?? '127.0.0.1';

interface ConnectedPeer {
    ws: WebSocket;
    info: PeerInfo;
}

interface RelayRegistration {
    peerId: string;
    sessionId: string;
    address: string;
    port: number;
}

const peers = new Map<string, ConnectedPeer>();
const sessions = new Map<string, { serverPeerId?: string; clientPeerId?: string }>();
const relayRegistrations = new Map<string, RelayRegistration>();
const peerToSession = new Map<string, string>();

function log(message: string): void {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

function relayEndpoint() {
    return {
        host: RELAY_HOST,
        port: RELAY_PORT,
    };
}

function getSessionId(serverPeerId: string, clientPeerId: string): string {
    return `${serverPeerId}:${clientPeerId}`;
}

function maybeAnnounceSession(): void {
    const orderedPeers = [...peers.values()].reverse();
    const server = orderedPeers.find((peer) => peer.info.role === PeerRole.Server);
    const client = orderedPeers.find((peer) => peer.info.role === PeerRole.Client);

    if (!server || !client) {
        return;
    }

    const sessionId = getSessionId(server.info.peerId, client.info.peerId);
    const current = sessions.get(sessionId) ?? {};
    current.serverPeerId = server.info.peerId;
    current.clientPeerId = client.info.peerId;
    sessions.set(sessionId, current);
    peerToSession.set(server.info.peerId, sessionId);
    peerToSession.set(client.info.peerId, sessionId);

    server.ws.send(JSON.stringify({
        type: 'session-ready',
        sessionId,
        initiatorPeerId: client.info.peerId,
        relay: relayEndpoint(),
        peer: client.info,
    }));

    client.ws.send(JSON.stringify({
        type: 'session-ready',
        sessionId,
        initiatorPeerId: client.info.peerId,
        relay: relayEndpoint(),
        peer: server.info,
    }));

    log(`Session ready: ${sessionId}`);
}

function getPeer(peerId: string): ConnectedPeer | undefined {
    return peers.get(peerId);
}

const wss = new WebSocketServer({ port: SIGNAL_PORT });
log(`Signaling server listening on ws://0.0.0.0:${SIGNAL_PORT}`);

wss.on('connection', (ws) => {
    let currentPeerId: string | null = null;

    ws.on('message', (raw) => {
        let message: SignalingMessage;
        try {
            message = JSON.parse(raw.toString()) as SignalingMessage;
        } catch {
            return;
        }

        switch (message.type) {
            case 'register': {
                currentPeerId = message.peerId;
                peers.set(message.peerId, {
                    ws,
                    info: {
                        peerId: message.peerId,
                        role: message.role,
                        publicKey: message.publicKey,
                    },
                });
                ws.send(JSON.stringify({
                    type: 'registered',
                    peerId: message.peerId,
                    relay: relayEndpoint(),
                }));
                log(`Registered ${message.role} peer ${message.peerId}`);
                maybeAnnounceSession();
                break;
            }

            case 'session-init': {
                const target = getPeer(message.targetPeerId);
                if (target) {
                    target.ws.send(JSON.stringify(message));
                    log(`Session init relayed ${message.fromPeerId} -> ${message.targetPeerId}`);
                }
                break;
            }

            case 'session-ack': {
                const target = getPeer(message.targetPeerId);
                if (target) {
                    target.ws.send(JSON.stringify(message));
                    log(`Session ack relayed ${message.fromPeerId} -> ${message.targetPeerId}`);
                }
                break;
            }
        }
    });

    ws.on('close', () => {
        if (!currentPeerId) {
            return;
        }

        const sessionId = peerToSession.get(currentPeerId);
        peerToSession.delete(currentPeerId);
        peers.delete(currentPeerId);
        relayRegistrations.delete(currentPeerId);

        if (sessionId) {
            const session = sessions.get(sessionId);
            if (session?.serverPeerId === currentPeerId) {
                session.serverPeerId = undefined;
            }
            if (session?.clientPeerId === currentPeerId) {
                session.clientPeerId = undefined;
            }
            if (!session?.serverPeerId && !session?.clientPeerId) {
                sessions.delete(sessionId);
            }
        }

        for (const peer of peers.values()) {
            peer.ws.send(JSON.stringify({ type: 'peer-left', peerId: currentPeerId }));
        }

        log(`Peer disconnected: ${currentPeerId}`);
    });
});

const relayServer = dgram.createSocket('udp4');

relayServer.on('message', (message, remote) => {
    if (message.length < 1) {
        return;
    }

    const type = message[0];

    if (type === 0x10) {
        const sessionLength = message[1] ?? 0;
        const sessionStart = 2;
        const sessionEnd = sessionStart + sessionLength;
        const peerLength = message[sessionEnd] ?? 0;
        const peerStart = sessionEnd + 1;
        const peerEnd = peerStart + peerLength;
        const sessionId = message.subarray(sessionStart, sessionEnd).toString('utf8');
        const peerId = message.subarray(peerStart, peerEnd).toString('utf8');

        relayRegistrations.set(peerId, {
            peerId,
            sessionId,
            address: remote.address,
            port: remote.port,
        });
        log(`Relay registered ${peerId} at ${remote.address}:${remote.port}`);
        return;
    }

    const source = [...relayRegistrations.values()].find(
        (entry) => entry.address === remote.address && entry.port === remote.port,
    );
    if (!source) {
        return;
    }

    const session = sessions.get(source.sessionId);
    if (!session?.serverPeerId || !session.clientPeerId) {
        return;
    }

    const targetPeerId = source.peerId === session.serverPeerId ? session.clientPeerId : session.serverPeerId;
    const target = relayRegistrations.get(targetPeerId);
    if (!target) {
        return;
    }

    relayServer.send(message, target.port, target.address);
});

relayServer.bind(RELAY_PORT, () => {
    log(`UDP relay listening on 0.0.0.0:${RELAY_PORT}`);
    log(`Advertised relay endpoint: ${RELAY_HOST}:${RELAY_PORT}`);
});
