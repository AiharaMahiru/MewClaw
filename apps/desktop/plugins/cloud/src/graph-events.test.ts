import { expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { GraphEventTransform, localGraphEvents } from './graph-events.js';
import { composeSessionGraph, sessionLocationHtml, type SessionBootGraph } from './session-boot.js';

const graph: SessionBootGraph = { rev: 'host', entries: [
  { id: '@deepseek-ai/dsh-client-ui-sidebar', url: '/sidebar', rev: '1' },
  { id: '@deepseek-ai/dsh-client-ui-settings', url: '/settings', rev: '1' },
  { id: 'dsh-plugin-desktop', url: '/desktop', rev: '1', inject: ['@deepseek-ai/dsh-client-ui-settings'] },
], batches: [] };

async function collect(chunks: Buffer[], transform: GraphEventTransform): Promise<string> {
  Readable.from(chunks).pipe(transform);
  let output = '';
  for await (const chunk of transform) output += chunk;
  return output;
}

it('分片 SSE 与首屏输出相同插件图，保留重建通知和中文', async () => {
  const options = { location: 'local' as const, locationRevision: '位置', accountRevision: 'account', brandRevision: 'brand' };
  const html = sessionLocationHtml(`<script>globalThis["__DSH_BOOT__"] = ${JSON.stringify(graph)};</script>`, options);
  const expected = JSON.parse(html.split('globalThis["__DSH_BOOT__"] = ')[1]!.split(';</script>')[0]!);
  const source = Buffer.from(`: ping\r\n\r\ndata: ${JSON.stringify({ type: 'graph', graph })}\r\n\r\ndata: {"type":"rebuilt","id":"中文","rev":"2"}\n\n`);
  const result = await collect([...source].map(byte => Buffer.from([byte])), new GraphEventTransform(value => composeSessionGraph(value, options), 10000));
  const frames = result.split('\n\n');
  expect(frames[0]).toBe(': ping');
  expect(JSON.parse(frames[1]!.replace(/^data: /, ''))).toEqual({ type: 'graph', graph: expected });
  expect(frames[2]).toBe('data: {"type":"rebuilt","id":"中文","rev":"2"}');
});

it('拒绝损坏、超长和未完成的图帧，不把未适配数据交给客户端', async () => {
  for (const input of ['data: {oops}\n\n', 'data: {"type":"graph","graph":{}}\n\n', 'data: {}'.repeat(20), 'data: {"type":"graph"}']) {
    await expect(collect([Buffer.from(input)], new GraphEventTransform(value => value, 100))).rejects.toThrow();
  }
});

it('图事件路由释放时关闭连接并撤销 Host 订阅', async () => {
  const offGraph = vi.fn(), offRebuilt = vi.fn();
  const source = { graph: () => graph, onGraphChanged: () => offGraph, onRebuilt: () => offRebuilt };
  const events = localGraphEvents({ get: () => source } as unknown as Context, value => composeSessionGraph(value, { location: 'local', locationRevision: '1' }));
  const server = createServer(events.handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('NO_ADDRESS');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}`);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('dsh-lark-desktop-location-client');
    events.dispose();
    await expect(reader.read()).rejects.toThrow();
    await vi.waitFor(() => { expect(offGraph).toHaveBeenCalledOnce(); expect(offRebuilt).toHaveBeenCalledOnce(); });
  } finally {
    events.dispose(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
