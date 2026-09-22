// @vitest-environment jsdom
/* 过渡面运行时在 jsdom 中直接执行序列化源码，验证解析期行为。 */
import { expect, it, vi } from 'vitest';
import { SWITCH_FLAG_KEY, SWITCH_SPLASH_SOURCE } from './switch-splash.js';

function run(): void { new Function(SWITCH_SPLASH_SOURCE)(); }

it('没有切换意图时完全静默，不触碰文档', () => {
  run();
  expect(document.getElementById('mewclaw-location-splash')).toBeNull();
  expect(document.documentElement.style.background).toBe('');
});

it('有意图时立即铺开过渡面，#root 有内容后淡出并清除意图', async () => {
  sessionStorage.setItem(SWITCH_FLAG_KEY, JSON.stringify({ to: 'local', bg: 'rgb(32, 33, 36)', ink: 'rgb(232, 234, 239)' }));
  run();
  const splash = document.getElementById('mewclaw-location-splash');
  expect(splash?.textContent).toContain('本地');
  expect(sessionStorage.getItem(SWITCH_FLAG_KEY)).toBeNull();
  expect(document.documentElement.style.background).not.toBe('');
  const root = document.createElement('div');
  root.id = 'root';
  root.appendChild(document.createElement('span'));
  document.body.appendChild(root);
  await vi.waitFor(() => {
    expect(document.getElementById('mewclaw-location-splash')?.style.opacity).toBe('0');
  }, { timeout: 3000 });
});

it('意图损坏时按默认色继续且不阻断启动', () => {
  sessionStorage.setItem(SWITCH_FLAG_KEY, '{broken');
  run();
  const splash = document.getElementById('mewclaw-location-splash');
  expect(splash).not.toBeNull();
  expect(splash?.getAttribute('style')).toContain('#17181c');
});

it('非法颜色回落默认色，不注入任意 CSS', () => {
  sessionStorage.setItem(SWITCH_FLAG_KEY, JSON.stringify({ to: 'cloud', bg: 'url(evil)', ink: 'expression(1)' }));
  run();
  const style = document.getElementById('mewclaw-location-splash')?.getAttribute('style') ?? '';
  expect(style).toContain('#17181c');
  expect(style).toContain('#e8eaef');
  expect(style).not.toContain('evil');
});

it('减少动态效果偏好关闭旋转和淡出动画', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  sessionStorage.setItem(SWITCH_FLAG_KEY, JSON.stringify({ to: 'local' }));
  run();
  expect(document.getElementById('mewclaw-location-splash')?.getAttribute('style')).toContain('opacity 0ms');
  vi.unstubAllGlobals();
});

it.each(['rgba(32, 33, 36, 0)', 'rgba(32, 33, 36, 0.5)', '#abcd', '#11223380', 'transparent'])('过渡面拒绝透明色 %s，挡住下层启动画面', (color) => {
  sessionStorage.setItem(SWITCH_FLAG_KEY, JSON.stringify({ to: 'local', bg: color, ink: color }));
  run();
  const style = document.getElementById('mewclaw-location-splash')?.getAttribute('style');
  expect(style).toContain('background:#17181c');
  expect(style).toContain('color:#e8eaef');
});
