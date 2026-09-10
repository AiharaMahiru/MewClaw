/**
 * 服务监督器：编排 worker/gateway/admin/postgres 的启停与健康检查。
 * 来源：lark-claw packages/service-runtime（整体平移，M0；子进程清单在 M5 对接新 bins）。
 */
import { spawn } from "node:child_process";
import { appendFile, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { openSync } from "node:fs";

import {
  createRuntimePaths,
  getPostgresStatus,
  loadLocalDatabaseConfig,
  startPostgres,
  stopPostgres,
} from "dsh-lark-postgres-runtime";

import { ManagedProcess } from "./managed-process.js";
import { resolveIsolationProfile, type IsolationProfileConfig } from "./isolation-profile.js";
import {
  createPodmanMachineKeepalive,
  type PodmanLifecycle,
} from "./podman-runtime.js";
import { createServiceEnvironment } from "./service-environment.js";
import { rotateLog, servicePaths, type SupervisorPaths } from "./supervisor-files.js";

const MONITOR_INTERVAL_MS = 10_000;
const WORKER_FAILURE_LIMIT = 3;
const WORKER_HEALTH_TIMEOUT_MS = 3_000;
const ADMIN_FAILURE_LIMIT = 3;
const ADMIN_HEALTH_TIMEOUT_MS = 3_000;
const AUTH_FAILURE_LIMIT = 3;
const AUTH_HEALTH_TIMEOUT_MS = 3_000;
// 迁移期并存端口（M5 交接后随 bundle 配置改回 8787/8790，此处同步改）。
const WORKER_DEFAULT_PORT = 8788;
const ADMIN_DEFAULT_PORT = 8791;
const GATEWAY_HEARTBEAT_TIMEOUT_MS = 45_000;
const MIN_PORT = 1;
const MAX_PORT = 65_535;
const CANONICAL_PORT = /^[1-9]\d*$/;

type GatewayState = "starting" | "connected" | "reconnecting" | "failed";

interface ServiceSupervisorOptions {
  monitorIntervalMs?: number;
  podman?: PodmanLifecycle;
}

function resolvePort(value: string | undefined, defaultPort: number, name: string): number {
  if (value === undefined) return defaultPort;
  const port = Number(value);
  if (
    !CANONICAL_PORT.test(value)
    || !Number.isSafeInteger(port)
    || port < MIN_PORT
    || port > MAX_PORT
  ) {
    throw new Error(`${name} 必须是 ${MIN_PORT}..${MAX_PORT} 的规范十进制端口`);
  }
  return port;
}

export class ServiceSupervisor {
  private gatewayHeartbeatAt = 0;
  private gatewayState: GatewayState = "starting";
  private monitor?: NodeJS.Timeout;
  private postgresRunning = false;
  private startedAt = new Date().toISOString();
  private stopping = false;
  private workerFailures = 0;
  private adminFailures = 0;
  private authFailures = 0;
  private readonly authEnabled: boolean;
  private readonly paths: SupervisorPaths;
  private readonly podman: PodmanLifecycle;
  private readonly monitorIntervalMs: number;
  private readonly gateway: ManagedProcess;
  private readonly worker: ManagedProcess;
  private readonly admin: ManagedProcess;
  private readonly auth: ManagedProcess | undefined;
  private readonly adminHealthUrl: string;
  private readonly authHealthUrl: string | undefined;
  private readonly workerHealthUrl: string;
  private readonly adminAuthHeader: Record<string, string>;
  private readonly serviceEnvironment: NodeJS.ProcessEnv;
  private readonly isolation: IsolationProfileConfig;

  constructor(root: string, options: ServiceSupervisorOptions = {}) {
    this.paths = servicePaths(root);
    this.serviceEnvironment = createServiceEnvironment(process.env, { root });
    const adminPort = resolvePort(this.serviceEnvironment.ADMIN_PORT, ADMIN_DEFAULT_PORT, "ADMIN_PORT");
    const workerPort = resolvePort(this.serviceEnvironment.LARK_WORKER_PORT, WORKER_DEFAULT_PORT, "LARK_WORKER_PORT");
    this.authEnabled = this.serviceEnvironment.DSH_AUTH_ENABLED === "true";
    const authPort = this.authEnabled ? resolvePort(this.serviceEnvironment.AUTH_PORT, 3080, "AUTH_PORT") : undefined;
    this.isolation = resolveIsolationProfile(this.serviceEnvironment);
    this.podman = options.podman ?? createPodmanMachineKeepalive(this.serviceEnvironment);
    this.monitorIntervalMs = options.monitorIntervalMs ?? MONITOR_INTERVAL_MS;
    this.adminHealthUrl = `http://127.0.0.1:${adminPort}/api/admin/healthz`;
    this.authHealthUrl = authPort === undefined ? undefined : `http://127.0.0.1:${authPort}/healthz`;
    this.workerHealthUrl = `http://127.0.0.1:${workerPort}/healthz`;
    // admin 健康面需要 Bearer（与 dsh-lark-admin 的 ADMIN_TOKEN 凭证引用一致）。
    this.adminAuthHeader = this.serviceEnvironment.ADMIN_TOKEN
      ? { authorization: `Bearer ${this.serviceEnvironment.ADMIN_TOKEN}` }
      : {};
    this.admin = new ManagedProcess("admin", () => this.spawnService(
      this.paths.adminEntry, this.paths.adminLog,
    ), { onEvent: (event) => void this.log(event) });
    this.auth = this.authEnabled ? new ManagedProcess("auth", () => this.spawnService(
      this.paths.authEntry, this.paths.authLog,
    ), { onEvent: (event) => void this.log(event) }) : undefined;
    const workerArgs = ["--patch", this.isolation.overlay];
    if (this.authEnabled) workerArgs.push("--port", this.serviceEnvironment.DSH_WEB_INTERNAL_PORT ?? "3081");
    this.worker = new ManagedProcess("worker", () => this.spawnService(
      this.paths.workerEntry, this.paths.workerLog, workerArgs,
    ), { onEvent: (event) => void this.log(event) });
    this.gateway = new ManagedProcess("gateway", () => this.spawnService(
      this.paths.gatewayEntry, this.paths.gatewayLog,
    ), {
      onEvent: (event) => void this.log(event),
      onMessage: (message) => this.handleGatewayMessage(message),
    });
  }

  async run(): Promise<void> {
    await mkdir(this.paths.serviceRoot, { recursive: true });
    await Promise.all([
      rotateLog(this.paths.supervisorLog),
      rotateLog(this.paths.workerLog),
      rotateLog(this.paths.gatewayLog),
      rotateLog(this.paths.adminLog),
      ...(this.authEnabled ? [rotateLog(this.paths.authLog)] : []),
    ]);
    await unlink(this.paths.stopRequest).catch(() => undefined);
    await this.ensurePostgres();
    if (this.isolation.requiresPodman) await this.podman.ensureReady();
    this.worker.start();
    await this.waitForWorker();
    this.admin.start();
    await this.waitForAdmin();
    if (this.auth) {
      this.auth.start();
      await this.waitForAuth();
    }
    this.gateway.start();
    await this.writeStatus();
    this.monitor = setInterval(() => void this.tick(), this.monitorIntervalMs);
    await this.log({ phase: "ready", pid: process.pid });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.monitor) clearInterval(this.monitor);
    await this.log({ phase: "stopping" });
    // 子服务互不依赖，必须并行退出；串行等待每个 20 秒会让计划任务
    // 的停止窗口先强杀 Supervisor，数据库来不及执行 pg_ctl stop。
    await Promise.all([
      this.gateway.stop(),
      this.auth?.stop(),
      this.admin.stop(),
      this.worker.stop(),
    ]);
    await stopPostgres(createRuntimePaths(this.paths.root));
    this.postgresRunning = false;
    await this.writeStatus();
    await this.log({ phase: "stopped" });
  }

  private spawnService(entry: string, logPath: string, args: string[] = []) {
    const log = openSync(logPath, "a");
    return spawn(process.execPath, [entry, ...args], {
      cwd: this.paths.root,
      env: this.serviceEnvironment,
      stdio: ["ignore", log, log, "ipc"],
      windowsHide: true,
    });
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    if (await this.stopWasRequested()) return this.stopAndExit();
    await this.ensurePostgres();
    if (this.isolation.requiresPodman) await this.podman.maintain();
    await this.checkWorker();
    await this.checkAdmin();
    await this.checkAuth();
    await this.checkGateway();
    await this.writeStatus();
  }

  private async ensurePostgres(): Promise<void> {
    const runtimePaths = createRuntimePaths(this.paths.root);
    const config = loadLocalDatabaseConfig(process.env);
    const status = await getPostgresStatus(runtimePaths, config);
    // pg_ctl status 只表示进程存在；vectorVersion 为空时仍可能处于启动窗口。
    if (!status.running || !status.vectorVersion) await startPostgres(runtimePaths, config);
    // startPostgres 已完成实际 SQL 探针、应用库检查和迁移，返回即表示可用。
    this.postgresRunning = true;
  }

  private async checkWorker(): Promise<void> {
    const healthy = await fetch(this.workerHealthUrl, {
      signal: AbortSignal.timeout(WORKER_HEALTH_TIMEOUT_MS),
    }).then((response) => response.ok).catch(() => false);
    if (healthy) {
      this.workerFailures = 0;
      this.worker.markHealthy();
      return;
    }
    this.workerFailures += 1;
    if (this.workerFailures < WORKER_FAILURE_LIMIT) return;
    this.workerFailures = 0;
    await this.worker.restart("health-check-failed");
  }

  private async checkGateway(): Promise<void> {
    if (!this.gateway.snapshot().running) return;
    const heartbeatAge = Date.now() - this.gatewayHeartbeatAt;
    if (this.gatewayHeartbeatAt > 0 && heartbeatAge <= GATEWAY_HEARTBEAT_TIMEOUT_MS) return;
    if (this.gatewayHeartbeatAt === 0 && Date.now() - Date.parse(this.startedAt) < GATEWAY_HEARTBEAT_TIMEOUT_MS) return;
    this.gatewayState = "starting";
    this.gatewayHeartbeatAt = 0;
    await this.gateway.restart("callback-heartbeat-stale");
  }

  private async checkAdmin(): Promise<void> {
    const healthy = await fetch(this.adminHealthUrl, {
      headers: this.adminAuthHeader,
      signal: AbortSignal.timeout(ADMIN_HEALTH_TIMEOUT_MS),
    }).then((response) => response.ok).catch(() => false);
    if (healthy) {
      this.adminFailures = 0;
      this.admin.markHealthy();
      return;
    }
    this.adminFailures += 1;
    if (this.adminFailures < ADMIN_FAILURE_LIMIT) return;
    this.adminFailures = 0;
    await this.admin.restart("health-check-failed");
  }

  private async checkAuth(): Promise<void> {
    if (!this.auth || !this.authHealthUrl) return;
    const healthy = await fetch(this.authHealthUrl, { signal: AbortSignal.timeout(AUTH_HEALTH_TIMEOUT_MS) }).then((response) => response.ok).catch(() => false);
    if (healthy) {
      this.authFailures = 0;
      this.auth.markHealthy();
      return;
    }
    this.authFailures += 1;
    if (this.authFailures < AUTH_FAILURE_LIMIT) return;
    this.authFailures = 0;
    await this.auth.restart("health-check-failed");
  }

  private handleGatewayMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const value = message as Record<string, unknown>;
    if (value.type !== "lark-status") return;
    if (!["starting", "connected", "reconnecting", "failed"].includes(String(value.state))) return;
    this.gatewayState = value.state as GatewayState;
    this.gatewayHeartbeatAt = Date.now();
    if (this.gatewayState === "connected") this.gateway.markHealthy();
  }

  private async waitForWorker(): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const ready = await fetch(this.workerHealthUrl, {
        signal: AbortSignal.timeout(WORKER_HEALTH_TIMEOUT_MS),
      }).then((response) => response.ok).catch(() => false);
      if (ready) return;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    }
    throw new Error("Worker did not become ready within 60 seconds");
  }

  private async waitForAdmin(): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const ready = await fetch(this.adminHealthUrl, {
        headers: this.adminAuthHeader,
        signal: AbortSignal.timeout(ADMIN_HEALTH_TIMEOUT_MS),
      }).then((response) => response.ok).catch(() => false);
      if (ready) return;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    }
    throw new Error("Admin API did not become ready within 60 seconds");
  }

  private async waitForAuth(): Promise<void> {
    if (!this.authHealthUrl) return;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const ready = await fetch(this.authHealthUrl, { signal: AbortSignal.timeout(AUTH_HEALTH_TIMEOUT_MS) }).then((response) => response.ok).catch(() => false);
      if (ready) return;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    }
    throw new Error("Auth edge did not become ready within 60 seconds");
  }

  private async stopWasRequested(): Promise<boolean> {
    return await stat(this.paths.stopRequest).then(() => true).catch(() => false);
  }

  private async stopAndExit(): Promise<void> {
    await unlink(this.paths.stopRequest).catch(() => undefined);
    await this.stop();
    process.exit(0);
  }

  private async writeStatus(): Promise<void> {
    const status = {
      admin: { ...this.admin.snapshot(), healthy: this.adminFailures === 0 },
      auth: this.auth ? { ...this.auth.snapshot(), healthy: this.authFailures === 0 } : { enabled: false },
      gateway: {
        ...this.gateway.snapshot(),
        callbackState: this.gatewayState,
        heartbeatAt: this.gatewayHeartbeatAt ? new Date(this.gatewayHeartbeatAt).toISOString() : null,
      },
      isolation: { profile: this.isolation.profile },
      podman: this.isolation.requiresPodman
        ? this.podman.snapshot()
        : { required: false, state: "not-required" },
      postgres: { running: this.postgresRunning },
      startedAt: this.startedAt,
      supervisor: { pid: process.pid, stopping: this.stopping },
      worker: { ...this.worker.snapshot(), healthy: this.workerFailures === 0 },
    };
    await writeFile(this.paths.status, JSON.stringify(status, null, 2), "utf8");
  }

  private async log(event: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({ at: new Date().toISOString(), ...event });
    await appendFile(this.paths.supervisorLog, `${line}\n`, "utf8");
  }
}
