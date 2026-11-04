const requiredIds = ['saveState', 'loadState', 'nextSlot'] as const;
const optionalIds = ['previousSlot', 'pauseResume', 'fastForward'] as const;
const ids = [...requiredIds, ...optionalIds] as const;
type ActionId = typeof ids[number];
interface RemoteProfile { id: string; label: string; actions: Partial<Record<ActionId, { label: string; shortcut: string }>> }
function element<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
const form = element<HTMLFormElement>('connect-form');
const tokenField = element<HTMLInputElement>('token');
const connectButton = element<HTMLButtonElement>('connect');
const disconnectButton = element<HTMLButtonElement>('disconnect');
const profileSelect = element<HTMLSelectElement>('profile');
const profileArea = element<HTMLDivElement>('profile-area');
const connection = element<HTMLSpanElement>('connection');
const feedback = element<HTMLParagraphElement>('feedback');
const uncertainPanel = element<HTMLDivElement>('uncertain');
const dialog = element<HTMLDialogElement>('load-dialog');
const confirmLoad = element<HTMLInputElement>('confirm-load-enabled');
try { confirmLoad.checked = localStorage.getItem('emulatorRemote.confirmLoad') === 'true'; }
catch { confirmLoad.checked = false; }
confirmLoad.addEventListener('change', () => {
  try { localStorage.setItem('emulatorRemote.confirmLoad', String(confirmLoad.checked)); } catch { /* Optional preference only. */ }
});
let token = '';
let profiles: RemoteProfile[] = [];
let ready = false;
let busy = false;
let checking = false;
let connecting = false;
let uncertain = false;
let generation = 0;
let cooldownUntil = 0;
const controllers = new Set<AbortController>();

class ApiError extends Error { constructor(readonly status: number, readonly code: string) { super('API request failed'); } }
function tell(message: string): void { feedback.textContent = message; }
function connected(label: string, state: string): void { connection.textContent = label; connection.dataset.state = state; }
function selected(): RemoteProfile | undefined { return profiles.find(profile => profile.id === profileSelect.value); }
function usable(): boolean { return ready && !!token && !!selected() && navigator.onLine && !document.hidden && !busy && !connecting && !uncertain && Date.now() >= cooldownUntil; }
function render(): void {
  for (const id of ids) {
    const profile = selected();
    const chord = profile?.actions[id];
    element<HTMLButtonElement>(id).disabled = !usable() || !chord;
    element(`${id}-detail`).textContent = chord ? `${profile!.label} · ${chord.shortcut}` : profile ? 'Not configured' : 'Connect to see shortcut';
  }
  profileSelect.disabled = busy || checking || connecting || !profiles.length || uncertain;
  uncertainPanel.hidden = !uncertain;
  connectButton.disabled = connecting;
}
async function api(route: string, payload?: unknown): Promise<any> {
  const controller = new AbortController();
  controllers.add(controller);
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(route, { method: payload === undefined ? 'GET' : 'POST',
      headers: { ...(token && route !== '/api/login' ? { Authorization: `Bearer ${token}` } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      cache: 'no-store', credentials: 'omit', signal: controller.signal, redirect: 'error' });
    const result = await response.json();
    if (!response.ok) throw new ApiError(response.status, typeof result.code === 'string' ? result.code : 'unknown');
    return result;
  } finally { clearTimeout(timer); controllers.delete(controller); }
}
function abortRequests(): void { for (const controller of controllers) controller.abort(); }
function expireToken(): void {
  ready = false; token = ''; tokenField.value = ''; form.hidden = false; disconnectButton.hidden = true;
  connected('Authentication needed', 'error');
}
function validProfiles(value: any): value is { defaultProfileId: string; profiles: RemoteProfile[] } {
  return value && typeof value.defaultProfileId === 'string' && Array.isArray(value.profiles) && value.profiles.length > 0 && value.profiles.length <= 20 &&
    value.profiles.every((profile: any) => profile && typeof profile.id === 'string' && typeof profile.label === 'string' && profile.actions &&
      requiredIds.every(id => typeof profile.actions[id]?.shortcut === 'string' && typeof profile.actions[id]?.label === 'string') &&
      optionalIds.every(id => profile.actions[id] === undefined || (typeof profile.actions[id]?.shortcut === 'string' && typeof profile.actions[id]?.label === 'string')));
}
async function checkHealth(): Promise<void> {
  if (!token || checking || busy || connecting || document.hidden || !navigator.onLine) return;
  checking = true;
  const version = generation;
  try {
    const health = await api('/api/health');
    if (version !== generation) return;
    ready = health.ready === true && health.inputAvailable === true;
    connected(ready ? 'Connected to your PC' : 'PC input unavailable', ready ? 'online' : 'error');
  } catch (error) {
    if (version !== generation) return;
    ready = false;
    if (error instanceof ApiError && error.status === 401) { expireToken(); tell('Session expired. Sign in again with your password.'); }
    else if (error instanceof ApiError && error.status === 429) connected('Please wait · rate limited', 'error');
    else connected('Connection unavailable', 'offline');
  } finally { checking = false; render(); }
}
form.addEventListener('submit', event => {
  event.preventDefault();
  if (connecting || busy) return;
  const candidate = tokenField.value;
  if (candidate.length < 1 || candidate.length > 128) { tell('Enter your password (or your existing access token).'); return; }
  void connect(candidate);
});
async function connect(candidate: string): Promise<void> {
  const version = ++generation;
  abortRequests();
  token = ''; tokenField.value = ''; ready = false; connecting = true;
  connected('Connecting…', 'offline'); render();
  try {
    const session = await api('/api/login', { credential: candidate });
    if (version !== generation) return;
    if (typeof session.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(session.token)) throw new Error('Invalid session');
    token = session.token;
    const result = await api('/api/profiles');
    if (version !== generation) return;
    if (!validProfiles(result)) throw new Error('Invalid profiles');
    profiles = result.profiles;
    profileSelect.replaceChildren();
    for (const profile of profiles) {
      const option = document.createElement('option'); option.value = profile.id; option.textContent = profile.label; profileSelect.append(option);
    }
    let stored: string | null = null;
    try { stored = localStorage.getItem('emulatorRemote.profile'); } catch { /* Storage may be unavailable. */ }
    profileSelect.value = profiles.some(profile => profile.id === stored) ? stored! : result.defaultProfileId;
    if (!selected()) profileSelect.value = profiles[0]!.id;
    profileArea.hidden = false; form.hidden = true; disconnectButton.hidden = false;
    tell('Ready to connect. Keep the emulator focused on your PC.');
  } catch (error) {
    if (version !== generation) return;
    expireToken();
    tell(error instanceof ApiError && error.status === 401 ? 'Password rejected. Check your password and try again.' :
      error instanceof ApiError && error.status === 429 ? 'Too many sign-in attempts. Wait a minute before trying again.' : 'Could not connect. Check the server and Wi-Fi.');
  } finally {
    connecting = false; render();
    if (version === generation && token) await checkHealth();
  }
}
profileSelect.addEventListener('change', () => {
  try { localStorage.setItem('emulatorRemote.profile', profileSelect.value); } catch { /* Optional preference only. */ }
  render();
});
disconnectButton.addEventListener('click', () => {
  generation++; abortRequests();
  if (token) void api('/api/logout', {}).catch(() => {});
  expireToken(); profiles = []; profileArea.hidden = true;
  if (dialog.open) dialog.close('cancel');
  connected('Disconnected', 'offline'); tell('Disconnected. Enter your password to reconnect.'); render();
});
function uuid(): string {
  // randomUUID is unavailable on some HTTP LAN origins; getRandomValues works there.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function sendAction(id: ActionId): Promise<void> {
  const profile = selected();
  if (!usable() || !profile?.actions[id]) return;
  const version = generation;
  busy = true; render(); tell('Sending shortcut…');
  try {
    const result = await api('/api/actions', { requestId: uuid(), profileId: profile.id, action: id });
    if (version !== generation) { uncertain = true; tell('Outcome unknown—check the emulator before trying again.'); return; }
    if (result.status !== 'sent') throw new Error('Unexpected action response');
    tell('Shortcut sent. Check the emulator for the result.');
  } catch (error) {
    // A disconnect/background event can abort the response after input occurred.
    if (error instanceof ApiError && error.status === 401) { expireToken(); tell('Session expired. Sign in again with your password.'); }
    else if (error instanceof ApiError && error.status === 409) tell('Shortcut rejected. Focus the emulator, release held keys, and wait for any current action.');
    else if (error instanceof ApiError && error.status === 429) { cooldownUntil = Date.now() + 2200; tell('Too many taps. Wait a moment before trying again.'); }
    else if (error instanceof ApiError && [400, 403, 404, 413, 415].includes(error.status)) { ready = false; tell('Request rejected. Reconnect and check the server configuration.'); }
    else { uncertain = true; ready = false; tell('Outcome unknown—check the emulator before trying again.'); }
    if (error instanceof ApiError && error.status === 503) connected('PC input unavailable · restart required', 'error');
  } finally {
    busy = false; cooldownUntil = Math.max(cooldownUntil, Date.now() + 300); render();
    setTimeout(render, Math.max(0, cooldownUntil - Date.now()) + 10);
  }
}
for (const id of ids) if (id !== 'loadState') element(id).addEventListener('click', () => { void sendAction(id); });
element('loadState').addEventListener('click', () => {
  if (!usable()) return;
  if (confirmLoad.checked) { dialog.returnValue = 'cancel'; dialog.showModal(); }
  else void sendAction('loadState');
});
dialog.addEventListener('close', () => { if (dialog.returnValue === 'confirm') void sendAction('loadState'); });
element('acknowledge').addEventListener('click', () => { uncertain = false; tell('Emulator checked. Checking the connection…'); render(); void checkHealth(); });
function suspend(): void {
  generation++; ready = false; abortRequests();
  if (busy) { uncertain = true; tell('Outcome unknown—check the emulator before trying again.'); }
  if (dialog.open) dialog.close('cancel');
  connected(navigator.onLine ? 'Checking connection…' : 'Offline', 'offline'); render();
}
window.addEventListener('offline', suspend);
window.addEventListener('online', () => { void checkHealth(); });
document.addEventListener('visibilitychange', () => { suspend(); if (!document.hidden) void checkHealth(); });
window.addEventListener('pagehide', suspend);
window.addEventListener('pageshow', () => { void checkHealth(); });
setInterval(() => { void checkHealth(); }, 10000);
render();
