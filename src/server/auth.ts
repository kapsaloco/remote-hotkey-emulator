import { timingSafeEqual, randomBytes, scrypt } from 'node:crypto';
import type { PasswordHash, ServerConfig } from './config';

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 },
      (error, key) => error ? reject(error) : resolve(key));
  });
}
export async function hashPassword(password: string): Promise<PasswordHash> {
  if (password.length < 6 || password.length > 128 || /[\p{C}]/u.test(password))
    throw new Error('Choose a password of 6–128 characters without control characters.');
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: (await derive(password, salt)).toString('hex') };
}

export class Sessions {
  private readonly sessions = new Map<string, number>();
  private verifying = 0;
  constructor(private readonly config: ServerConfig, private readonly now = Date.now) {}
  private prune(): void {
    for (const [token, expires] of this.sessions) if (expires <= this.now()) this.sessions.delete(token);
  }
  async login(credential: string): Promise<string | undefined> {
    this.prune();
    if (credential.length < 1 || credential.length > 128) return undefined;
    if (this.verifying >= 2 || this.sessions.size >= 128) throw new Error('Login capacity exceeded');
    this.verifying++;
    try {
      const valid = this.config.password
        ? timingSafeEqual(await derive(credential, this.config.password.salt), Buffer.from(this.config.password.hash, 'hex'))
        : authenticate(`Bearer ${credential}`, this.config.token);
      if (!valid) return undefined;
      const token = randomBytes(32).toString('base64url');
      this.sessions.set(token, this.now() + 12 * 60 * 60 * 1000);
      return token;
    } finally { this.verifying--; }
  }
  authenticate(header: string | undefined): boolean {
    this.prune();
    if (!this.config.password && authenticate(header, this.config.token)) return true;
    if (!header?.startsWith('Bearer ')) return false;
    return this.sessions.has(header.slice(7));
  }
  logout(header: string | undefined): void {
    if (header?.startsWith('Bearer ')) this.sessions.delete(header.slice(7));
  }
  clear(): void { this.sessions.clear(); }
}

export function authenticate(header: string | undefined, token: string): boolean {
  if (!header || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) return false;
  const supplied = header.slice(7);
  const bytes = Buffer.from(supplied, 'base64url');
  const expected = Buffer.from(token, 'base64url');
  return bytes.length === 32 && expected.length === 32 &&
    bytes.toString('base64url') === supplied && timingSafeEqual(bytes, expected);
}
