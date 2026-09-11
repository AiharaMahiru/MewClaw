import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceBroker, type WorkspaceState } from './broker.js';

const brokers: WorkspaceBroker[] = [];
afterEach(() => { for (const broker of brokers.splice(0)) broker.dispose(); });
function fixture() {
  const states = new Map<string, WorkspaceState>();
  const journal = { read: (id: string) => states.get(id), write: async (id: string, state: WorkspaceState) => { states.set(id, state); } };
  const limits = { requestTimeoutMs: 100, heartbeatTimeoutMs: 5000, maxBindings: 10 };
  const broker = new WorkspaceBroker(journal, limits); brokers.push(broker);
  const identity = { sessionId: 'session-a', owner: 'scope-a', generation: 'host-secret-a', revision: '' };
  return { broker, journal, limits, identity, signal: new AbortController().signal };
}

describe('云端到本机的有界工作区传输', () => {
  it('请求只投递一次，匹配结果后进入工具结果，重复结果拒绝', async () => {
    const { broker, identity, signal } = fixture();
    await broker.select(identity, 'desktop');
    const response = broker.execute({ ...identity, operation: { action: 'read', path: 'a.txt' } }, signal);
    const request = broker.poll(identity)!;
    expect(request.operation).toEqual({ action: 'read', path: 'a.txt' });
    expect(broker.poll(identity)).toBeNull();
    const result = { id: request.id, ok: true, value: { content: 'example' } };
    broker.result(identity, result);
    expect(await response).toEqual({ content: 'example' });
    expect(() => broker.result(identity, result)).toThrow('WORKSPACE_REQUEST_MISMATCH');
  });
  it('跨账号、旧绑定和错误请求ID不能读取或提交操作', async () => {
    const { broker, identity, signal } = fixture();
    await broker.select(identity, 'desktop');
    const response = broker.execute({ ...identity, operation: {} }, signal);
    expect(() => broker.poll({ ...identity, owner: 'scope-b' })).toThrow('WORKSPACE_OWNER_MISMATCH');
    expect(() => broker.poll({ ...identity, generation: 'old' })).toThrow('WORKSPACE_BINDING_MISMATCH');
    const request = broker.poll(identity)!;
    expect(() => broker.result(identity, { id: 'wrong', ok: true, value: {} })).toThrow('WORKSPACE_REQUEST_MISMATCH');
    broker.result(identity, { id: request.id, ok: true, value: {} }); await response;
  });
  it('操作在途时拒绝切换，断线取消并继续禁止服务器工具', async () => {
    const { broker, identity, signal } = fixture();
    await broker.select(identity, 'desktop');
    const response = broker.execute({ ...identity, operation: {} }, signal);
    const rejection = expect(response).rejects.toThrow('LOCAL_WORKSPACE_DISCONNECTED');
    await expect(broker.select(identity, 'cloud')).rejects.toThrow('WORKSPACE_BUSY');
    broker.disconnect(identity.sessionId); await rejection;
    expect(broker.status(identity.sessionId, identity.owner)).toMatchObject({ mode: 'desktop', connected: false });
    expect(broker.denyTool({ ...identity, tool: 'bash' })).toBe('LOCAL_WORKSPACE_REQUIRES_DESKTOP_FILE_TOOL');
    expect(() => broker.execute({ ...identity, operation: {} }, signal)).toThrow('LOCAL_WORKSPACE_DISCONNECTED');
  });
  it('Worker重启保留本机状态但不恢复连接凭据', async () => {
    const { broker, journal, limits, identity, signal } = fixture();
    await broker.select(identity, 'desktop'); broker.dispose();
    const restored = new WorkspaceBroker(journal, limits); brokers.push(restored);
    expect(restored.status(identity.sessionId, identity.owner)).toMatchObject({ mode: 'desktop', connected: false });
    expect(() => restored.execute({ ...identity, operation: {} }, signal)).toThrow('LOCAL_WORKSPACE_DISCONNECTED');
    expect(journal.read(identity.sessionId)?.generation).not.toBe(identity.generation);
    await restored.select({ ...identity, generation: 'new-host-secret', revision: restored.status(identity.sessionId, identity.owner).revision }, 'desktop');
    expect(() => restored.poll(identity)).toThrow('WORKSPACE_BINDING_MISMATCH');
  });
  it('超时与取消不重放操作，切回云端恢复工具许可', async () => {
    const { broker, identity, signal } = fixture();
    await broker.select(identity, 'desktop');
    await expect(broker.execute({ ...identity, operation: {} }, signal)).rejects.toThrow('WORKSPACE_REQUEST_TIMEOUT');
    expect(broker.poll(identity)).toBeNull();
    const abort = new AbortController();
    const response = broker.execute({ ...identity, operation: {} }, abort.signal);
    const rejection = expect(response).rejects.toThrow('WORKSPACE_REQUEST_CANCELLED');
    abort.abort(); await rejection;
    await broker.select({ ...identity, revision: broker.status(identity.sessionId, identity.owner).revision }, 'cloud');
    expect(broker.denyTool({ ...identity, tool: 'bash' })).toBeUndefined();
  });
});
