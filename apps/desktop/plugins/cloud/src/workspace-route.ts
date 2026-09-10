import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkspaceController } from './workspace-controller.js';
import { workspaceTransport } from './workspace-transport.js';

export function localWorkspaceRoute(options: { origin: string; controller: WorkspaceController; reject(req: IncomingMessage): number | undefined }) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value));
    };
    const rejection = options.reject(req);
    if (rejection !== undefined) return send(rejection, { error: 'DESKTOP_UNAUTHORIZED' });
    if (req.method !== 'POST') return send(405, { error: 'METHOD_NOT_ALLOWED' });
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > 4096) throw new Error('INVALID_WORKSPACE_REQUEST');
        chunks.push(bytes);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (!value || Object.keys(value).some(key => !['sessionId', 'mode', 'permission', 'enabled'].includes(key)) || typeof value.sessionId !== 'string' || !value.sessionId) throw new Error('INVALID_WORKSPACE_REQUEST');
      const transport = workspaceTransport(req, options.origin);
      if (value.permission !== undefined) {
        if (value.mode !== undefined || !['shell', 'sync'].includes(String(value.permission)) || typeof value.enabled !== 'boolean') throw new Error('INVALID_WORKSPACE_REQUEST');
        return send(200, await options.controller.permission(value.sessionId, value.permission as 'shell' | 'sync', value.enabled, transport));
      }
      if (value.enabled !== undefined) throw new Error('INVALID_WORKSPACE_REQUEST');
      if (value.mode === undefined) return send(200, await options.controller.status(value.sessionId, transport));
      if (value.mode !== 'cloud' && value.mode !== 'desktop') throw new Error('INVALID_WORKSPACE_REQUEST');
      send(200, await options.controller.select({ sessionId: value.sessionId, mode: value.mode }, transport));
    } catch (error) {
      const message = error instanceof Error && /^(?:WORKSPACE|INVALID_WORKSPACE|LOCAL)_/.test(error.message) ? error.message : 'WORKSPACE_UNAVAILABLE';
      send(409, { error: message });
    }
  };
}
