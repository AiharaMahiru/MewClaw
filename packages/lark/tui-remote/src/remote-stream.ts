import { randomUUID } from 'node:crypto';

import { RemoteClientError, normalizeErrorCode } from './errors.js';
import type { StreamOptions, WebSocketFactory, WebSocketLike } from './types.js';

/** `/api/remote.mux` 的最小安全客户端；认证由调用方注入的 WebSocket 工厂完成。 */
export class RemoteStreamTransport {
  constructor(
    private readonly factory: WebSocketFactory | undefined,
    private readonly url: string,
    private readonly headers: Readonly<Record<string, string>>,
  ) {}

  open(endpoint: string, payload: unknown, options: StreamOptions = {}): AsyncIterable<unknown> {
    if (!this.factory) throw new RemoteClientError('STREAM_FAILED');
    if (!validEndpoint(endpoint)) throw new RemoteClientError('INVALID_ENDPOINT');
    return this.consume(endpoint, payload, options);
  }

  private async *consume(endpoint: string, initialPayload: unknown, options: StreamOptions): AsyncGenerator<unknown> {
    const signal = options.signal;
    let payload = initialPayload;
    let reconnects = 0;
    let lastItem: unknown;
    while (true) {
      if (signal?.aborted) return;
      try {
        for await (const item of this.openOnce(endpoint, payload, signal)) {
          lastItem = item;
          yield item;
        }
        return;
      } catch (error) {
        if (signal?.aborted) return;
        if (reconnects >= (options.maxReconnects ?? 0)) throw normalizeStreamError(error);
        reconnects += 1;
        if (options.resumePayload) payload = options.resumePayload(lastItem);
      }
    }
  }

  private async *openOnce(endpoint: string, payload: unknown, signal?: AbortSignal): AsyncGenerator<unknown> {
    const streamId = randomUUID();
    const socket = await this.factory!(this.url, { headers: this.headers, signal: signal ?? new AbortController().signal });
    const queue = new AsyncQueue<StreamFrame>();
    const disposers: Array<() => void> = [];
    let ended = false;
    let opened = false;
    const dispose = (): void => { for (const remove of disposers.splice(0)) remove(); };
    const fail = (error: RemoteClientError): void => queue.fail(error);
    const onOpen = (): void => {
      if (opened) return;
      opened = true;
      try { socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload })); }
      catch { fail(new RemoteClientError('STREAM_DISCONNECTED')); }
    };
    const onMessage = (event: unknown, ...rest: unknown[]): void => {
      const raw = messageData(event, rest[0]);
      if (raw === undefined) { fail(new RemoteClientError('STREAM_FAILED')); return; }
      let frame: unknown;
      try { frame = JSON.parse(raw) as unknown; } catch { fail(new RemoteClientError('STREAM_FAILED')); return; }
      const parsed = parseFrame(frame, streamId);
      if (parsed instanceof RemoteClientError) { fail(parsed); return; }
      if (parsed.type === 'end') ended = true;
      queue.push(parsed);
    };
    const onError = (): void => fail(new RemoteClientError('STREAM_DISCONNECTED'));
    const onClose = (): void => { if (!ended) fail(new RemoteClientError('STREAM_DISCONNECTED')); else queue.end(); };
    disposers.push(attach(socket, 'open', onOpen));
    disposers.push(attach(socket, 'message', onMessage));
    disposers.push(attach(socket, 'error', onError));
    disposers.push(attach(socket, 'close', onClose));
    const abort = (): void => {
      try { socket.send(JSON.stringify({ type: 'cancel', streamId })); } catch { /* 已断线。 */ }
      try { socket.close(1000, 'cancelled'); } catch { /* 已关闭。 */ }
      queue.end();
    };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      disposers.push(() => signal.removeEventListener('abort', abort));
    }
    // 注入工厂可能返回已打开的 socket，不会再触发 open 事件。
    if (socket.readyState === 1) onOpen();
    try {
      while (true) {
        const next = await queue.next();
        if (next.done) return;
        if (next.value.type === 'item') yield next.value.value;
        else if (next.value.type === 'error') throw new RemoteClientError(next.value.code);
        else return;
      }
    } finally {
      dispose();
      if (!ended && !signal?.aborted) {
        try { socket.send(JSON.stringify({ type: 'cancel', streamId })); } catch { /* 已断线。 */ }
      }
      try { socket.close(1000, 'complete'); } catch { /* 已关闭。 */ }
    }
  }
}

type StreamFrame =
  | { readonly type: 'item'; readonly value: unknown }
  | { readonly type: 'error'; readonly code: string }
  | { readonly type: 'end' };

class AsyncQueue<T> {
  private values: T[] = [];
  private waiters: Array<{ resolve: (result: IteratorResult<T>) => void; reject: (error: Error) => void }> = [];
  private failure: Error | undefined;
  private closed = false;

  push(value: T): void {
    if (this.closed || this.failure) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }
  end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }
  fail(error: Error): void {
    if (this.closed || this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
  next(): Promise<IteratorResult<T>> {
    if (this.failure) return Promise.reject(this.failure);
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

function attach(socket: WebSocketLike, type: string, listener: (event: unknown, ...rest: unknown[]) => void): () => void {
  if (socket.addEventListener) {
    socket.addEventListener(type, listener);
    return () => socket.removeEventListener?.(type, listener);
  }
  if (socket.on) {
    socket.on(type, listener);
    return () => socket.off?.(type, listener);
  }
  const key = `on${type}` as 'onopen' | 'onmessage' | 'onerror' | 'onclose';
  const previous = socket[key];
  socket[key] = listener;
  return () => { if (socket[key] === listener) socket[key] = previous ?? null; };
}

function messageData(event: unknown, fallback: unknown): string | undefined {
  const value = event && typeof event === 'object' && 'data' in event ? (event as { data?: unknown }).data : event ?? fallback;
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  return undefined;
}

function parseFrame(value: unknown, streamId: string): StreamFrame | RemoteClientError {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new RemoteClientError('STREAM_FAILED');
  const record = value as Record<string, unknown>;
  if (record.streamId !== streamId || typeof record.type !== 'string') return new RemoteClientError('STREAM_FAILED');
  if (record.type === 'item') return { type: 'item', value: record.value };
  if (record.type === 'end') return { type: 'end' };
  if (record.type === 'error') {
    const error = record.error;
    const code = error && typeof error === 'object' && !Array.isArray(error) ? (error as Record<string, unknown>).code : undefined;
    return { type: 'error', code: normalizeErrorCode(code, 'STREAM_FAILED') };
  }
  return new RemoteClientError('STREAM_FAILED');
}

function validEndpoint(value: string): boolean { return typeof value === 'string' && /^[A-Za-z0-9_$.-]+(?:\/[A-Za-z0-9_$.-]+)*$/u.test(value) && value.length <= 256; }
function normalizeStreamError(value: unknown): RemoteClientError { return value instanceof RemoteClientError ? value : new RemoteClientError('STREAM_FAILED'); }
