// ============================================================
// KeyperVPN — Hybrid Post-Quantum Crypto Engine
// Kyber-768 (ML-KEM-768) + X25519 + ChaCha20-Poly1305
// ============================================================

import { MlKem768 } from 'mlkem';
import { x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/ciphers/webcrypto';
import type { CryptoKeys, SessionKeys } from '../types.js';

const CRYPTO_MODE = 'Kyber-768 + X25519 + ChaCha20-Poly1305';

// ── Key Generation ───────────────────────────────────────────

export async function generateKeys(): Promise<CryptoKeys> {
    // ML-KEM-768 keypair (Kyber-768)
    const kyberInstance = new MlKem768();
    const [kyberPublicKey, kyberSecretKey] = await kyberInstance.generateKeyPair();

    // X25519 keypair
    const x25519PrivateKey = randomBytes(32);
    const x25519PublicKey = x25519.getPublicKey(x25519PrivateKey);

    return {
        kyberPublicKey: new Uint8Array(kyberPublicKey),
        kyberSecretKey: new Uint8Array(kyberSecretKey),
        x25519PrivateKey: new Uint8Array(x25519PrivateKey),
        x25519PublicKey: new Uint8Array(x25519PublicKey),
    };
}

// ── Hybrid Key Exchange ──────────────────────────────────────

export interface KeyExchangeResult {
    sessionKeys: SessionKeys;
    kyberCiphertext: Uint8Array | null; // non-null only for initiator
}

/**
 * Perform key exchange as the initiator (client).
 * Encapsulates with remote Kyber PK + computes X25519 DH.
 */
export async function initiateKeyExchange(
    localKeys: CryptoKeys,
    remoteKyberPK: Uint8Array,
    remoteX25519PK: Uint8Array,
): Promise<KeyExchangeResult> {
    // Kyber encapsulation → ciphertext + shared secret
    const kyberInstance = new MlKem768();
    const [ciphertext, kyberShared] = await kyberInstance.encap(remoteKyberPK);

    // X25519 DH
    const x25519Shared = x25519.getSharedSecret(
        localKeys.x25519PrivateKey,
        remoteX25519PK,
    );

    // Derive session keys from combined secrets
    const sessionKeys = deriveSessionKeys(
        new Uint8Array(kyberShared),
        new Uint8Array(x25519Shared),
        true,
    );

    return { sessionKeys, kyberCiphertext: new Uint8Array(ciphertext) };
}

/**
 * Complete key exchange as responder (server).
 * Decapsulates Kyber ciphertext + computes X25519 DH.
 */
export async function completeKeyExchange(
    localKeys: CryptoKeys,
    kyberCiphertext: Uint8Array,
    remoteX25519PK: Uint8Array,
): Promise<KeyExchangeResult> {
    // Kyber decapsulation
    const kyberInstance = new MlKem768();
    const kyberShared = await kyberInstance.decap(kyberCiphertext, localKeys.kyberSecretKey);

    // X25519 DH
    const x25519Shared = x25519.getSharedSecret(
        localKeys.x25519PrivateKey,
        remoteX25519PK,
    );

    // Derive session keys (opposite direction)
    const sessionKeys = deriveSessionKeys(
        new Uint8Array(kyberShared),
        new Uint8Array(x25519Shared),
        false,
    );

    return { sessionKeys, kyberCiphertext: null };
}

// ── KDF ──────────────────────────────────────────────────────

function deriveSessionKeys(
    kyberShared: Uint8Array,
    x25519Shared: Uint8Array,
    isInitiator: boolean,
): SessionKeys {
    // Concatenate both shared secrets
    const combined = new Uint8Array(kyberShared.length + x25519Shared.length);
    combined.set(kyberShared, 0);
    combined.set(x25519Shared, kyberShared.length);

    // HKDF-SHA256 → 64 bytes (two 32-byte keys)
    const info = new TextEncoder().encode('keypervpn-session-v1');
    const derived = hkdf(sha256, combined, undefined, info, 64);

    // Split into send/recv keys (direction-aware)
    const key1 = derived.slice(0, 32);
    const key2 = derived.slice(32, 64);

    return {
        sendKey: isInitiator ? key1 : key2,
        recvKey: isInitiator ? key2 : key1,
        sendNonce: 0n,
        recvNonce: 0n,
    };
}

// ── AEAD Encrypt / Decrypt ───────────────────────────────────

function buildNonce(counter: bigint): Uint8Array {
    const nonce = new Uint8Array(12);
    // First 4 bytes: random
    const rand = randomBytes(4);
    nonce.set(rand, 0);
    // Last 8 bytes: counter (big-endian)
    const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
    view.setBigUint64(4, counter, false);
    return nonce;
}

export function encrypt(
    plaintext: Uint8Array,
    sessionKeys: SessionKeys,
): { ciphertext: Uint8Array; nonce: Uint8Array } {
    const nonce = buildNonce(sessionKeys.sendNonce);
    sessionKeys.sendNonce += 1n;

    const cipher = chacha20poly1305(sessionKeys.sendKey, nonce);
    const ciphertext = cipher.encrypt(plaintext);

    return { ciphertext: new Uint8Array(ciphertext), nonce };
}

export function decrypt(
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    sessionKeys: SessionKeys,
): Uint8Array {
    sessionKeys.recvNonce += 1n;
    const cipher = chacha20poly1305(sessionKeys.recvKey, nonce);
    return new Uint8Array(cipher.decrypt(ciphertext));
}

export function getCryptoMode(): string {
    return CRYPTO_MODE;
}
