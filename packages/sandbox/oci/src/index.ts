/**
 * dsh-sandbox-oci 插件入口（SPEC sandbox-oci.md）。
 *
 * 双服务：ctx.subprocess（容器执行，替换 dsh-subprocess-local）+
 * ctx.sandbox（confine 透传，替换 sandbox-local）。挂载本行前须禁用
 * dsh-base 的 subprocess/sandbox 行（见 worker 组合的 oci.overlay.yml）。
 * localInsecure 字段显式拒绝（生产 fail closed）。
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

import { resolveSandboxConfig, type SandboxConfigInput } from "./config.js";
import { OciContainerRuntime } from "./container.js";
import { OciSandbox, OciSubprocessRuntime } from "./runtime.js";

export const name = "sandbox-oci";

export const inject = [];

export interface Config extends SandboxConfigInput {
  /** 本机逃逸开关：true 即拒绝（fail closed at load；apply 显式校验）。 */
  localInsecure?: boolean;
}

export const Config: z<Config> = z.object({
  image: z.string().required(),
  podmanPath: z.string(),
  network: z.string(),
  resources: z.object({
    cpus: z.number(),
    memoryMiB: z.number(),
    pids: z.number(),
    tmpfsMiB: z.number(),
  }),
  workspaceRoot: z.string().required(),
  storageLimitBytes: z.number(),
  localInsecure: z.boolean(),
});

export function apply(ctx: Context, config: Config): void {
  // 生产拒绝逃逸开关：出现 true 即拒绝加载（fail closed）。
  if (config.localInsecure) {
    throw new Error("sandbox-oci: localInsecure 逃逸开关在生产配置中拒绝");
  }
  const resolved = resolveSandboxConfig({
    image: config.image,
    ...(config.podmanPath === undefined ? {} : { podmanPath: config.podmanPath }),
    ...(config.network === undefined ? {} : { network: config.network }),
    ...(config.resources === undefined ? {} : { resources: config.resources }),
    workspaceRoot: config.workspaceRoot,
    ...(config.storageLimitBytes === undefined ? {} : { storageLimitBytes: config.storageLimitBytes }),
  });
  const core = new OciContainerRuntime({ config: resolved });
  // Service 子类构造即自动注册（SubprocessRuntime/SandboxProvider 的静态
  // provide 名），不得再手动 ctx.provide——重复注册会被 cordis 拒绝。
  new OciSubprocessRuntime(ctx, core, resolved);
  new OciSandbox(ctx, core);
  ctx.effect(() => () => core.dispose());
}

export * from "./config.js";
export * from "./container.js";
export * from "./runtime.js";
