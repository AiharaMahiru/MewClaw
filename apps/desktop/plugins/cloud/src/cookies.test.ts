import { describe, expect, it } from 'vitest';
import { desktopSessionCookie } from './cookies.js';

describe('桌面认证保持', () => {
  it('保存认证与CSRF对并保留安全属性', () => {
    for (const name of ['__Host-dsh_session', 'dsh_session', 'dsh_csrf']) {
      const cookie = name + '=fake; Path=/; Secure; HttpOnly; SameSite=Lax';
      expect(desktopSessionCookie(cookie, 3600)).toBe(cookie + '; Max-Age=3600');
    }
  });
  it.each(['Max-Age=0', 'max-age=60', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'])('尊重服务器 %s', expiry => {
    const cookie = 'dsh_session=; Path=/; ' + expiry;
    expect(desktopSessionCookie(cookie, 3600)).toBe(cookie);
  });
  it('不持久化本地连接、OAuth临时状态或其他Cookie', () => {
    for (const name of ['dsh-auth-local', 'dsh_oauth_state', 'unrelated']) {
      expect(desktopSessionCookie(name + '=fake', 3600)).toBe(name + '=fake');
    }
    expect(desktopSessionCookie('dsh_session=fake', 0)).toBe('dsh_session=fake');
  });
});
