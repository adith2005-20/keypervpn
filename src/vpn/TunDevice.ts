// ============================================================
// KeyperVPN — TUN Device Wrapper
// Creates and manages the virtual network interface
// ============================================================

import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import os from 'node:os';

// tuntap2 is a native module — dynamic import to handle platforms where it's unavailable
let tuntap: any;

export interface TunDeviceEvents {
    data: [packet: Buffer];
    error: [err: Error];
    close: [];
}

export class TunDevice extends EventEmitter {
    private tun: any = null;
    private name: string;
    private address: string;
    private netmask: string;
    private mtu: number;
    private running = false;

    constructor(
        name: string = 'pqvpn0',
        address: string = '10.8.0.1',
        netmask: string = '255.255.255.0',
        mtu: number = 1420,
    ) {
        super();
        this.name = name;
        this.address = address;
        this.netmask = netmask;
        this.mtu = mtu;
    }

    /**
     * Open and configure the TUN device.
     * Requires root/sudo privileges.
     */
    async open(): Promise<void> {
        try {
            tuntap = await import('tuntap2');
        } catch (err) {
            throw new Error(
                'Failed to load tuntap2 module. Ensure it is installed and you are running on Linux. ' +
                `Original error: ${(err as Error).message}`,
            );
        }

        const Tun = tuntap.Tun || tuntap.default?.Tun || tuntap;

        this.tun = new Tun();

        // Open the device
        this.tun.open();

        // Configure the interface via OS commands
        const platform = os.platform();

        try {
            if (platform === 'linux') {
                execSync(`ip addr add ${this.address}/24 dev ${this.name}`, { stdio: 'pipe' });
                execSync(`ip link set dev ${this.name} mtu ${this.mtu}`, { stdio: 'pipe' });
                execSync(`ip link set dev ${this.name} up`, { stdio: 'pipe' });
            } else if (platform === 'darwin') {
                // macOS TUN setup
                execSync(
                    `ifconfig ${this.name} ${this.address} ${this.address} netmask ${this.netmask} mtu ${this.mtu} up`,
                    { stdio: 'pipe' },
                );
            } else {
                throw new Error(`Unsupported platform: ${platform}. KeyperVPN requires Linux or macOS.`);
            }
        } catch (err) {
            throw new Error(
                `Failed to configure TUN interface. Are you running as root/sudo? ` +
                `Error: ${(err as Error).message}`,
            );
        }

        this.running = true;

        // Read packets from the TUN device
        this.tun.on('data', (packet: Buffer) => {
            if (this.running) {
                this.emit('data', packet);
            }
        });

        this.tun.on('error', (err: Error) => {
            this.emit('error', err);
        });
    }

    /**
     * Write a decrypted IP packet back into the TUN device.
     */
    write(packet: Buffer): void {
        if (this.running && this.tun) {
            try {
                this.tun.write(packet);
            } catch (err) {
                this.emit('error', err as Error);
            }
        }
    }

    /**
     * Close and tear down the TUN interface.
     */
    close(): void {
        this.running = false;
        if (this.tun) {
            try {
                this.tun.close();
            } catch { /* ignore */ }
            this.tun = null;
        }

        // Attempt to clean up routes
        try {
            const platform = os.platform();
            if (platform === 'linux') {
                execSync(`ip link set dev ${this.name} down`, { stdio: 'pipe' });
                execSync(`ip link delete ${this.name}`, { stdio: 'pipe' });
            }
        } catch { /* best effort cleanup */ }

        this.emit('close');
    }

    /**
     * Set up routing so VPN subnet goes through the TUN device.
     */
    setupRouting(subnet: string = '10.8.0.0/24'): void {
        const platform = os.platform();
        try {
            if (platform === 'linux') {
                execSync(`ip route add ${subnet} dev ${this.name}`, { stdio: 'pipe' });
            } else if (platform === 'darwin') {
                execSync(`route add -net ${subnet} -interface ${this.name}`, { stdio: 'pipe' });
            }
        } catch {
            // Route may already exist — ignore
        }
    }

    /**
     * Parse basic IPv4 header to extract source and destination IP.
     */
    static parseIPv4Header(packet: Buffer): {
        srcIp: string;
        dstIp: string;
        protocol: number;
        totalLength: number;
    } | null {
        if (packet.length < 20) return null;

        const version = (packet[0]! >> 4) & 0x0f;
        if (version !== 4) return null;

        const totalLength = packet.readUInt16BE(2);
        const protocol = packet[9]!;

        const srcIp = `${packet[12]!}.${packet[13]!}.${packet[14]!}.${packet[15]!}`;
        const dstIp = `${packet[16]!}.${packet[17]!}.${packet[18]!}.${packet[19]!}`;

        return { srcIp, dstIp, protocol, totalLength };
    }

    get isRunning(): boolean {
        return this.running;
    }

    get deviceName(): string {
        return this.name;
    }
}
