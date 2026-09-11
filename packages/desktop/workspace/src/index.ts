/** Worker插件：公开WebServer、Session与Tools能力的桌面工作区Consumer。 */
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import type {} from '@deepseek-ai/dsh-host-webserver';
import { SessionId } from '@deepseek-ai/dsh-session';
import 'dsh-lark-contracts';
import { NodeSyncDirectory, executeSync } from 'dsh-lark-desktop-host';
import { realpath } from 'node:fs/promises';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { WorkspaceBroker } from './broker.js';
import { workspaceJournal } from './journal.js';
import { workspaceRoute } from './route.js';
import { ownerKey } from './wire.js';
import { prepareLineage, childToolDenial } from './lineage.js';

export const name = 'desktop-workspace';
export const inject = ['webServer', 'credentials', 'sessions', 'sessionPersistence', 'tools', 'larkScopeIndex'];
export const Config = z.object({
  enabled: z.boolean().default(false),
  tokenRef: z.string().required(),
  requestTimeoutMs: z.number().step(1).min(1000).max(120000).default(30000),
  heartbeatTimeoutMs: z.number().step(1).min(3000).max(60000).default(10000),
  maxBindings: z.number().step(1).min(1).max(10000).default(1000),
  syncMaxBytes: z.number().step(1).min(1024).max(4194304).default(1048576),
  syncMaxEntries: z.number().step(1).min(1).max(10000).default(2000),
  syncMaxTotalBytes: z.number().step(1).min(1024).max(268435456).default(33554432),
});
interface Config { enabled?: boolean; tokenRef: string; requestTimeoutMs: number; heartbeatTimeoutMs: number; maxBindings: number; syncMaxBytes?: number; syncMaxEntries?: number; syncMaxTotalBytes?: number }
interface ScopeIndex { get(id: SessionId): unknown }

export async function apply(ctx: Context, config: Config): Promise<void> {
  ctx.effect(() => ctx.webServer.tapIndex(html => html.replace(/<head([^>]*)>/,
    `<head$1><script>globalThis.__MEWCLAW_WORKSPACE_ENABLED__=${config.enabled !== false};</script>`)));
  const token = config.enabled === false ? undefined : await ctx.credentials.resolve(config.tokenRef as CredentialRef);
  if (config.enabled !== false && !token?.value) throw new Error('desktop-workspace: Worker凭证引用未配置');
  const journal = workspaceJournal(ctx);
  const broker = new WorkspaceBroker(journal, config);
  const active = new Map<string, number>();
  const syncing = new Set<string>();
  const lineages = new WeakMap<object, Awaited<ReturnType<typeof prepareLineage>>>();
  const scopeIndex = ctx.get('larkScopeIndex') as ScopeIndex;
  ctx.effect(() => () => broker.dispose());
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/internal/desktop-workspace',
    handler: !token ? (_req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'WORKSPACE_BRIDGE_UNAVAILABLE' })); }
      : workspaceRoute({ broker, token: token.value, isBusy: id => (active.get(id) ?? 0) > 0 || syncing.has(id),
        sync: async (id, rootPath, operation, signal) => {
          syncing.add(id);
          try {
            const session = ctx.sessions.get(SessionId(id));
            if (typeof rootPath !== 'string' || !session?.header.cwd || await realpath(rootPath) !== await realpath(session.header.cwd)) throw new Error('WORKSPACE_SYNC_ROOT_MISMATCH');
            const dir = await NodeSyncDirectory.create(rootPath, { maxBytes: config.syncMaxBytes ?? 1048576,
              maxEntries: config.syncMaxEntries ?? 2000, maxTotalBytes: config.syncMaxTotalBytes ?? 33554432 });
            return await executeSync(dir, operation, signal);
          } finally { syncing.delete(id); }
        } }) }));
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent) lineages.set(exec, await prepareLineage(ctx, exec.agent.id, journal, exec.signal));
    return next();
  });
  ctx.on('tools/execute', async (exec, next) => {
    const id = exec.agent?.id;
    if (!id) return next();
    const lineage = lineages.get(exec);
    if (!lineage || lineage.chain[0] !== id) throw new Error('WORKSPACE_LINEAGE_UNVERIFIED');
    const chain = lineage.chain;
    if (chain.some(sessionId => broker.isChanging(sessionId) || syncing.has(sessionId))) throw new Error('WORKSPACE_SWITCH_IN_PROGRESS');
    for (const sessionId of chain) active.set(sessionId, (active.get(sessionId) ?? 0) + 1);
    try { return await next(); }
    finally { for (const sessionId of chain) {
      const remaining = (active.get(sessionId) ?? 1) - 1;
      if (remaining) active.set(sessionId, remaining); else active.delete(sessionId);
    } }
  });
  ctx.effect(() => ctx.tools.guard(exec => {
    if (!exec.agent) return undefined;
    const lineage = lineages.get(exec);
    if (!lineage || lineage.chain[0] !== exec.agent.id) return 'WORKSPACE_LINEAGE_UNVERIFIED';
    const chain = lineage.chain;
    if (chain.some(id => broker.isChanging(id))) return 'WORKSPACE_SWITCH_IN_PROGRESS';
    const inheritedDenial = childToolDenial(chain, lineage.journal);
    if (inheritedDenial) return inheritedDenial;
    if (journal.read(exec.agent.id)?.mode !== 'desktop') return undefined;
    const scope = scopeIndex.get(exec.agent.id);
    if (!scope) return 'LOCAL_WORKSPACE_SCOPE_REQUIRED';
    return broker.denyTool({ sessionId: exec.agent.id, owner: ownerKey(scope), tool: exec.name });
  }));
  if (config.enabled !== false) registerFileTool(ctx, { broker, scopeIndex });
}

function registerFileTool(ctx: Context, options: { broker: WorkspaceBroker; scopeIndex: ScopeIndex }): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'desktop_shell', description: '在用户独立授权的本机 Shell 执行命令；不是服务器 Shell，也不是目录沙箱。未授权或断线时拒绝。',
    parameters: { command: { type: 'string', required: true }, path: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('LOCAL_WORKSPACE_SCOPE_REQUIRED');
      return JSON.stringify(await options.broker.execute({ sessionId: exec.agent.id, owner: ownerKey(options.scopeIndex.get(exec.agent.id)),
        operation: { action: 'shell', ...args } }, exec.signal));
    },
  })));
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
