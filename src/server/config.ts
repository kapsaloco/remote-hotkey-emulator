import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';

export const requiredActionIds = ['saveState', 'loadState'] as const;
export const optionalActionIds = ['nextSlot', 'previousSlot', 'pauseResume', 'fastForward'] as const;
export const actionIds = [...requiredActionIds, ...optionalActionIds] as const;
export type ActionId = typeof actionIds[number];
export const actionLabels: Record<ActionId, string> = {
  saveState: 'Save state', loadState: 'Load state', nextSlot: 'Next slot',
  previousSlot: 'Previous slot', pauseResume: 'Pause / Resume', fastForward: 'Fast-forward',
};
export const modifierOrder = ['Ctrl', 'Alt', 'Shift'] as const;
export type Modifier = typeof modifierOrder[number];
export interface Chord { key: string; modifiers: Modifier[] }
export interface Profile {
  id: string; label: string; processNames: string[];
  actions: Record<typeof requiredActionIds[number], Chord> & Partial<Record<typeof optionalActionIds[number], Chord>>;
}
export interface Profiles { schemaVersion: 1; defaultProfileId: string; profiles: Profile[] }
export interface PasswordHash { salt: string; hash: string }
export interface ServerConfig { host: string; port: number; token: string; password?: PasswordHash }

function invalid(): never { throw new Error('Invalid configuration. Check the documented schema; values are omitted to protect secrets.'); }
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length || fields.some(field => !Object.hasOwn(record, field))) return invalid();
  return record;
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || pattern.exec(value)?.[0] !== value) return invalid();
  return value;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) return invalid();
  return value;
}
function chord(value: unknown): Chord {
  const item = object(value, ['key', 'modifiers']);
  const key = text(item.key, /^(F([1-9]|1[0-2])|[A-Z0-9]|Space|Tab)$/);
  if (!Array.isArray(item.modifiers) || item.modifiers.length > 3 ||
      item.modifiers.some(value => !modifierOrder.includes(value)) ||
      new Set(item.modifiers).size !== item.modifiers.length) return invalid();
  const modifiers = modifierOrder.filter(value => (item.modifiers as unknown[]).includes(value));
  if ((key === 'F4' || key === 'Tab') && modifiers.includes('Alt')) return invalid();
  return { key, modifiers };
}
export function validateProfiles(value: unknown): Profiles {
  const root = object(value, ['schemaVersion', 'defaultProfileId', 'profiles']);
  if (root.schemaVersion !== 1) return invalid();
  const ids = new Set<string>();
  const profiles = list(root.profiles, 20).map(value => {
    const item = object(value, ['id', 'label', 'processNames', 'actions']);
    const id = text(item.id, /^[a-z][a-z0-9-]{0,31}$/);
    if (ids.has(id)) return invalid();
    ids.add(id);
    const label = text(item.label, /^[^\p{C}]{1,64}$/u);
    const processNames = list(item.processNames, 5).map(value =>
      text(value, /^(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/));
    if (new Set(processNames.map(name => name.toLowerCase())).size !== processNames.length) return invalid();
    if (!item.actions || typeof item.actions !== 'object' || Array.isArray(item.actions)) return invalid();
    const actions = item.actions as Record<string, unknown>;
    if (Object.keys(actions).some(id => !(actionIds as readonly string[]).includes(id)) ||
        requiredActionIds.some(id => !Object.hasOwn(actions, id))) return invalid();
    const parsed: Profile['actions'] = { saveState: chord(actions.saveState), loadState: chord(actions.loadState) };
    for (const id of optionalActionIds) if (Object.hasOwn(actions, id)) parsed[id] = chord(actions[id]);
    const chords = Object.values(parsed).map(displayChord);
    if (new Set(chords).size !== chords.length) return invalid();
    return { id, label, processNames, actions: parsed };
  });
  if (typeof root.defaultProfileId !== 'string' || !ids.has(root.defaultProfileId)) return invalid();
  return { schemaVersion: 1, defaultProfileId: root.defaultProfileId, profiles };
}
export function displayChord(chord: Chord): string { return [...chord.modifiers, chord.key].join('+'); }

export function validateHost(host: unknown, assigned = Object.values(networkInterfaces()).flatMap(items => items?.map(item => item.address) ?? [])): string {
  if (typeof host !== 'string' || !isIPv4(host)) return invalid();
  if (host === '127.0.0.1') return host;
  const [a, b] = host.split('.').map(Number);
  if (!(a === 10 || (a === 172 && b !== undefined && b >= 16 && b <= 31) || (a === 192 && b === 168)) ||
      !assigned.includes(host)) return invalid();
  return host;
}
export function validateServer(value: unknown, assigned?: string[]): ServerConfig {
  const hasPassword = value !== null && typeof value === 'object' && Object.hasOwn(value, 'password');
  const item = object(value, ['host', 'port', 'token', ...(hasPassword ? ['password'] : [])]);
  const host = validateHost(item.host, assigned);
  if (!Number.isInteger(item.port) || typeof item.port !== 'number' || item.port < 1 || item.port > 65535) return invalid();
  const token = text(item.token, /^[A-Za-z0-9_-]{43}$/);
  if (Buffer.from(token, 'base64url').length !== 32 || Buffer.from(token, 'base64url').toString('base64url') !== token) return invalid();
  if (hasPassword) {
    const password = object(item.password, ['salt', 'hash']);
    return { host, port: item.port, token, password: {
      salt: text(password.salt, /^[a-f0-9]{32}$/), hash: text(password.hash, /^[a-f0-9]{64}$/),
    } };
  }
  return { host, port: item.port, token };
}
export function readJson(file: string): unknown {
  try {
    const data = readFileSync(file);
    if (data.length > 65536) return invalid();
    return JSON.parse(data.toString('utf8')) as unknown;
  } catch { throw new Error(`Cannot read valid configuration from ${file}. Run npm run setup or check the file schema.`); }
}
