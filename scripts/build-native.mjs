import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('The input helper requires Windows.');
const root = fileURLToPath(new URL('../', import.meta.url));
const windows = process.env.SystemRoot ?? 'C:\\Windows';
const compiler = ['Framework64', 'Framework']
  .map(dir => path.join(windows, 'Microsoft.NET', dir, 'v4.0.30319', 'csc.exe'))
  .find(existsSync);
if (!compiler) throw new Error('Missing .NET Framework v4 C# compiler (csc.exe).');
mkdirSync(path.join(root, 'dist', 'native'), { recursive: true });
console.log(`C# compiler: ${compiler}`);
const result = spawnSync(compiler, [
  '/nologo', '/warnaserror+', '/reference:System.Web.Extensions.dll',
  `/out:${path.join(root, 'dist', 'native', 'WindowsInput.exe')}`,
  path.join(root, 'native', 'WindowsInput.cs'),
], { cwd: root, shell: false, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (result.status === 0 && process.argv.includes('--test-fixture')) {
  const fixture = spawnSync(compiler, ['/nologo', '/warnaserror+',
    `/out:${path.join(root, 'dist', 'native', 'HelperFixture.exe')}`,
    path.join(root, 'src-tauri', 'tests', 'fixtures', 'HelperFixture.cs')],
    { cwd: root, shell: false, stdio: 'inherit', windowsHide: true });
  if (fixture.error) throw fixture.error;
  process.exitCode = fixture.status ?? 1;
}
