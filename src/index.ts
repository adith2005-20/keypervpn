import { PeerRole, type VPNConfig } from './types.js';
import { renderApp } from './ui/App.js';
import { VPNTunnel } from './vpn/VPNTunnel.js';

const args = process.argv.slice(2);
const mode = args[0]?.toLowerCase();

if (mode !== 'server' && mode !== 'client') {
    console.log(`
Repository demo modes:
  sudo npm start server
  sudo npm start client
  npm run signal

Optional environment:
  SIGNAL_URL=ws://raspberrypi:8080
  RELAY_HOST=raspberrypi
  RELAY_PORT=8081
  KEYPERVPN_NO_TUN=1
`);
    process.exit(1);
}

const role = mode === 'server' ? PeerRole.Server : PeerRole.Client;
const noTun = process.env.KEYPERVPN_NO_TUN === '1';

const config: VPNConfig = {
    role,
    tunName: 'keyper0',
    tunAddress: role === PeerRole.Server ? '10.44.0.1' : '10.44.0.2',
    peerTunAddress: role === PeerRole.Server ? '10.44.0.2' : '10.44.0.1',
    tunNetmask: '255.255.255.0',
    tunMTU: 1280,
    signalingUrl: process.env.SIGNAL_URL ?? 'ws://127.0.0.1:8080',
    relayHost: process.env.RELAY_HOST,
    relayPort: Number(process.env.RELAY_PORT ?? 8081),
    noTun,
    morphPacketSize: Number(process.env.MORPH_PACKET_SIZE ?? 1200),
};

async function main(): Promise<void> {
    const tunnel = new VPNTunnel(config);
    renderApp(tunnel);

    const shutdown = async () => {
        await tunnel.shutdown();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await tunnel.start();
}

main().catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
});
