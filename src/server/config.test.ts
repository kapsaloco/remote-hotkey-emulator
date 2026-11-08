import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { readJson, validateProfiles, validateServer, displayChord } from './config';
import { authenticate } from './auth';

function example(): any {
  return readJson(path.resolve(__dirname, '../../config/profiles.example.json'));
}
test('example profile and canonical chords', () => {
  const config = example();
  config.profiles[0].actions.saveState.modifiers = ['Shift', 'Ctrl'];
  const parsed = validateProfiles(config);
  assert.equal(displayChord(parsed.profiles[0]!.actions.saveState), 'Ctrl+Shift+F1');
});
test('reject unknown fields, duplicate IDs/chords, unsupported and reserved inputs', () => {
  const mutations = [
    (c: any) => { c.command = 'anything'; },
    (c: any) => { c.profiles[0].actions.saveState.command = 'anything'; },
    (c: any) => { c.profiles.push(structuredClone(c.profiles[0])); },
    (c: any) => { c.profiles[0].actions.loadState.key = 'F1'; },
    (c: any) => { delete c.profiles[0].actions.loadState; },
    (c: any) => { c.profiles[0].processNames = ['C:\\pcsx2.exe']; },
    (c: any) => { c.profiles[0].processNames = ['pcsx2.exe', 'PCSX2.EXE']; },
    (c: any) => { c.profiles[0].processNames = ['*.exe']; },
    (c: any) => { c.profiles[0].actions.saveState.key = 'F13'; },
    (c: any) => { c.profiles[0].actions.saveState.key = 'F1\n'; },
    (c: any) => { c.profiles[0].actions.saveState.modifiers = ['Win']; },
    (c: any) => { c.profiles[0].actions.saveState.modifiers = ['Ctrl', 'Ctrl']; },
    (c: any) => { c.profiles[0].actions.saveState = { key: 'F4', modifiers: ['Alt'] }; },
    (c: any) => { c.profiles[0].actions.fastForward = { key: 'Tab', modifiers: ['Alt'] }; },
    (c: any) => { c.profiles[0].actions.pauseResume = { key: 'F1', modifiers: [] }; },
    (c: any) => { c.profiles[0].actions.unknown = { key: 'F6', modifiers: [] }; },
    (c: any) => { c.defaultProfileId = 'missing'; },
    (c: any) => { c.schemaVersion = 2; },
  ];
  for (const mutate of mutations) {
    const config = example(); mutate(config);
    assert.throws(() => validateProfiles(config), /Invalid configuration/);
  }
});

test('optional controls support Space, Tab and Shift+F2; old profiles remain valid', () => {
  const config = example();
  const profile = validateProfiles(config).profiles[0]!;
  assert.equal(profile.actions.pauseResume?.key, 'Space');
  assert.equal(profile.actions.fastForward?.key, 'Tab');
  assert.equal(displayChord(profile.actions.previousSlot!), 'Shift+F2');
  for (const id of ['previousSlot', 'pauseResume', 'fastForward']) delete config.profiles[0].actions[id];
  assert.equal(validateProfiles(config).profiles[0]!.actions.pauseResume, undefined);
});
test('server accepts assigned private addresses and loopback, rejects unsafe config', () => {
  const token = randomBytes(32).toString('base64url');
  const config = { host: '127.0.0.1', port: 3000, token };
  assert.deepEqual(validateServer(config, []), config);
  for (const host of ['10.0.0.2', '172.16.0.2', '192.168.1.2'])
    assert.equal(validateServer({ ...config, host }, [host]).host, host);
  for (const host of ['0.0.0.0', '::', '8.8.8.8', 'localhost', '172.32.0.2', '192.168.1.2'])
    assert.throws(() => validateServer({ ...config, host }, []));
  for (const port of [0, 65536, 1.5, '3000']) assert.throws(() => validateServer({ ...config, port }));
  for (const token of ['', 'short', 'a'.repeat(43)]) assert.throws(() => validateServer({ ...config, token }));
  assert.throws(() => validateServer({ ...config, extra: true }));
});
test('bearer auth requires canonical token and rotation invalidates old token', () => {
  const token = randomBytes(32).toString('base64url');
  assert.equal(authenticate(`Bearer ${token}`, token), true);
  for (const header of [undefined, '', `bearer ${token}`, `Bearer ${token}=`, `Bearer ${token}\n`, `Bearer ${'a'.repeat(43)}`])
    assert.equal(authenticate(header, token), false);
  assert.equal(authenticate(`Bearer ${token}`, randomBytes(32).toString('base64url')), false);
});

test('RPCS3 maps native shortcuts without requiring slot cycling', () => {
  const profile = validateProfiles(example()).profiles.find(profile => profile.id === 'rpcs3')!;
  assert.deepEqual(profile.processNames, ['rpcs3.exe']);
  assert.equal(displayChord(profile.actions.saveState), 'Ctrl+S');
  assert.equal(displayChord(profile.actions.loadState), 'Ctrl+Alt+1');
  assert.equal(displayChord(profile.actions.pauseResume!), 'Ctrl+P');
  assert.equal(displayChord(profile.actions.fastForward!), 'Ctrl+F10');
  assert.equal(profile.actions.nextSlot, undefined);
  assert.equal(profile.actions.previousSlot, undefined);
});

test('mGBA uses slot 1 and toggle fast-forward', () => {
  const profile = validateProfiles(example()).profiles.find(profile => profile.id === 'mgba')!;
  assert.deepEqual(profile.processNames, ['mGBA.exe']);
  assert.equal(displayChord(profile.actions.saveState), 'Shift+F1');
  assert.equal(displayChord(profile.actions.loadState), 'F1');
  assert.equal(displayChord(profile.actions.pauseResume!), 'Ctrl+P');
  assert.equal(displayChord(profile.actions.fastForward!), 'Shift+Tab');
  assert.equal(profile.actions.nextSlot, undefined);
  assert.equal(profile.actions.previousSlot, undefined);
});

test('new emulator profiles use distinct native shortcuts and omit held fast-forward', () => {
 const profiles = validateProfiles(example()).profiles;
 for (const [id, save, load, pause, previous, next] of [
 ['dolphin', 'Shift+F1', 'F1', 'F10', undefined, undefined],
 ['duckstation', 'F2', 'F1', 'Space', 'F3', 'F4'],
 ['ppsspp', 'F2', 'F4', 'F8', undefined, 'F3'],
 ]) {
 const p = profiles.find(p => p.id === id)!;
 assert.ok(p.processNames.length > 0);
 assert.equal(displayChord(p.actions.saveState), save); assert.equal(displayChord(p.actions.loadState), load);
 assert.equal(displayChord(p.actions.pauseResume!), pause);
 assert.equal(p.actions.previousSlot && displayChord(p.actions.previousSlot), previous);
 assert.equal(p.actions.nextSlot && displayChord(p.actions.nextSlot), next);
 assert.equal(p.actions.fastForward, undefined);
 }
});
