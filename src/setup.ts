import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Writable } from 'node:stream';
import { readJson, validateProfiles, validateServer } from './server/config';
import { hashPassword } from './server/auth';

async function choosePassword(): Promise<Awaited<ReturnType<typeof hashPassword>>> {
  if (!stdin.isTTY) throw new Error('Run password setup in an interactive PowerShell terminal.');
  // Suppress readline echo, including pasted text; never pass passwords via CLI args.
  const silent = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const prompt = createInterface({ input: stdin, output: silent, terminal: true });
  try {
    stdout.write('Choose password (6–128 characters, input hidden): ');
    const password = await prompt.question('');
    stdout.write('\nConfirm password (input hidden): ');
    const confirmation = await prompt.question('');
    stdout.write('\n');
    if (password !== confirmation) throw new Error('Passwords did not match. Configuration unchanged.');
    return await hashPassword(password);
  } finally { prompt.close(); silent.end(); }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => !['--rotate-token', '--set-password'].includes(arg))) throw new Error('Usage: npm run setup -- [--rotate-token | --set-password]');
  const directory = path.resolve(__dirname, '../config');
  const serverFile = path.join(directory, 'server.local.json');
  const profilesFile = path.join(directory, 'profiles.local.json');
  mkdirSync(directory, { recursive: true });
  if (args.includes('--set-password')) {
    const config = validateServer(readJson(serverFile));
    config.password = await choosePassword();
    config.token = randomBytes(32).toString('base64url');
    writeFileSync(serverFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    console.log('Password saved as a salted hash. Restart the server. The old access token will no longer sign in.');
    return;
  }
  if (args.includes('--rotate-token')) {
    const config = validateServer(readJson(serverFile));
    config.token = randomBytes(32).toString('base64url');
    writeFileSync(serverFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    console.log('Token rotated. Restart the server to invalidate existing clients.');
    return;
  }
  if (existsSync(serverFile)) throw new Error('Server config already exists; use --set-password or --rotate-token, or edit host/port locally.');
  const profiles = validateProfiles(readJson(existsSync(profilesFile) ? profilesFile : path.join(directory, 'profiles.example.json')));
  const prompt = createInterface({ input: stdin, output: stdout });
  let host: string;
  try { host = (await prompt.question('PC LAN IPv4 address (Enter for local-only 127.0.0.1): ')).trim() || '127.0.0.1'; }
  finally { prompt.close(); }
  const config = validateServer({ host, port: 3000, token: randomBytes(32).toString('base64url') });
  if (!existsSync(profilesFile)) writeFileSync(profilesFile, JSON.stringify(profiles, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(serverFile, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Local configuration created. Review emulator process names and shortcuts in config/profiles.local.json.');
  console.log('Run npm run setup -- --set-password to choose an easier sign-in password. Keep local configuration private.');
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Setup failed.');
  process.exitCode = 1;
});
