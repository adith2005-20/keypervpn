import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';

interface TunInstance {
    name: string;
    mtu: number;
    ipv4: string;
    isUp: boolean;
    on(event: 'data', handler: (packet: Buffer) => void): void;
    on(event: 'error', handler: (error: Error) => void): void;
    write(packet: Buffer): void;
    release(): void;
}

export interface TunDeviceEvents {
    data: [packet: Buffer];
    error: [error: Error];
    close: [];
}

export class TunDevice extends EventEmitter {
    private tun: TunInstance | null = null;
    private readonly requestedName: string;
    private readonly address: string;
    private readonly netmask: string;
    private readonly mtu: number;
    private running = false;
    private actualName: string | null = null;

    constructor(name: string, address: string, netmask: string, mtu: number) {
        super();
        this.requestedName = name;
        this.address = address;
        this.netmask = netmask;
        this.mtu = mtu;
    }

    async open(): Promise<void> {
        const module = await import('tuntap2/dist/index.js');
        const Tun = (module as { Tun: new () => TunInstance }).Tun;
        const tun = new Tun();

        tun.mtu = this.mtu;
        tun.ipv4 = `${this.address}/${TunDevice.netmaskToPrefix(this.netmask)}`;
        tun.isUp = true;

        this.tun = tun;
        this.actualName = tun.name || this.requestedName;
        this.running = true;

        tun.on('data', (packet) => {
            if (this.running) {
                this.emit('data', packet);
            }
        });

        tun.on('error', (error) => {
            this.emit('error', error);
        });
    }

    write(packet: Buffer): void {
        if (!this.running || !this.tun) {
            return;
        }

        try {
            this.tun.write(packet);
        } catch (error) {
            this.emit('error', error as Error);
        }
    }

    setupRouting(remoteIp: string): void {
        const name = this.deviceName;
        execSync(`ip route replace ${remoteIp}/32 dev ${name}`, { stdio: 'pipe' });
    }

    close(): void {
        this.running = false;
        const name = this.actualName;

        if (this.tun) {
            try {
                this.tun.release();
            } catch {
                // Ignore cleanup races.
            }
            this.tun = null;
        }

        if (name) {
            try {
                execSync(`ip link set ${name} down`, { stdio: 'pipe' });
            } catch {
                // Best effort.
            }
        }

        this.emit('close');
    }

    get isRunning(): boolean {
        return this.running;
    }

    get deviceName(): string {
        return this.actualName ?? this.requestedName;
    }

    private static netmaskToPrefix(netmask: string): number {
        return netmask
            .split('.')
            .map((segment) => Number(segment).toString(2).padStart(8, '0'))
            .join('')
            .split('')
            .filter((bit) => bit === '1')
            .length;
    }
}
