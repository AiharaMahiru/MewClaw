// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { sessionUiStateScript } from './session-ui-state.js';

it('云端与本地往返恢复各自选中会话，不复制账号配置', () => {
  localStorage.clear();
  localStorage.setItem('dsh.sessions.current', 'cloud-session');
  localStorage.setItem('dsh.auth.account.v1', 'account');
  new Function(sessionUiStateScript('local'))();
  expect(localStorage.getItem('dsh.sessions.current')).toBeNull();
  localStorage.setItem('dsh.sessions.current', 'local-session');
  new Function(sessionUiStateScript('cloud'))();
  expect(localStorage.getItem('dsh.sessions.current')).toBe('cloud-session');
  new Function(sessionUiStateScript('local'))();
  expect(localStorage.getItem('dsh.sessions.current')).toBe('local-session');
  expect(localStorage.getItem('dsh.auth.account.v1')).toBe('account');
});
