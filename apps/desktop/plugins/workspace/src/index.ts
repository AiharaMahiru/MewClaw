/** Worker插件：公开WebServer、Session与Tools能力的桌面工作区Consumer。 */
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import type {} from '@deepseek-ai/dsh-host-webserver';
import { KNOWN_SESSION_EVENT_TYPES, type SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { WorkspaceBroker } from './broker.js';
import { workspaceJournal } from './journal.js';
import { workspaceRoute } from './route.js';
import { ownerKey } from './wire.js';
import { sessionAncestry, childToolDenial } from './lineage.js';

// 与仓库contracts事件注册一致：运行时公开集合为Set，类型只读。
(KNOWN_SESSION_EVENT_TYPES as Set<string>).add('desktop/workspace');
export const name = 'desktop-workspace';
export const inject = ['webServer', 'credentials', 'sessions', 'sessionPersistence', 'tools', 'larkScopeIndex'];
export const Config = z.object({
  tokenRef: z.string().required(),
  requestTimeoutMs: z.number().step(1).min(1000).max(120000).default(30000),
  heartbeatTimeoutMs: z.number().step(1).min(3000).max(60000).default(10000),
  maxBindings: z.number().step(1).min(1).max(10000).default(1000),
});
interface Config { tokenRef: string; requestTimeoutMs: number; heartbeatTimeoutMs: number; maxBindings: number }
interface ScopeIndex { get(id: SessionId): unknown }

export async function apply(ctx: Context, config: Config): Promise<void> {
  const token = await ctx.credentials.resolve(config.tokenRef as CredentialRef);
  if (!token?.value) throw new Error('desktop-workspace: Worker凭证引用未配置');
  const journal = workspaceJournal(ctx);
  const broker = new WorkspaceBroker(journal, config);
  const active = new Map<string, number>();
  const scopeIndex = ctx.get('larkScopeIndex') as ScopeIndex;
  ctx.effect(() => () => broker.dispose());
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/internal/desktop-workspace',
    handler: workspaceRoute({ broker, token: token.value, isBusy: id => (active.get(id) ?? 0) > 0 }) }));
  ctx.on('tools/execute', async (exec, next) => {
    const id = exec.agent?.id;
    if (!id) return next();
    const chain = sessionAncestry(ctx, id);
    if (chain.some(sessionId => broker.isChanging(sessionId))) throw new Error('WORKSPACE_SWITCH_IN_PROGRESS');
    for (const sessionId of chain) active.set(sessionId, (active.get(sessionId) ?? 0) + 1);
    try { return await next(); }
    finally { for (const sessionId of chain) {
      const remaining = (active.get(sessionId) ?? 1) - 1;
      if (remaining) active.set(sessionId, remaining); else active.delete(sessionId);
    } }
  });
  ctx.effect(() => ctx.tools.guard(exec => {
    if (!exec.agent) return undefined;
    const chain = sessionAncestry(ctx, exec.agent.id);
    if (chain.some(id => broker.isChanging(id))) return 'WORKSPACE_SWITCH_IN_PROGRESS';
    const inheritedDenial = childToolDenial(chain, journal);
    if (inheritedDenial) return inheritedDenial;
    if (journal.read(exec.agent.id)?.mode !== 'desktop') return undefined;
    const scope = scopeIndex.get(exec.agent.id);
    if (!scope) return 'LOCAL_WORKSPACE_SCOPE_REQUIRED';
    return broker.denyTool({ sessionId: exec.agent.id, owner: ownerKey(scope), tool: exec.name });
  }));
  registerFileTool(ctx, { broker, scopeIndex });
}

function registerFileTool(ctx: Context, options: { broker: WorkspaceBroker; scopeIndex: ScopeIndex }): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'desktop_workspace', description: '读取、列出或按版本写入当前会话已授权的本机目录。仅接受相对路径；断线时不得改用云端目录。',
    parameters: {
      action: { type: 'string', enum: ['list', 'read', 'write'], required: true },
      path: { type: 'string', required: true }, content: { type: 'string' }, version: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(operation, exec) {
      if (!exec.agent) throw new Error('LOCAL_WORKSPACE_SCOPE_REQUIRED');
      const owner = ownerKey(options.scopeIndex.get(exec.agent.id));
      return JSON.stringify(await options.broker.execute({ sessionId: exec.agent.id, owner, operation }, exec.signal));
    },
  })));
}
