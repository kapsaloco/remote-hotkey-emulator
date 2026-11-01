import { createHash } from 'node:crypto';
import { InputRejected, type InputAdapter } from '../input/adapter';
import type { ActionId, Profiles } from './config';

export interface ActionRequest { requestId: string; profileId: string; action: ActionId }
export interface Result { status: number; body: Record<string, unknown> }
export function error(status: number, code: string, message: string): Result { return { status, body: { code, message } }; }
interface Entry { hash: string; expires: number; result?: Result }

export class Dispatcher {
  private readonly cache = new Map<string, Entry>();
  private busy = false;
  private disabled = false;
  constructor(private readonly input: InputAdapter, private readonly profiles: Profiles,
    private readonly now = Date.now, private readonly deadlineMs = 2000) {}
  get available(): boolean { return !this.disabled && this.input.available; }

  async dispatch(request: ActionRequest): Promise<Result> {
    const now = this.now();
    for (const [id, entry] of this.cache) if (entry.expires <= now && entry.result) this.cache.delete(id);
    const hash = createHash('sha256').update(JSON.stringify([request.profileId, request.action])).digest('hex');
    const existing = this.cache.get(request.requestId);
    if (existing) {
      if (existing.hash !== hash) return error(409, 'request_conflict', 'Request ID was used for a different action.');
      return existing.result ?? error(409, 'busy', 'This request is already in progress.');
    }
    const profile = this.profiles.profiles.find(profile => profile.id === request.profileId);
    if (!profile) return error(404, 'profile_not_found', 'Profile not found.');
    const chord = profile.actions[request.action];
    if (!chord) return error(400, 'action_not_configured', 'This control has no configured shortcut.');
    if (!this.available) return error(503, 'input_unavailable', 'Input unavailable; restart required.');
    if (this.busy) return error(409, 'busy', 'An action is in progress.');
    // Never evict unexpired IDs: reject at capacity to preserve deduplication.
    if (this.cache.size >= 512) return error(429, 'request_capacity', 'Too many recent requests.');
    const entry: Entry = { hash, expires: now + 60000 };
    this.cache.set(request.requestId, entry);
    this.busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.input.sendShortcut({ allowedProcesses: [...profile.processNames], key: chord.key,
          modifiers: [...chord.modifiers] }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), this.deadlineMs); }),
      ]);
      entry.result = { status: 200, body: { requestId: request.requestId, status: 'sent' } };
    } catch (failure) {
      const safeRejections = ['foreground_mismatch', 'foreground_changed', 'foreground_unavailable', 'modifier_held', 'key_held'];
      if (failure instanceof InputRejected && safeRejections.includes(failure.code)) {
        entry.result = error(409, failure.code, 'Shortcut rejected. Focus the emulator and release held keys.');
      } else {
        this.disabled = true;
        // Do not allow recovery before the old helper has exited.
        await this.input.close();
        entry.result = error(503, 'input_unavailable', 'Outcome unknown. Check the emulator before restarting.');
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.busy = false;
      entry.expires = this.now() + 60000;
    }
    return entry.result;
  }
  async close(): Promise<void> { this.disabled = true; await this.input.close(); }
}
