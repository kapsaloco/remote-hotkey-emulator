import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { InputRejected } from './adapter';

export function windowsInputHelperPath(): string {
  return path.resolve(__dirname, '../native/WindowsInput.exe');
}

export interface Shortcut {
  allowedProcesses: string[];
  key: string;
  modifiers: Array<'Ctrl' | 'Alt' | 'Shift'>;
}

export class WindowsInput {
  private readonly child: ChildProcessWithoutNullStreams;
  private disabled = false;
  private started = false;
  get available(): boolean { return this.started && !this.disabled; }
  async ready(): Promise<void> {
    if (this.disabled) throw new Error('Windows input helper unavailable. Run npm run build.');
    if (this.started) return;
    await new Promise<void>((resolve, reject) => {
      const onError = () => { cleanup(); reject(new Error('Windows input helper unavailable. Run npm run build.')); };
      const onSpawn = () => { cleanup(); resolve(); };
      const cleanup = () => { this.child.off('error', onError); this.child.off('spawn', onSpawn); };
      this.child.once('error', onError);
      this.child.once('spawn', onSpawn);
    });
    if (this.disabled) throw new Error('Windows input helper unavailable.');
  }
  private buffer = '';
  private pending: {
    resolve: (value: { status: 'sent' }) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | undefined;

  constructor() {
    if (process.platform !== 'win32') throw new Error('Windows input requires Windows.');
    const helper = windowsInputHelperPath();
    this.child = spawn(helper, [], {
      shell: false, windowsHide: true, stdio: 'pipe',
    });
    this.child.stdout.setEncoding('utf8');
    this.child.once('spawn', () => { this.started = true; });
    this.child.stdout.on('data', (chunk: string) => this.receive(chunk));
    this.child.stderr.resume();
    this.child.on('error', () => this.fail('Could not start Windows input helper.'));
    this.child.on('exit', () => this.fail('Windows input helper exited.'));
    this.child.stdin.on('error', () => this.fail('Windows input helper pipe failed.'));
  }

  sendShortcut(shortcut: Shortcut): Promise<{ status: 'sent' }> {
    if (this.disabled) return Promise.reject(new Error('Windows input is disabled; restart required.'));
    if (this.pending) return Promise.reject(new Error('An input operation is already in progress.'));
    // The native boundary independently validates these values before any injection.
    const line = JSON.stringify(shortcut);
    if (Buffer.byteLength(line, 'utf8') > 4096) return Promise.reject(new Error('Shortcut request too large.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('Helper timeout; outcome unknown. Check the emulator before trying again.'), 2000);
      this.pending = { resolve, reject, timer };
      this.child.stdin.write(line + '\n');
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 4096) { this.fail('Invalid helper response.'); return; }
    let end: number;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      const pending = this.pending;
      if (!pending) { this.fail('Unexpected helper response.'); return; }
      let reply: unknown;
      try { reply = JSON.parse(line); }
      catch { this.fail('Invalid helper response.'); return; }
      if (typeof reply !== 'object' || reply === null || !('status' in reply)) {
        this.fail('Invalid helper response.'); return;
      }
      if (reply.status === 'sent' && Object.keys(reply).length === 1) {
        clearTimeout(pending.timer);
        this.pending = undefined;
        pending.resolve({ status: 'sent' });
      } else if (reply.status === 'error' && 'code' in reply && typeof reply.code === 'string') {
        if (reply.code === 'injection_failed' || reply.code === 'input_disabled') {
          this.fail('Input failed; outcome unknown. Restart required.'); return;
        }
        clearTimeout(pending.timer);
        this.pending = undefined;
        pending.reject(new InputRejected(reply.code));
      } else { this.fail('Invalid helper response.'); return; }
    }
  }

  private fail(message: string): void {
    this.disabled = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error(message));
      this.pending = undefined;
    }
    this.child.kill();
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      this.child.once('close', () => resolve());
      this.fail('Windows input helper closed.');
    });
  }
}
