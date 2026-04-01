import React, { useEffect, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import { ConnectionState, type VPNStats } from '../types.js';
import type { VPNTunnel } from '../vpn/VPNTunnel.js';

function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes}B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)}KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function uptime(connectedAt: Date | null): string {
    if (!connectedAt) {
        return '--:--:--';
    }
    const totalSeconds = Math.floor((Date.now() - connectedAt.getTime()) / 1000);
    const hours = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
    const minutes = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

function stateTone(state: ConnectionState): string {
    switch (state) {
        case ConnectionState.Connected:
            return '#6CFF8F';
        case ConnectionState.Handshaking:
            return '#62F2FF';
        case ConnectionState.Connecting:
            return '#FFE066';
        case ConnectionState.Error:
            return '#FF5D73';
        default:
            return '#7A7E8A';
    }
}

function Header() {
    const logo = [
        '██╗  ██╗███████╗██╗   ██╗██████╗ ███████╗██████╗',
        '██║ ██╔╝██╔════╝╚██╗ ██╔╝██╔══██╗██╔════╝██╔══██╗',
        '█████╔╝ █████╗   ╚████╔╝ ██████╔╝█████╗  ██████╔╝',
        '██╔═██╗ ██╔══╝    ╚██╔╝  ██╔═══╝ ██╔══╝  ██╔══██╗',
        '██║  ██╗███████╗   ██║   ██║     ███████╗██║  ██║',
        '╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝     ╚══════╝╚═╝  ╚═╝',
    ];

    return (
        <Box flexDirection="column" marginBottom={1}>
            {logo.map((line, index) => (
                <Text key={line} color={index < 2 ? '#8FF7A7' : index < 4 ? '#6CEBFF' : '#93A1FF'}>
                    {line}
                </Text>
            ))}
            <Text color="#8B93A7">POST-QUANTUM OVERLAY VPN // RELAY-ASSISTED DEMO BUILD</Text>
        </Box>
    );
}

function Strip({ label, value, color = '#C5CBD8' }: { label: string; value: string; color?: string }) {
    return (
        <Box width={38}>
            <Text color="#525869">{label.padEnd(14, ' ')}</Text>
            <Text color={color}>{value}</Text>
        </Box>
    );
}

function Dashboard({ stats, peerId }: { stats: VPNStats; peerId: string }) {
    return (
        <Box flexDirection="column" borderStyle="double" borderColor={stateTone(stats.state)} paddingX={1}>
            <Text color={stateTone(stats.state)}>
                LINK {stats.state.toUpperCase()} // {peerId}
            </Text>
            <Box marginTop={1}>
                <Strip label="crypto" value={stats.cryptoMode} color="#FFE082" />
                <Strip label="transport" value={stats.transportMode} color="#7CE7FF" />
            </Box>
            <Box>
                <Strip label="morphing" value={stats.morphMode} color="#9AF7B3" />
                <Strip label="peer" value={stats.peerId ?? 'waiting'} color="#9DB5FF" />
            </Box>
            <Box>
                <Strip label="vpn-ip" value={stats.peerVpnIp ?? 'n/a'} />
                <Strip label="latency" value={`${stats.latencyMs}ms`} color="#FFB86C" />
            </Box>
            <Box>
                <Strip label="uplink" value={formatBytes(stats.bytesSent)} color="#6CFF8F" />
                <Strip label="downlink" value={formatBytes(stats.bytesReceived)} color="#62F2FF" />
            </Box>
            <Box>
                <Strip label="pkts-out" value={stats.packetsSent.toString()} />
                <Strip label="pkts-in" value={stats.packetsReceived.toString()} />
            </Box>
            <Box>
                <Strip label="uptime" value={uptime(stats.connectedAt)} />
            </Box>
        </Box>
    );
}

function LogPane({ logs }: { logs: string[] }) {
    return (
        <Box flexDirection="column" borderStyle="single" borderColor="#343946" paddingX={1} marginTop={1}>
            <Text color="#8B93A7">EVENT STREAM</Text>
            {logs.slice(-8).map((line) => (
                <Text key={line} color="#B6BECE">{line}</Text>
            ))}
        </Box>
    );
}

function Footer() {
    return (
        <Box marginTop={1}>
            <Text color="#525869">Controls: </Text>
            <Text color="#9AF7B3">e</Text>
            <Text color="#525869"> send encrypted echo  </Text>
            <Text color="#9AF7B3">ctrl+c</Text>
            <Text color="#525869"> exit</Text>
        </Box>
    );
}

function App({ tunnel }: { tunnel: VPNTunnel }) {
    const { exit } = useApp();
    const [stats, setStats] = useState<VPNStats>(tunnel.getStats());
    const [logs, setLogs] = useState<string[]>([]);

    useEffect(() => {
        const onStats = (nextStats: VPNStats) => setStats(nextStats);
        const onLog = (message: string) => {
            const stamp = new Date().toLocaleTimeString();
            setLogs((current) => [...current.slice(-30), `[${stamp}] ${message}`]);
        };

        tunnel.on('stats', onStats);
        tunnel.on('log', onLog);

        return () => {
            tunnel.off('stats', onStats);
            tunnel.off('log', onLog);
        };
    }, [tunnel]);

    useInput((input, key) => {
        if (key.ctrl && input === 'c') {
            tunnel.shutdown().finally(() => exit());
        }
        if (input === 'e') {
            tunnel.sendTestData();
        }
    });

    return (
        <Box flexDirection="column" paddingX={1}>
            <Header />
            <Dashboard stats={stats} peerId={tunnel.getPeerId()} />
            <LogPane logs={logs} />
            <Footer />
        </Box>
    );
}

export function renderApp(tunnel: VPNTunnel): void {
    render(React.createElement(App, { tunnel }));
}
