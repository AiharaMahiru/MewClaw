/** 复用 Web 账号客户端，认证请求仍由 CloudProxy 转发到 Auth Edge。 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function installLocalAccount(ctx: Context): string {
  const client = readFileSync(new URL('../web-auth-client.js', import.meta.url));
  ctx.inject(['webServer'], local => {
    local.effect(() => local.webServer.register({ kind: 'exact', path: '/_dsh/desktop/account-client.js', handler: (req, res) => {
      const connection = local.get('connection');
      const denied = connection?.requestRejection(req);
      if (!connection || denied !== undefined) { res.writeHead(denied ?? 503); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' }); res.end(client);
    } }));
  });
  return createHash('sha256').update(client).digest('hex').slice(0, 16);
}
