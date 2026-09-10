/**
 * 子进程辅助（启动/等待退出）。
 * 来源：lark-claw packages/postgres-runtime（整体平移，M0）。
 */
import { spawn } from "node:child_process";
import { basename } from "node:path";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  completeOnExit?: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value) => (stdout += value));
    child.stderr.setEncoding("utf8").on("data", (value) => (stderr += value));
    child.on("error", reject);
    const finish = (code: number | null) => {
      if (options.completeOnExit) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
      resolve({ exitCode: code ?? -1, stdout, stderr });
    };
    if (options.completeOnExit) child.on("exit", finish);
    else child.on("close", finish);
  });
}

export async function runChecked(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const result = await runProcess(command, args, options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "no output";
    throw new Error(`${basename(command)} failed (${result.exitCode}): ${detail}`);
  }
  return result;
}
