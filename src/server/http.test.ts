import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { InputRejected, type InputAdapter } from '../input/adapter';
import type { Shortcut } from '../input/windows';
import { readJson, validateProfiles } from './config';
import { createRemoteServer } from './http';
import { Dispatcher } from './dispatcher';
import { RateLimit } from './rate-limit';
import { hashPassword } from './auth';
import type { PasswordHash, ServerConfig } from './config';

class FakeInput implements InputAdapter {
  available = true;
  calls: Shortcut[] = [];
  operation: () => Promise<{ status: 'sent' }> = async () => ({ status: 'sent' });
  async sendShortcut(shortcut: Shortcut): Promise<{ status: 'sent' }> { this.calls.push(shortcut); return this.operation(); }
  async close(): Promise<void> { this.available = false; }
}
const profiles = () => validateProfiles(readJson(path.resolve(__dirname, '../../config/profiles.example.json')));
const action = () => ({ requestId: randomUUID(), profileId: 'pcsx2', action: 'saveState' as const });

async function fixture(password?: PasswordHash) {
  const input = new FakeInput();
  const config: ServerConfig = { host: '127.0.0.1', port: 0, token: randomBytes(32).toString('base64url'), ...(password ? { password } : {}) };
  const app = createRemoteServer(config, profiles(), input);
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  const host = `127.0.0.1:${port}`;
  async function send(options: { method?: string; url?: string; headers?: Record<string, string>; raw?: string; json?: unknown; chunked?: boolean } = {}) {
    const method = options.method ?? 'POST';
    const data = options.raw ?? JSON.stringify(options.json ?? action());
    return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; text: string; body: any }>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, method, path: options.url ?? '/api/actions', headers: {
        Host: host, Origin: `http://${host}`, Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json', ...(method === 'POST' ? options.chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...options.headers,
      } }, response => {
        let text = '';
        response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
        response.on('end', () => {
          let body; try { body = JSON.parse(text); } catch { body = undefined; }
          resolve({ status: response.statusCode!, headers: response.headers, text, body });
        });
      });
      request.on('error', reject);
      if (method === 'POST') request.write(data);
      request.end();
    });
  }
  return { ...app, input, config, send };
}

test('authenticated routes, sanitized profiles, exact dispatch and deduplication', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send({ method: 'GET', url: '/api/health' })).body.inputAvailable, true);
    const visible = await f.send({ method: 'GET', url: '/api/profiles' });
    assert.equal(visible.body.profiles[0].actions.saveState.shortcut, 'F1');
    assert.equal(visible.text.includes('.exe'), false);
    assert.equal(visible.text.includes(f.config.token), false);
    const request = action();
    const first = await f.send({ json: request });
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'sent');
    assert.equal((await f.send({ json: request })).status, 200);
    assert.equal((await f.send({ json: { ...request, action: 'loadState' } })).status, 409);
    assert.deepEqual(f.input.calls, [{ allowedProcesses: ['pcsx2-qt.exe'], key: 'F1', modifiers: [] }]);
    assert.equal(first.headers['cache-control'], 'no-store');
    assert.equal(first.headers['access-control-allow-origin'], undefined);
  } finally { await f.close(); }
});

test('password login issues a private session, disables old token, and logout revokes it', async () => {
  const f = await fixture(await hashPassword('test password only'));
  try {
    const login = await f.send({ url: '/api/login', json: { credential: 'test password only' }, headers: { Authorization: '' } });
    assert.equal(login.status, 200);
    assert.match(login.body.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(login.text.includes('test password only'), false);
    assert.equal(login.headers['cache-control'], 'no-store');
    const headers = { Authorization: `Bearer ${login.body.token}` };
    assert.equal((await f.send({ method: 'GET', url: '/api/health', headers })).status, 200);
    assert.equal((await f.send({ method: 'GET', url: '/api/health' })).status, 401);
    assert.equal((await f.send({ url: '/api/logout', headers })).status, 200);
    assert.equal((await f.send({ method: 'GET', url: '/api/health', headers })).status, 401);
    assert.equal(f.input.calls.length, 0);
  } finally { await f.close(); }
});
test('login rejects cross-origin and malformed requests and limits guesses', async () => {
  const f = await fixture(await hashPassword('test password only'));
  try {
    assert.equal((await f.send({ url: '/api/login', json: { credential: 'test password only' }, headers: { Origin: 'http://evil.example' } })).status, 403);
    for (let i = 0; i < 3; i++) assert.equal((await f.send({ url: '/api/login', json: { credential: 'wrong' } })).status, 401);
    assert.equal((await f.send({ url: '/api/login', json: { credential: 'test password only' } })).status, 429);
    assert.equal(f.input.calls.length, 0);
  } finally { await f.close(); }
  const g = await fixture();
  try {
    assert.equal((await g.send({ url: '/api/login', json: { credential: 'anything', extra: true } })).status, 400);
    assert.equal((await g.send({ url: '/api/login', raw: 'x'.repeat(1025) })).status, 413);
    assert.equal(g.input.calls.length, 0);
  } finally { await g.close(); }
});

test('unauthorized and cross-origin requests cannot dispatch', async () => {
  const f = await fixture();
  try {
    for (const url of ['/api/health', '/api/profiles', '/api/actions'])
      assert.equal((await f.send({ url, headers: { Authorization: '' } })).status, 401);
    for (const headers of [{ Origin: 'null' }, { Origin: 'http://evil.example' }, { Origin: '' },
      { Host: 'evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }])
      assert.equal((await f.send({ headers })).status, 403);
    assert.equal(f.input.calls.length, 0);
  } finally { await f.close(); }
});

test('malformed, oversized and chunked bodies fail before dispatch', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send({ raw: '{' })).status, 400);
    assert.equal((await f.send({ json: { ...action(), key: 'F1' } })).status, 400);
    assert.equal((await f.send({ json: { ...action(), action: 'constructor' } })).status, 400);
    assert.equal((await f.send({ raw: 'x'.repeat(1025) })).status, 413);
    assert.equal((await f.send({ raw: 'x'.repeat(1025), chunked: true })).status, 413);
    assert.equal((await f.send({ headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await f.send({ headers: { 'Content-Encoding': 'gzip' } })).status, 415);
    assert.equal((await f.send({ json: { ...action(), profileId: 'missing' } })).status, 404);
    assert.equal(f.input.calls.length, 0);
  } finally { await f.close(); }
});

test('static allowlist, unsupported methods and pre-auth rate limit', async () => {
  const f = await fixture();
  try {
    const page = await f.send({ method: 'GET', url: '/' });
    assert.equal(page.status, 200);
    assert.equal(page.text.includes(f.config.token), false);
    for (const url of ['/config/server.local.json', '/../package.json', '/%2e%2e/config/server.local.json', '/native/WindowsInput.exe'])
      assert.equal((await f.send({ method: 'GET', url })).status, 404);
    assert.equal((await f.send({ method: 'GET' })).status, 404);
    assert.equal((await f.send({ method: 'OPTIONS' })).status, 404);
    for (let i = 0; i < 3; i++) await f.send({ method: 'GET', url: '/api/health' });
    assert.equal((await f.send()).status, 429);
    assert.equal(f.input.calls.length, 0);
  } finally { await f.close(); }
});

test('global authenticated action burst limit prevents excess input', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 3; i++) assert.equal((await f.send()).status, 200);
    assert.equal((await f.send()).status, 429);
    assert.equal(f.input.calls.length, 3);
  } finally { await f.close(); }
});

test('browser assets are public, typed and allowlisted; configs and source maps stay private', async () => {
  const f = await fixture();
  try {
    for (const [url, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/styles.css', 'text/css'], ['/emulator-pcsx2.png', 'image/png'], ['/emulator-rpcs3.png', 'image/png'], ['/emulator-mgba.png', 'image/png']] as const) {
      const result = await f.send({ method: 'GET', url, headers: { Authorization: '' } });
      assert.equal(result.status, 200);
      assert.ok(result.headers['content-type']?.startsWith(type!));
      assert.equal(result.text.includes(f.config.token), false);
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.equal(typeof result.headers['content-security-policy'], 'string');
    }
    for (const url of ['/app.js.map', '/server.local.json', '/web/../config/server.local.json'])
      assert.equal((await f.send({ method: 'GET', url })).status, 404);
    const head = await f.send({ method: 'HEAD', url: '/' });
    assert.equal(head.status, 200); assert.equal(head.text, '');
    assert.equal(f.input.calls.length, 0);
  } finally { await f.close(); }
});

test('dispatcher rejects concurrent and pending duplicates without queuing', async () => {
  const input = new FakeInput();
  let finish!: () => void;
  input.operation = () => new Promise(resolve => { finish = () => resolve({ status: 'sent' }); });
  const dispatcher = new Dispatcher(input, profiles());
  const request = action();
  const pending = dispatcher.dispatch(request);
  assert.equal((await dispatcher.dispatch(request)).status, 409);
  assert.equal((await dispatcher.dispatch(action())).status, 409);
  finish();
  assert.equal((await pending).status, 200);
  assert.equal(input.calls.length, 1);
  await dispatcher.close();
});

test('new API controls dispatch validated configured chords', async () => {
  const f = await fixture();
  try {
    for (const id of ['previousSlot', 'pauseResume', 'fastForward']) {
      assert.equal((await f.send({ json: { ...action(), action: id } })).status, 200);
    }
    assert.deepEqual(f.input.calls.map(call => ({ key: call.key, modifiers: call.modifiers })), [
      { key: 'F2', modifiers: ['Shift'] }, { key: 'Space', modifiers: [] }, { key: 'Tab', modifiers: [] },
    ]);
  } finally { await f.close(); }
});

test('dispatcher refuses optional actions absent from the selected profile', async () => {
  const input = new FakeInput();
  const config = profiles();
  delete config.profiles[0]!.actions.pauseResume;
  const dispatcher = new Dispatcher(input, config);
  assert.equal((await dispatcher.dispatch({ ...action(), action: 'pauseResume' })).status, 400);
  assert.equal(input.calls.length, 0);
  await dispatcher.close();
});

test('foreground rejection is recorded; helper failure disables further input', async () => {
  const input = new FakeInput();
  input.operation = async () => { throw new InputRejected('foreground_mismatch'); };
  const dispatcher = new Dispatcher(input, profiles());
  const request = action();
  assert.equal((await dispatcher.dispatch(request)).status, 409);
  assert.equal((await dispatcher.dispatch(request)).status, 409);
  assert.equal(input.calls.length, 1);
  input.operation = async () => { throw new Error('private details'); };
  const result = await dispatcher.dispatch(action());
  assert.equal(result.status, 503);
  assert.equal(JSON.stringify(result).includes('private details'), false);
  assert.equal(dispatcher.available, false);
  assert.equal((await dispatcher.dispatch(action())).status, 503);
  assert.equal(input.calls.length, 2);
});

test('helper deadline closes adapter and never sends twice', async () => {
  const input = new FakeInput();
  input.operation = () => new Promise(() => {});
  const dispatcher = new Dispatcher(input, profiles(), Date.now, 10);
  assert.equal((await dispatcher.dispatch(action())).status, 503);
  assert.equal(input.available, false);
  assert.equal((await dispatcher.dispatch(action())).status, 503);
  assert.equal(input.calls.length, 1);
});

test('deduplication cache is bounded and expires, limiter bounds and expires source buckets', async () => {
  let now = 0;
  const input = new FakeInput();
  const dispatcher = new Dispatcher(input, profiles(), () => now);
  for (let i = 0; i < 512; i++) assert.equal((await dispatcher.dispatch(action())).status, 200);
  assert.equal((await dispatcher.dispatch(action())).status, 429);
  now = 60001;
  assert.equal((await dispatcher.dispatch(action())).status, 200);
  const limiter = new RateLimit(0.5, 1, 2, () => now);
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('a'), false);
  assert.equal(limiter.take('b'), true);
  assert.equal(limiter.take('c'), false);
  now += 60001;
  assert.equal(limiter.take('c'), true);
  await dispatcher.close();
});

test('new emulator icons are served locally without authentication', async () => {
 const f = await fixture();
 try {
  for (const id of ['dolphin', 'duckstation', 'ppsspp']) {
   const result = await f.send({method: 'GET', url: '/emulator-' + id + '.png', headers: { Authorization: '' }});
   assert.equal(result.status, 200); assert.ok(result.headers['content-type']?.startsWith('image/png'));
  }
 } finally { await f.close(); }
});
