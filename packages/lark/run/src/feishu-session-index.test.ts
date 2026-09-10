import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessageId } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionLogOffset, SessionSeq, type SessionHeader } from "@deepseek-ai/dsh-session";
import type { SessionInspection } from "@deepseek-ai/dsh-session-persistence";
import type { ProjectionSnapshot } from "@deepseek-ai/dsh-session-projection";
import { describe, expect, it, vi } from "vitest";

import {
  attachFeishuSession,
  feishuPromptTitle,
  feishuWorkspaceTitle,
  indexFeishuSessions,
  isFeishuSessionId,
  shortFeishuSessionKey,
  updateFeishuWorkspaceTitle,
} from "./feishu-session-index.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dsh-feishu-index-"));
}

function header(id: SessionId, cwd: string): SessionHeader {
  return { version: 3, id, cwd, createdAt: 1, isSeeded: false };
}

function inspection(meta: SessionHeader, prompt?: string): SessionInspection {
  return {
    meta,
    inheritedEventCount: SessionLogOffset(0),
    events: prompt ? [{
      seq: SessionSeq(0), time: 1, type: "user/message",
      surfaceOp: "append",
      data: {
        role: "user", id: MessageId("message-index-test"),
        source: { kind: "user" }, content: [{ type: "text", text: prompt }],
      },
    }] : [],
  };
}

describe("Feishu session index", () => {
  it("只识别 deterministic Feishu session id，并生成短 workspace 名", () => {
    const id = `session-${"c221a1963f38bef5d502ece218cb8a3c88b5381d7293fa27410f270cba37095d"}`;
    expect(isFeishuSessionId(id)).toBe(true);
    expect(isFeishuSessionId(`${id}:1`)).toBe(true);
    expect(isFeishuSessionId("session-8a5c6f28-a30c-0127-a987-0fb3e7425f17")).toBe(false);
    expect(shortFeishuSessionKey(id)).toBe("c221a196");
    expect(feishuWorkspaceTitle(id)).toBe("飞书 · c221a196");
    expect(feishuPromptTitle("  整理\nCSV\t文件并生成报告  ")).toBe("整理 CSV 文件并生成报告");
    expect(feishuPromptTitle("\u0000\u001b[31m")).toBe("飞书会话");
  });

  it("创建并 attach 隔离 workspace，同时预热冷会话投影", async () => {
    const root = await makeRoot();
    const workspace = join(root, "c221");
    await mkdir(workspace);
    const id = `session-${"c".repeat(64)}` as SessionId;
    const other = "session-12345678-1234-1234-1234-123456789012" as SessionId;
    const create = vi.fn(async () => ({
      title: "飞书 · 旧标题",
      attachSession: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
    }));
    const meta = header(id, workspace);
    const inspected = inspection(meta);
    const coldSnapshot = vi.fn((): ProjectionSnapshot => ({ asOfSeq: -1, values: { title: "你好" } }));

    const result = await indexFeishuSessions({
      persistence: {
        list: vi.fn(async () => [
          meta,
          header(other, workspace),
          header(SessionId(id + ":1"), join(root, "missing")),
        ]),
        inspect: vi.fn(async () => inspected),
      },
      registry: { create },
      projectionCache: { coldSnapshot, write: vi.fn(async () => undefined) },
      workspaceRoot: root,
    });

    expect(result).toEqual({ candidates: 1, indexed: 1, prewarmed: 1, cacheFailures: 0 });
    expect(create).toHaveBeenCalledWith(workspace, "飞书 · 你好");
    expect(coldSnapshot).toHaveBeenCalledWith(meta, SessionLogOffset(0), inspected.events);
  });

  it("冷快照没有标题时，从首条合法 user/message 恢复可读标题", async () => {
    const root = await makeRoot();
    const workspace = join(root, "fallback");
    await mkdir(workspace);
    const id = `session-${"d".repeat(64)}` as SessionId;
    const create = vi.fn(async () => ({ attachSession: vi.fn(async () => undefined) }));
    const meta = header(id, workspace);
    const inspect = vi.fn(async () => inspection(meta, "实现报表导出"));

    await indexFeishuSessions({
      persistence: { list: vi.fn(async () => [meta]), inspect },
      registry: { create },
      projectionCache: {
        coldSnapshot: vi.fn((): ProjectionSnapshot => ({ asOfSeq: -1, values: { title: null } })),
        write: vi.fn(async () => undefined),
      },
      workspaceRoot: root,
    });

    expect(inspect).toHaveBeenCalledWith(id);
    expect(create).toHaveBeenCalledWith(workspace, "飞书 · 实现报表导出");
  });

  it("冷快照失败时仍从持久化事件恢复标题", async () => {
    const root = await makeRoot();
    const workspace = join(root, "fallback-cache-error");
    await mkdir(workspace);
    const id = `session-${"e".repeat(64)}` as SessionId;
    const create = vi.fn(async () => ({ attachSession: vi.fn(async () => undefined) }));
    const meta = header(id, workspace);
    const inspect = vi.fn(async () => inspection(meta, "修复启动失败"));

    await indexFeishuSessions({
      persistence: { list: vi.fn(async () => [meta]), inspect },
      registry: { create },
      projectionCache: {
        coldSnapshot: vi.fn(() => { throw new Error("cache unavailable"); }),
        write: vi.fn(async () => undefined),
      },
      workspaceRoot: root,
    });

    expect(inspect).toHaveBeenCalledWith(id);
    expect(create).toHaveBeenCalledWith(workspace, "飞书 · 修复启动失败");
  });

  it("运行期 attach 不改写 cwd，也不触碰非 Feishu id", async () => {
    const create = vi.fn(async () => ({ attachSession: vi.fn(async () => undefined) }));
    const id = `session-${"a".repeat(64)}` as SessionId;
    await attachFeishuSession({ registry: { create }, workspacePath: "D:/AI/dsh/.workspaces/a", sessionId: id });
    await attachFeishuSession({
      registry: { create },
      workspacePath: "D:/AI/dsh/.workspaces/web",
      sessionId: "session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as SessionId,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith("D:/AI/dsh/.workspaces/a", "飞书 · aaaaaaaa");
  });

  it("旧 hash workspace 会迁移为可读标题，但不覆盖用户重命名", async () => {
    const id = `session-${"b".repeat(64)}` as SessionId;
    const setTitle = vi.fn(async () => undefined);
    const create = vi.fn(async () => ({
      title: feishuWorkspaceTitle(id),
      setTitle,
      attachSession: vi.fn(async () => undefined),
    }));

    await attachFeishuSession({
      registry: { create },
      workspacePath: "D:/AI/dsh/.workspaces/b",
      sessionId: id,
      title: "分析构建失败日志",
    });
    expect(setTitle).toHaveBeenCalledWith("飞书 · 分析构建失败日志");

    const customSetTitle = vi.fn(async () => undefined);
    await updateFeishuWorkspaceTitle({
      workspace: { title: "我手动命名的项目", setTitle: customSetTitle, attachSession: vi.fn() },
      sessionId: id,
      provisionalTitle: "分析构建失败日志",
      title: "模型生成的新标题",
    });
    expect(customSetTitle).not.toHaveBeenCalled();
  });

  it("迁移早期直接使用 hash 的 workspace 标题", async () => {
    const id = `session-${"f".repeat(64)}` as SessionId;
    const setTitle = vi.fn(async () => undefined);
    const create = vi.fn(async () => ({
      title: "f".repeat(64),
      setTitle,
      attachSession: vi.fn(async () => undefined),
    }));

    await attachFeishuSession({
      registry: { create },
      workspacePath: "D:/AI/dsh/.workspaces/f",
      sessionId: id,
      title: "整理部署日志",
    });

    expect(setTitle).toHaveBeenCalledWith("飞书 · 整理部署日志");
  });
});
