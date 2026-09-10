/**
 * 受管子进程（启停/重启/健康标记）。
 * 来源：lark-claw packages/service-runtime（整体平移，M0）。
 */
import type { Serializable } from "node:child_process";

const BASE_RESTART_DELAY_MS = 1_000;
const MAX_RESTART_DELAY_MS = 30_000;
const SHUTDOWN_GRACE_MS = 15_000;
const FORCE_EXIT_WAIT_MS = 5_000;

export interface ManagedChild {
  readonly pid?: number | undefined;
  readonly connected: boolean;
  send(message: Serializable): boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "message", listener: (message: unknown) => void): this;
}

export interface ManagedProcessSnapshot {
  desired: boolean;
  lastExitCode: number | null;
  pid: number | null;
  restartCount: number;
  running: boolean;
}

interface ManagedProcessOptions {
  onEvent?: (event: Record<string, unknown>) => void;
  onMessage?: (message: unknown) => void;
  shutdownGraceMs?: number;
}

export function restartDelayMs(attempt: number): number {
  const multiplier = 2 ** Math.max(0, attempt - 1);
  return Math.min(BASE_RESTART_DELAY_MS * multiplier, MAX_RESTART_DELAY_MS);
}

export class ManagedProcess {
  private child: ManagedChild | undefined;
  private desired = false;
  private lastExitCode: number | null = null;
  private restartAttempt = 0;
  private restartCount = 0;
  private restartTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly name: string,
    private readonly spawnChild: () => ManagedChild,
    private readonly options: ManagedProcessOptions = {},
  ) {}

  start(): void {
    this.desired = true;
    if (!this.child && !this.restartTimer) this.launch();
  }

  markHealthy(): void {
    this.restartAttempt = 0;
  }

  async restart(reason: string): Promise<void> {
    this.options.onEvent?.({ service: this.name, phase: "restart", reason });
    await this.stop();
    this.desired = true;
    this.launch();
  }

  async stop(): Promise<void> {
    this.desired = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const graceMs = this.options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        clearTimeout(abandonTimer);
        resolve();
      };
      child.once("exit", finish);
      const forceTimer = setTimeout(() => {
        child.kill();
      }, graceMs);
      const abandonTimer = setTimeout(finish, graceMs + FORCE_EXIT_WAIT_MS);
      try {
        if (child.connected) child.send({ type: "shutdown" });
        else child.kill("SIGTERM");
      } catch {
        child.kill();
      }
    });
  }

  snapshot(): ManagedProcessSnapshot {
    return {
      desired: this.desired,
      lastExitCode: this.lastExitCode,
      pid: this.child?.pid ?? null,
      restartCount: this.restartCount,
      running: Boolean(this.child),
    };
  }

  private launch(): void {
    if (!this.desired || this.child) return;
    const child = this.spawnChild();
    this.child = child;
    child.on("message", (message) => this.options.onMessage?.(message));
    child.once("exit", (code, signal) => this.handleExit(child, code, signal));
    this.options.onEvent?.({ service: this.name, phase: "started", pid: child.pid ?? null });
  }

  private handleExit(
    child: ManagedChild,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.lastExitCode = code;
    this.options.onEvent?.({ service: this.name, phase: "exited", code, signal });
    if (!this.desired) return;
    this.restartCount += 1;
    this.restartAttempt += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.launch();
    }, restartDelayMs(this.restartAttempt));
  }
}
