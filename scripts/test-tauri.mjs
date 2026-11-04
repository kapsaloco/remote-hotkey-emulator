import { spawnSync } from 'node:child_process';
const result = spawnSync('cargo', ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml',
  '--lib', '--test', 'backend', '--features', 'custom-protocol'], {
  stdio: 'inherit', shell: false, windowsHide: true,
  env: { ...process.env, EMULATOR_REMOTE_TEST_NODE: process.execPath },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
