import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkspaceBroker } from './broker.js';
import { ownerKey, parseCommand } from './wire.js';

function authorized(req: IncomingMessage, token: string): boolean {
  const a = Buffer.from(req.headers.authorization ?? ''); const b = Buffer.from('Bearer ' + token);
  return a.length === b.length && timingSafeEqual(a, b);
}
function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value));
}
async function read(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 1048576) throw new Error('WORKSPACE_REQUEST_TOO_LARGE');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function workspaceRoute(options: { broker: WorkspaceBroker; token: string; isBusy(sessionId: string): boolean }) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!authorized(req, options.token)) return send(res, 401, { error: 'UNAUTHORIZED' });
    if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    try {
      const input = await read(req);
      const owner = ownerKey(input.scope);
      const command = parseCommand(input.command);
      if ((input.scope as Record<string, unknown>).conversationId !== command.sessionId) throw new Error('WORKSPACE_SCOPE_SESSION_MISMATCH');
      const identity = command.revision === undefined
        ? { owner, sessionId: command.sessionId, generation: command.generation ?? '' }
        : { owner, sessionId: command.sessionId, generation: command.generation ?? '', revision: command.revision };
      if ((command.action === 'bind' || command.action === 'unbind') && options.isBusy(command.sessionId)) throw new Error('WORKSPACE_BUSY');
      switch (command.action) {
        case 'status': return send(res, 200, { ...options.broker.status(command.sessionId, owner), accountId: (input.scope as Record<string, unknown>).userId });
        case 'bind': await options.broker.select(identity, 'desktop'); break;
        case 'unbind': await options.broker.select(identity, 'cloud'); break;
        case 'poll': return send(res, 200, { request: options.broker.poll(identity) });
        case 'result': options.broker.result(identity, command.result!); break;
      }
      send(res, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error && /^(?:WORKSPACE|INVALID_WORKSPACE|LOCAL_WORKSPACE)_/.test(error.message) ? error.message : 'INVALID_WORKSPACE_REQUEST';
      send(res, 409, { error: message });
    }
  };
}
