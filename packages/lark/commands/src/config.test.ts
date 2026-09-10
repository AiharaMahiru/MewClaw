import { describe, expect, it } from "vitest";

import { MAX_CARD_ACTION_MAX_ENTRIES, MAX_CARD_ACTION_TTL_MS } from "./card-actions.js";
import { apply } from "./index.js";

function makeContext() {
  return { larkRunClient: {}, provide: () => undefined };
}

describe("命令卡配置", () => {
  for (const [field, config] of [
    ["cardActionTtlMs", { cardActionTtlMs: 0 }],
    ["cardActionMaxEntries", { cardActionMaxEntries: 0 }],
  ] as const) {
    it(`${field} 为零时启动失败`, () => {
      expect(() => apply(makeContext() as never, config)).toThrow(field);
    });
  }

  it.each([
    ["cardActionTtlMs", { cardActionTtlMs: MAX_CARD_ACTION_TTL_MS + 1 }],
    ["cardActionMaxEntries", { cardActionMaxEntries: MAX_CARD_ACTION_MAX_ENTRIES + 1 }],
  ])("%s 超过上限时启动失败", (field, config) => {
    expect(() => apply(makeContext() as never, config)).toThrow(field);
  });
});
