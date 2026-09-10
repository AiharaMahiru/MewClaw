/**
 * dsh-lark-image 测试（SPEC image.md §7）：路由请求体、PNG 魔数校验、
 * 参考图越界/超限拒绝、脱敏、服务层落盘。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId, type Scope } from "dsh-lark-contracts";

import { decodePng, requestImage, type ImageClientConfig } from "./client.js";
import { apply, isWithinWorkspace, type Config, type LarkImageService } from "./index.js";
import { MAX_GENERATED_IMAGE_BASE64_CHARS, MAX_IMAGE_RESPONSE_BYTES } from "./response.js";

const scope: Scope = {
  tenantId: makeTenantId("t"),
  botId: makeBotId("b"),
  deploymentId: makeDeploymentId("d"),
  userId: makeUserId("ou_1"),
  conversationId: makeConversationId("oc_1"),
};

const config: ImageClientConfig = { baseUrl: "https://img.example/v1", apiKey: "sk-secret", model: "gpt-image-2" };

/** 1x1 PNG（合法魔数载荷）。 */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function okResponse(): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG.toString("base64") }] }), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestImage（client）", () => {
  it("无参考图 → generations JSON 请求体", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    const buffer = await requestImage(config, "一只猫", [], fetchMock);
    expect(buffer.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://img.example/v1/images/generations");
    expect(String(init.body)).toEqual(JSON.stringify({ model: "gpt-image-2", prompt: "一只猫", output_format: "png" }));
  });

  it("有参考图 → edits multipart；base 无 /v1 后缀自动补", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    await requestImage({ ...config, baseUrl: "https://img.example" }, "改成夜景", [{ path: "", relativePath: "ref.png" }], fetchMock)
      .catch(() => undefined);
    expect(fetchMock).not.toHaveBeenCalled(); // 空路径读取失败先抛
    const dir = await mkdtemp(join(tmpdir(), "img-"));
    await writeFile(join(dir, "ref.png"), TINY_PNG);
    await requestImage({ ...config, baseUrl: "https://img.example" }, "改成夜景", [{ path: join(dir, "ref.png"), relativePath: "ref.png" }], fetchMock);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://img.example/v1/images/edits");
    expect(init.body).toBeInstanceOf(FormData);
    await rm(dir, { recursive: true, force: true });
  });

  it("非 PNG 数据拒绝；错误信息脱敏 key 与 base URL", async () => {
    const notPng = Buffer.from("aGVsbG8=", "base64");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ data: [{ b64_json: notPng.toString("base64") }] }), { status: 200 },
    )));
    await expect(requestImage(config, "x", [])).rejects.toThrow(/不是 PNG/);

    const maskedKey = "sk-2e416*******************************************************c8d6";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `bad key sk-secret / ${maskedKey} / Bearer proxy-token-secret at https://img.example/v1`,
      { status: 401 },
    )));
    const failure = await requestImage(config, "x", []).catch((error: unknown) => error);
    if (!(failure instanceof Error)) throw new Error("图像请求应返回已脱敏的错误");
    expect(failure.message).toContain("[REDACTED]");
    expect(failure.message).not.toContain(config.apiKey);
    expect(failure.message).not.toContain(maskedKey);
    expect(failure.message).not.toContain("proxy-token-secret");
    expect(failure.message).not.toContain(config.baseUrl);
  });

  it("限制成功 JSON、错误详情与解码后的交付物大小", async () => {
    const oversizedHeader = new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG.toString("base64") }] }), {
      headers: { "content-length": String(MAX_IMAGE_RESPONSE_BYTES + 1) },
    });
    await expect(requestImage(config, "x", [], async () => oversizedHeader))
      .rejects.toThrow(/JSON 非法或超过响应上限/);

    const detail = "x".repeat(513);
    await expect(requestImage(config, "x", [], async () => new Response(detail, { status: 400 })))
      .rejects.toThrow("x".repeat(512));
    await expect(requestImage(config, "x", [], async () => new Response(detail, { status: 400 })))
      .rejects.not.toThrow(detail);

    await expect(() => decodePng("A".repeat(MAX_GENERATED_IMAGE_BASE64_CHARS + 1), config))
      .toThrow(/超过交付物上限/);
  });
});

describe("dsh-lark-image 服务层", () => {
  let workspaceRoot: string;
  const tempDirs: string[] = [];

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "dsh-lark-image-"));
    tempDirs.push(workspaceRoot);
  });
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function service(overrides: Partial<Config> = {}): LarkImageService {
    const provided: Record<string, unknown> = {};
    const resolveCredential = vi.fn(async (ref: string) => ({ value: ref === "OPENAI_API_KEY" ? "sk-secret" : "" }));
    const ctx = {
      credentials: { resolve: resolveCredential },
      provide: vi.fn((key: string, value: unknown) => { provided[key] = value; }),
    };
    apply(ctx as never, {
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://img.example/v1",
      model: "gpt-image-2",
      workspaceRoot,
      ...overrides,
    });
    return provided.larkImage! as LarkImageService;
  }

  it("生成成功：写工作区顶层 generated-*.png", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse()));
    const result = await service().generate({ scope, prompt: "一只猫" });
    expect(result.path).toMatch(/^generated-[0-9a-f-]{36}\.png$/);
    // 工作区路径 = workspaceRoot/scopeKey(scope)；验证文件确实写入。
    const { scopeKey } = await import("dsh-lark-contracts");
    const written = await readFile(join(workspaceRoot, scopeKey(scope), result.path));
    expect(written.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(result.bytes).toBe(written.length);
  });

  it("只通过 credentials 解析 OPENAI_API_KEY", async () => {
    const provided: Record<string, unknown> = {};
    const resolveCredential = vi.fn(async (ref: string) => ({
      value: ref === "OPENAI_API_KEY" ? "sk-secret" : "",
    }));
    const ctx = {
      credentials: { resolve: resolveCredential },
      provide: vi.fn((key: string, value: unknown) => { provided[key] = value; }),
    };
    apply(ctx as never, { workspaceRoot });
    vi.stubGlobal("fetch", vi.fn(async () => okResponse()));

    await (provided.larkImage as LarkImageService).generate({ scope, prompt: "一只猫" });

    expect(resolveCredential).toHaveBeenCalledTimes(1);
    expect(resolveCredential).toHaveBeenCalledWith("OPENAI_API_KEY");
  });

  it("Web 共享会话写入实际 cwd，并拒绝配置根外目录", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse()));
    const selected = join(workspaceRoot, "users", "user-a", "project-a");
    const result = await service().generate({ scope, workspace: selected, prompt: "科研图" });
    await expect(readFile(join(selected, result.path))).resolves.toEqual(TINY_PNG);
    await expect(service().generate({ scope, workspace: join(workspaceRoot, "..", "escape"), prompt: "x" }))
      .rejects.toThrow(/越出配置根/);
  });

  it("参考图越界（..）与不存在 → 拒绝；超默认 8 张 → 拒绝；prompt 空 → 拒绝", async () => {
    const image = service();
    await expect(image.generate({ scope, prompt: "x", references: ["../escape.png"] })).rejects.toThrow(/非法|越出/);
    await expect(image.generate({ scope, prompt: "x", references: ["ghost.png"] })).rejects.toThrow(/不存在/);
    await expect(image.generate({
      scope,
      prompt: "x",
      references: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
    })).rejects.toThrow(/最多/);
    await expect(image.generate({ scope, prompt: "  " })).rejects.toThrow(/prompt/);
  });

  it("默认允许 8 张参考图，并注入图号/主图映射提示", async () => {
    const { scopeKey } = await import("dsh-lark-contracts");
    const scopeWorkspace = join(workspaceRoot, scopeKey(scope));
    const names = ["person.png", "style.png", "lighting.png", "pose.png", "prop.png", "scene.png", "color.png", "texture.png"];
    await mkdir(scopeWorkspace, { recursive: true });
    await Promise.all(names.map((name) => writeFile(join(scopeWorkspace, name), TINY_PNG)));
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    await service().generate({
      scope,
      prompt: "融合参考图，保留人物一致性",
      references: names,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const prompt = String(await (init.body as FormData).get("prompt"));
    expect(prompt).toContain("图1");
    expect(prompt).toContain("person.png");
    expect(prompt).toContain("图8");
    expect(prompt).toMatch(/第一|主图/);
    expect(prompt).toMatch(/角色映射|人物.*风格/);
  });

  it("自定义 maxReferences 生效，非法配置在装载时 fail loud", async () => {
    const image = service({ maxReferences: 2 });
    await expect(image.generate({ scope, prompt: "x", references: ["a", "b", "c"] })).rejects.toThrow(/最多 2 张/);
    expect(() => service({ maxReferences: 0 })).toThrow(/maxReferences/);
    expect(() => service({ maxReferences: 17 })).toThrow(/maxReferences/);
    expect(() => service({ maxReferences: 1.5 })).toThrow(/maxReferences/);
    expect(() => service({ maxReferenceBytes: 0 })).toThrow(/maxReferenceBytes/);
    expect(() => service({ maxReferenceBytes: 50 * 1024 * 1024 + 1 })).toThrow(/maxReferenceBytes/);
  });

  it("工作区包含判断统一 Windows/POSIX 分隔符，并拒绝相邻前缀", () => {
    expect(isWithinWorkspace("C:\\work\\scope", "C:\\work\\scope\\ref.png")).toBe(true);
    expect(isWithinWorkspace("C:\\work\\scope", "C:\\work\\scope2\\ref.png")).toBe(false);
    expect(isWithinWorkspace("/work/scope", "/work/scope/ref.png")).toBe(true);
    expect(isWithinWorkspace("/work/scope", "/work/scope2/ref.png")).toBe(false);
  });

  it("凭证缺失 → 生成时 fail loud（不猜测）", async () => {
    const provided: Record<string, unknown> = {};
    const ctx = {
      credentials: { resolve: vi.fn(async () => ({ value: "" })) },
      provide: vi.fn((key: string, value: unknown) => { provided[key] = value; }),
    };
    apply(ctx as never, { apiKeyEnv: "OPENAI_API_KEY", workspaceRoot });
    await expect((provided.larkImage as LarkImageService).generate({ scope, prompt: "x" }))
      .rejects.toThrow(/凭证引用未配置/);
  });
});
