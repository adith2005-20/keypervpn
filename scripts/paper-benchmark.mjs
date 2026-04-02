import { spawn } from 'node:child_process';
import { VPNTunnel } from '../dist/vpn/VPNTunnel.js';
import { PeerRole } from '../dist/types.js';

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTunnel(role, basePort, morphPacketSize) {
    return new VPNTunnel({
        role,
        tunName: 'keyper0',
        tunAddress: role === PeerRole.Server ? '10.44.0.1' : '10.44.0.2',
        peerTunAddress: role === PeerRole.Server ? '10.44.0.2' : '10.44.0.1',
        tunNetmask: '255.255.255.0',
        tunMTU: 1280,
        signalingUrl: `ws://127.0.0.1:${basePort}`,
        relayHost: '127.0.0.1',
        relayPort: basePort + 1,
        noTun: true,
        morphPacketSize,
    });
}

async function runTrial(basePort, morphPacketSize) {
    const relayProcess = spawn(
        'node',
        ['dist/signaling/server.js'],
        {
            cwd: process.cwd(),
            env: {
                ...process.env,
                SIGNAL_PORT: String(basePort),
                RELAY_PORT: String(basePort + 1),
                RELAY_HOST: '127.0.0.1',
            },
            stdio: ['ignore', 'ignore', 'ignore'],
        },
    );

    await wait(500);

    const server = makeTunnel(PeerRole.Server, basePort, morphPacketSize);
    const client = makeTunnel(PeerRole.Client, basePort, morphPacketSize);

    try {
        await Promise.all([server.start(), client.start()]);
        await wait(2500);
        client.sendTestData(`benchmark-${morphPacketSize}`);
        await wait(2500);

        const serverStats = server.getStats();
        const clientStats = client.getStats();

        return {
            morphPacketSize,
            server: serverStats,
            client: clientStats,
            avgPacketSizeServer: serverStats.packetsSent
                ? serverStats.bytesSent / serverStats.packetsSent
                : 0,
            avgPacketSizeClient: clientStats.packetsSent
                ? clientStats.bytesSent / clientStats.packetsSent
                : 0,
        };
    } finally {
        await Promise.allSettled([server.shutdown(), client.shutdown()]);
        relayProcess.kill('SIGINT');
        await wait(250);
    }
}

const results = [];
let port = 21080;
for (const morphPacketSize of [900, 1200, 1400]) {
    results.push(await runTrial(port, morphPacketSize));
    port += 10;
}

console.log(JSON.stringify(results, null, 2));
