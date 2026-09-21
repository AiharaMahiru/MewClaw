/** 本地 preset 物化：布局、include 重写、幂等与官方发现链路。 */
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { materializeLocalPresets } from './local-presets.js';

it('物化云端 preset 集并按云端序接入三根', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mewclaw-presets-'));
  const dest = materializeLocalPresets(home)!;
  expect(dest).toBe(join(home, 'mewclaw-presets'));
  // 与云端 cordis.patch.yml 同序：lightweight → agent-presets → 官方 shipped。
  expect(readdirSync(join(dest, 'agent-presets-lightweight'))).toEqual(['lark-lightweight']);
  expect(readdirSync(join(dest, 'agent-presets')).sort()).toEqual(['cordis', 'lark-standard', 'liangshen']);
  // lark-standard 的 include 被改写为已安装官方包内的绝对路径（不再是相对 ../ 链）。
  const composed = readFileSync(join(dest, 'agent-presets', 'lark-standard', 'agent.cordis.yml'), 'utf8');
  expect(composed).toMatch(/path: '.*dsh-agent-presets.presets.standard.agent\.cordis\.yml'/);
  expect(composed).not.toMatch(/path:.*\.\.\//);
  // liangshen 的 oci-pipe-bash 相对引用落在物化树内。
  expect(existsSync(join(dest, 'agent-presets-oci', 'pipe-bash.mjs'))).toBe(true);
  expect(existsSync(join(dest, 'tool-schema.mjs'))).toBe(true);
  // 幂等：指纹未变不重复拷贝。
  const second = materializeLocalPresets(home);
  expect(second).toBe(dest);
});

it('物化结果经官方 discoverPresets 全部健康', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mewclaw-presets-'));
  const dest = materializeLocalPresets(home)!;
  const { discoverPresets } = await import('@deepseek-ai/dsh-agent-presets');
  const { pathToFileURL } = await import('node:url');
  const { createRequire } = await import('node:module');
  const { dirname } = await import('node:path');
  // 裸 specifier 从宿主组合基址解析；用已安装 dsh-agent-presets 所在包根
  // 充当 harnessBase（与生产 profile 的解析域一致）。
  const require2 = createRequire(import.meta.url);
  const harnessBase = pathToFileURL(join(dirname(require2.resolve('@deepseek-ai/dsh-agent-presets/package.json')), 'x')).href;
  const shipped = join(dirname(require2.resolve('@deepseek-ai/dsh-agent-presets/package.json')), 'presets');
  const roots = [
    { path: join(dest, 'agent-presets-lightweight'), trust: 'system' as const },
    { path: join(dest, 'agent-presets'), trust: 'system' as const },
    { path: shipped, trust: 'system' as const },
  ];
  const presets = await discoverPresets(roots, harnessBase);
  const broken = presets.filter(p => p.broken);
  expect(broken).toEqual([]);
  // 与云端同集同序（根序 lightweight → agent-presets → shipped；cordis 由
  // shipped 拷入 agent-presets 根以保持云端目录序位）。
  expect(presets.map(p => p.id).sort()).toEqual(['cordis', 'lark-lightweight', 'lark-standard', 'liangshen', 'minimal', 'ptc', 'standard']);
  expect(presets[0]?.id).toBe('lark-lightweight');
  expect(presets.slice(-3).map(p => p.id)).toEqual(['standard', 'ptc', 'minimal']);
});
