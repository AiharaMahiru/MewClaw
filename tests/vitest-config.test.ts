import { describe, expect, it } from "vitest";
import { configDefaults } from "vitest/config";

import config from "../vitest.config.js";

describe("默认 Vitest 门禁", () => {
  it("保留默认排除规则，并将真实知识 E2E 设为显式 opt-in", () => {
    expect(config.test?.exclude).toEqual(expect.arrayContaining([
      ...configDefaults.exclude,
      "tests/knowledge-e2e.test.ts",
    ]));
  });
});
