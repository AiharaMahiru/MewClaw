/** 本地使用与 Web 相同的品牌 Provider，浏览器代码通过自有资源路由提供。 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import * as brand from 'dsh-lark-atw-brand';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const LOCAL_BRAND_PATH = '/_dsh/desktop/brand-client.js';
export function installLocalBrand(ctx: Context): string {
  const require = createRequire(import.meta.url);
  const client = readFileSync(require.resolve('dsh-lark-atw-brand/client'));
  ctx.inject(['webServer'], local => {
    local.plugin(brand);
    local.effect(() => local.webServer.register({ kind: 'exact', path: LOCAL_BRAND_PATH, handler: (req, res) => {
      const connection = local.get('connection');
      const denied = connection?.requestRejection(req);
      if (!connection || denied !== undefined) { res.writeHead(denied ?? 503); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' }); res.end(client);
    } }));
  });
  return createHash('sha256').update(client).digest('hex').slice(0, 16);
}
