import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// Package only the desktop frontend, never Node code, tests, configuration or credentials.
const output = new URL('../dist/tauri/', import.meta.url);
mkdirSync(new URL('assets/', output), { recursive: true });
for (const file of ['app.js', 'tauri-bridge.js'])
  copyFileSync(new URL(`../dist/desktop/ui/${file}`, import.meta.url), new URL(file, output));
copyFileSync(new URL('../src/desktop/ui/styles.css', import.meta.url), new URL('styles.css', output));
const html = readFileSync(new URL('../src/desktop/ui/index.html', import.meta.url), 'utf8')
  .replace(/  <meta http-equiv="Content-Security-Policy"[^>]+>\r?\n/, '') // Tauri supplies its CSP, including IPC.
  .replace('../../assets/icon.png', 'assets/icon.png')
  .replace('<script src="app.js" defer></script>', '<script src="tauri-bridge.js" defer></script>\n  <script src="app.js" defer></script>');
writeFileSync(new URL('index.html', output), html);
copyFileSync(new URL('../assets/icon-1024.png', import.meta.url), new URL('assets/icon.png', output));
