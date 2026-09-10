import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, unlink, symlink, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NodeSyncDirectory } from './sync-directory.js';
import { SyncEngine } from './sync.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const limits = { maxBytes: 4096, maxEntries: 20, maxTotalBytes: 8192 };
const signal = new AbortController().signal;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mewclaw-sync-')); roots.push(root);
  const a = join(root, 'a'), b = join(root, 'b'); await mkdir(a); await mkdir(b);
  const left = await NodeSyncDirectory.create(a, limits), right = await NodeSyncDirectory.create(b, limits);
  return { a, b, left, right, engine: new SyncEngine(left, right) };
}
it('真实目录双向复制二进制和嵌套文件，单边更新和删除保留恢复版本', async () => {
  const { a, b, engine } = await fixture();
  await mkdir(join(a, 'nested')); await writeFile(join(a, 'nested/image.bin'), Buffer.from([0, 255, 1]));
  await writeFile(join(b, 'remote.txt'), '云端创建');
  expect(await engine.run(signal)).toEqual({ transferred: 2, removed: 0, conflicts: [] });
  expect(await readFile(join(b, 'nested/image.bin'))).toEqual(Buffer.from([0, 255, 1]));
  await writeFile(join(a, 'remote.txt'), '本机修改');
  expect((await engine.run(signal)).transferred).toBe(1);
  expect(await readFile(join(b, 'remote.txt'), 'utf8')).toBe('本机修改');
  await unlink(join(b, 'remote.txt'));
  expect((await engine.run(signal)).removed).toBe(1);
  const backups = (await readdir(join(a, '.mewclaw-sync/recovery'))).filter(name => name.endsWith('.data'));
  expect(await readFile(join(a, '.mewclaw-sync/recovery', backups[0]!), 'utf8')).toBe('本机修改');
  expect(JSON.parse(await readFile(join(a, '.mewclaw-sync/recovery', backups[0]! + '.json'), 'utf8'))).toMatchObject({ path: 'remote.txt' });
});
it('两边同时修改、首次同名异内容和删除对修改均保留冲突', async () => {
  const { a, b, engine } = await fixture();
  await writeFile(join(a, 'x'), 'base'); await engine.run(signal);
  await writeFile(join(a, 'x'), 'left'); await writeFile(join(b, 'x'), 'right');
  expect((await engine.run(signal)).conflicts).toEqual(['x']);
  expect(await readFile(join(a, 'x'), 'utf8')).toBe('left');
  await unlink(join(a, 'x')); expect((await engine.run(signal)).conflicts).toEqual(['x']);
});
it('凭证和状态默认排除，根外符号链接、父路径、大小写碰撞与超限明确拒绝', async () => {
  const { a, b, left } = await fixture();
  await writeFile(join(a, '.env'), 'excluded'); expect(await left.snapshot(signal)).toEqual({});
  await expect(left.write('../outside', '', null, signal)).rejects.toThrow('SYNC_PATH_REJECTED');
  await expect(left.write('.env.local', '', null, signal)).rejects.toThrow('SYNC_PATH_REJECTED');
  await symlink(b, join(a, 'escape')); await expect(left.snapshot(signal)).rejects.toThrow('SYNC_PATH_REJECTED');
  await unlink(join(a, 'escape')); await writeFile(join(a, 'X'), 'a'); await writeFile(join(a, 'x'), 'b');
  const caseEntries = (await readdir(a)).filter(name => !name.startsWith('.env'));
  if (caseEntries.length === 2) await expect(left.snapshot(signal)).rejects.toThrow('SYNC_CASE_COLLISION');
  await unlink(join(a, caseEntries[0]!)); await writeFile(join(a, 'x'), Buffer.alloc(4097));
  await expect(left.snapshot(signal)).rejects.toThrow('SYNC_LIMIT');
});
it('旧摘要写入和并发创建不能覆盖文件，取消不开始新写入', async () => {
  const { a, left } = await fixture();
  await writeFile(join(a, 'x'), 'base'); const original = (await left.snapshot(signal)).x!;
  await writeFile(join(a, 'x'), 'external');
  await expect(left.write('x', Buffer.from('new').toString('base64'), original.hash, signal)).rejects.toThrow('SYNC_CONFLICT');
  await expect(left.write('x', '', null, signal)).rejects.toThrow('SYNC_CONFLICT');
  expect(await readFile(join(a, 'x'), 'utf8')).toBe('external');
  const abort = new AbortController(); abort.abort();
  await expect(left.write('new', '', null, abort.signal)).rejects.toThrow();
});

it('跨端大小写碰撞在任何写入前拒绝', async () => {
  const { a, b, engine } = await fixture();
  await writeFile(join(a, 'File'), 'a'); await writeFile(join(b, 'file'), 'b');
  await expect(engine.run(signal)).rejects.toThrow('SYNC_CASE_COLLISION');
  expect(await readdir(a)).toEqual(['File']); expect(await readdir(b)).toEqual(['file']);
});
