// ============================================================
// KeyperVPN — STUN Client (RFC 5389 minimal implementation)
// Discovers public IP/port for NAT traversal
// ============================================================

import dgram from 'node:dgram';
import crypto from 'node:crypto';
import type { STUNInfo } from '../types.js';

const STUN_MAGIC_COOKIE = 0x2112a442;
const STUN_BINDING_REQUEST = 0x0001;
const STUN_ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const STUN_ATTR_MAPPED_ADDRESS = 0x0001;
const STUN_HEADER_SIZE = 20;

/**
 * Build a minimal STUN Binding Request.
 */
function buildBindingRequest(): { buffer: Buffer; transactionId: Buffer } {
    const transactionId = crypto.randomBytes(12);
    const buf = Buffer.alloc(STUN_HEADER_SIZE);

    // Message Type: Binding Request (0x0001)
    buf.writeUInt16BE(STUN_BINDING_REQUEST, 0);
    // Message Length: 0 (no attributes)
    buf.writeUInt16BE(0, 2);
    // Magic Cookie
    buf.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
    // Transaction ID (12 bytes)
    transactionId.copy(buf, 8);

    return { buffer: buf, transactionId };
}

/**
 * Parse a STUN Binding Response to extract the public IP and port.
 */
function parseBindingResponse(
    data: Buffer,
    transactionId: Buffer,
): { ip: string; port: number } | null {
    if (data.length < STUN_HEADER_SIZE) return null;

    // Verify magic cookie
    const cookie = data.readUInt32BE(4);
    if (cookie !== STUN_MAGIC_COOKIE) return null;

    // Verify transaction ID
    const rxnId = data.subarray(8, 20);
    if (!rxnId.equals(transactionId)) return null;

    const msgLength = data.readUInt16BE(2);
    let offset = STUN_HEADER_SIZE;
    const end = STUN_HEADER_SIZE + msgLength;

    while (offset + 4 <= end) {
        const attrType = data.readUInt16BE(offset);
        const attrLength = data.readUInt16BE(offset + 2);
        const attrValue = data.subarray(offset + 4, offset + 4 + attrLength);

        if (attrType === STUN_ATTR_XOR_MAPPED_ADDRESS && attrLength >= 8) {
            const family = attrValue[1]!;
            if (family === 0x01) {
                // IPv4
                const xorPort = attrValue.readUInt16BE(2) ^ (STUN_MAGIC_COOKIE >>> 16);
                const xorIp = attrValue.readUInt32BE(4) ^ STUN_MAGIC_COOKIE;
                const ip = [
                    (xorIp >>> 24) & 0xff,
                    (xorIp >>> 16) & 0xff,
                    (xorIp >>> 8) & 0xff,
                    xorIp & 0xff,
                ].join('.');
                return { ip, port: xorPort };
            }
        }

        if (attrType === STUN_ATTR_MAPPED_ADDRESS && attrLength >= 8) {
            const family = attrValue[1]!;
            if (family === 0x01) {
                const port = attrValue.readUInt16BE(2);
                const ip = [
                    attrValue[4]!, attrValue[5]!, attrValue[6]!, attrValue[7]!,
                ].join('.');
                return { ip, port };
            }
        }

        // Align to 4-byte boundary
        offset += 4 + Math.ceil(attrLength / 4) * 4;
    }

    return null;
}

/**
 * Discover public IP/port via STUN.
 * Sends a Binding Request to the given STUN server and returns the result.
 */
export async function discoverPublicEndpoint(
    stunServer: string = 'stun.l.google.com',
    stunPort: number = 19302,
    timeoutMs: number = 5000,
): Promise<STUNInfo> {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        let attempts = 0;
        const maxAttempts = 2;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let currentTxnId: Buffer;

        const sendRequest = () => {
            attempts++;
            const { buffer, transactionId } = buildBindingRequest();
            currentTxnId = transactionId;
            socket.send(buffer, 0, buffer.length, stunPort, stunServer, (err) => {
                if (err) {
                    socket.close();
                    reject(new Error(`STUN send error: ${err.message}`));
                }
            });
        };

        const cleanup = () => {
            if (timer) clearTimeout(timer);
            try { socket.close(); } catch { /* ignore */ }
        };

        socket.on('message', (msg) => {
            const result = parseBindingResponse(msg, currentTxnId!);
            if (result) {
                const addr = socket.address();
                cleanup();
                resolve({
                    publicIp: result.ip,
                    publicPort: result.port,
                    localIp: addr.address,
                    localPort: addr.port,
                    natType: 'unknown', // Simple implementation — full NAT type detection requires multiple requests
                });
            }
        });

        socket.on('error', (err) => {
            cleanup();
            reject(new Error(`STUN socket error: ${err.message}`));
        });

        socket.bind(0, () => {
            sendRequest();

            timer = setTimeout(() => {
                if (attempts < maxAttempts) {
                    sendRequest();
                    timer = setTimeout(() => {
                        cleanup();
                        reject(new Error('STUN timeout: no response from server'));
                    }, timeoutMs);
                } else {
                    cleanup();
                    reject(new Error('STUN timeout: no response from server'));
                }
            }, timeoutMs);
        });
    });
}

/**
 * Get local network IP address.
 */
export function getLocalIp(): string {
    const socket = dgram.createSocket('udp4');
    return new Promise<string>((resolve) => {
        socket.connect(80, '8.8.8.8', () => {
            const addr = socket.address();
            socket.close();
            resolve(addr.address);
        });
    }) as unknown as string;
}

export async function getLocalIpAsync(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        socket.connect(80, '8.8.8.8', () => {
            const addr = socket.address();
            socket.close();
            resolve(addr.address);
        });
        socket.on('error', () => {
            socket.close();
            resolve('127.0.0.1');
        });
    });
}
