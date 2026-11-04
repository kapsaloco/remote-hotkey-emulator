// Native command bridge for the Tauri desktop frontend.
interface Window {
  __TAURI__: { core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> } };
}
(() => {
  async function call(command: string, args?: Record<string, unknown>): Promise<DesktopReply> {
    try {
      const value = await window.__TAURI__.core.invoke<DesktopViewState | undefined>(command, args);
      return value === undefined || value === null ? { ok: true } : { ok: true, value };
    } catch (error) {
      if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
        return { ok: false, message: error.message, unavailable: 'unavailable' in error && error.unavailable === true };
      }
      return { ok: false, message: 'Desktop controller unavailable.', unavailable: true };
    }
  }
  window.remoteDesktop = {
    getState: () => call('remote_state'),
    start: () => call('remote_start'),
    stop: () => call('remote_stop'),
    setPassword: (password, confirmation) => call('remote_password', { password, confirmation }),
    setNetwork: (host, port) => call('remote_network', { host, port }),
    copyUrl: () => call('remote_copy_url'),
  };
})();
