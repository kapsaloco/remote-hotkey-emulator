import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { hashPassword, Sessions } from './auth';
import { validateServer } from './config';

test('password hashes are salted, validated, and never store plaintext', async () => {
  const first = await hashPassword('test password only');
  const second = await hashPassword('test password only');
  assert.notDeepEqual(first, second);
  assert.equal(JSON.stringify(first).includes('test password only'), false);
  const config = { host: '127.0.0.1', port: 3000, token: randomBytes(32).toString('base64url'), password: first };
  assert.deepEqual(validateServer(config), config);
  assert.throws(() => validateServer({ ...config, password: { ...first, hash: 'invalid' } }));
  assert.throws(() => validateServer({ ...config, password: { ...first, plaintext: 'secret' } }));
  for (const invalid of ['', 'short', 'a'.repeat(129), 'password\n']) await assert.rejects(hashPassword(invalid));
  const six = await hashPassword('abc123');
  assert.equal(six.hash.length, 64);
});
test('password sessions reject bad passwords and legacy token, expire and revoke', async () => {
  let now = 0;
  const config = { host: '127.0.0.1', port: 3000, token: randomBytes(32).toString('base64url'), password: await hashPassword('test password only') };
  const sessions = new Sessions(config, () => now);
  assert.equal(await sessions.login('wrong password'), undefined);
  assert.equal(await sessions.login(config.token), undefined);
  assert.equal(sessions.authenticate(`Bearer ${config.token}`), false);
  const token = await sessions.login('test password only');
  assert.ok(token); assert.notEqual(token, config.token);
  assert.equal(sessions.authenticate(`Bearer ${token}`), true);
  sessions.logout(`Bearer ${token}`);
  assert.equal(sessions.authenticate(`Bearer ${token}`), false);
  const expired = await sessions.login('test password only');
  now += 12 * 60 * 60 * 1000;
  assert.equal(sessions.authenticate(`Bearer ${expired}`), false);
  const revoked = await sessions.login('test password only');
  sessions.clear(); assert.equal(sessions.authenticate(`Bearer ${revoked}`), false);
});
test('legacy token can exchange for session until password configured', async () => {
  const config = { host: '127.0.0.1', port: 3000, token: randomBytes(32).toString('base64url') };
  const sessions = new Sessions(config);
  const token = await sessions.login(config.token);
  assert.ok(token);
  assert.equal(sessions.authenticate(`Bearer ${token}`), true);
  assert.equal(await sessions.login('wrong'), undefined);
});
