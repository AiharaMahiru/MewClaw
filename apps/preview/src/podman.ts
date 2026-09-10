import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { AppConfig } from "./config.js";
import { PreviewAppError } from "./errors.js";

const MANAGED_LABEL = "io.dsh.preview.managed=true";
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const REMOVE_ATTEMPTS = 3;
const NODE_BRIDGE_SCRIPT = [
  "const net=require('node:net')",
  "const socket=net.connect({host:'127.0.0.1',port:Number(process.argv[1])})",
  "process.stdin.pipe(socket)",
  "socket.pipe(process.stdout)",
  "socket.on('error',()=>process.exit(1))",
].join(";");
const NODE_PROBE_SCRIPT = [
  "const net=require('node:net')",
  "const socket=net.connect({host:'127.0.0.1',port:Number(process.argv[1])},()=>{socket.end();process.exit(0)})",
  "socket.setTimeout(1000,()=>{socket.destroy();process.exit(1)})",
  "socket.on('error',()=>process.exit(1))",
].join(";");

export interface PodmanProcess {
  run(args: readonly string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }>;
  spawn(args: readonly string[]): ChildProcessWithoutNullStreams;
}

export class NodePodmanProcess implements PodmanProcess {
  constructor(private readonly executable: string) {}

  run(args: readonly string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.executable, [...args], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout = boundedAppend(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = boundedAppend(stderr, chunk); });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new PreviewAppError("PREVIEW_UNAVAILABLE", "Podman 操作超时"));
      }, timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new PreviewAppError("PREVIEW_UNAVAILABLE", `Podman 不可用：${error.message}`));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolvePromise({ code: code ?? 1, stdout, stderr });
      });
    });
  }

  spawn(args: readonly string[]): ChildProcessWithoutNullStreams {
    return spawn(this.executable, [...args], { stdio: ["pipe", "pipe", "pipe"] });
  }
}

export interface RuntimeCreateInput {
  id: string;
  userId: string;
  workspace: string;
  command: string;
  port: number;
}

export interface PreviewRuntime {
  cleanupOrphans(): Promise<void>;
  create(input: RuntimeCreateInput): Promise<string>;
  remove(container: string): Promise<void>;
  bridge(container: string, port: number): ChildProcessWithoutNullStreams;
}

export class PodmanRuntime implements PreviewRuntime {
  readonly #process: PodmanProcess;

  constructor(private readonly config: AppConfig, process?: PodmanProcess) {
    this.#process = process ?? new NodePodmanProcess(config.podmanPath);
  }

  async cleanupOrphans(): Promise<void> {
    const listed = await this.#process.run(["ps", "-aq", "--filter", `label=${MANAGED_LABEL}`], this.config.startupTimeoutMs);
    if (listed.code !== 0) {
      const reason = /newuidmap|newgidmap|cannot clone|cannot re-exec|user namespace/iu.test(listed.stderr)
        ? "ROOTLESS_INIT_REQUIRED" : "PODMAN_LIST_FAILED";
      throw new PreviewAppError("PREVIEW_UNAVAILABLE", `无法枚举 Preview 容器（${reason}）`);
    }
    const containers = listed.stdout.split(/\s+/).filter(Boolean);
    if (containers.length > 0) {
      const removed = await this.#process.run(["rm", "-f", "--time", "1", ...containers], this.config.startupTimeoutMs);
      if (removed.code !== 0) throw new PreviewAppError("PREVIEW_UNAVAILABLE", "无法回收 Preview 孤儿容器");
    }
  }

  async create(input: RuntimeCreateInput): Promise<string> {
    const container = `dsh-preview-${input.id}`;
    const args = [
      "run", "-d", "--rm", "--name", container,
      "--label", MANAGED_LABEL,
      "--label", `io.dsh.preview.owner=${input.userId}`,
      "--network", "none", "--read-only", "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--userns=keep-id:uid=10001,gid=10001", "--user=10001:10001",
      "--cpus", String(this.config.resources.cpus),
      "--memory", `${this.config.resources.memoryMiB}m`,
      "--pids-limit", String(this.config.resources.pids),
      "--tmpfs", `/tmp:rw,nosuid,nodev,size=${this.config.resources.tmpfsMiB}m`,
      "--mount", `type=bind,src=${input.workspace},dst=/workspace,rw`,
      "--workdir", "/workspace",
      "--entrypoint", "/bin/bash",
      this.config.image, "-c", input.command,
    ];
    const started = await this.#process.run(args, this.config.startupTimeoutMs);
    if (started.code !== 0) throw new PreviewAppError("PREVIEW_UNAVAILABLE", "Preview 容器启动失败");
    try {
      await this.#waitForPort(container, input.port);
      return container;
    } catch (error) {
      await this.remove(container).catch(() => undefined);
      throw error;
    }
  }

  async remove(container: string): Promise<void> {
    for (let attempt = 1; attempt <= REMOVE_ATTEMPTS; attempt += 1) {
      const result = await this.#process.run(["rm", "-f", "--time", "1", container], this.config.startupTimeoutMs);
      if (result.code === 0 || /no such container/i.test(result.stderr)) return;
      if (attempt < REMOVE_ATTEMPTS) await delay(100 * attempt);
    }
    throw new PreviewAppError("PREVIEW_UNAVAILABLE", "Preview 容器回收失败");
  }

  bridge(container: string, port: number): ChildProcessWithoutNullStreams {
    return this.#process.spawn(["exec", "-i", container, "node", "-e", NODE_BRIDGE_SCRIPT, String(port)]);
  }

  async #waitForPort(container: string, port: number): Promise<void> {
    const deadline = Date.now() + this.config.startupTimeoutMs;
    while (Date.now() < deadline) {
      const probe = await this.#process.run([
        "exec", container, "node", "-e", NODE_PROBE_SCRIPT, String(port),
      ], Math.min(2_000, this.config.startupTimeoutMs));
      if (probe.code === 0) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    throw new PreviewAppError("PREVIEW_UNAVAILABLE", "用户服务端口未就绪");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function boundedAppend(current: string, chunk: Buffer): string {
  if (current.length >= MAX_DIAGNOSTIC_BYTES) return current;
  return (current + chunk.toString("utf8")).slice(0, MAX_DIAGNOSTIC_BYTES);
}
