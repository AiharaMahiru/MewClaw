/**
 * dsh-cdg-bridge 插件入口（SPEC cdg-bridge.md）。
 *
 * 提供 ctx.cdgBridge：CDG 加密附件的探测（inspect）与解密（decrypt）桥接。
 * 外部可执行文件（cdgbridge）路径只来自配置（绝对路径，受控目录）；
 * 未配置、调用失败或输出不可判定时全部 fail closed。
 *
 * 桥接二进制是供应链输入：参数数组化（无 shell），stdout 有界收集，
 * 超时 kill；探测 JSON 解析失败拒绝附件并告警。
 */
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

import { resolveCdgBridgeConfig } from "./config.js";

export const name = "cdg-bridge";

export const inject = [];

export interface Config {
  /** cdgbridge 可执行文件绝对路径；缺省 = 桥接关闭。 */
  command?: string;
  /** 单次调用超时（默认 30s）。 */
  timeoutMs?: number;
}

export const Config: z<Config> = z.object({
  command: z.string(),
  timeoutMs: z.number(),
});

const MAX_STDOUT_BYTES = 64 * 1024;

/** 桥接服务契约（未配置时的降级语义见各方法）。 */
export interface CdgBridge {
  inspect(path: string): Promise<boolean>;
  decrypt(source: string, destination: string): Promise<void>;
}

/** 执行一次桥接调用：参数数组化、超时 kill、stdout 有界。 */
function runBridge(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: MAX_STDOUT_BYTES,
    }, (error, stdout) => {
      if (error) {
        reject(new Error(`cdg-bridge: ${args[0]} 调用失败（${error.code ?? error.message}）`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** 解析 inspect 的 JSON 输出；失败 → undefined（探测不可判定）。 */
function parseInspectResult(stdout: string): { isEncrypted: boolean } | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === "object" && parsed !== null
      && typeof (parsed as { isEncrypted?: unknown }).isEncrypted === "boolean") {
      return { isEncrypted: (parsed as { isEncrypted: boolean }).isEncrypted };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function assertCommandFile(command: string): void {
  if (!isAbsolute(command)) throw new Error("cdg-bridge: command 必须是绝对路径");
  let metadata: ReturnType<typeof statSync>;
  try {
    metadata = statSync(command);
  } catch {
    throw new Error("cdg-bridge: command 指向的可执行文件不存在");
  }
  if (!metadata.isFile()) throw new Error("cdg-bridge: command 必须指向常规文件");
}

export function apply(ctx: Context, config: Config): void {
  const { command, timeoutMs } = resolveCdgBridgeConfig(config);

  if (command) {
    // 绝对路径和常规文件强制（防搜索路径注入）；装载期 fail loud。
    assertCommandFile(command);
  }

  const bridge: CdgBridge = {
    async inspect(path: string): Promise<boolean> {
      if (!command) {
        throw new Error("cdg-bridge: 未配置 cdgbridge 可执行文件，无法检查附件加密状态");
      }
      const stdout = await runBridge(command, ["inspect", path], timeoutMs);
      const result = parseInspectResult(stdout);
      if (!result) {
        ctx.logger.warn("cdg-bridge: inspect 输出无法解析（附件已拒绝）");
        throw new Error("cdg-bridge: inspect 输出无法解析");
      }
      return result.isEncrypted;
    },
    async decrypt(source: string, destination: string): Promise<void> {
      if (!command) {
        throw new Error("cdg-bridge: 未配置 cdgbridge 可执行文件，加密附件无法解密（配置 command 后启用）");
      }
      await runBridge(command, ["read", source, "--out", destination, "--strict-output"], timeoutMs);
    },
  };

  ctx.provide("cdgBridge", bridge);
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** CDG 加密附件桥接（inspect/decrypt；不可用时 fail closed）。 */
    cdgBridge?: CdgBridge;
  }
}
