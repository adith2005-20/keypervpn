# KeyperVPN

KeyperVPN is a relay-assisted overlay VPN demo designed to show two Linux machines communicating as if they are on the same private network while all overlay traffic remains encrypted in transit.

This build is aimed at a reviewer demo:

- two internet-connected Linux hosts
- one Raspberry Pi running the signaling server and UDP relay
- a terminal UI that shows tunnel state, crypto mode, latency, traffic, and morphing mode
- Wireshark-visible encrypted UDP packets with constant packet size

## What This Demo Implements

### 1. Overlay VPN addressing

Each peer gets a TUN interface address on the same virtual subnet:

- server: `10.44.0.1`
- client: `10.44.0.2`

The TUN device captures IP packets for the remote overlay peer and injects decrypted packets back into the kernel.

### 2. Hybrid post-quantum session setup

The data plane uses:

- ML-KEM-768 (`mlkem`) for post-quantum key encapsulation
- X25519 for classical ECDH
- ChaCha20-Poly1305 for authenticated encryption

The client initiates the session. Both shared secrets are combined through HKDF-SHA256 to derive directional send/receive keys.

### 3. Relay-assisted encrypted transport

The Raspberry Pi hosts:

- a WebSocket signaling server on port `8080`
- a UDP relay on port `8081`

Peers exchange public keys over signaling, derive end-to-end session keys locally, then send encrypted UDP frames through the relay. The relay sees only ciphertext and metadata needed for forwarding.

### 4. Traffic morphing

Every encrypted overlay frame is padded to a constant size before transmission. By default:

- `MORPH_PACKET_SIZE=1200`

This means payload size is not directly exposed by packet length in Wireshark. You should see repeated UDP datagrams of the same size during steady-state traffic.

### 5. Demo TUI

The Ink TUI shows:

- connection state
- crypto suite
- transport mode
- morphing mode
- peer ID and peer VPN IP
- packet and byte counters
- live event log

Press `e` to send an encrypted echo probe through the overlay.

## Repository Layout

```text
src/
├── index.ts                 CLI entry point
├── types.ts                 Shared protocol and stats types
├── signaling/server.ts      WebSocket signaling + UDP relay
├── p2p/SignalingClient.ts   Control-plane client
├── p2p/RelayTransport.ts    UDP relay transport
├── vpn/CryptoEngine.ts      Hybrid PQ + classical key exchange and AEAD
├── vpn/TunDevice.ts         Linux TUN wrapper
├── vpn/VPNTunnel.ts         Main orchestrator
└── ui/App.tsx               Ink terminal UI
```

## Requirements

- Node.js 20+
- Linux on both peers for the real TUN demo
- `sudo` on both peers
- an internet-reachable Linux host for signaling
- `iproute2` installed on peers
- UDP reachability to the relay port

## Install

```bash
npm install
npm run build
```

## Raspberry Pi Setup

Run this on the Pi:

```bash
SIGNAL_PORT=8080 RELAY_PORT=8081 RELAY_HOST=<public-pi-ip-or-dns> npm run signal
```

If the Pi is behind a firewall, allow:

- TCP `8080`
- UDP `8081`

## Peer Setup

### Server peer

```bash
SIGNAL_URL=ws://<pi-host>:8080 RELAY_HOST=<pi-host> RELAY_PORT=8081 sudo npm start server
```

### Client peer

```bash
SIGNAL_URL=ws://<pi-host>:8080 RELAY_HOST=<pi-host> RELAY_PORT=8081 sudo npm start client
```

## Reviewer Demo Flow

1. Start the Pi signaling/relay server.
2. Start the server peer.
3. Start the client peer.
4. Wait for both TUIs to show `CONNECTED`.
5. On the client, press `e` to send an encrypted echo probe.
6. Run `ping 10.44.0.1` from the client and `ping 10.44.0.2` from the server.
7. Open Wireshark on either peer and capture on the physical NIC.
8. Filter by the relay UDP port, for example `udp.port == 8081`.

Expected result:

- packets are UDP ciphertext, not raw ICMP payload
- packet sizes are flat or nearly flat because of constant-size morphing

## Wireshark Notes

For the cleanest screenshot:

- start a capture before pressing `e`
- filter `udp.port == 8081`
- add the `Length` column

You should be able to show:

- repeated same-size encrypted UDP datagrams
- no readable application payload
- overlay traffic continuing while pings succeed across `10.44.0.0/24`

## Local Smoke Test Without TUN

For development on systems without `/dev/net/tun`:

```bash
KEYPERVPN_NO_TUN=1 npm start server
KEYPERVPN_NO_TUN=1 npm start client
```

This validates control plane, handshake, encrypted transport, and echo probes without root networking.

## Current Limitations

- This build uses a relay path for reliability; it does not yet attempt direct NAT traversal.
- It supports a single server peer and a single client peer for the demo.
- Traffic morphing is fixed-size padding, not adaptive probabilistic shaping.
- The real same-subnet demo target is Linux; no-TUN mode is only for development validation.

## Recommended Offload To The Raspberry Pi

Your Raspberry Pi should host both:

- signaling server
- UDP relay

That is the correct place to offload internet-facing coordination. The peers keep all session keys locally, so the Pi does not terminate the encrypted overlay.
