/**
 * Podman 机器保活与生命周期。
 * 来源：lark-claw packages/service-runtime（整体平移，M0）。
 */
import { execFile } from "node:child_process";

const INFO_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 120_000;
const DEFAULT_RETRY_DELAY_MS = 30_000;
const WINDOWS_PODMAN = "C:\\Program Files\\RedHat\\Podman\\podman.exe";

export const PODMAN_MACHINE_NAME = "podman-machine-default";

export type PodmanCommandRunner = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<boolean>;

export interface PodmanRuntimeSnapshot {
  failureCode: "PODMAN_UNAVAILABLE" | null;
  healthy: boolean;
  lastCheckedAt: string | null;
  machine: string;
  recoveryCount: number;
  state: "unknown" | "checking" | "recovering" | "running" | "failed";
}

export interface PodmanLifecycle {
  ensureReady(): Promise<void>;
  maintain(): Promise<boolean>;
  snapshot(): PodmanRuntimeSnapshot;
}

interface PodmanKeepaliveOptions {
  now?: () => number;
  retryDelayMs?: number;
  run: PodmanCommandRunner;
}

type Environment = Record<string, string | undefined>;

export class PodmanUnavailableError extends Error {
  constructor() {
    super("Podman machine is unavailable");
    this.name = "PodmanUnavailableError";
  }
}

export class PodmanMachineKeepalive implements PodmanLifecycle {
  private active: Promise<boolean> | undefined;
  private failureCode: "PODMAN_UNAVAILABLE" | null = null;
  private healthy = false;
  private lastCheckedAt: string | null = null;
  private nextRetryAt = 0;
  private recoveryCount = 0;
  private state: PodmanRuntimeSnapshot["state"] = "unknown";
  private readonly now: () => number;
  private readonly retryDelayMs: number;
  private readonly run: PodmanCommandRunner;

  constructor(options: PodmanKeepaliveOptions) {
    this.now = options.now ?? Date.now;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.run = options.run;
  }

  async ensureReady(): Promise<void> {
    if (!await this.execute(true)) throw new PodmanUnavailableError();
  }

  maintain(): Promise<boolean> {
    return this.execute(false);
  }

  snapshot(): PodmanRuntimeSnapshot {
    return {
      failureCode: this.failureCode,
      healthy: this.healthy,
      lastCheckedAt: this.lastCheckedAt,
      machine: PODMAN_MACHINE_NAME,
      recoveryCount: this.recoveryCount,
      state: this.state,
    };
  }

  private execute(ignoreCooldown: boolean): Promise<boolean> {
    if (this.active) return this.active;
    if (!ignoreCooldown && this.now() < this.nextRetryAt) return Promise.resolve(false);
    const operation = this.checkAndRecover();
    this.active = operation.finally(() => {
      this.active = undefined;
    });
    return this.active;
  }

  private async checkAndRecover(): Promise<boolean> {
    this.state = "checking";
    if (await this.run(["info", "--format", "json"], INFO_TIMEOUT_MS)) {
      return this.recordHealthy(false);
    }
    this.state = "recovering";
    const started = await this.run(
      ["machine", "start", PODMAN_MACHINE_NAME], START_TIMEOUT_MS,
    );
    if (!started) return this.recordFailure();
    const healthy = await this.run(["info", "--format", "json"], INFO_TIMEOUT_MS);
    return healthy ? this.recordHealthy(true) : this.recordFailure();
  }

  private recordHealthy(recovered: boolean): true {
    this.failureCode = null;
    this.healthy = true;
    this.lastCheckedAt = new Date(this.now()).toISOString();
    this.nextRetryAt = 0;
    this.state = "running";
    if (recovered) this.recoveryCount += 1;
    return true;
  }

  private recordFailure(): false {
    this.failureCode = "PODMAN_UNAVAILABLE";
    this.healthy = false;
    this.lastCheckedAt = new Date(this.now()).toISOString();
    this.nextRetryAt = this.now() + this.retryDelayMs;
    this.state = "failed";
    return false;
  }
}

export function createPodmanMachineKeepalive(
  environment: Environment,
): PodmanMachineKeepalive {
  const configured = environment.PI_SANDBOX_RUNTIME?.trim();
  const command = configured || (process.platform === "win32" ? WINDOWS_PODMAN : "podman");
  return new PodmanMachineKeepalive({ run: createCommandRunner(command) });
}

function createCommandRunner(command: string): PodmanCommandRunner {
  return (args, timeoutMs) => new Promise((resolveResult) => {
    execFile(command, [...args], { timeout: timeoutMs, windowsHide: true }, (error) => {
      resolveResult(!error);
    });
  });
}
