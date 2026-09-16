/** 本地模式装配液态玻璃主题：与云端 Worker 同一插件，Host 注入配置，浏览器 bundle 走自有资源路由。 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import * as glass from 'dsh-lark-liquid-glass';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const LOCAL_GLASS_PATH = '/_dsh/desktop/glass-client.js';
export function installLocalGlass(ctx: Context): string {
  const require = createRequire(import.meta.url);
  const client = readFileSync(require.resolve('dsh-lark-liquid-glass/client'));
  ctx.inject(['webServer'], local => {
    // Host apply 只向本地 index 注入配置脚本；云端页面的配置由远端部署自带，不重复注入。
    local.plugin(glass);
    local.effect(() => local.webServer.register({ kind: 'exact', path: LOCAL_GLASS_PATH, handler: (req, res) => {
      const connection = local.get('connection');
      const denied = connection?.requestRejection(req);
      if (!connection || denied !== undefined) { res.writeHead(denied ?? 503); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' }); res.end(client);
    } }));
  });
  return createHash('sha256').update(client).digest('hex').slice(0, 16);
}
