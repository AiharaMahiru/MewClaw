import { describe, expect, it } from "vitest";

import {
  lockfilePatches,
  manifestPatches,
  verifyPatchPolicy,
} from "../scripts/verify-official-integrity.mjs";

describe("官方依赖完整性门禁", () => {
  it("接受 manifest 与 lockfile 对称的迁移期补丁", () => {
    const manifest = { pnpm: { patchedDependencies: { "example@1.0.0": "patches/example.patch" } } };
    const lockfile = { patchedDependencies: { "example@1.0.0": { path: "patches/example.patch" } } };
    expect(verifyPatchPolicy(manifest, lockfile, ["example@1.0.0"])).toEqual([]);
  });

  it("拒绝未列入清单的补丁和单边锁文件记录", () => {
    expect(verifyPatchPolicy(
      { pnpm: { patchedDependencies: { "@deepseek-ai/dsh-example@1.0.0": "patches/example.patch" } } },
      { patchedDependencies: {} },
      [],
    )).toEqual(expect.arrayContaining([
      "禁止的 patchedDependency: @deepseek-ai/dsh-example@1.0.0",
      "lockfile 缺少 patchedDependency: @deepseek-ai/dsh-example@1.0.0",
    ]));
  });

  it("空补丁映射是最终合规状态", () => {
    expect(manifestPatches({})).toEqual({});
    expect(lockfilePatches({})).toEqual({});
    expect(verifyPatchPolicy({}, {}, [])).toEqual([]);
  });
});
