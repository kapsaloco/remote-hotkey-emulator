import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const home = os.homedir();
const inherited = process.env.CARGO_ENCODED_RUSTFLAGS
  ? process.env.CARGO_ENCODED_RUSTFLAGS.split('\x1f')
  : (process.env.RUSTFLAGS?.trim().split(/\s+/).filter(Boolean) ?? []);
const mappings = [[home, 'build-home'], [process.env.CARGO_HOME || path.join(home, '.cargo'), 'cargo-home'],
  [process.env.RUSTUP_HOME || path.join(home, '.rustup'), 'rust-toolchain'], [root, 'project']];
const flags = [...inherited];
for (const [source, replacement] of mappings) {
  for (const variant of new Set([source, source.replaceAll('\\', '/')]))
    flags.push(`--remap-path-prefix=${variant}=${replacement}`);
}
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'),
  'build', '--no-bundle', ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', shell: false, windowsHide: true,
  env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
