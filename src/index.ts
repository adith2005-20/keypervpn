// ============================================================
// KeyperVPN — Entry Point
// Parses CLI args, creates VPN tunnel, renders TUI
// ============================================================

import { PeerRole, type VPNConfig } from './types.js';
import { VPNTunnel } from './vpn/VPNTunnel.js';
import { renderApp } from './ui/App.js';

// ── CLI Argument Parsing ─────────────────────────────────────

const args = process.argv.slice(2);
const mode = args[0]?.toLowerCase();

if (!mode || (mode !== 'server' && mode !== 'client')) {
    console.log(`
╔╗╔═╦═╦═╦═╦═╦═╦╗╔╗
║╠╣╔╣╩╣╬║╩╣╔╣╬║╠╣║
╚╝╚╝╚═╩═╩═╩╝╚═╩╝╚╝

Usage:
  sudo npm start server    Start as VPN server (10.8.0.1)
  sudo npm start client    Start as VPN client (10.8.0.2)
  npm run signal           Start signaling server

Options:
  server    Accept incoming VPN connections
  client    Connect to a VPN server peer
`);
    process.exit(1);
}

// ── Check Root Privileges ────────────────────────────────────

if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    console.error('Error: Root privileges required. Please run with sudo.');
    console.error('  sudo npm start server');
    console.error('  sudo npm start client');
    process.exit(1);
}

// ── Configuration ────────────────────────────────────────────

const role = mode === 'server' ? PeerRole.Server : PeerRole.Client;

const config: VPNConfig = {
    role,
    tunName: 'pqvpn0',
    tunAddress: role === PeerRole.Server ? '10.8.0.1' : '10.8.0.2',
    tunNetmask: '255.255.255.0',
    tunMTU: 1420,
    signalingUrl: process.env.SIGNAL_URL || 'ws://localhost:8080',
    stunServer: 'stun.l.google.com',
    stunPort: 19302,
    subnet: '10.8.0.0/24',
};

// ── Start ────────────────────────────────────────────────────

async function main() {
    const tunnel = new VPNTunnel(config);

    // Render the TUI
    renderApp(tunnel);

    // Handle graceful shutdown
    const shutdown = async () => {
        await tunnel.shutdown();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Start the tunnel
    try {
        await tunnel.start();
    } catch (err) {
        // Error is displayed in TUI logs
        // Give user time to see the error before potentially exiting
    }
}

main().catch((err) => {
    console.error(`Fatal error: ${(err as Error).message}`);
    process.exit(1);
});
