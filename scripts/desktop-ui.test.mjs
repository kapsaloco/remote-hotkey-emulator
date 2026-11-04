import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = file => readFileSync(new URL(`../dist/tauri/${file}`, import.meta.url), 'utf8');
const html = source('index.html');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function harness(invoke) {
  class Element extends EventTarget {
    textContent = ''; value = ''; disabled = false; dataset = {}; children = [];
    replaceChildren() { this.children = []; }
    append(child) { this.children.push(child); }
    setAttribute() {}
  }
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const window = { __TAURI__: { core: { invoke } } };
  let refresh;
  const context = {
    window,
    document: { getElementById: id => elements.get(id), createElement: () => new Element() },
    setInterval: callback => { refresh = callback; },
  };
  runInNewContext(source('tauri-bridge.js'), context);
  const load = () => runInNewContext(source('app.js'), context);
  return { bridge: window.remoteDesktop, get: id => elements.get(id), load, refresh: () => refresh() };
}

test('Tauri bridge routes commands and arguments without retrying', async () => {
  const calls = [];
  const h = harness(async (command, args) => { calls.push({ command, args }); return null; });
  for (const result of [await h.bridge.getState(), await h.bridge.start(), await h.bridge.stop(),
    await h.bridge.setPassword('secret', 'secret'), await h.bridge.setNetwork('192.168.1.2', 3000), await h.bridge.copyUrl()]) {
    assert.equal(result.ok, true);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { command: 'remote_state' }, { command: 'remote_start' }, { command: 'remote_stop' },
    { command: 'remote_password', args: { password: 'secret', confirmation: 'secret' } },
    { command: 'remote_network', args: { host: '192.168.1.2', port: 3000 } },
    { command: 'remote_copy_url' },
  ]);
});

test('unavailable backend disables controls and cannot report a successful action', async () => {
  const calls = [];
  const h = harness(async command => {
    calls.push(command);
    throw { message: 'The server is not available in this build yet.', unavailable: true };
  });
  h.load();
  await flush();
  for (const id of ['start', 'stop', 'copy', 'save-password', 'save-network', 'password', 'toggle-password', 'host', 'port'])
    assert.equal(h.get(id).disabled, true, id);
  assert.match(h.get('message').textContent, /not available/);
  h.get('start').dispatchEvent(new Event('click'));
  await flush();
  assert.deepEqual(calls, ['remote_state']);
  assert.equal(h.get('status').textContent, 'Server unavailable');
});

test('unexpected IPC rejection is handled and normal controller replies can recover the UI', async () => {
  let available = false;
  const state = { runtime: { phase: 'stopped', inputAvailable: false }, host: '127.0.0.1', port: 3000,
    passwordEnabled: true, addresses: ['127.0.0.1'] };
  const h = harness(async () => { if (!available) throw 'IPC transport failed'; return state; });
  h.load();
  await flush();
  assert.equal(h.get('start').disabled, true);
  available = true;
  h.refresh();
  await flush();
  assert.equal(h.get('start').disabled, false);
  assert.equal(h.get('save-password').disabled, false);
  assert.equal(h.get('host').disabled, false);
  assert.equal(h.get('message').textContent, 'Ready.');
});

const view = (phase = 'stopped', passwordEnabled = false) => ({ runtime: { phase, inputAvailable: phase === 'running',
  ...(phase === 'running' ? { url: 'http://127.0.0.1:3000' } : {}) }, host: '127.0.0.1', port: 3000,
  passwordEnabled, addresses: ['127.0.0.1'] });

test('desktop password, server, clipboard and network forms update from controller replies', async () => {
  let state = view(); const calls = [];
  const h = harness(async (command,args) => {
    calls.push({command,args});
    if (command === 'remote_password') state = view('stopped',true);
    if (command === 'remote_start') state = view('running',true);
    if (command === 'remote_stop') state = view('stopped',true);
    if (command === 'remote_network') state = { ...view('stopped',true), host:args.host, port:args.port };
    return command === 'remote_copy_url' ? null : state;
  });
  h.load(); await flush(); assert.equal(h.get('start').disabled,true);
  h.get('password').value = 'test-password'; h.get('password-form').dispatchEvent(new Event('submit',{cancelable:true})); await flush();
  assert.equal(h.get('start').disabled,false); assert.equal(h.get('password-status').dataset.saved,'true');
  h.get('start').dispatchEvent(new Event('click')); await flush();
  assert.equal(h.get('stop').disabled,false); assert.equal(h.get('copy').disabled,false); assert.equal(h.get('url').textContent,'http://127.0.0.1:3000');
  h.get('copy').dispatchEvent(new Event('click')); await flush(); assert.equal(h.get('message').textContent,'Phone address copied.');
  h.get('host').value = '127.0.0.1'; h.get('port').value = '3001'; h.get('network-form').dispatchEvent(new Event('submit',{cancelable:true})); await flush();
  assert.equal(h.get('copy').disabled,true); assert.equal(h.get('port').value,'3001');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(c=>c.command!=='remote_state'))),[
    {command:'remote_password',args:{password:'test-password',confirmation:'test-password'}}, {command:'remote_start'},
    {command:'remote_copy_url'}, {command:'remote_network',args:{host:'127.0.0.1',port:3001}},
  ]);
});

test('a pending operation disables controls and duplicate clicks do not invoke it twice', async () => {
  let complete; let starts = 0;
  const h = harness(async command => {
    if (command === 'remote_start') { starts++; return new Promise(resolve=>{complete=resolve;}); }
    return view('stopped',true);
  });
  h.load(); await flush(); h.get('start').dispatchEvent(new Event('click'));
  assert.equal(h.get('host').disabled,true); assert.equal(h.get('save-password').disabled,true);
  h.get('start').dispatchEvent(new Event('click')); assert.equal(starts,1);
  complete(view('running',true)); await flush(); assert.equal(h.get('stop').disabled,false);
});

test('a stale state poll cannot overwrite a more recent command result', async () => {
  let calls = 0; let oldPoll;
  const h = harness(async command => {
    if (command === 'remote_start') return view('running',true);
    if (++calls === 1) return view('stopped',true);
    return new Promise(resolve=>{oldPoll=resolve;});
  });
  h.load(); await flush(); h.refresh(); h.get('start').dispatchEvent(new Event('click')); await flush();
  oldPoll(view('stopped',true)); await flush();
  assert.equal(h.get('status').textContent,'Server running'); assert.equal(h.get('stop').disabled,false);
});

test('rejected password is shown as an error and never enables server start', async () => {
  const h = harness(async command => {
    if (command === 'remote_password') throw {message:'Choose a longer password.',unavailable:false};
    return view();
  });
  h.load(); await flush(); h.get('password').value = 'short';
  h.get('password-form').dispatchEvent(new Event('submit',{cancelable:true})); await flush();
  assert.equal(h.get('start').disabled,true); assert.notEqual(h.get('password-status').dataset.saved,'true');
  assert.equal(h.get('message').textContent,'Choose a longer password.'); assert.equal(h.get('message').dataset.error,'true');
});
