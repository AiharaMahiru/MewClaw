import { expect, it } from 'vitest';
import { WorkspaceController } from './workspace-controller.js';

it('退出登录期间返回的状态不能继续解除或创建授权', async () => {
  const controller = new WorkspaceController({
    fs: () => { throw new Error('UNEXPECTED_FS'); },
    pick: async () => { throw new Error('UNEXPECTED_PICK'); },
    maxBytes: 1024, maxEntries: 10,
  });
  for (const mode of ['cloud', 'desktop'] as const) {
    let complete!: (value: Record<string, unknown>) => void;
    let calls = 0;
    const pending = controller.select({ sessionId: 'session', mode }, async () => {
      calls++;
      return new Promise(resolve => { complete = resolve; });
    });
    controller.revokeAll();
    complete({ accountId: 'account', revision: 'revision' });
    await expect(pending).rejects.toThrow();
    expect(calls).toBe(1);
  }
  controller.dispose();
});
