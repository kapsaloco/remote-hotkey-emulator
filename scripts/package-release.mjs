import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build the portable release on Windows x64.');
const root = fileURLToPath(new URL('../', import.meta.url));
const readJson = file => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const { version } = readJson('package.json');
assert.match(version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
assert.equal(version, readJson('src-tauri/tauri.conf.json').version, 'Tauri and package versions must agree');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const output = path.join(root, 'release'); mkdirSync(output, { recursive: true });
const baseline = path.join(output, `EmulatorRemote-${version}-portable-x64.exe`);
const baselineHash = existsSync(baseline) ? hash(baseline) : undefined;
const stem = `EmulatorRemote-${version}-tauri-portable-x64`;
const staging = path.join(output, stem); mkdirSync(staging, { recursive: true });
const source = path.join(root, 'src-tauri/target/release/emulator-remote.exe');
const binary = readFileSync(source);
const homeVariants = [os.homedir(), os.homedir().replaceAll('\\', '/')];
const binaryText = binary.toString('utf8').toLowerCase();
assert.ok(!homeVariants.some(home => binaryText.includes(home.toLowerCase()) || binary.includes(Buffer.from(home, 'utf16le'))),
  'Executable contains a local home path; rebuild with npm run build:tauri to remap compiler paths');
assert.equal(binary.toString('ascii', 0, 2), 'MZ', 'Missing Windows executable');
const pe = binary.readUInt32LE(0x3c);
assert.equal(binary.readUInt32LE(pe), 0x4550, 'Invalid PE signature');
assert.equal(binary.readUInt16LE(pe + 4), 0x8664, 'Expected x64 executable');
assert.equal(binary.readUInt16LE(pe + 24 + 68), 2, 'Expected release GUI executable, not debug console build');
assert.ok(binary.length < 10_000_000, 'Portable EXE exceeds the 10 MB target');

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
};
const metadata = JSON.parse(run('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', 'x86_64-pc-windows-msvc', '--manifest-path', 'src-tauri/Cargo.toml']));
const packages = new Map(metadata.packages.map(p => [p.id, p]));
assert.equal(packages.get(metadata.resolve.root).version, version, 'Cargo and package versions must agree');
const nodes = new Map(metadata.resolve.nodes.map(n => [n.id, n]));
const included = new Set();
function visit(id) {
  if (included.has(id)) return;
  included.add(id);
  for (const dependency of nodes.get(id)?.deps ?? []) {
    if (dependency.dep_kinds.some(kind => kind.kind !== 'dev')) visit(dependency.pkg);
  }
}
visit(metadata.resolve.root);
const notices = ['Emulator Remote dependency notices',
  'License declarations and available license/notice files from production and build dependencies. Test-only dependencies are excluded.\n'];
for (const pkg of [...included].map(id => packages.get(id)).filter(p => p.id !== metadata.resolve.root).sort((a,b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))) {
  const directory = path.dirname(pkg.manifest_path);
  notices.push(`\n${'='.repeat(72)}\n${pkg.name} ${pkg.version}\nLicense: ${pkg.license ?? 'see license file'}\n${pkg.repository ?? ''}\n`);
  const files = new Set(readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && /^(licen[cs]e|copying|copyright|notice)(?:[._-]|$)/i.test(entry.name)).map(entry => entry.name));
  if (pkg.license_file) files.add(pkg.license_file);
  for (const file of [...files].sort()) {
    const absolute = path.resolve(directory, file);
    const relative = path.relative(directory, absolute);
    assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'License file must stay inside its package');
    notices.push(`--- ${relative} ---\n${readFileSync(absolute, 'utf8')}\n`);
  }
}
const executable = path.join(output, `${stem}.exe`);
assert.notEqual(executable, baseline);
copyFileSync(source, executable);
copyFileSync(source, path.join(staging, 'EmulatorRemote.exe'));
copyFileSync(path.join(root, 'LICENSE'), path.join(staging, 'LICENSE'));
writeFileSync(path.join(staging, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n'));
writeFileSync(path.join(staging, 'README.txt'), `Emulator Remote ${version} - portable Windows x64\r\n\r\nExtract this ZIP into an empty writable folder, then open EmulatorRemote.exe.\r\nNo Node.js, Rust compiler, or app installer is needed on the destination PC.\r\n\r\nRequired shared Windows components:\r\n- Microsoft Edge WebView2 Runtime (Evergreen). If missing, the app shows installation instructions.\r\n  https://developer.microsoft.com/microsoft-edge/webview2/\r\n- Microsoft .NET Framework v4 runtime for the embedded Windows input helper.\r\n  Windows 10/11 with .NET Framework 4.8 or later is recommended.\r\n\r\nThe browser runtime is not bundled or automatically downloaded by this portable app.\r\nThe app is unsigned. Windows may display an unknown-publisher warning.\r\n\r\nSet a fresh password, choose the PC's private LAN address, and start the server.\r\nOpen the displayed URL on a phone on the same trusted network. Choose the matching\r\nemulator profile and keep the emulator focused. Never expose the server to the internet.\r\n\r\nSettings and helper/browser files are created in EmulatorRemote-data beside the EXE.\r\nMove that folder with the EXE to preserve profiles and network settings.\r\nPasswords are session-only and must be set again after reopening.\r\nClose the app before editing EmulatorRemote-data/config/profiles.local.json.\r\n\r\nThe optional Node CLI and development tools are not included.\r\nSee LICENSE and THIRD-PARTY-NOTICES.txt for license information.\r\n`);
const info = { product: 'Emulator Remote', version, target: 'x86_64-pc-windows-msvc', profile: 'release',
  nodeBuildVersion: process.version, rustBuildVersion: run('rustc', ['--version']).trim(),
  exeBytes: binary.length, exeSha256: hash(executable), productionAndBuildPackages: included.size - 1,
  sharedRequirements: ['Microsoft Edge WebView2 Runtime (Evergreen)', 'Microsoft .NET Framework v4'],
  signed: false, settingsIncluded: false };
writeFileSync(path.join(staging, 'BUILD-INFO.json'), JSON.stringify(info, null, 2) + '\n');
const archive = path.join(output, `${stem}.zip`);
const temporary = path.join(output, `${stem}.${Date.now()}.zip.tmp`);
try {
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/zip-release.ps1'), '-SourceDirectory', staging, '-Destination', temporary]);
  assert.ok(readFileSync(temporary).length < 10_000_000, 'Complete portable ZIP exceeds the 10 MB target');
  renameSync(temporary, archive);
} finally { if (existsSync(temporary)) unlinkSync(temporary); }
const report = { ...info, zipBytes: readFileSync(archive).length, zipSha256: hash(archive),
  ...(baselineHash ? { originalElectronBytes: readFileSync(baseline).length, originalElectronSha256: baselineHash,
    reductionPercent: Number(((1 - binary.length / readFileSync(baseline).length) * 100).toFixed(2)) } : {}) };
if (baselineHash) assert.equal(hash(baseline), baselineHash, 'Original Electron EXE changed');
writeFileSync(path.join(output, `${stem}-build.json`), JSON.stringify(report, null, 2) + '\n');
writeFileSync(path.join(output, `${stem}-SHA256SUMS.txt`), `${info.exeSha256}  ${stem}.exe\n${report.zipSha256}  ${stem}.zip\n`);
console.log(JSON.stringify({ exe: path.relative(root, executable), exeMB: binary.length / 1_000_000,
  zip: path.relative(root, archive), zipMB: report.zipBytes / 1_000_000, reductionPercent: report.reductionPercent }, null, 2));
