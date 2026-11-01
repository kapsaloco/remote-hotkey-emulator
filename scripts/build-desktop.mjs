import { copyFileSync, mkdirSync } from 'node:fs';
const directory = new URL('../dist/desktop/ui/', import.meta.url);
mkdirSync(directory, { recursive: true });
for (const file of ['index.html', 'styles.css'])
  copyFileSync(new URL(`../src/desktop/ui/${file}`, import.meta.url), new URL(file, directory));
const assets = new URL('../dist/assets/', import.meta.url);
mkdirSync(assets, { recursive: true });
copyFileSync(new URL('../assets/icon.ico', import.meta.url), new URL('icon.ico', assets));
copyFileSync(new URL('../assets/icon-1024.png', import.meta.url), new URL('icon.png', assets));
