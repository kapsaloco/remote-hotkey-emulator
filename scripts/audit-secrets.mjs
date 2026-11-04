// Project/distribution hygiene check. Findings identify locations, never values.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const execute = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
};
const provider = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b|\bAIza[A-Za-z0-9_-]{30,}\b|\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{30,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b/;
const credentialUrl = /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/:]+:[^\s@]+@/;
const homes = [os.homedir(), os.homedir().replaceAll('\\', '/')];
const values = [];
for (const directory of ['config', '.tauri-dev-data/config', 'release/EmulatorRemote-data/config']) {
  const file = path.join(root, directory, 'server.local.json');
  if (existsSync(file)) {
    const config = JSON.parse(readFileSync(file, 'utf8'));
    for (const value of [config.token, config.password?.hash]) if (typeof value === 'string' && value.length >= 24) values.push(value);
  }
}
const findings = [];
function inspect(label, bytes, machinePaths = true) {
  const text = bytes.toString('utf8');
  if (provider.test(text)) findings.push({ file: label, kind: 'credential-pattern' });
  if (credentialUrl.test(text)) findings.push({ file: label, kind: 'credential-url' });
  if (values.some(value => bytes.includes(Buffer.from(value)))) findings.push({ file: label, kind: 'local-credential-value' });
  if (machinePaths && homes.some(home => text.toLowerCase().includes(home.toLowerCase()) || bytes.includes(Buffer.from(home, 'utf16le'))))
    findings.push({ file: label, kind: 'local-home-path' });
}
const listed = execute('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
if (listed.status !== 0) throw new Error('Cannot list project files for audit');
let scanned = 0;
for (const file of new Set(listed.stdout.split('\0').filter(Boolean))) {
  const absolute = path.join(root, file);
  if (!existsSync(absolute) || !statSync(absolute).isFile() || /\.(png|ico)$/i.test(file)) continue;
  inspect(file, readFileSync(absolute)); scanned++;
}
if (process.argv.includes('--history')) {
  const revisions = execute('git', ['rev-list', '--all']);
  if (revisions.status !== 0) throw new Error('Cannot enumerate Git history');
  const pattern = '-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(proj-|svcacct-)?[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}';
  const commits = revisions.stdout.trim().split('\n').filter(Boolean);
  for (const commit of commits) {
    const result = execute('git', ['grep', '-I', '-l', '-E', '-e', pattern, commit, '--']);
    if (result.status === 0) for (const file of result.stdout.trim().split('\n')) findings.push({ file, kind: 'historical-credential-pattern' });
    else if (result.status !== 1) throw new Error('Git history audit failed');
  }
  console.log(`Checked ${commits.length} commits for strong credential patterns.`);
}
if (!process.argv.includes('--source-only')) {
  const {version} = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Invalid release version');
  const stem = `release/EmulatorRemote-${version}-tauri-portable-x64`;
  for (const file of [`${stem}.exe`, `${stem}/EmulatorRemote.exe`, `${stem}/THIRD-PARTY-NOTICES.txt`, `${stem}/BUILD-INFO.json`, `${stem}-build.json`])
    if (existsSync(path.join(root, file))) inspect(file, readFileSync(path.join(root, file)));
  const original = `release/EmulatorRemote-${version}-portable-x64.exe`;
  if (existsSync(path.join(root, original))) inspect(original, readFileSync(path.join(root, original)));
  if (existsSync(path.join(root, `${stem}.zip`))) {
    const archive = execute('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/audit-release.ps1'),'-Archive',path.join(root,`${stem}.zip`),'-ProjectRoot',root]);
    if (archive.status !== 0) throw new Error(`Archive hygiene check failed: ${archive.stdout || archive.stderr}`);
    console.log(archive.stdout.trim());
  }
}
if (findings.length) { console.error(JSON.stringify(findings,null,2)); process.exitCode = 1; }
else console.log(`No credential-pattern, known local-credential, or local-home-path matches in ${scanned} project files${process.argv.includes('--source-only') ? '' : ' and checked release artifacts'}.`);
