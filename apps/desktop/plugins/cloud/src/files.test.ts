import { afterEach, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import LocalFileSystem from '@deepseek-ai/dsh-fs-local';
import { mkdtemp, writeFile, mkdir, symlink, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalWorkspaceFiles, parseFileOperation } from './files.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const task of cleanup.splice(0).reverse()) await task(); });
async function fixture(maxBytes = 1024) {
  const parent = await mkdtemp(join(tmpdir(), 'mewclaw-local-files-'));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'workspace'); await mkdir(root);
  const ctx = new Context(); await ctx.plugin(LocalFileSystem, { cwd: root });
  cleanup.push(() => ctx.fiber.dispose());
  const files = await LocalWorkspaceFiles.create(ctx.fs, root, { maxBytes, maxEntries: 20 });
  return { files, root, parent, signal: new AbortController().signal };
}

describe('官方 FileSystem 本地目录 Consumer', () => {
  it('创建、读取和带版本替换真实文件', async () => {
    const { files, root, signal } = await fixture();
    await files.execute({ action: 'write', path: 'hello.txt', content: '你好' }, signal);
    const result = await files.execute({ action: 'read', path: 'hello.txt' }, signal) as { version: string; content: string };
    expect(result.content).toBe('你好');
    await files.execute({ action: 'write', path: 'hello.txt', content: '已更新', version: result.version }, signal);
    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('已更新');
    expect(await files.execute({ action: 'list', path: '.' }, signal)).toMatchObject({ entries: [{ name: 'hello.txt', type: 'file' }] });
  });
  it('拒绝没有版本的覆盖与过期版本写入', async () => {
    const { files, root, signal } = await fixture();
    await writeFile(join(root, 'a.txt'), '原文');
    const result = await files.execute({ action: 'read', path: 'a.txt' }, signal) as { version: string };
    await expect(files.execute({ action: 'write', path: 'a.txt', content: '覆盖' }, signal)).rejects.toThrow();
    await writeFile(join(root, 'a.txt'), '其他进程更新后的原文');
    await expect(files.execute({ action: 'write', path: 'a.txt', content: '覆盖', version: result.version }, signal)).rejects.toThrow();
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('其他进程更新后的原文');
  });
  it('拒绝越界路径和根外符号链接', async () => {
    const { files, root, parent, signal } = await fixture();
    await writeFile(join(parent, 'private.txt'), 'outside');
    await symlink(join(parent, 'private.txt'), join(root, 'link.txt'));
    for (const path of ['../private.txt', '/etc/passwd', 'C:\\private.txt', 'link.txt']) {
      await expect(files.execute({ action: 'read', path }, signal)).rejects.toThrow('LOCAL_PATH_NOT_ALLOWED');
    }
  });
  it('拒绝超限读写及撤销后的请求', async () => {
    const { files, root, signal } = await fixture(4);
    await writeFile(join(root, 'big.txt'), '12345');
    await expect(files.execute({ action: 'read', path: 'big.txt' }, signal)).rejects.toThrow('LOCAL_FILE_TOO_LARGE');
    await expect(files.execute({ action: 'write', path: 'new.txt', content: '12345' }, signal)).rejects.toThrow('LOCAL_FILE_TOO_LARGE');
    files.dispose();
    await expect(files.execute({ action: 'list', path: '.' }, signal)).rejects.toThrow('LOCAL_WORKSPACE_REVOKED');
  });
  it('拒绝协议额外字段和非写操作正文', () => {
    expect(() => parseFileOperation({ action: 'read', path: 'a', command: 'bad' })).toThrow();
    expect(() => parseFileOperation({ action: 'read', path: 'a', content: 'bad' })).toThrow();
  });
});
