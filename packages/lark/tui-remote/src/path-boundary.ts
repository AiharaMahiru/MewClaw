import { RemoteClientError } from './errors.js';

/** 以词法方式检查工作区路径，同时接受 POSIX 与 Windows 路径。 */
export function assertWorkspacePath(path: string, root: string): string {
  if (typeof path !== 'string' || typeof root !== 'string' || !path || !root) throw new RemoteClientError('WORKSPACE_PATH_NOT_ALLOWED');
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(path);
  const within = normalizedRoot === '/' ? normalizedPath.startsWith('/') : normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
  if (!within) throw new RemoteClientError('WORKSPACE_PATH_NOT_ALLOWED');
  return path;
}

/** 本地文件操作只接受相对路径，拒绝绝对路径、盘符和 traversal。 */
export function assertRelativeWorkspacePath(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new RemoteClientError('WORKSPACE_PATH_NOT_ALLOWED');
  const candidate = value.replaceAll('\\', '/');
  if (candidate.startsWith('/') || /^[A-Za-z]:\//u.test(candidate)) throw new RemoteClientError('WORKSPACE_PATH_NOT_ALLOWED');
  const parts = candidate.split('/');
  if (parts.some(part => part === '..' || part === '')) throw new RemoteClientError('WORKSPACE_PATH_NOT_ALLOWED');
  return candidate;
}

function normalizePath(value: string): string {
  const slash = value.replaceAll('\\', '/');
  const drive = /^[A-Za-z]:/u.test(slash);
  const prefix = drive ? slash.slice(0, 2).toLowerCase() : slash.startsWith('/') ? '/' : '';
  const parts = slash.split('/');
  const output: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') { if (output.length > 0 && output.at(-1) !== '..') output.pop(); else if (!prefix) output.push('..'); }
    else output.push(drive ? part.toLowerCase() : part);
  }
  const joined = output.join('/');
  if (prefix === '/') return `/${joined}` || '/';
  if (drive) return `${prefix}/${joined}`;
  return joined || '.';
}
