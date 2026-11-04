// Execute the compiled browser script with a small DOM/fetch harness, no desktop input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const html = readFileSync(new URL('../dist/web/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../dist/web/app.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
class Element extends EventTarget {
  value = ''; textContent = ''; hidden = false; disabled = false; dataset = {}; children = []; open = false; returnValue = '';
  emit(type) { this.dispatchEvent(new Event(type, { cancelable: true })); }
  replaceChildren() { this.children = []; }
  append(item) { this.children.push(item); }
  showModal() { this.open = true; }
  close(value) { this.returnValue = value; this.open = false; this.emit('close'); }
}
function harness(storage = new Map(), storageUnavailable = false) {
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const document = new EventTarget();
  document.hidden = false;
  document.getElementById = id => elements.get(id);
  document.createElement = () => new Element();
  const window = new EventTarget();
  const navigator = { onLine: true };
  const requests = [];
  let now = 10000;
  let next = 0;
  const timers = new Map();
  let actionResponse = async () => ({ status: 'sent' });
  let status = 200;
  let loginStatus = 200;
  const profile = { id: 'pcsx2', label: '<img src=x onerror=alert(1)>', actions: Object.fromEntries(
    ['saveState', 'loadState', 'nextSlot', 'previousSlot', 'pauseResume', 'fastForward'].map(id => [id, { label: id, shortcut: 'F1' }])) };
  const fetch = async (url, options) => {
    requests.push({ url, ...options });
    if (url === '/api/login') return { ok: loginStatus === 200, status: loginStatus, json: async () => loginStatus === 200 ? { token: 'B'.repeat(43) } : { code: 'unauthorized' } };
    if (url === '/api/actions') return { ok: status === 200, status, json: () => actionResponse(options) };
    return { ok: true, status: 200, json: async () => url === '/api/profiles' ? { defaultProfileId: 'pcsx2', profiles: [profile] } : { ready: true, inputAvailable: true } };
  };
  runInNewContext(script, { document, window, navigator, fetch, crypto: webcrypto, AbortController,
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, delay) => { timers.set(++next, { fn, due: now + delay }); return next; },
    clearTimeout: id => timers.delete(id), setInterval: () => 0,
    localStorage: {
      getItem: key => { if (storageUnavailable) throw new Error('Storage unavailable'); return storage.get(key) ?? null; },
      setItem: (key, value) => { if (storageUnavailable) throw new Error('Storage unavailable'); storage.set(key, value); },
    },
  });
  const get = id => elements.get(id);
  async function connect(password = 'A'.repeat(43)) { get('token').value = password; get('connect-form').emit('submit'); await flush(); }
  async function tick(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); }
    await flush();
  }
  return { get, connect, tick, document, window, navigator, requests, storage, profile,
    actions: () => requests.filter(request => request.url === '/api/actions'),
    loginRespond: status => { loginStatus = status; },
    respond: (code, body) => { status = code; actionResponse = async () => body; },
    hang: () => { actionResponse = options => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))); },
  };
}

test('connect enables controls, renders profile text, keeps token out of storage and URLs', async () => {
  const h = harness();
  assert.equal(h.get('saveState').disabled, true);
  await h.connect();
  assert.equal(h.get('saveState').disabled, false);
  assert.match(h.get('saveState-detail').textContent, /<img/);
  assert.equal(h.get('token').value, '');
  assert.equal(h.storage.size, 0);
  assert.equal(h.requests.some(request => request.url.includes('AAAA')), false);
  assert.equal(JSON.parse(h.requests[0].body).credential, 'A'.repeat(43));
  assert.equal(h.requests[0].headers.Authorization, undefined);
  assert.equal(h.requests.find(request => request.url === '/api/profiles').headers.Authorization, `Bearer ${'B'.repeat(43)}`);
});

test('chosen password is exchanged once; wrong password and login limiting keep controls disabled', async () => {
  const h = harness(); await h.connect('my test passphrase');
  assert.equal(JSON.parse(h.requests[0].body).credential, 'my test passphrase');
  assert.equal(h.get('token').value, ''); assert.equal(h.storage.size, 0);
  h.get('saveState').emit('click'); await flush();
  assert.equal(h.actions()[0].headers.Authorization, `Bearer ${'B'.repeat(43)}`);
  assert.equal(h.actions()[0].body.includes('my test passphrase'), false);
  for (const status of [401, 429]) {
    const f = harness(); f.loginRespond(status); await f.connect('wrong password');
    assert.equal(f.get('saveState').disabled, true);
    assert.equal(f.get('token').value, '');
    assert.equal(f.requests.length, 1);
    assert.match(f.get('feedback').textContent, status === 401 ? /Password rejected/ : /Too many sign-in attempts/);
  }
});
test('load sends once without a prompt by default and blocks rapid taps', async () => {
  const h = harness(); await h.connect();
  assert.equal(h.get('confirm-load-enabled').checked, false);
  h.get('loadState').emit('click'); h.get('loadState').emit('click'); await flush();
  assert.equal(h.get('load-dialog').open, false);
  assert.equal(h.actions().length, 1);
  assert.equal(JSON.parse(h.actions()[0].body).action, 'loadState');
});

test('load confirmation preference persists across visits and can be turned off', async () => {
  const h = harness();
  h.get('confirm-load-enabled').checked = true; h.get('confirm-load-enabled').emit('change');
  assert.equal(h.actions().length, 0);
  const reopened = harness(h.storage); await reopened.connect();
  assert.equal(reopened.get('confirm-load-enabled').checked, true);
  reopened.get('loadState').emit('click');
  assert.equal(reopened.get('load-dialog').open, true);
  reopened.get('load-dialog').close('cancel');
  reopened.get('confirm-load-enabled').checked = false; reopened.get('confirm-load-enabled').emit('change');
  const disabled = harness(h.storage); await disabled.connect();
  assert.equal(disabled.get('confirm-load-enabled').checked, false);
  disabled.get('loadState').emit('click'); await flush();
  assert.equal(disabled.actions().length, 1);
  assert.equal(disabled.get('load-dialog').open, false);
});

test('unavailable storage keeps confirmation off by default and allows a session preference', async () => {
  const h = harness(new Map(), true); await h.connect();
  assert.equal(h.get('confirm-load-enabled').checked, false);
  h.get('confirm-load-enabled').checked = true; h.get('confirm-load-enabled').emit('change');
  h.get('loadState').emit('click');
  assert.equal(h.get('load-dialog').open, true);
  assert.equal(h.actions().length, 0);
});

test('Load cancel sends nothing when enabled; confirmation sends once; cooldown blocks rapid taps', async () => {
  const h = harness(); await h.connect();
  h.get('confirm-load-enabled').checked = true; h.get('confirm-load-enabled').emit('change');
  h.get('loadState').emit('click');
  assert.equal(h.get('load-dialog').open, true);
  assert.equal(h.actions().length, 0);
  h.get('load-dialog').close('cancel'); await flush();
  assert.equal(h.actions().length, 0);
  h.get('loadState').emit('click'); h.get('load-dialog').close('confirm');
  h.get('saveState').emit('click'); await flush();
  assert.equal(h.actions().length, 1);
  const payload = JSON.parse(h.actions()[0].body);
  assert.equal(payload.action, 'loadState');
  assert.match(payload.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(h.get('saveState').disabled, true);
  await h.tick(310);
  assert.equal(h.get('saveState').disabled, false);
});
test('401 requests reauthentication; 409 rejects; 429 applies cooldown; 503 locks actions', async () => {
  for (const code of [401, 409, 429, 503]) {
    const h = harness(); await h.connect();
    h.respond(code, { code: 'test' }); h.get('saveState').emit('click'); await flush();
    assert.equal(h.actions().length, 1);
    if (code === 401) assert.equal(h.get('connect-form').hidden, false);
    if (code === 409) assert.match(h.get('feedback').textContent, /rejected/);
    if (code === 429) { await h.tick(310); assert.equal(h.get('saveState').disabled, true); await h.tick(2000); assert.equal(h.get('saveState').disabled, false); }
    if (code === 503) { assert.equal(h.get('uncertain').hidden, false); await h.tick(5000); assert.equal(h.get('saveState').disabled, true); }
  }
});
test('lost response shows unknown outcome and never automatically retries', async () => {
  const h = harness(); await h.connect(); h.hang();
  h.get('saveState').emit('click'); await flush();
  await h.tick(3001);
  assert.equal(h.get('uncertain').hidden, false);
  assert.match(h.get('feedback').textContent, /Outcome unknown/);
  await h.tick(60000);
  assert.equal(h.actions().length, 1);
  assert.equal(h.get('saveState').disabled, true);
});
test('offline and background prevent input; returning online only checks health', async () => {
  const h = harness(); await h.connect();
  h.get('confirm-load-enabled').checked = true;
  h.get('loadState').emit('click');
  h.document.hidden = true; h.document.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(h.get('load-dialog').open, false);
  h.get('saveState').emit('click');
  assert.equal(h.actions().length, 0);
  h.document.hidden = false; h.document.dispatchEvent(new Event('visibilitychange')); await flush();
  h.navigator.onLine = false; h.window.dispatchEvent(new Event('offline'));
  h.get('nextSlot').emit('click'); assert.equal(h.actions().length, 0);
  h.navigator.onLine = true; h.window.dispatchEvent(new Event('online')); await flush();
  assert.equal(h.actions().length, 0);
  assert.equal(h.get('nextSlot').disabled, false);
});

test('backgrounding during a pending action locks unknown outcome until acknowledged', async () => {
  const h = harness(); await h.connect(); h.hang();
  h.get('saveState').emit('click'); await flush();
  h.document.hidden = true; h.document.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(h.get('uncertain').hidden, false);
  h.document.hidden = false; h.document.dispatchEvent(new Event('visibilitychange')); await flush();
  await h.tick(1000);
  assert.equal(h.get('saveState').disabled, true);
  assert.equal(h.actions().length, 1);
  h.get('acknowledge').emit('click'); await flush();
  assert.equal(h.get('saveState').disabled, false);
  assert.equal(h.actions().length, 1);
});

test('slot arrows and playback buttons dispatch their configured action once', async () => {
  const h = harness(); await h.connect();
  for (const id of ['previousSlot', 'nextSlot', 'pauseResume', 'fastForward']) {
    assert.equal(h.get(id).disabled, false);
    const before = h.actions().length;
    h.get(id).emit('click'); await flush();
    assert.equal(h.actions().length, before + 1);
    assert.equal(JSON.parse(h.actions().at(-1).body).action, id);
    await h.tick(310);
  }
});

test('legacy profiles keep working and unconfigured controls stay disabled', async () => {
  const h = harness();
  for (const id of ['previousSlot', 'pauseResume', 'fastForward']) delete h.profile.actions[id];
  await h.connect();
  assert.equal(h.get('saveState').disabled, false);
  for (const id of ['previousSlot', 'pauseResume', 'fastForward']) {
    assert.equal(h.get(id).disabled, true);
    h.get(id).emit('click');
  }
  await flush(); assert.equal(h.actions().length, 0);
});
