/** 本机 Harness 文件工具 Consumer，授权来源始终为原生目录选择。 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-agent';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { LocalWorkspaceFiles } from 'dsh-lark-desktop-host';
import { realpath } from 'node:fs/promises';
import type { FileLimits } from 'dsh-lark-desktop-host';

export class LocalHarnessWorkspaces {
  private readonly grants = new Map<string, LocalWorkspaceFiles>();
  private picking = false;
  constructor(private readonly ctx: Context, private readonly limits: FileLimits) {}

  async pick(): Promise<{ workspaceId: string; path: string } | null> {
    if (this.picking) throw new Error('LOCAL_PICKER_BUSY');
    this.picking = true;
    try {
      const runtime = this.ctx.get('desktopRuntime') as { pickDirectory(): Promise<string | null> };
      const path = await runtime.pickDirectory();
      if (!path) return null;
      const canonical = await realpath(path);
      const files = await LocalWorkspaceFiles.create(this.ctx.fs, canonical, this.limits);
      try {
        const workspace = await this.ctx.workspaceRegistry.create(canonical);
        this.grants.get(canonical)?.dispose();
        this.grants.set(canonical, files);
        return { workspaceId: workspace.id, path: canonical };
      } catch (error) { files.dispose(); throw error; }
    } finally { this.picking = false; }
  }

  async execute(sessionId: string, operation: unknown, signal: AbortSignal): Promise<unknown> {
    const session = this.ctx.sessions.get(sessionId as Parameters<typeof this.ctx.sessions.get>[0]);
    if (!session?.header.cwd) throw new Error('LOCAL_WORKSPACE_NOT_AUTHORIZED');
    const root = await realpath(session.header.cwd);
    const grant = this.grants.get(root);
    if (!grant) throw new Error('LOCAL_WORKSPACE_NOT_AUTHORIZED');
    return grant.execute(operation, signal);
  }

  dispose(): void {
    for (const files of this.grants.values()) files.dispose();
    this.grants.clear();
  }

  install(ctx: Context): void {
    ctx.effect(() => () => this.dispose());
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'desktop_workspace', description: '读取、列出或按版本写入本机会话已通过原生选择授权的目录。仅接受相对路径。',
      parameters: {
        action: { type: 'string', enum: ['list', 'read', 'write'], required: true },
        path: { type: 'string', required: true }, content: { type: 'string' }, version: { type: 'string' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (operation, exec) => {
        if (!exec.agent) throw new Error('LOCAL_WORKSPACE_NOT_AUTHORIZED');
        return JSON.stringify(await this.execute(exec.agent.id, operation, exec.signal));
      },
    })));
    ctx.on('agent/created', ({ agent }) => {
      const tools = agent.ctx.get('tools');
      if (!tools) throw new Error('LOCAL_TOOLS_UNAVAILABLE');
      agent.ctx.effect(() => tools.restrict({ allow: ['desktop_workspace'] }));
    });
  }
}
