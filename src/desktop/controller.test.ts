import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DesktopController } from './controller';
import type { RuntimeStatus } from '../server/runtime';

class FakeRuntime {
  status: RuntimeStatus = { phase: 'stopped', passwordEnabled: false, inputAvailable: false };
  starts = 0;
  stops = 0;
  async start(): Promise<RuntimeStatus> {
    this.starts++;
    this.status = { phase: 'running', url: 'http://127.0.0.1:3000', passwordEnabled: true, inputAvailable: true };
    return this.status;
  }
  async stop(): Promise<void> {
    this.stops++; this.status = { phase: 'stopped', passwordEnabled: false, inputAvailable: false };
  }
}
function fixture() {
  const root = path.resolve(__dirname);
  const directory = mkdtempSync(path.join(root, 'controller-test-'));
  const runtime = new FakeRuntime();
  const example = path.resolve(__dirname, '../../config/profiles.example.json');
  const controller = new DesktopController(directory, example, runtime);
  const raw = () => readFileSync(path.join(directory, 'server.local.json'), 'utf8');
  return { directory, runtime, controller, raw, example,
    async cleanup() {
      await controller.shutdown();
      assert.equal(path.dirname(directory), root);
      assert.ok(path.basename(directory).startsWith('controller-test-'));
      rmSync(directory, { recursive: true });
    },
  };
}
test('desktop initializes local-only config without starting or exposing credentials', async () => {
  const f = fixture();
  try {
    const state = f.controller.getState();
    assert.equal(state.host, '127.0.0.1'); assert.equal(state.port, 3000);
    assert.equal(state.passwordEnabled, false); assert.equal(f.runtime.starts, 0);
    assert.equal(JSON.stringify(state).includes(JSON.parse(f.raw()).token), false);
    await assert.rejects(f.controller.start(), /Set a password/);
    const original = f.raw();
    new DesktopController(f.directory, f.example, new FakeRuntime());
    assert.equal(f.raw(), original);
  } finally { await f.cleanup(); }
});
test('desktop password stays in memory, preserves settings, and stops runtime', async () => {
  const f = fixture();
  try {
    const original = JSON.parse(f.raw());
    const state = await f.controller.setPassword('abc123', 'abc123');
    assert.equal(state.passwordEnabled, true); assert.equal(f.runtime.stops, 1);
    assert.equal(f.raw().includes('abc123'), false);
    assert.equal(JSON.stringify(state).includes('salt'), false);
    const updated = JSON.parse(f.raw());
    assert.equal(updated.password, undefined); assert.equal(updated.host, original.host); assert.equal(updated.port, original.port);
    const reopened = new DesktopController(f.directory, f.example, new FakeRuntime());
    assert.equal(reopened.getState().passwordEnabled, false);
    await assert.rejects(reopened.start(), /Set a password/);
    await reopened.shutdown();
    assert.equal((await f.controller.start()).runtime.phase, 'running');
    assert.equal(f.runtime.starts, 1);
    await f.controller.setPassword('another test password', 'another test password');
    assert.equal(f.runtime.status.phase, 'stopped');
  } finally { await f.cleanup(); }
});
test('desktop rejects bad passwords and unsafe network settings without altering config', async () => {
  const f = fixture();
  try {
    const before = f.raw();
    await assert.rejects(f.controller.setPassword('test password', 'different'), /do not match/);
    await assert.rejects(f.controller.setPassword('short', 'short'), /6/);
    for (const host of ['0.0.0.0', '8.8.8.8', '::', 'localhost'])
      await assert.rejects(f.controller.setNetwork(host, 3000));
    await assert.rejects(f.controller.setNetwork('127.0.0.1', 65536));
    assert.equal(f.raw(), before); assert.equal(f.runtime.stops, 0);
    const state = await f.controller.setNetwork('127.0.0.1', 3001);
    assert.equal(state.port, 3001); assert.equal(f.runtime.stops, 1);
  } finally { await f.cleanup(); }
});
test('desktop serializes changes and shutdown waits for the pending password write', async () => {
  const f = fixture();
  try {
    const changing = f.controller.setPassword('test password only', 'test password only');
    await assert.rejects(f.controller.start(), /operation is in progress/);
    const closing = f.controller.shutdown();
    await assert.rejects(f.controller.setNetwork('127.0.0.1', 3001), /closing/);
    await changing; await closing;
    assert.equal(f.controller.getState().passwordEnabled, false);
    assert.equal(f.runtime.status.phase, 'stopped');
  } finally { await f.cleanup(); }
});
