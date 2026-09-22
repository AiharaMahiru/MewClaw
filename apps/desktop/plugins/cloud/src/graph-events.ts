/** 桌面图事件 Provider：复用官方图与重建通知，输出和首屏一致的组合。 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-modules';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type { ServerResponse } from 'node:http';
import { Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { SessionBootGraph } from './session-boot.js';

export const GRAPH_EVENTS_PATH = '/plugins/events';
type Compose = (graph: SessionBootGraph) => SessionBootGraph;

/** 连接关闭和插件退出均取消订阅，不保留旧 renderer。 */
export function localGraphEvents(ctx: Context, compose: Compose): { handler: WebRoute['handler']; dispose(): void } {
  const connections = new Set<ServerResponse>();
  const dispose = (): void => { for (const response of connections) response.destroy(); connections.clear(); };
  const handler: WebRoute['handler'] = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    const modules = ctx.get('clientModules');
    if (!modules) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    if (req.method === 'HEAD') { res.end(); return; }
    const send = (frame: unknown): void => { res.write(`data: ${JSON.stringify(frame)}\n\n`); };
    const publish = (): void => { send({ type: 'graph', graph: compose(structuredClone(modules.graph())) }); };
    connections.add(res);
    const offGraph = modules.onGraphChanged(publish);
    const offRebuilt = modules.onRebuilt((id, rev) => send({ type: 'rebuilt', id, rev }));
    res.once('close', () => { offGraph(); offRebuilt(); connections.delete(res); });
    publish();
  };
  return { handler, dispose };
}

/** 只转换 SSE graph 帧；分片 UTF-8、心跳和 rebuilt 帧保持完整。 */
export class GraphEventTransform extends Transform {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  constructor(private readonly mapGraph: Compose, private readonly maxBytes: number) { super(); }
  private frame(source: string): string {
    const lines = source.split(/\r?\n/);
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return source;
    const value = JSON.parse(data) as { type?: unknown; graph?: SessionBootGraph };
    if (value.type !== 'graph') return source;
    if (!value.graph || !Array.isArray(value.graph.entries) || !Array.isArray(value.graph.batches)) throw new Error('INVALID_CLOUD_BOOT');
    return [...lines.filter(line => !line.startsWith('data:')), `data: ${JSON.stringify({ ...value, graph: this.mapGraph(value.graph) })}`].join('\n');
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.pending += this.decoder.write(chunk);
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(this.pending))) {
        const frame = this.pending.slice(0, boundary.index);
        if (Buffer.byteLength(frame) > this.maxBytes) throw new Error('CLOUD_GRAPH_TOO_LARGE');
        this.push(this.frame(frame) + '\n\n');
        this.pending = this.pending.slice(boundary.index + boundary[0].length);
      }
      if (Buffer.byteLength(this.pending) > this.maxBytes) throw new Error('CLOUD_GRAPH_TOO_LARGE');
      callback();
    } catch (error) { callback(error as Error); }
  }
  override _flush(callback: TransformCallback): void {
    this.pending += this.decoder.end();
    // 不完整 SSE 帧没有投递语义，不能把未转换的图交给 renderer。
    callback(this.pending.trim() ? new Error('INCOMPLETE_CLOUD_GRAPH_EVENT') : undefined);
  }
}
