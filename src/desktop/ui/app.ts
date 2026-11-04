interface DesktopViewState {
  runtime: { phase: string; url?: string; inputAvailable: boolean; error?: string };
  host: string; port: number; passwordEnabled: boolean; addresses: string[];
}
type DesktopReply = { ok: true; value?: DesktopViewState } | { ok: false; message: string; unavailable?: boolean };
interface DesktopBridge {
  getState(): Promise<DesktopReply>;
  start(): Promise<DesktopReply>;
  stop(): Promise<DesktopReply>;
  setPassword(password: string, confirmation: string): Promise<DesktopReply>;
  setNetwork(host: string, port: number): Promise<DesktopReply>;
  copyUrl(): Promise<DesktopReply>;
}
interface Window { remoteDesktop: DesktopBridge }
function field<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
let desktopBusy = false;
let lastState: DesktopViewState | undefined;
let passwordSaved = false;
let controllerUnavailable = false;
let stateVersion = 0;
const bridge = window.remoteDesktop;
function message(text: string, error = false): void {
  field('message').textContent = text; field('message').dataset.error = String(error);
}
function unavailable(text: string): void {
  controllerUnavailable = true;
  lastState = undefined;
  for (const id of ['start', 'stop', 'copy', 'save-password', 'save-network', 'password', 'toggle-password', 'host', 'port'])
    field<HTMLInputElement>(id).disabled = true;
  field('status').textContent = 'Server unavailable';
  field('status-dot').dataset.phase = 'stopped';
  field('input-status').textContent = text;
  field('password-status').textContent = 'Unavailable';
  field('url').textContent = 'Not running';
  message(text, true);
}
function paint(state: DesktopViewState): void {
  if (controllerUnavailable) message('Ready.');
  controllerUnavailable = false;
  lastState = state;
  const running = state.runtime.phase === 'running';
  const changing = desktopBusy || ['starting', 'stopping'].includes(state.runtime.phase);
  field('status').textContent = ({ stopped: 'Server stopped', starting: 'Starting server…', running: 'Server running', stopping: 'Stopping server…', error: 'Server needs attention' } as Record<string, string>)[state.runtime.phase] ?? 'Server stopped';
  field('status-dot').dataset.phase = state.runtime.phase;
  field('input-status').textContent = state.runtime.error ?? (running
    ? state.runtime.inputAvailable ? 'Ready. Keep your configured emulator focused while using your phone.' : 'Input helper unavailable. Stop and restart the server.'
    : 'Start the server to connect your phone.');
  field('url').textContent = state.runtime.url ?? 'Not running';
  field<HTMLButtonElement>('start').disabled = changing || running || !state.passwordEnabled;
  field<HTMLButtonElement>('stop').disabled = changing || !running;
  field<HTMLButtonElement>('copy').disabled = changing || !running;
  field<HTMLButtonElement>('save-password').disabled = changing;
  field<HTMLButtonElement>('save-network').disabled = changing;
  field<HTMLInputElement>('password').disabled = changing;
  field<HTMLButtonElement>('toggle-password').disabled = changing;
  field<HTMLSelectElement>('host').disabled = changing;
  field<HTMLInputElement>('port').disabled = changing;
  field('password-status').textContent = passwordSaved ? 'Password saved. Use it to connect from your phone.' : state.passwordEnabled ? 'Password is set. Use it to connect from your phone.' : 'Choose a password before starting your server.';
  field('password-status').dataset.saved = String(passwordSaved);
  field('save-password').textContent = state.passwordEnabled ? 'Change password' : 'Set password';
  const host = field<HTMLSelectElement>('host');
  const addresses = state.addresses.includes(state.host) ? state.addresses : [...state.addresses, state.host];
  const signature = addresses.join(',') + ':' + state.host + ':' + state.port;
  if (host.dataset.config !== signature) {
    host.replaceChildren();
    for (const address of addresses) {
      const option = document.createElement('option'); option.value = address;
      option.textContent = address === '127.0.0.1' ? `${address} — this PC only` : `${address}${state.addresses.includes(address) ? '' : ' — no longer available'}`;
      host.append(option);
    }
    host.value = state.host; field<HTMLInputElement>('port').value = String(state.port); host.dataset.config = signature;
  }
}
async function perform(operation: () => Promise<DesktopReply>, success: string): Promise<boolean> {
  if (desktopBusy || controllerUnavailable) return false;
  stateVersion++;
  desktopBusy = true; if (lastState) paint(lastState);
  try {
    const result = await operation();
    if (!result.ok) { if (result.unavailable) unavailable(result.message); else message(result.message, true); return false; }
    if (result.value) paint(result.value);
    message(success);
    return true;
  } catch { message('Could not reach the desktop controller. Restart the application.', true); return false; }
  finally { desktopBusy = false; if (lastState) paint(lastState); }
}
field('start').addEventListener('click', () => { void perform(() => bridge.start(), 'Server started. Open its address on your phone.'); });
field('stop').addEventListener('click', () => { void perform(() => bridge.stop(), 'Server stopped.'); });
field('copy').addEventListener('click', () => { void perform(() => bridge.copyUrl(), 'Phone address copied.'); });
field('password-form').addEventListener('submit', event => {
  event.preventDefault();
  const value = field<HTMLInputElement>('password').value;
  void perform(() => bridge.setPassword(value, value), 'Password saved. Start the server when you are ready.').then(saved => {
    if (saved) { passwordSaved = true; if (lastState) paint(lastState); }
  });
});
field('toggle-password').addEventListener('click', () => {
  const input = field<HTMLInputElement>('password');
  const visible = input.type === 'password';
  input.type = visible ? 'text' : 'password';
  const button = field<HTMLButtonElement>('toggle-password');
  button.textContent = visible ? 'Hide' : 'Show';
  button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
  button.setAttribute('aria-pressed', String(visible));
});
field('password').addEventListener('input', () => {
  passwordSaved = false; if (lastState) paint(lastState);
});
field('network-form').addEventListener('submit', event => {
  event.preventDefault();
  void perform(() => bridge.setNetwork(field<HTMLSelectElement>('host').value, Number(field<HTMLInputElement>('port').value)), 'Network settings saved. Start the server to use them.');
});
async function refreshState(): Promise<void> {
  if (desktopBusy) return;
  const version = stateVersion;
  try {
    const result = await bridge.getState();
    if (desktopBusy || version !== stateVersion) return;
    if (result.ok && result.value) { paint(result.value); if (field('message').textContent === 'Loading…') message('Ready.'); }
    else if (!result.ok) { if (result.unavailable) unavailable(result.message); else message(result.message, true); }
  } catch { unavailable('Desktop controller unavailable.'); }
}
void refreshState(); setInterval(() => { void refreshState(); }, 1500);
