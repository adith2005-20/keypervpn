// ============================================================
// KeyperVPN — Signaling Server
// WebSocket server for peer discovery & connection coordination
// ============================================================

import { WebSocketServer, WebSocket } from 'ws';
import type { PeerInfo, SignalingMessage } from '../types.js';

const PORT = 8080;

interface ConnectedPeer {
    ws: WebSocket;
    info: PeerInfo;
}

const peers = new Map<string, ConnectedPeer>();

function log(msg: string) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${msg}`);
}

const wss = new WebSocketServer({ port: PORT });

log(`KeyperVPN Signaling Server listening on port ${PORT}`);

wss.on('connection', (ws) => {
    let peerId: string | null = null;

    ws.on('message', (raw) => {
        let msg: SignalingMessage;
        try {
            msg = JSON.parse(raw.toString()) as SignalingMessage;
        } catch {
            return;
        }

        switch (msg.type) {
            case 'register': {
                peerId = msg.peerId;
                const peerInfo: PeerInfo = {
                    peerId: msg.peerId,
                    publicKey: msg.publicKey,
                    stunInfo: msg.stunInfo,
                };
                peers.set(msg.peerId, { ws, info: peerInfo });
                log(`Peer registered: ${msg.peerId} (${msg.stunInfo.publicIp}:${msg.stunInfo.publicPort})`);

                // Acknowledge
                ws.send(JSON.stringify({ type: 'registered', peerId: msg.peerId }));
                break;
            }

            case 'list-peers': {
                const peerList = Array.from(peers.values())
                    .filter((p) => p.ws !== ws)
                    .map((p) => p.info);
                ws.send(JSON.stringify({ type: 'peer-list', peers: peerList }));
                log(`Peer list requested by ${peerId ?? 'unknown'}, sent ${peerList.length} peers`);
                break;
            }

            case 'offer': {
                const target = peers.get(msg.targetPeerId);
                if (target) {
                    target.ws.send(JSON.stringify(msg));
                    log(`Offer relayed: ${msg.fromPeerId} → ${msg.targetPeerId}`);
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: `Peer ${msg.targetPeerId} not found` }));
                }
                break;
            }

            case 'answer': {
                const target = peers.get(msg.targetPeerId);
                if (target) {
                    target.ws.send(JSON.stringify(msg));
                    log(`Answer relayed: ${msg.fromPeerId} → ${msg.targetPeerId}`);
                }
                break;
            }

            case 'ice-candidate': {
                const target = peers.get(msg.targetPeerId);
                if (target) {
                    target.ws.send(JSON.stringify(msg));
                    log(`ICE candidate relayed: ${msg.fromPeerId} → ${msg.targetPeerId}`);
                }
                break;
            }
        }
    });

    ws.on('close', () => {
        if (peerId) {
            peers.delete(peerId);
            log(`Peer disconnected: ${peerId}`);
        }
    });

    ws.on('error', (err) => {
        log(`WebSocket error for ${peerId ?? 'unknown'}: ${err.message}`);
    });
});

wss.on('error', (err) => {
    log(`Server error: ${err.message}`);
    process.exit(1);
});
