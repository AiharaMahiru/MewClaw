/** Auth Edge签发的完整Scope是唯一身份来源；模型和浏览器不得填写。 */
export const SCOPE_KEYS = ['tenantId', 'botId', 'deploymentId', 'userId', 'conversationId'] as const;
export function ownerKey(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_WORKSPACE_SCOPE');
  const scope = value as Record<string, unknown>;
  if (Object.keys(scope).length !== SCOPE_KEYS.length) throw new Error('INVALID_WORKSPACE_SCOPE');
  const values = SCOPE_KEYS.map(key => scope[key]);
  if (values.some(item => typeof item !== 'string' || !item || item.length > 512)) throw new Error('INVALID_WORKSPACE_SCOPE');
  return JSON.stringify(values);
}

export interface BridgeCommand {
  action: 'status' | 'bind' | 'poll' | 'result' | 'unbind';
  sessionId: string;
  generation?: string;
  revision?: string;
  result?: { id: string; ok: boolean; value: unknown };
}
export function parseCommand(input: unknown): BridgeCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_WORKSPACE_COMMAND');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['action', 'sessionId', 'generation', 'revision', 'result'].includes(key))) throw new Error('INVALID_WORKSPACE_COMMAND');
  if (!['status', 'bind', 'poll', 'result', 'unbind'].includes(String(value.action)) || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 512) throw new Error('INVALID_WORKSPACE_COMMAND');
  if (value.action !== 'status' && (typeof value.generation !== 'string' || value.generation.length < 16 || value.generation.length > 128)) throw new Error('INVALID_WORKSPACE_COMMAND');
  if (['bind', 'unbind'].includes(String(value.action)) && (typeof value.revision !== 'string' || value.revision.length > 128)) throw new Error('INVALID_WORKSPACE_REVISION');
  if (value.action === 'result') {
    const result = value.result as Record<string, unknown> | undefined;
    if (!result || typeof result.id !== 'string' || typeof result.ok !== 'boolean' || !('value' in result)) throw new Error('INVALID_WORKSPACE_RESULT');
  } else if (value.result !== undefined) throw new Error('INVALID_WORKSPACE_COMMAND');
  return value as unknown as BridgeCommand;
}
