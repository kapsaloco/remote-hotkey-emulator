// Run the real phone client against a Rust test server with a recording input
// adapter. This is a DOM simulation, not a physical phone or keyboard test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const origin = process.argv[2];
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
const html = readFileSync(new URL('../dist/web/index.html', import.meta.url), 'utf8');
class Element extends EventTarget {
  value = ''; textContent = ''; disabled = false; hidden = false; dataset = {}; children = []; open = false; returnValue = '';
  emit(type) { this.dispatchEvent(new Event(type, { cancelable: true })); }
  replaceChildren() { this.children = []; }
  append(child) { this.children.push(child); }
  showModal() { this.open = true; }
  close(value) { this.returnValue = value; this.open = false; this.emit('close'); }
}
const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([,id]) => [id, new Element()]));
const get = id => elements.get(id);
const document = Object.assign(new EventTarget(), { hidden: false, getElementById: get, createElement: () => new Element() });
const storage = new Map();
const requests = [];
const transport = async (route, options) => {
  const request = { route }; requests.push(request);
  try {
    const response = await fetch(new URL(route, origin), { ...options, headers: { ...options.headers, Origin: origin } });
    request.status = response.status; return response;
  } catch (error) { request.error = error.name; throw error; }
};
const waitFor = async predicate => {
  const deadline = Date.now() + 8000;
  while (!predicate()) { assert.ok(Date.now() < deadline, `Phone client did not reach the expected state: ${get('feedback').textContent}; ${JSON.stringify(requests)}`); await delay(10); }
};
runInNewContext(readFileSync(new URL('../dist/web/app.js', import.meta.url), 'utf8'), {
  document, window: new EventTarget(), navigator: { onLine: true }, crypto: webcrypto,
  fetch: transport, AbortController, Date, setTimeout, clearTimeout, setInterval: () => 0,
  localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key,value) => storage.set(key,value) },
});
assert.equal(get('saveState').disabled, true);
get('token').value = 'test-password'; get('connect-form').emit('submit');
await waitFor(() => !get('saveState').disabled);
assert.equal(get('profile').children.length, 2);
assert.equal(get('token').value, ''); assert.equal(storage.size, 0);
assert.equal(get('confirm-load-enabled').checked, false);
get('confirm-load-enabled').checked = true; get('confirm-load-enabled').emit('change');
get('loadState').emit('click'); assert.equal(get('load-dialog').open, true);
get('load-dialog').close('cancel'); assert.equal(requests.filter(r => r.route === '/api/actions').length, 0);
get('saveState').emit('click');
await waitFor(() => get('feedback').textContent.startsWith('Shortcut sent.'));
await delay(350);
get('profile').value = 'another-emulator'; get('profile').emit('change');
assert.equal(get('pauseResume').disabled, true);
assert.match(get('saveState-detail').textContent, /F4/);
get('saveState').emit('click');
await waitFor(() => requests.filter(r => r.route === '/api/actions').length === 2 && get('feedback').textContent.startsWith('Shortcut sent.'));
assert.deepEqual([...storage.keys()], ['emulatorRemote.confirmLoad', 'emulatorRemote.profile']);
assert.equal(storage.get('emulatorRemote.confirmLoad'), 'true');
assert.equal(storage.get('emulatorRemote.profile'), 'another-emulator');
get('disconnect').emit('click');
await waitFor(() => requests.some(r => r.route === '/api/logout'));
assert.equal(get('saveState').disabled, true);
assert.equal(requests.filter(r => r.route === '/api/login').length, 1);
assert.equal(requests.filter(r => r.route === '/api/actions').length, 2);
console.log('Phone client: sign-in, profiles, canceled load, configured actions, preference and logout passed.');
