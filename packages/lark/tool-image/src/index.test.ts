/**
 * dsh-tool-image 测试（SPEC image.md §7）：工具注册、Scope 信封解析、
 * 参数透传与缺信封拒绝。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeConversationId, makeBotId, makeDeploymentId, makeTenantId, makeUserId } from "dsh-lark-contracts";

import { apply } from "./index.js";

const scope = {
  tenantId: makeTenantId("t"),
  botId: makeBotId("b"),
  deploymentId: makeDeploymentId("d"),
  userId: makeUserId("ou_1"),
  conversationId: makeConversationId("oc_1"),
};

function makeEnv() {
  const tools: Array<{ name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }> = [];
  const larkImage = { generate: vi.fn(async () => ({ path: "generated-x.png", bytes: 1234 })) };
  const larkScopeIndex = { get: vi.fn(() => scope) };
  const ctx = {
    larkImage,
    larkScopeIndex,
    tools: { register: vi.fn((definition: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }) => { tools.push(definition); return () => undefined; }) },
    systemPrompt: { section: vi.fn() },
    effect: vi.fn((run: () => unknown) => { run(); return () => undefined; }),
  };
  apply(ctx as never, {});
  return { ctx, tools, larkImage, larkScopeIndex };
}

let env: ReturnType<typeof makeEnv>;

beforeEach(() => {
  env = makeEnv();
});

describe("dsh-tool-image", () => {
  it("注册 generate_image 工具与提示段", () => {
    expect(env.tools).toHaveLength(1);
    expect(env.tools[0]!.name).toBe("generate_image");
    expect(env.ctx.effect).toHaveBeenCalledTimes(1);
    expect(env.ctx.systemPrompt.section).toHaveBeenCalledWith(expect.objectContaining({
      name: "tool:generate_image",
      text: expect.stringMatching(/图1|主图|角色映射|canonical reference/),
    }));
    expect((env.tools[0] as unknown as { description: string }).description).toMatch(/图1|8/);
  });

  it("执行：Scope 取自信封，参数透传；schema 门拒绝非字符串元素", async () => {
    const result = await env.tools[0]!.execute(
      { prompt: "画一只猫", reference_paths: ["a.png", "b.png"] },
      { agent: { id: "session-1", session: { header: { cwd: "/workspace/project" } } } },
    ) as { path: string };
    expect(result.path).toBe("generated-x.png");
    expect(env.larkImage.generate).toHaveBeenCalledWith({
      scope,
      workspace: "/workspace/project",
      prompt: "画一只猫",
      references: ["a.png", "b.png"],
    });
    // 注册表 schema 边界：数组元素类型由框架校验（execute 收到的必然合规）。
    await expect(env.tools[0]!.execute(
      { prompt: "x", reference_paths: ["a.png", 42] },
      { agent: { id: "session-1" } },
    )).rejects.toThrow(/must be a string/);
  });

  it("无 agent 或无 Scope 信封 → 拒绝", async () => {
    await expect(env.tools[0]!.execute({ prompt: "x" }, {})).rejects.toThrow(/agent context/);
    env.larkScopeIndex.get = vi.fn(() => undefined) as never;
    await expect(env.tools[0]!.execute({ prompt: "x" }, { agent: { id: "s" } })).rejects.toThrow(/Scope 信封/);
  });
});
