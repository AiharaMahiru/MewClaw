import type { IncomingMessage } from 'node:http';
import { cloudOrigin } from './proxy.js';

/** 仅固定云端、仅当前认证Cookie；不携带本地Connection凭证。 */
export function workspaceTransport(req: IncomingMessage, origin: string) {
  const url = new URL('/desktop-workspace', cloudOrigin(origin));
  const cookie = (req.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => !value.startsWith('dsh-auth-')).join('; ');
  const csrf = cookie.split('; ').find(value => value.startsWith('dsh_csrf='))?.slice('dsh_csrf='.length) ?? '';
  return async (command: unknown, signal: AbortSignal): Promise<Record<string, unknown>> => {
    const response = await fetch(url, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf, origin: url.origin },
      body: JSON.stringify(command), signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    });
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > 1048576) throw new Error('WORKSPACE_RESPONSE_TOO_LARGE');
      chunks.push(chunk);
    }
    if (!response.ok) throw new Error(response.status === 401 ? 'WORKSPACE_LOGIN_REQUIRED' : 'WORKSPACE_CLOUD_UNAVAILABLE');
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('INVALID_WORKSPACE_RESPONSE');
    return result as Record<string, unknown>;
  };
}
