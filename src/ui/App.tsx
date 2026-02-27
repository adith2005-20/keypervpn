// ============================================================
// KeyperVPN — Terminal UI (Ink)
// Renders status, stats, and peer info in the terminal
// ============================================================

import React, { useState, useEffect } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import type { VPNStats } from '../types.js';
import { ConnectionState } from '../types.js';
import type { VPNTunnel } from '../vpn/VPNTunnel.js';

// ── Helpers ──────────────────────────────────────────────────

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const val = bytes / Math.pow(1024, i);
    return `${val.toFixed(1)} ${units[i]}`;
}

function formatUptime(connectedAt: Date | null): string {
    if (!connectedAt) return '—';
    const seconds = Math.floor((Date.now() - connectedAt.getTime()) / 1000);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function stateColor(state: ConnectionState): string {
    switch (state) {
        case ConnectionState.Connected: return 'green';
        case ConnectionState.Connecting: return 'yellow';
        case ConnectionState.Handshaking: return 'cyan';
        case ConnectionState.Disconnected: return 'gray';
        case ConnectionState.Error: return 'red';
        default: return 'white';
    }
}

function stateIcon(state: ConnectionState): string {
    switch (state) {
        case ConnectionState.Connected: return '●';
        case ConnectionState.Connecting: return '◌';
        case ConnectionState.Handshaking: return '◎';
        case ConnectionState.Disconnected: return '○';
        case ConnectionState.Error: return '✗';
        default: return '?';
    }
}

// ── Components ───────────────────────────────────────────────

function Header() {
    // ASCII art header with gradient colors
    const title = [
        '╔╗╔═╦═╦═╦═╦═╦═╦╗╔╗',
        '║╠╣╔╣╩╣╬║╩╣╔╣╬║╠╣║',
        '╚╝╚╝╚═╩═╩═╩╝╚═╩╝╚╝',
    ];

    const colors = ['#00d4ff', '#00ccaa', '#00ff88'];

    return (
        <Box flexDirection="column" alignItems="center" marginBottom={1}>
            {title.map((line, i) => (
                <Text key={i} color={colors[i]} bold>{line}</Text>
            ))}
            <Text color="#888" dimColor>Post-Quantum Peer-to-Peer VPN</Text>
        </Box>
    );
}

interface StatusBoxProps {
    stats: VPNStats;
    peerId: string;
}

function StatusBox({ stats, peerId }: StatusBoxProps) {
    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={stateColor(stats.state)}
            paddingX={2}
            paddingY={0}
            marginBottom={1}
        >
            <Box>
                <Text color={stateColor(stats.state)} bold>
                    {stateIcon(stats.state)} {stats.state.toUpperCase()}
                </Text>
                <Text color="#666"> │ </Text>
                <Text color="#aaa">Peer ID: </Text>
                <Text color="cyan" bold>{peerId}</Text>
            </Box>

            <Box marginTop={0}>
                <Text color="#aaa">Crypto: </Text>
                <Text color="#ffaa00">{stats.cryptoMode}</Text>
            </Box>

            {stats.state === ConnectionState.Connected && (
                <Box>
                    <Text color="#aaa">Latency: </Text>
                    <Text color={stats.latencyMs < 50 ? 'green' : stats.latencyMs < 150 ? 'yellow' : 'red'}>
                        {stats.latencyMs}ms
                    </Text>
                    <Text color="#666"> │ </Text>
                    <Text color="#aaa">Uptime: </Text>
                    <Text color="white">{formatUptime(stats.connectedAt)}</Text>
                </Box>
            )}
        </Box>
    );
}

interface StatsBoxProps {
    stats: VPNStats;
}

function StatsPanel({ stats }: StatsBoxProps) {
    return (
        <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="#444"
            paddingX={2}
            paddingY={0}
            marginBottom={1}
        >
            <Text color="#888" bold>── Traffic Stats ──</Text>
            <Box>
                <Box width={30}>
                    <Text color="#aaa">↑ Sent: </Text>
                    <Text color="green" bold>{formatBytes(stats.bytesSent)}</Text>
                </Box>
                <Box width={30}>
                    <Text color="#aaa">↓ Received: </Text>
                    <Text color="blue" bold>{formatBytes(stats.bytesReceived)}</Text>
                </Box>
            </Box>
            <Box>
                <Box width={30}>
                    <Text color="#aaa">📦 Packets Out: </Text>
                    <Text color="white">{stats.packetsSent.toLocaleString()}</Text>
                </Box>
                <Box width={30}>
                    <Text color="#aaa">📦 Packets In: </Text>
                    <Text color="white">{stats.packetsReceived.toLocaleString()}</Text>
                </Box>
            </Box>
        </Box>
    );
}

interface PeerListProps {
    stats: VPNStats;
}

function PeerList({ stats }: PeerListProps) {
    if (!stats.peerId) {
        return (
            <Box borderStyle="single" borderColor="#444" paddingX={2}>
                <Text color="#666" italic>No peers connected</Text>
            </Box>
        );
    }

    return (
        <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="#444"
            paddingX={2}
            paddingY={0}
            marginBottom={1}
        >
            <Text color="#888" bold>── Connected Peer ──</Text>
            <Box>
                <Text color="#aaa">ID: </Text>
                <Text color="cyan" bold>{stats.peerId}</Text>
                <Text color="#666"> │ </Text>
                <Text color="#aaa">VPN IP: </Text>
                <Text color="green" bold>{stats.peerVpnIp ?? 'n/a'}</Text>
                <Text color="#666"> │ </Text>
                <Text color={stateColor(stats.state)}>
                    {stateIcon(stats.state)} {stats.state}
                </Text>
            </Box>
        </Box>
    );
}

interface LogViewProps {
    logs: string[];
}

function LogView({ logs }: LogViewProps) {
    const recent = logs.slice(-6);
    return (
        <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="#333"
            paddingX={2}
            paddingY={0}
            marginBottom={1}
        >
            <Text color="#888" bold>── Log ──</Text>
            {recent.map((log, i) => (
                <Text key={i} color="#555">{log}</Text>
            ))}
        </Box>
    );
}

function Controls() {
    return (
        <Box>
            <Text color="#555">Press </Text>
            <Text color="red" bold>Ctrl+C</Text>
            <Text color="#555"> to disconnect</Text>
        </Box>
    );
}

// ── Main App ─────────────────────────────────────────────────

interface AppProps {
    tunnel: VPNTunnel;
}

function App({ tunnel }: AppProps) {
    const { exit } = useApp();
    const [stats, setStats] = useState<VPNStats>(tunnel.getStats());
    const [logs, setLogs] = useState<string[]>([]);

    useEffect(() => {
        const onStats = (newStats: VPNStats) => setStats(newStats);
        const onLog = (msg: string) => {
            setLogs((prev) => [...prev.slice(-50), `[${new Date().toLocaleTimeString()}] ${msg}`]);
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
            tunnel.shutdown().then(() => exit());
        }
    });

    return (
        <Box flexDirection="column" paddingX={1}>
            <Header />
            <StatusBox stats={stats} peerId={tunnel.getPeerId()} />
            <StatsPanel stats={stats} />
            <PeerList stats={stats} />
            <LogView logs={logs} />
            <Controls />
        </Box>
    );
}

// ── Render function ──────────────────────────────────────────

export function renderApp(tunnel: VPNTunnel): void {
    render(React.createElement(App, { tunnel }));
}
