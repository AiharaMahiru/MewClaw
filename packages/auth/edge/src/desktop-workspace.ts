/** 桌面工作区入口：只把认证派生的Scope交给固定Worker，不执行文件操作。 */
import type { IncomingMessage, ServerResponse } from 'node:http';

interface WorkspaceEdgeOptions {
  userId: string;
  workerBaseUrl: string;
  workerToken: string | undefined;
  requestBodyLimit: number;
  findResource(type: 'session', id: string): Promise<{ userId: string } | null | undefined>;
}
function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function commandBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > limit) throw new Error('WORKSPACE_REQUEST_TOO_LARGE');
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_WORKSPACE_REQUEST');
  return value as Record<string, unknown>;
}
export async function proxyDesktopWorkspace(req: IncomingMessage, res: ServerResponse, options: WorkspaceEdgeOptions): Promise<void> {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  if (!options.workerToken) return send(res, 503, { error: 'WORKSPACE_BRIDGE_UNAVAILABLE' });
  let command: Record<string, unknown>;
  try { command = await commandBody(req, options.requestBodyLimit); }
  catch { return send(res, 400, { error: 'INVALID_WORKSPACE_REQUEST' }); }
  if (Object.keys(command).some(key => !['action', 'sessionId', 'generation', 'revision', 'result'].includes(key))
    || typeof command.sessionId !== 'string' || !command.sessionId) return send(res, 400, { error: 'INVALID_WORKSPACE_REQUEST' });
  const resource = await options.findResource('session', command.sessionId);
  if (!resource || resource.userId !== options.userId) return send(res, 403, { error: 'RESOURCE_NOT_ALLOWED' });
  const scope = { tenantId: 'dsh-web', botId: 'dsh-web', deploymentId: 'auth-edge', userId: options.userId, conversationId: command.sessionId };
  try {
    const response = await fetch(new URL('/internal/desktop-workspace', options.workerBaseUrl), {
      method: 'POST', headers: { authorization: 'Bearer ' + options.workerToken, 'content-type': 'application/json' },
      body: JSON.stringify({ scope, command }), signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    const body = await response.text();
    if (Buffer.byteLength(body) > options.requestBodyLimit) throw new Error('WORKSPACE_RESPONSE_TOO_LARGE');
    res.writeHead(response.status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(body);
  } catch { send(res, 502, { error: 'WORKSPACE_BRIDGE_UNAVAILABLE' }); }
}
