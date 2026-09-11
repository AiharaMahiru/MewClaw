import { expect, it, vi } from 'vitest';
import { WorkspaceBroker, type WorkspaceState } from './broker.js';

it('旧切换版本不能撤销新授权，失联连接释放容量且保留本机状态', async () => {
  const states = new Map<string, WorkspaceState>();
  const broker = new WorkspaceBroker({ read: id => states.get(id), write: async (id, state) => { states.set(id, state); } },
    { requestTimeoutMs: 1000, heartbeatTimeoutMs: 1000, maxBindings: 1 });
  const identity = { sessionId: 'a', owner: 'scope-a', generation: 'first', revision: '' };
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    await broker.select(identity, 'desktop');
    const revision = broker.status('a', 'scope-a').revision;
    await broker.select({ ...identity, generation: 'second', revision }, 'desktop');
    await expect(broker.select({ ...identity, revision }, 'cloud')).rejects.toThrow('WORKSPACE_REVISION_CONFLICT');
    expect(broker.status('a', 'scope-a').mode).toBe('desktop');
    clock.mockReturnValue(now + 1001);
    await broker.select({ sessionId: 'b', owner: 'scope-b', generation: 'third', revision: '' }, 'desktop');
    expect(broker.status('a', 'scope-a')).toMatchObject({ mode: 'desktop', connected: false });
    expect(broker.status('b', 'scope-b').connected).toBe(true);
  } finally { clock.mockRestore(); broker.dispose(); }
});
