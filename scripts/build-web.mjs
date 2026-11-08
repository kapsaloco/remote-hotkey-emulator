import { copyFileSync, mkdirSync } from 'node:fs';
const destination = new URL('../dist/web/', import.meta.url);
mkdirSync(destination, { recursive: true });
for (const file of ['index.html', 'styles.css']) {
  copyFileSync(new URL(`../src/web/${file}`, import.meta.url), new URL(file, destination));
}
copyFileSync(new URL('../assets/icon-1024.png', import.meta.url), new URL('icon.png', destination));

for (const name of ['pcsx2', 'rpcs3', 'mgba', 'dolphin', 'duckstation', 'ppsspp']) copyFileSync(new URL('../assets/emulators/' + name + '.png', import.meta.url), new URL('emulator-' + name + '.png', destination));
