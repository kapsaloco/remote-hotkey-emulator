import type { Shortcut } from './windows';

export interface InputAdapter {
  readonly available: boolean;
  sendShortcut(shortcut: Shortcut): Promise<{ status: 'sent' }>;
  close(): Promise<void>;
}

export class InputRejected extends Error {
  constructor(public readonly code: string) { super(`Shortcut rejected: ${code}`); }
}
