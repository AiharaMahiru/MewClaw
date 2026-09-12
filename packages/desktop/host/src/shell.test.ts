import { Context } from '@deepseek-ai/cordis';
import LocalFileSystem from '@deepseek-ai/dsh-fs-local';
import Subprocess from '@deepseek-ai/dsh-subprocess-local';
import Bash from '@deepseek-ai/dsh-bash-local';
import Pwsh from '@deepseek-ai/dsh-pwsh-local';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { LocalWorkspaceShell } from './shell.js';

it('真实官方 Shell 执行、有界输出、非零退出、超时和撤销', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mewclaw-shell-'));
  const ctx = new Context();
  try {
    await ctx.plugin(LocalFileSystem, { cwd: root }); await ctx.plugin(Subprocess);
    const windows = process.platform === 'win32';
    // Windows PowerShell 的冷启动可能超过 1 秒；测试超时应覆盖启动开销，避免把环境延迟误判为执行失败。
    await ctx.plugin(windows ? Pwsh : Bash, { cwd: root, timeoutMs: 5000, maxTimeoutMs: 10000, maxOutputBytes: 1024, maxSpillBytes: 1024, graceMs: 100 });
    const shell = new LocalWorkspaceShell(ctx.fs, ctx.shell, root, { timeoutMs: 5000, maxOutputBytes: 1024 });
    const signal = new AbortController().signal;
    const result = await shell.execute({ action: 'shell', command: windows ? "[Console]::Write('mew'); exit 7" : 'printf mew; exit 7', path: '.' }, signal);
    expect(result).toMatchObject({ location: 'desktop', exitCode: 7, stdout: { text: 'mew' } });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(await shell.execute({ action: 'shell', command: windows ? 'Start-Sleep -Seconds 10' : 'sleep 10' }, signal)).toMatchObject({ timedOut: true });
    const pending = shell.execute({ action: 'shell', command: windows ? "Set-Content -LiteralPath './started' -NoNewline -Value 'ready'; Start-Sleep -Seconds 10" : 'printf ready > started; sleep 10' }, signal);
    await expect.poll(async () => readFile(join(root, 'started'), 'utf8').catch(() => ''), { timeout: 15000 }).toBe('ready');
    shell.revoke();
    expect(await pending).toMatchObject({ aborted: true });
    await expect(shell.execute({ action: 'shell', command: 'echo no' }, signal)).rejects.toThrow('LOCAL_SHELL_REVOKED');
    await expect(shell.execute({ action: 'shell', command: 'echo no', path: '..' }, signal)).rejects.toThrow('LOCAL_PATH_NOT_ALLOWED');
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
}, 15000);
