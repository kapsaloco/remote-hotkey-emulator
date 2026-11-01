import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { RemoteServerRuntime, type RuntimeStatus } from './runtime';

class FakeInput {
  available = true;
  closes = 0;
  async ready(): Promise<void> {}
  async sendShortcut(): Promise<{ status: 'sent' }> { throw new Error('Lifecycle tests must never send input.'); }
  async close(): Promise<void> { this.closes++; this.available = false; }
}
async function reservePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { server, port: address.port, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
async function fixture() {
  const reservation = await reservePort(); await reservation.close();
  const root = path.resolve(__dirname, '..');
  const directory = mkdtempSync(path.join(root, 'runtime-test-'));
  const token = randomBytes(32).toString('base64url');
  writeFileSync(path.join(directory, 'server.local.json'), JSON.stringify({ host: '127.0.0.1', port: reservation.port, token,
    password: { salt: 'a'.repeat(32), hash: 'b'.repeat(64) } }));
  writeFileSync(path.join(directory, 'profiles.local.json'), readFileSync(path.resolve(__dirname, '../../config/profiles.example.json')));
  const inputs: FakeInput[] = [];
  const states: RuntimeStatus[] = [];
  const runtime = new RemoteServerRuntime({ configDirectory: directory, onStatus: state => states.push(state) }, {
    createInput: () => { const input = new FakeInput(); inputs.push(input); return input; },
  });
  return { runtime, inputs, states, token, directory, port: reservation.port,
    async cleanup() {
      await runtime.stop();
      assert.equal(path.dirname(directory), root);
      assert.ok(path.basename(directory).startsWith('runtime-test-'));
      rmSync(directory, { recursive: true });
    },
  };
}

test('runtime import/construction has no effects; duplicate start/stop is safe; restart works', async () => {
  const f = await fixture();
  try {
    assert.equal(f.runtime.status.phase, 'stopped'); assert.equal(f.inputs.length, 0);
    const first = f.runtime.start(); assert.equal(f.runtime.start(), first);
    const status = await first;
    assert.equal(status.phase, 'running'); assert.equal(status.url, `http://127.0.0.1:${f.port}`);
    assert.equal(status.inputAvailable, true); assert.equal(f.inputs.length, 1);
    assert.equal((await f.runtime.start()).phase, 'running'); assert.equal(f.inputs.length, 1);
    assert.equal(JSON.stringify(f.states).includes(f.token), false);
    assert.equal(f.runtime.getLegacyAccessToken(), undefined);
    status.phase = 'error'; assert.equal(f.runtime.status.phase, 'running');
    const stopping = f.runtime.stop(); assert.equal(f.runtime.stop(), stopping); await stopping;
    assert.equal(f.inputs[0]!.closes, 1); assert.equal(f.runtime.status.phase, 'stopped');
    assert.equal(f.runtime.getLegacyAccessToken(), undefined);
    await f.runtime.start(); assert.equal(f.inputs.length, 2);
    f.inputs[1]!.available = false; assert.equal(f.runtime.status.inputAvailable, false);
  } finally { await f.cleanup(); }
});
test('invalid configuration fails before spawning a helper and reports a safe error', async () => {
  const f = await fixture();
  try {
    writeFileSync(path.join(f.directory, 'server.local.json'), '{');
    await assert.rejects(f.runtime.start(), /startup failed/);
    assert.equal(f.runtime.status.phase, 'error'); assert.equal(f.inputs.length, 0);
    assert.equal(JSON.stringify(f.runtime.status).includes(f.token), false);
  } finally { await f.cleanup(); }
});

test('server refuses startup without a password before opening a listener or helper', async () => {
  const f = await fixture();
  try {
    const config = JSON.parse(readFileSync(path.join(f.directory, 'server.local.json'), 'utf8'));
    delete config.password;
    writeFileSync(path.join(f.directory, 'server.local.json'), JSON.stringify(config));
    await assert.rejects(f.runtime.start(), /Set a password before starting/);
    assert.equal(f.runtime.status.phase, 'error'); assert.equal(f.inputs.length, 0);
  } finally { await f.cleanup(); }
});

test('desktop runtime uses only its current session password, ignoring saved credentials', async () => {
  const f = await fixture();
  let password: { salt: string; hash: string } | undefined;
  const input = new FakeInput();
  const runtime = new RemoteServerRuntime({ configDirectory: f.directory, sessionPassword: () => password }, { createInput: () => input });
  try {
    await assert.rejects(runtime.start(), /Set a password/);
    password = { salt: 'a'.repeat(32), hash: 'b'.repeat(64) };
    assert.equal((await runtime.start()).phase, 'running');
    await runtime.stop();
    password = undefined;
    await assert.rejects(runtime.start(), /Set a password/);
  } finally { await runtime.stop(); await f.cleanup(); }
});
test('port collision closes helper; same instance can retry after port is freed', async () => {
  const f = await fixture(); const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(f.port, '127.0.0.1', resolve));
  try {
    await assert.rejects(f.runtime.start(), /startup failed/);
    assert.equal(f.inputs[0]!.closes, 1); assert.equal(f.runtime.status.phase, 'error');
    await new Promise<void>(resolve => occupied.close(() => resolve()));
    assert.equal((await f.runtime.start()).phase, 'running');
  } finally { if (occupied.listening) occupied.close(); await f.cleanup(); }
});
test('stop during startup waits and shuts down; a new start cannot race shutdown', async () => {
  const f = await fixture();
  try {
    const starting = f.runtime.start(); const stopping = f.runtime.stop();
    await assert.rejects(f.runtime.start(), /stopping/);
    await starting; await stopping;
    assert.equal(f.runtime.status.phase, 'stopped'); assert.equal(f.inputs[0]!.closes, 1);
    assert.deepEqual(f.states.map(state => state.phase), ['starting', 'running', 'stopping', 'stopped']);
  } finally { await f.cleanup(); }
});
test('helper readiness failure releases helper before rejecting startup', async () => {
  const f = await fixture(); const input = new FakeInput();
  input.ready = async () => { throw new Error('private helper detail'); };
  const runtime = new RemoteServerRuntime({ configDirectory: f.directory }, { createInput: () => input });
  try {
    await assert.rejects(runtime.start(), /startup failed/);
    assert.equal(input.closes, 1); assert.equal(runtime.status.phase, 'error');
    assert.equal(JSON.stringify(runtime.status).includes('private helper detail'), false);
  } finally { await runtime.stop(); await f.cleanup(); }
});
