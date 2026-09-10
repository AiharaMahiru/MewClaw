/** 同步 JSON 边界；base64 与文件大小在 Provider 内再次校验。 */
import type { SyncEndpoint } from './sync.js';
export type SyncOperation = { action: 'snapshot' } | { action: 'read' | 'remove'; path: string; expected: string } | { action: 'write'; path: string; expected: string | null; data: string };
export function parseSyncOperation(input: unknown): SyncOperation {
  const value = input as Record<string, unknown> | null;
  if (!value || Array.isArray(value)) throw new Error('SYNC_INVALID_OPERATION');
  if (value.action === 'snapshot' && Object.keys(value).length === 1) return { action: 'snapshot' };
  if (!['read', 'write', 'remove'].includes(String(value.action)) || typeof value.path !== 'string'
    || Object.keys(value).some(k => !['action', 'path', 'expected', ...(value.action === 'write' ? ['data'] : [])].includes(k))
    || !(value.action === 'write' && value.expected === null) && !(typeof value.expected === 'string' && /^[0-9a-f]{64}$/.test(value.expected))
    || value.action === 'write' && typeof value.data !== 'string') throw new Error('SYNC_INVALID_OPERATION');
  return value as unknown as SyncOperation;
}
export async function executeSync(endpoint: SyncEndpoint, input: unknown, signal: AbortSignal): Promise<unknown> {
  const op = parseSyncOperation(input);
  switch (op.action) {
    case 'snapshot': return endpoint.snapshot(signal);
    case 'read': return endpoint.read(op.path, op.expected, signal);
    case 'write': await endpoint.write(op.path, op.data, op.expected, signal); return { ok: true };
    case 'remove': await endpoint.remove(op.path, op.expected, signal); return { ok: true };
  }
}
