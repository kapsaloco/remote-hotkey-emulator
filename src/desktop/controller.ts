import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { hashPassword } from '../server/auth';
import { readJson, validateHost, validateProfiles, validateServer, type PasswordHash, type ServerConfig } from '../server/config';
import { RemoteServerRuntime, type RuntimeStatus } from '../server/runtime';

export interface DesktopState {
  runtime: RuntimeStatus;
  host: string;
  port: number;
  passwordEnabled: boolean;
  addresses: string[];
}
interface Runtime {
  readonly status: RuntimeStatus;
  start(): Promise<RuntimeStatus>;
  stop(): Promise<void>;
}
export class DesktopController {
  private readonly runtime: Runtime;
  private busy = false;
  private closing = false;
  private pending: Promise<DesktopState> | undefined;
  private password: PasswordHash | undefined;
  constructor(private readonly directory: string, exampleFile: string, runtime?: Runtime) {
    mkdirSync(directory, { recursive: true });
    this.runtime = runtime ?? new RemoteServerRuntime({ configDirectory: directory, sessionPassword: () => this.password });
    const profilesFile = path.join(directory, 'profiles.local.json');
    if (!existsSync(profilesFile)) {
      const profiles = validateProfiles(readJson(exampleFile));
      writeFileSync(profilesFile, JSON.stringify(profiles, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    if (!existsSync(this.file)) this.save({ host: '127.0.0.1', port: 3000, token: randomBytes(32).toString('base64url') });
    // Migrate away from persisted desktop credentials, including hashes saved by older versions.
    const config = this.config();
    if (config.password) {
      delete config.password;
      config.token = randomBytes(32).toString('base64url');
      this.save(config);
    }
  }
  private get file(): string { return path.join(this.directory, 'server.local.json'); }
  private config(): ServerConfig {
    const value = readJson(this.file);
    // Let the window display an old private address after DHCP changes, so it can be edited.
    // Actual start/network save always validates against live interfaces.
    const host = value && typeof value === 'object' && 'host' in value && typeof value.host === 'string' ? value.host : '';
    return validateServer(value, [host]);
  }
  private save(config: ServerConfig): void {
    const temporary = path.join(this.directory, `server-${randomBytes(8).toString('hex')}.local.json`);
    writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, this.file);
  }
  getState(): DesktopState {
    const config = this.config();
    const candidates = Object.values(networkInterfaces()).flatMap(items => items?.map(item => item.address) ?? []);
    const addresses = ['127.0.0.1', ...new Set(candidates.filter(address => {
      try { validateHost(address, candidates); return address !== '127.0.0.1'; } catch { return false; }
    }))];
    return { runtime: this.runtime.status, host: config.host, port: config.port,
      passwordEnabled: !!this.password, addresses };
  }
  private async change(operation: () => Promise<void>): Promise<DesktopState> {
    if (this.closing) throw new Error('Application is closing.');
    if (this.busy) throw new Error('Another operation is in progress. Please wait.');
    this.busy = true;
    this.pending = (async () => { await operation(); return this.getState(); })();
    try { return await this.pending; } finally { this.busy = false; this.pending = undefined; }
  }
  start(): Promise<DesktopState> {
    return this.change(async () => {
      if (!this.password) throw new Error('Set a password before starting the desktop server.');
      await this.runtime.start();
    });
  }
  stop(): Promise<DesktopState> { return this.change(() => this.runtime.stop()); }
  setPassword(password: unknown, confirmation: unknown): Promise<DesktopState> {
    return this.change(async () => {
      if (typeof password !== 'string' || typeof confirmation !== 'string') throw new Error('Enter and confirm your password.');
      if (password !== confirmation) throw new Error('Passwords do not match.');
      const hash = await hashPassword(password);
      await this.runtime.stop();
      this.password = hash;
    });
  }
  setNetwork(host: unknown, port: unknown): Promise<DesktopState> {
    return this.change(async () => {
      const config = validateServer({ ...this.config(), host, port });
      await this.runtime.stop();
      this.save(config);
    });
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    try { await this.pending; } catch { /* Still close the runtime after a failed operation. */ }
    try { await this.runtime.stop(); } finally { this.password = undefined; }
  }
}
