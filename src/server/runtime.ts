import { existsSync } from 'node:fs';
import path from 'node:path';
import { WindowsInput } from '../input/windows';
import type { InputAdapter } from '../input/adapter';
import { readJson, validateProfiles, validateServer, type PasswordHash, type ServerConfig } from './config';
import { createRemoteServer } from './http';

export interface RuntimeStatus {
  phase: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  url?: string;
  passwordEnabled: boolean;
  inputAvailable: boolean;
  error?: string;
}
export interface RuntimeOptions {
  configDirectory?: string;
  sessionPassword?: () => PasswordHash | undefined;
  onStatus?: (status: RuntimeStatus) => void;
  log?: Parameters<typeof createRemoteServer>[3];
}
interface ReadyInput extends InputAdapter { ready(): Promise<void> }
// Tests explicitly inject a fake; production always uses the real Windows helper.
interface RuntimeDependencies { createInput(): ReadyInput }
class PasswordRequiredError extends Error {
  constructor() { super('Set a password before starting the server. Use the desktop app or npm run setup -- --set-password.'); }
}
function productionInput(): ReadyInput {
  if (process.platform !== 'win32') throw new Error('Production input requires Windows.');
  if (!existsSync(path.resolve(__dirname, '../native/WindowsInput.exe')))
    throw new Error('Windows input helper missing. Run npm run build.');
  return new WindowsInput();
}

/** Importing this module never starts listeners, installs signals, or spawns a helper. */
export class RemoteServerRuntime {
  private current: RuntimeStatus = { phase: 'stopped', passwordEnabled: false, inputAvailable: false };
  private app: ReturnType<typeof createRemoteServer> | undefined;
  private input: ReadyInput | undefined;
  private config: ServerConfig | undefined;
  private starting: Promise<RuntimeStatus> | undefined;
  private stopping: Promise<void> | undefined;
  constructor(private readonly options: RuntimeOptions = {},
    private readonly dependencies: RuntimeDependencies = { createInput: productionInput }) {}
  get status(): RuntimeStatus {
    return { ...this.current, inputAvailable: this.current.phase === 'running' && this.input?.available === true };
  }
  /** Only for the local CLI console; never put credentials in renderer status. */
  getLegacyAccessToken(): string | undefined {
    return this.current.phase === 'running' && !this.config?.password ? this.config?.token : undefined;
  }
  private update(status: RuntimeStatus): void {
    this.current = status;
    const snapshot = this.status;
    // Notify after start/stop promises are installed, so UI callbacks can safely call them.
    queueMicrotask(() => {
      try { this.options.onStatus?.(snapshot); } catch { /* Presentation errors must not leak resources. */ }
    });
  }
  start(): Promise<RuntimeStatus> {
    if (this.stopping) return Promise.reject(new Error('Server is stopping. Wait before starting it again.'));
    if (this.starting) return this.starting;
    if (this.current.phase === 'running') return Promise.resolve(this.status);
    this.update({ phase: 'starting', passwordEnabled: false, inputAvailable: false });
    this.starting = this.startInternal().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async startInternal(): Promise<RuntimeStatus> {
    let app: ReturnType<typeof createRemoteServer> | undefined;
    let input: ReadyInput | undefined;
    try {
      const directory = this.options.configDirectory ?? path.resolve(__dirname, '../../config');
      const config = validateServer(readJson(path.join(directory, 'server.local.json')));
      if (this.options.sessionPassword) {
        const password = this.options.sessionPassword();
        if (password) config.password = { ...password };
        else delete config.password;
      }
      if (!config.password) throw new PasswordRequiredError();
      const profiles = validateProfiles(readJson(path.join(directory, 'profiles.local.json')));
      input = this.dependencies.createInput();
      await input.ready();
      if (!input.available) throw new Error('Input helper unavailable.');
      app = createRemoteServer(config, profiles, input, this.options.log);
      const server = app.server;
      await new Promise<void>((resolve, reject) => {
        const failed = (failure: Error) => { server.off('listening', listening); reject(failure); };
        const listening = () => { server.off('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', listening);
        server.listen(config.port, config.host);
      });
      this.app = app; this.input = input; this.config = config;
      server.on('error', () => {
        this.update({ ...this.status, phase: 'error', inputAvailable: false, error: 'Server failed. Stop and restart it.' });
        void this.stop().catch(() => {});
      });
      this.update({ phase: 'running', url: `http://${config.host}:${config.port}`,
        passwordEnabled: !!config.password, inputAvailable: input.available });
      return this.status;
    } catch (failure) {
      try { if (app) await app.close(); else await input?.close(); } catch { /* Preserve safe startup error. */ }
      this.app = undefined; this.input = undefined; this.config = undefined;
      const message = failure instanceof PasswordRequiredError ? failure.message : 'Server startup failed. Check local configuration, the helper build, and address/port availability.';
      this.update({ phase: 'error', passwordEnabled: false, inputAvailable: false, error: message });
      throw new Error(message);
    }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopInternal().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
  private async stopInternal(): Promise<void> {
    if (this.starting) { try { await this.starting; } catch { /* Failed startup already cleaned up. */ } }
    if (!this.app) {
      this.update({ phase: 'stopped', passwordEnabled: false, inputAvailable: false });
      return;
    }
    this.update({ ...this.status, phase: 'stopping', inputAvailable: false });
    try {
      await this.app.close();
      this.update({ phase: 'stopped', passwordEnabled: false, inputAvailable: false });
    } catch {
      const message = 'Server shutdown failed. Close the application before restarting.';
      this.update({ phase: 'error', passwordEnabled: false, inputAvailable: false, error: message });
      throw new Error(message);
    } finally { this.app = undefined; this.input = undefined; this.config = undefined; }
  }
}
