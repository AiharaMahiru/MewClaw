/** 本机工作区原生目录入口；模型侧使用与 Web 相同的官方 preset 和工具。 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-agent';
import { LocalWorkspaceFiles } from 'dsh-lark-desktop-host';
import { realpath } from 'node:fs/promises';
import type { FileLimits } from 'dsh-lark-desktop-host';

export class LocalHarnessWorkspaces {
  private readonly grants = new Map<string, LocalWorkspaceFiles>();
  private picking = false;
  private generation = 0;
  constructor(private readonly ctx: Context, private readonly limits: FileLimits) {}

  async pick(): Promise<{ workspaceId: string; path: string } | null> {
    if (this.picking) throw new Error('LOCAL_PICKER_BUSY');
    this.picking = true;
    const generation = this.generation;
    const assertCurrent = () => {
      if (generation !== this.generation) throw new Error('LOCAL_WORKSPACE_AUTHORIZATION_REVOKED');
    };
    try {
      const runtime = this.ctx.get('desktopRuntime') as { pickDirectory(): Promise<string | null> };
      const path = await runtime.pickDirectory();
      assertCurrent();
      if (!path) return null;
      const canonical = await realpath(path);
      const files = await LocalWorkspaceFiles.create(this.ctx.fs, canonical, this.limits);
      try {
        assertCurrent();
        const workspace = await this.ctx.workspaceRegistry.create(canonical);
        assertCurrent();
        const key = grantKey(canonical);
        this.grants.get(key)?.dispose();
        this.grants.set(key, files);
        return { workspaceId: workspace.id, path: canonical };
      } catch (error) { files.dispose(); throw error; }
    } finally { this.picking = false; }
  }

  async execute(sessionId: string, operation: unknown, signal: AbortSignal): Promise<unknown> {
    const session = this.ctx.sessions.get(sessionId as Parameters<typeof this.ctx.sessions.get>[0]);
    if (!session?.header.cwd) throw new Error('LOCAL_WORKSPACE_NOT_AUTHORIZED：会话未绑定本地目录。请让用户通过侧栏「打开本地目录」选择工作目录并创建会话。');
    const root = await realpath(session.header.cwd);
    const grant = this.grants.get(grantKey(root));
    if (!grant) throw new Error(`LOCAL_WORKSPACE_NOT_AUTHORIZED：${root} 的目录授权已失效（授权不跨重启、登出或模式切换保留）。请让用户通过侧栏「打开本地目录」重新选择该目录。`);
    return grant.execute(operation, signal);
  }

  dispose(): void {
    this.generation += 1;
    for (const files of this.grants.values()) files.dispose();
    this.grants.clear();
  }

  install(ctx: Context): void {
    ctx.effect(() => () => this.dispose());
  }
}

/** Windows 的同一规范目录可能以不同盘符/目录大小写出现在旧会话中。 */
function grantKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}
