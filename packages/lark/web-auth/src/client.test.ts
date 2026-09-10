import { describe, expect, it } from "vitest";

import { selectConnectionSource } from "./client.js";

function observable(snapshot: unknown) {
  return { getSnapshot: () => snapshot, subscribe: () => () => undefined };
}

describe("Web Auth 连接观察源兼容性", () => {
  it("优先选择 alpha generation，并保留 state 语义", () => {
    const generation = observable({ id: 1 });
    const state = observable("connected");
    expect(selectConnectionSource({ generation, state })).toEqual({ source: generation, stateSource: state });
  });

  it("连接服务缺失或形状不完整时安全降级", () => {
    expect(selectConnectionSource(undefined)).toBeUndefined();
    expect(selectConnectionSource({ generation: { subscribe() {} } })).toBeUndefined();
  });
});
