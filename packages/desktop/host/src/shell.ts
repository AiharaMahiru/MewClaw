/** 本机 Shell Consumer：只消费官方执行器，独立授权由桌面原生界面持有。 */
import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type { ShellExecutor } from '@deepseek-ai/dsh-shell';
import { parseFileOperation } from './files.js';

export interface ShellLimits { timeoutMs: number; maxOutputBytes: number }
export class LocalWorkspaceShell {
  private readonly lifetime = new AbortController();
  constructor(private readonly fs: FileSystem, private readonly shell: ShellExecutor, private readonly root: string, private readonly limits: ShellLimits) {}
  revoke(): void { this.lifetime.abort(new Error('LOCAL_SHELL_REVOKED')); }
  async execute(input: unknown, caller: AbortSignal): Promise<unknown> {
    const value = input as Record<string, unknown> | null;
    if (!value || Array.isArray(value) || Object.keys(value).some(k => !['action', 'command', 'path'].includes(k))
      || value.action !== 'shell' || typeof value.command !== 'string' || !value.command.trim() || value.command.length > 32768) throw new Error('LOCAL_INVALID_SHELL');
    const path = value.path ?? '.';
    parseFileOperation({ action: 'list', path });
    const signal = AbortSignal.any([caller, this.lifetime.signal]); signal.throwIfAborted();
    const root = await this.fs.resolve(this.root, { signal });
    const target = await this.fs.resolve(path as string, { cwd: this.fs.processPath(root), signal });
    if (!this.fs.contains(root, target) || (await this.fs.stat(target, signal))?.type !== 'directory') throw new Error('LOCAL_PATH_NOT_ALLOWED');
    const result = await this.shell.run(this.shell.resolve({ command: value.command, workdir: this.fs.processPath(target),
      timeoutMs: this.limits.timeoutMs, stdoutMaxBytes: this.limits.maxOutputBytes, signal }));
    // 不传 Provider 的 spillPath 或主机元数据。命令正文和输出由用户明确授权发送给云端。
    const output = (stream: { text: string; truncated: boolean }) => ({ text: Buffer.from(stream.text).subarray(0, this.limits.maxOutputBytes).toString('utf8'), truncated: stream.truncated || Buffer.byteLength(stream.text) > this.limits.maxOutputBytes });
    return { location: 'desktop', exitCode: result.exitCode, timedOut: result.timedOut, aborted: result.aborted,
      stdout: output(result.stdout), stderr: output(result.stderr) };
  }
}
