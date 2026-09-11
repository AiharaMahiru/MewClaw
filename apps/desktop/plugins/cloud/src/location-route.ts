import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseLocation, type LocationPreference } from './location.js';

/** 控制面只接受本机认证请求；模式在原生重启后才生效。 */
export function locationRoute(options: {
  preference: LocationPreference;
  reject(req: IncomingMessage): number | undefined;
  restart(): Promise<() => void>;
}) {
  let changing = false;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    const rejection = options.reject(req);
    if (rejection !== undefined) return send(rejection, { error: 'DESKTOP_UNAUTHORIZED' });
    if (req.method === 'GET') return send(200, { location: options.preference.location });
    if (req.method !== 'POST') return send(405, { error: 'METHOD_NOT_ALLOWED' });
    if (req.headers.origin !== `http://${req.headers.host}`) return send(403, { error: 'DESKTOP_UNAUTHORIZED' });
    if (changing) return send(409, { error: 'LOCATION_CHANGING' });
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 256) throw new Error('INVALID_LOCATION');
      }
      const value = JSON.parse(body);
      if (!value || Object.keys(value).some(key => key !== 'location')) throw new Error('INVALID_LOCATION');
      const location = parseLocation(value.location);
      if (location === options.preference.location) return send(200, { location });
      if (changing) return send(409, { error: 'LOCATION_CHANGING' });
      changing = true;
      await options.preference.save(location);
      const restart = await options.restart();
      // 先结束控制面响应，再触发官方 before-quit 清理，避免等待自身连接。
      res.once('finish', () => setImmediate(restart));
      send(202, { location, restarting: true });
    } catch (error) {
      if (changing) await options.preference.save(options.preference.location).catch(() => {});
      changing = false;
      if (!res.writableEnded) send(409, { error: error instanceof Error && error.message === 'INVALID_LOCATION' ? 'INVALID_LOCATION' : 'LOCATION_SAVE_FAILED' });
    }
  };
}
