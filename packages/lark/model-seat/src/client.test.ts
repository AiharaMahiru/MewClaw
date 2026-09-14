import { describe, expect, it, vi } from "vitest";
import { SlotCore } from "@deepseek-ai/dsh-client-ui-slots";

import { applyModelSeat } from "./client.js";
import {
  SEAT_CSS,
  createSeatComponent,
  currentEntry,
  effortRows,
  ensureSeatStyle,
  initialView,
  triggerEffortLabel,
  triggerModelLabel,
  type SeatGroup,
  type SeatModel,
  type SeatProps,
  type SeatSnapshot,
} from "./seat.js";

type El = { type: unknown; props: Record<string, unknown> | null; children: unknown[] };

/** 可控假 React：useState 依序取 states 种子，setter 记录调用。 */
function makeReact(states: unknown[] = []) {
  let cursor = 0;
  const sets: Array<{ index: number; calls: unknown[] }> = [];
  return {
    sets,
    react: {
      createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El {
        return { type, props, children };
      },
      useSyncExternalStore<T>(_sub: (fn: () => void) => () => void, get: () => T): T {
        return get();
      },
      useState<T>(initial: T | (() => T)) {
        const index = cursor++;
        const calls: unknown[] = [];
        sets.push({ index, calls });
        const value = index < states.length ? (states[index] as T) : typeof initial === "function" ? (initial as () => T)() : initial;
        return [value, (v: T) => calls.push(v)] as [T, (v: T) => void];
      },
      useRef<T>(initial: T) {
        return { current: initial };
      },
      useEffect() {},
      useLayoutEffect() {},
      useMemo<T>(factory: () => T): T {
        return factory();
      },
      useId() {
        return "tid";
      },
    },
  };
}

const dom = { createPortal: (node: unknown, host: unknown) => ({ portal: node, host }) };

(globalThis as { document?: unknown }).document ??= { body: { marker: true } };

function walk(node: unknown, visit: (el: El) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (node === null || node === undefined || typeof node !== "object") return;
  const el = node as El;
  visit(el);
  if (Array.isArray(el.children)) for (const child of el.children) walk(child, visit);
  if ("portal" in el) walk(el.portal, visit);
}

function findAll(node: unknown, pred: (el: El) => boolean): El[] {
  const found: El[] = [];
  walk(node, (el) => {
    if (pred(el)) found.push(el);
  });
  return found;
}

const byClass = (name: string) => (el: El) => String(el.props?.className ?? "").split(" ").includes(name);

const MUSE: SeatModel = {
  id: "muse-spark-1.3",
  name: "Muse Spark 1.3",
  reasoning: {
    defaultEffort: "high",
    efforts: [
      { id: "low", name: "Low" },
      { id: "high", name: "High" },
    ],
  },
};
const PLAIN: SeatModel = { id: "ling-3.0-flash", name: "Ling 3.0 Flash" };
const GROUPS: readonly SeatGroup[] = [
  { id: "deepseek-official", name: "DeepSeek", models: [MUSE, PLAIN] },
  {
    id: "openai",
    name: "OpenAI",
    models: [{ id: "gpt-5.6-luna", name: "GPT 5.6 Luna", reasoning: { efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }] } }],
  },
];

function snapshot(partial: Partial<SeatSnapshot> = {}): SeatSnapshot {
  return {
    current: { provider: "deepseek-official", model: "muse-spark-1.3" },
    routable: true,
    groups: GROUPS,
    failures: [],
    status: "ready",
    error: null,
    ...partial,
  };
}

function seatProps(state: SeatSnapshot, over: Partial<SeatProps> = {}): SeatProps {
  return {
    available: true,
    directory: { subscribe: () => () => undefined, getSnapshot: () => state },
    load: vi.fn(),
    select: vi.fn(async () => true),
    ...over,
  };
}

describe("composer 模型位 shadow 注册", () => {
  it("以 priority:-1 占据 conversation.input.model，注入面与官方同构", () => {
    const injected: Array<{ name: string; callback: () => () => void }> = [];
    const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = [];
    const store = { subscribe: () => () => undefined, getSnapshot: () => snapshot() };
    const directory = { store, load: vi.fn(async () => snapshot()), select: vi.fn(async () => undefined) };
    const fakeContext = {
      slots: {
        inject(name: string, callback: () => () => void) {
          injected.push({ name, callback });
          return () => undefined;
        },
        register(options: Record<string, unknown>, component: unknown) {
          registrations.push({ options, component });
          return () => undefined;
        },
      },
      modelDirectories: { directoryFor: vi.fn(() => directory) },
      sessions: { subagentAddress: vi.fn(() => undefined) },
    } as never;

    applyModelSeat(fakeContext, makeReact().react, dom);
    expect(injected.map(({ name }) => name)).toEqual(["conversation.input.model"]);

    injected[0]!.callback();
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.options.name).toBe("conversation.input.model");
    expect(registrations[0]!.options.priority).toBe(-1);

    const inject = registrations[0]!.options.inject as (sessionId: string) => Record<string, unknown>;
    const face = inject("sess-1");
    expect(face.available).toBe(true);
    expect(face.directory).toBe(store);
  });

  it("模块 inject 声明覆盖 directoryFor 的 ctx.remote.session 访问", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("./client.ts", import.meta.url)), "utf8");
    const inject = src.match(/inject:\s*\[([^\]]+)\]/)?.[1] ?? "";
    for (const dep of ["slots", "modelDirectories", "sessions", "remote.session"]) {
      expect(inject).toContain(`"${dep}"`);
    }
  });

  it("真实 SlotCore 选举：priority:-1 在 single 槽位上恒定遮蔽官方占据", () => {
    const core = new SlotCore();
    core.register(
      { name: "root", children: { "conversation.input.model": { kind: "single", scope: "session" } } },
      () => "shell",
    );
    // 与官方注册等价的占据（无 priority → 0）。
    core.register({ name: "conversation.input.model", inject: () => ({}) }, () => "official");
    core.register({ name: "conversation.input.model", priority: -1, inject: () => ({}) }, () => "ours");
    const winners = core.entriesOfSlot("conversation.input.model");
    expect(winners).toHaveLength(1);
    expect(winners[0]!.component({} as never)).toBe("ours");
    expect(core.entries("conversation.input.model")).toHaveLength(2);
  });

  it("子代理会话判定为不可用并 fail-closed", async () => {
    const registrations: Array<{ options: Record<string, unknown> }> = [];
    const directory = {
      store: { subscribe: () => () => undefined, getSnapshot: () => snapshot() },
      load: vi.fn(async () => snapshot()),
      select: vi.fn(async () => undefined),
    };
    const fakeContext = {
      slots: {
        inject(_name: string, callback: () => () => void) {
          callback();
          return () => undefined;
        },
        register(options: Record<string, unknown>, _component: unknown) {
          registrations.push({ options });
          return () => undefined;
        },
      },
      modelDirectories: { directoryFor: () => directory },
      sessions: { subagentAddress: () => ({ agent: "sub" }) },
    } as never;
    applyModelSeat(fakeContext, makeReact().react, dom);
    const face = (registrations[0]!.options.inject as (id: string) => {
      available: boolean;
      load(): void;
      select(s: { provider: string; model: string }): Promise<boolean>;
    })("sess-sub");
    expect(face.available).toBe(false);
    face.load();
    expect(directory.load).not.toHaveBeenCalled();
    await expect(face.select({ provider: "p", model: "m" })).resolves.toBe(false);
    expect(directory.select).not.toHaveBeenCalled();
  });
});

describe("模型位渲染与选择", () => {
  const Seat = createSeatComponent(makeReact().react as never, dom);

  it("关闭态渲染触发器：模型名 + 生效强度", () => {
    const tree = Seat(seatProps(snapshot())) as El;
    const trigger = findAll(tree, byClass("mwseat-trigger"))[0]!;
    expect(trigger.props["aria-expanded"]).toBe(false);
    expect(findAll(trigger, byClass("mwseat-label"))[0]!.children).toContain("Muse Spark 1.3");
    expect(findAll(trigger, byClass("mwseat-effort"))[0]!.children).toContain("High");
    expect(findAll(tree, (el) => "portal" in el)).toHaveLength(0);
  });

  it("打开后首先呈现思考强度滑条，而非模型清单", () => {
    const react = makeReact([true, "effort", { left: 0, top: 0 }]);
    const SeatOpen = createSeatComponent(react.react as never, dom);
    const tree = SeatOpen(seatProps(snapshot())) as El;
    const menu = findAll(tree, byClass("mwseat-menu"))[0]!;
    const segments = findAll(menu, byClass("mwseat-seg"));
    expect(segments.map((seg) => seg.children[0])).toEqual(["Low", "High"]);
    expect(segments[1]!.props.className).toContain("on");
    expect(segments[1]!.props["aria-checked"]).toBe(true);
    expect(findAll(menu, byClass("mwseat-more"))[0]!.children).toContain("更多");
    expect(findAll(menu, byClass("mwseat-row"))).toHaveLength(0);
  });

  it("点击档位经官方 select 通路提交 reasoningEffort", () => {
    const select = vi.fn(async () => true);
    const react = makeReact([true, "effort", { left: 0, top: 0 }]);
    const SeatOpen = createSeatComponent(react.react as never, dom);
    const tree = SeatOpen(seatProps(snapshot(), { select })) as El;
    const seg = findAll(tree, byClass("mwseat-seg"))[0]!;
    (seg.props.onClick as () => void)();
    expect(select).toHaveBeenCalledWith({ provider: "deepseek-official", model: "muse-spark-1.3", reasoningEffort: "low" });
  });

  it("「更多」切换到模型清单视图", () => {
    const react = makeReact([true, "effort", { left: 0, top: 0 }]);
    const SeatOpen = createSeatComponent(react.react as never, dom);
    const tree = SeatOpen(seatProps(snapshot())) as El;
    const more = findAll(tree, byClass("mwseat-more"))[0]!;
    (more.props.onClick as () => void)();
    expect(react.sets.find((s) => s.index === 1)!.calls).toEqual(["list"]);
  });

  it("清单视图按 provider 分组渲染，标题无黑底类样式", () => {
    const react = makeReact([true, "list", { left: 0, top: 0 }]);
    const SeatList = createSeatComponent(react.react as never, dom);
    const tree = SeatList(seatProps(snapshot())) as El;
    const titles = findAll(tree, byClass("mwseat-groupTitle"));
    expect(titles.map((t) => t.children[0])).toEqual(["DeepSeek", "OpenAI"]);
    const groupRule = SEAT_CSS.match(/\.mwseat-groupTitle\{[^}]*\}/u)![0];
    expect(groupRule).toContain("background:transparent");
    expect(groupRule).not.toContain("--dsw-specific-menu");
    const rows = findAll(tree, byClass("mwseat-row"));
    expect(rows).toHaveLength(3);
    expect(rows[0]!.props.className).toContain("on");
    expect(findAll(rows[0]!, byClass("mwseat-check"))).toHaveLength(1);
  });

  it("模型行选择携带该模型的默认 reasoningEffort", () => {
    const select = vi.fn(async () => true);
    const react = makeReact([true, "list", { left: 0, top: 0 }]);
    const SeatList = createSeatComponent(react.react as never, dom);
    const tree = SeatList(seatProps(snapshot(), { select })) as El;
    const rows = findAll(tree, byClass("mwseat-row"));
    (rows[2]!.props.onClick as () => void)();
    expect(select).toHaveBeenCalledWith({ provider: "openai", model: "gpt-5.6-luna" });
    (rows[1]!.props.onClick as () => void)();
    expect(select).toHaveBeenCalledWith({ provider: "deepseek-official", model: "ling-3.0-flash" });
  });

  it("无 reasoning 元数据的模型打开时直接进清单", () => {
    const state = snapshot({ current: { provider: "deepseek-official", model: "ling-3.0-flash" } });
    const { model } = currentEntry(state);
    expect(initialView(model)).toBe("list");
    expect(triggerEffortLabel(model, state.current)).toBeUndefined();
  });

  it("unavailable 会话不渲染，locked 时触发器禁用", () => {
    const SeatClosed = createSeatComponent(makeReact().react as never, dom);
    expect(SeatClosed(seatProps(snapshot(), { available: false }))).toBeNull();
    const locked = SeatClosed(seatProps(snapshot(), { locked: true })) as El;
    expect(findAll(locked, byClass("mwseat-trigger"))[0]!.props.disabled).toBe(true);
  });

  it("空目录与错误态在清单内提示而非破坏 composer", () => {
    const renderOpen = (state: SeatSnapshot) =>
      createSeatComponent(makeReact([true, "list", { left: 0, top: 0 }]).react as never, dom)(seatProps(state)) as El;
    expect(JSON.stringify(renderOpen(snapshot({ current: null, groups: [], status: "loading" })))).toContain("正在加载模型目录");
    expect(JSON.stringify(renderOpen(snapshot({ groups: [], error: "catalog down" })))).toContain("catalog down");
    expect(JSON.stringify(renderOpen(snapshot({
      failures: [{ id: "openai", name: "OpenAI", message: "timeout" }],
      groups: [GROUPS[0]!],
    })))).toContain("OpenAI：timeout");
  });
});

describe("视图辅助", () => {
  it("effortRows：defaultEffort 缺失时首档为「默认」", () => {
    const noDefault: SeatModel = { id: "m", name: "M", reasoning: { efforts: [{ id: "a", name: "A" }] } };
    const rows = effortRows(noDefault, { provider: "p", model: "m", reasoningEffort: "a" });
    expect(rows[0]).toMatchObject({ key: "provider-default", effort: undefined, active: false });
    expect(rows[1]).toMatchObject({ effort: "a", active: true });
    expect(effortRows(noDefault, { provider: "p", model: "m" })[0]!.active).toBe(true);
  });

  it("triggerModelLabel：无选中按状态回退", () => {
    expect(triggerModelLabel(snapshot({ current: null, status: "loading" }), undefined)).toBe("加载中…");
    expect(triggerModelLabel(snapshot({ current: null }), undefined)).toBe("选择模型");
    expect(triggerModelLabel(snapshot(), undefined)).toBe("deepseek-official/muse-spark-1.3");
  });

  it("ensureSeatStyle 幂等且无 document 时安全跳过", () => {
    const appended: unknown[] = [];
    const doc = {
      head: { appendChild: (n: unknown) => appended.push(n) },
      getElementById: (id: string) => appended.find((n) => (n as { id: string }).id === id) ?? null,
      createElement: () => ({ id: "", textContent: "" }),
    };
    ensureSeatStyle(doc);
    ensureSeatStyle(doc);
    expect(appended).toHaveLength(1);
    expect((appended[0] as { textContent: string }).textContent).toContain(".mwseat-groupTitle");
    expect(() => ensureSeatStyle(undefined)).not.toThrow();
  });
});
