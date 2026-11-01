import { app, BrowserWindow, clipboard, ipcMain, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DesktopController } from './controller';

let window: BrowserWindow | undefined;
let controller: DesktopController | undefined;
let exiting = false;
const page = path.resolve(__dirname, 'ui/index.html');
const pageUrl = pathToFileURL(page).href;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.on('before-quit', event => {
    if (exiting) return;
    event.preventDefault();
    exiting = true;
    void controller?.shutdown().catch(() => {}).finally(() => app.quit());
    if (!controller) app.quit();
  });
  void app.whenReady().then(async () => {
    if (process.platform !== 'win32') throw new Error('The desktop app requires Windows.');
    const directory = app.isPackaged
      ? path.join(process.env.LOCALAPPDATA ?? app.getPath('userData'), 'EmulatorRemote', 'config')
      : path.resolve(__dirname, '../../config');
    controller = new DesktopController(directory, path.resolve(__dirname, '../../config/profiles.example.json'));
    window = new BrowserWindow({ width: 500, height: 780, minWidth: 420, minHeight: 620,
      title: 'Emulator Remote', backgroundColor: '#02040d', autoHideMenuBar: true,
      icon: path.resolve(__dirname, '../assets/icon.ico'),
      webPreferences: { preload: path.resolve(__dirname, 'preload.js'), nodeIntegration: false,
        contextIsolation: true, sandbox: true, devTools: !app.isPackaged } });
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    function handle(channel: string, operation: (...args: unknown[]) => unknown): void {
      ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pageUrl)
          throw new Error('Desktop request rejected.');
        if (exiting) return { ok: false, message: 'Application is closing.' };
        try { return { ok: true, value: await operation(...args) }; }
        catch (failure) { return { ok: false, message: failure instanceof Error ? failure.message : 'Operation failed.' }; }
      });
    }
    handle('remote:state', () => controller!.getState());
    handle('remote:start', () => controller!.start());
    handle('remote:stop', () => controller!.stop());
    handle('remote:password', (password, confirmation) => controller!.setPassword(password, confirmation));
    handle('remote:network', (host, port) => controller!.setNetwork(host, port));
    handle('remote:copy-url', () => {
      const status = controller!.getState().runtime;
      if (status.phase !== 'running' || !status.url) throw new Error('Start the server before copying its address.');
      clipboard.writeText(status.url);
    });
    window.on('closed', () => { window = undefined; app.quit(); });
    await window.loadFile(page);
    console.log('Emulator Remote desktop ready.');
  }).catch(() => { console.error('Desktop startup failed. Check local configuration and the desktop build.'); app.quit(); });
}
