/** 仅为云端认证会话补充桌面保存期限；服务端仍决定会话是否有效。 */
const AUTH_COOKIES = new Set(['dsh_session', '__Host-dsh_session', 'dsh_csrf']);

export function desktopSessionCookie(cookie: string, retentionSeconds: number): string {
  const name = cookie.slice(0, cookie.indexOf('=')).trim();
  if (!AUTH_COOKIES.has(name) || retentionSeconds === 0) return cookie;
  // 尊重服务端显式过期和退出登录指令，不延长或复活已删除凭据。
  if (/;\s*(?:max-age|expires)\s*=/i.test(cookie)) return cookie;
  return cookie + '; Max-Age=' + retentionSeconds;
}
