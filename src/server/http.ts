import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { InputAdapter } from '../input/adapter';
import { Sessions } from './auth';
import { actionIds, actionLabels, displayChord, validateProfiles, type Profiles, type ServerConfig } from './config';
import { Dispatcher, error, type ActionRequest, type Result } from './dispatcher';
import { RateLimit } from './rate-limit';

const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
};
class HttpError extends Error {
  constructor(readonly result: Result) { super('Request rejected'); }
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-encoding']) throw new HttpError(error(415, 'content_encoding', 'Encoded bodies are unsupported.'));
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? ''))
    throw new HttpError(error(415, 'content_type', 'Use application/json.'));
  if (Number(request.headers['content-length'] ?? 0) > 1024) throw new HttpError(error(413, 'body_too_large', 'Body exceeds 1 KiB.'));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const timer = setTimeout(() => finish(error(400, 'body_timeout', 'Request body timed out.')), 3000);
    const cleanup = () => {
      clearTimeout(timer); request.off('data', data); request.off('end', end);
      request.off('error', aborted); request.off('aborted', aborted);
    };
    const finish = (result: Result) => { cleanup(); request.resume(); reject(new HttpError(result)); };
    const data = (chunk: Buffer) => {
      length += chunk.length;
      if (length > 1024) finish(error(413, 'body_too_large', 'Body exceeds 1 KiB.'));
      else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown); }
      catch { reject(new HttpError(error(400, 'invalid_json', 'Invalid JSON body.'))); }
    };
    const aborted = () => finish(error(400, 'body_aborted', 'Request body interrupted.'));
    request.on('data', data); request.once('end', end); request.once('error', aborted); request.once('aborted', aborted);
  });
}
function action(value: unknown): ActionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(error(400, 'invalid_action', 'Invalid action request.'));
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3 || !['requestId', 'profileId', 'action'].every(key => Object.hasOwn(record, key)) ||
      typeof record.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.requestId) ||
      record.requestId.length !== 36 || typeof record.profileId !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(record.profileId) ||
      typeof record.action !== 'string' || !(actionIds as readonly string[]).includes(record.action))
    throw new HttpError(error(400, 'invalid_action', 'Invalid action request.'));
  return { requestId: record.requestId.toLowerCase(), profileId: record.profileId, action: record.action as ActionRequest['action'] };
}

export function createRemoteServer(config: ServerConfig, profiles: Profiles, input: InputAdapter,
  log: (entry: { time: string; requestId: string; action: string; outcome: string }) => void = () => {}) {
  const settings = structuredClone(config);
  const sessions = new Sessions(settings);
  const logins = new RateLimit(5 / 60, 3);
  const globalLogins = new RateLimit(20 / 60, 5, 1);
  // Own a validated snapshot; callers cannot mutate dispatch targets after startup.
  const snapshot = validateProfiles(structuredClone(profiles));
  const dispatcher = new Dispatcher(input, snapshot);
  const preAuth = new RateLimit(0.5, 10);
  const actions = new RateLimit(5, 3);
  const assets = new Map([
    ['/', { type: 'text/html; charset=utf-8', file: 'index.html' }],
    ['/styles.css', { type: 'text/css; charset=utf-8', file: 'styles.css' }],
    ['/app.js', { type: 'text/javascript; charset=utf-8', file: 'app.js' }],
    ['/icon.png', { type: 'image/png', file: 'icon.png' }],
  ].map(([url, asset]) => {
    const item = asset as { type: string; file: string };
    return [url as string, { type: item.type, data: readFileSync(path.resolve(__dirname, '../web', item.file)) }] as const;
  }));
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000,
    connectionsCheckingInterval: 1000, keepAliveTimeout: 5000 }, (request, response) => {
    void handle(request, response).catch(() => send(response, error(500, 'internal_error', 'Request failed.')));
  });
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 100;
  server.setTimeout(5000, socket => socket.destroy());
  function send(response: ServerResponse, result: Result): void {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(result.status, { ...headers, 'Content-Type': 'application/json; charset=utf-8',
      Connection: 'close', ...(result.status === 429 ? { 'Retry-After': '2' } : {}) });
    response.end(JSON.stringify(result.body));
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!preAuth.take(request.socket.remoteAddress ?? 'unknown')) return send(response, error(429, 'rate_limited', 'Too many requests.'));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : settings.port;
      const authority = `${settings.host}:${port}`;
      const origin = `http://${authority}`;
      const rawHostCount = request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index]?.toLowerCase() === 'host').length;
      if (rawHostCount !== 1 || request.headers.host !== authority ||
          (request.headers.origin !== undefined && request.headers.origin !== origin) ||
          (request.headers['sec-fetch-site'] !== undefined && request.headers['sec-fetch-site'] !== 'same-origin' && request.headers['sec-fetch-site'] !== 'none'))
        return send(response, error(403, 'origin_rejected', 'Host or origin rejected.'));
      if (request.method === 'POST' && request.headers.origin !== origin)
        return send(response, error(403, 'origin_rejected', 'POST requires the configured origin.'));
      const asset = assets.get(request.url ?? '');
      if (asset && (request.method === 'GET' || request.method === 'HEAD')) {
        response.writeHead(200, { ...headers, 'Content-Type': asset.type, Connection: 'close' });
        response.end(request.method === 'HEAD' ? undefined : asset.data);
        return;
      }
      if (!request.url?.startsWith('/api/')) return send(response, error(404, 'not_found', 'Not found.'));
      if (request.url === '/api/login' && request.method === 'POST') {
        if (!logins.take(request.socket.remoteAddress ?? 'unknown') || !globalLogins.take('login'))
          return send(response, error(429, 'login_limited', 'Too many sign-in attempts. Wait before trying again.'));
        const value = await body(request);
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 ||
            !('credential' in value) || typeof value.credential !== 'string' || value.credential.length < 1 || value.credential.length > 128)
          return send(response, error(400, 'invalid_login', 'Enter a valid password or access token.'));
        let token: string | undefined;
        try { token = await sessions.login(value.credential); }
        catch { return send(response, error(429, 'login_limited', 'Sign-in is busy. Wait before trying again.')); }
        return send(response, token ? { status: 200, body: { token } } : error(401, 'unauthorized', 'Password or access token rejected.'));
      }
      if (!sessions.authenticate(request.headers.authorization)) return send(response, error(401, 'unauthorized', 'Sign in again.'));
      if (request.url === '/api/logout' && request.method === 'POST') {
        sessions.logout(request.headers.authorization);
        return send(response, { status: 200, body: { status: 'signed_out' } });
      }
      if (request.method === 'GET' && request.url === '/api/health')
        return send(response, { status: 200, body: { ready: dispatcher.available, inputAvailable: dispatcher.available } });
      if (request.method === 'GET' && request.url === '/api/profiles')
        return send(response, { status: 200, body: { defaultProfileId: snapshot.defaultProfileId,
          profiles: snapshot.profiles.map(profile => ({ id: profile.id, label: profile.label,
            actions: Object.fromEntries(actionIds.flatMap(id => {
              const chord = profile.actions[id];
              return chord ? [[id, { label: actionLabels[id], shortcut: displayChord(chord) }]] : [];
            })) })) } });
      if (request.method !== 'POST' || request.url !== '/api/actions') return send(response, error(404, 'not_found', 'Not found.'));
      const parsed = action(await body(request));
      if (request.aborted || response.destroyed) return;
      if (!actions.take('global')) return send(response, error(429, 'rate_limited', 'Too many actions.'));
      const result = await dispatcher.dispatch(parsed);
      log({ time: new Date().toISOString(), requestId: parsed.requestId, action: parsed.action,
        outcome: typeof result.body.code === 'string' ? result.body.code : 'sent' });
      send(response, result);
    } catch (failure) {
      send(response, failure instanceof HttpError ? failure.result : error(500, 'internal_error', 'Request failed.'));
    } finally { request.resume(); }
  }
  async function close(): Promise<void> {
    sessions.clear();
    const stopped = new Promise<void>((resolve, reject) => {
      server.close(failure => failure && (failure as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(failure) : resolve());
      server.closeIdleConnections();
    });
    await Promise.all([stopped, dispatcher.close()]);
  }
  return { server, close };
}
