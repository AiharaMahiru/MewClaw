import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

// R49 事故防回归：裸 tools.register 的 parameters 由 schemaOf 原样透传，
// 传 defineTool 字段表会得到缺根 type 的 schema，provider 以 "type: null"
// 400 拒掉整轮。本测试实际装载每一个随包发出的 .mjs 插件（自动 glob，
// 未来新增免维护），把注册进 registry 的 definition 全量过
// assertModelToolSchema——校验的是注册结果而非源码形态。

const root = resolve(__dirname, "..");
const PRESET_ROOT = join(root, "packages/bundle/web");

interface PluginModule {
  name?: string;
  apply?: (ctx: unknown, config: Record<string, unknown>) => unknown;
}

// 逐插件的最小可用 config：apply 期不应要求真实服务，但 liangshen 的
// 启动钳制要求显式工具清单（与 agent.cordis.yml 保持一致）。
const CONFIGS: Record<string, Record<string, unknown>> = {
  "anchored-tool-bootstrap": { shellTools: ["bash"], commonTools: ["str_replace_editor"] },
};

function anyService(): unknown {
  const callable = function () { return anyService(); };
  return new Proxy(callable, {
    get: (_target, property) => (property === Symbol.toPrimitive ? () => "" : anyService()),
    apply: () => anyService(),
  });
}

function createContext(registered: unknown[], effects: unknown[]): unknown {
  const base: Record<string, unknown> = {
    tools: {
      register: (definition: unknown) => { registered.push(definition); return () => undefined; },
      // tools.guard 注册执行围栏（fs-read-guard），返回值此处不消费。
      guard: () => () => undefined,
    },
    on: () => () => undefined,
    // effect 回调照常执行：插件在 effect 里做贡献的也覆盖到。
    effect: (register: () => unknown) => { effects.push(register()); return () => undefined; },
    emit: () => undefined,
    inject: () => () => undefined,
    get: () => anyService(),
    logger: { warn() {}, error() {}, info() {}, debug() {} },
  };
  return new Proxy(base, {
    get: (target, property) => (property in target ? target[property as string] : anyService()),
  });
}

async function presetModules(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".mjs") && !entry.name.endsWith(".test.mjs")) found.push(path);
    }
  };
  await walk(PRESET_ROOT);
  return found.sort();
}

const modules = await presetModules();
const { assertModelToolSchema } = (await import(
  pathToFileURL(join(PRESET_ROOT, "tool-schema.mjs")).href
)) as { assertModelToolSchema: (name: string, parameters: unknown) => void };

describe("agent preset .mjs 插件的工具 schema", () => {
  it("扫描确实覆盖了当前随包插件", () => {
    const names = modules.map((path) => relative(root, path).replaceAll("\\", "/"));
    expect(names).toEqual(expect.arrayContaining([
      "packages/bundle/web/tool-schema.mjs",
      "packages/bundle/web/agent-presets/liangshen/custom-bash.mjs",
      "packages/bundle/web/agent-presets/liangshen/tool-bootstrap.mjs",
      "packages/bundle/web/agent-presets-oci/pipe-bash.mjs",
      "packages/bundle/web/agent-presets-oci/workspace-guidance.mjs",
    ]));
  });

  for (const path of modules) {
    it(`${relative(root, path).replaceAll("\\", "/")} 注册的工具均为 object 根 JSON Schema`, async () => {
      const mod = (await import(pathToFileURL(path).href)) as PluginModule;
      if (typeof mod.apply !== "function") return;
      const registered: unknown[] = [];
      const effects: unknown[] = [];
      await mod.apply(createContext(registered, effects), CONFIGS[mod.name ?? ""] ?? {});
      for (const definition of registered) {
        const tool = definition as { name?: unknown; parameters?: unknown; execute?: unknown };
        expect(typeof tool.name, "工具必须有 name").toBe("string");
        expect(typeof tool.execute, `${String(tool.name)} 必须有 execute`).toBe("function");
        expect(() => assertModelToolSchema(tool.name as string, tool.parameters)).not.toThrow();
        // wire 上只允许可序列化 schema。
        expect(() => JSON.stringify(tool.parameters)).not.toThrow();
      }
    });
  }

  it("registerModelTool 在 schema 缺 object 根时于装载期抛错", async () => {
    const { registerModelTool } = (await import(
      pathToFileURL(join(PRESET_ROOT, "tool-schema.mjs")).href
    )) as { registerModelTool: (ctx: unknown, definition: unknown) => unknown };
    const registered: unknown[] = [];
    const ctx = { tools: { register: (d: unknown) => { registered.push(d); return () => undefined; } } };
    expect(() => registerModelTool(ctx, {
      name: "bad",
      parameters: { command: { type: "string" } },
      execute: () => undefined,
    })).toThrow(/type:"object"/u);
    expect(registered).toHaveLength(0);
    expect(() => registerModelTool(ctx, {
      name: "ok",
      parameters: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      execute: () => undefined,
    })).not.toThrow();
    expect(registered).toHaveLength(1);
  });
});
