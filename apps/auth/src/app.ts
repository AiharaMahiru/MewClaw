import type { AddressInfo } from "node:net";

import type { Context } from "@deepseek-ai/cordis";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import z from "@deepseek-ai/schemastery";
import {
  AuthService,
  MemoryAuthStore,
  PostgresAuthStore,
  type AuthServiceOptions,
  type AuthStore,
  type MailSender,
} from "dsh-lark-auth";
import {
  createAuthEdgeServer,
  createMailSender,
  createPromptAuditor,
  type AuthEdgeConfig,
  type AuthEdgeServerOptions,
  type MailConfig,
} from "dsh-lark-auth-edge";
import type { PromptAuditModel } from "./prompt-audit-model.js";
import { createPromptAuditModel } from "./prompt-audit-model.js";

export const name = "lark-auth-runtime";
export const Config = z.object({});

/** Auth 业务生命周期的 Cordis 所有者；App 入口只负责组合 boot 与信号。 */
export async function apply(ctx: Context): Promise<void> {
  const bootCheck = bootCheckRequested(process.argv);
  const environment = bootCheck
    ? {
        ...process.env,
        AUTH_DATABASE_URL: process.env.AUTH_DATABASE_URL ?? "postgres://boot-check.invalid/auth",
        AUTH_USER_MODEL_ENCRYPTION_KEY: process.env.AUTH_USER_MODEL_ENCRYPTION_KEY ?? "A".repeat(43),
      }
    : process.env;
  const runtime = await runAuthApp({
    config: (await import("dsh-lark-auth-edge")).resolveAuthConfig(environment),
    bootCheck,
    dependencies: { createAuditModel: () => createPromptAuditModel({ launchEnvironment: launchEnvironmentOf(ctx) }) },
  });
  if (runtime) ctx.effect(() => () => runtime.close());
}

const BOOT_CHECK_HOST = "127.0.0.1";
const BOOT_CHECK_PORT = 0;
const BOOT_CHECK_HEALTH_TIMEOUT_MS = 5_000;

interface AuthStoreLifecycle extends AuthStore {
  migrate(): Promise<void>;
  close(): Promise<void>;
}

interface AuthEdgeLifecycle {
  listen(): Promise<void>;
  close(): Promise<void>;
  address(): AddressInfo | string | null;
}

export interface AuthAppDependencies {
  createStore(databaseUrl: string): AuthStoreLifecycle;
  createMailSender(config: MailConfig): MailSender;
  createService(options: AuthServiceOptions): AuthService;
  createEdgeServer(options: AuthEdgeServerOptions): AuthEdgeLifecycle;
  createAuditModel(): Promise<PromptAuditModel>;
}

export interface StartAuthAppOptions {
  config: AuthEdgeConfig;
  bootCheck: boolean;
  dependencies?: Partial<AuthAppDependencies>;
}

export interface RunAuthAppOptions extends StartAuthAppOptions {
  log?: (line: string) => void;
}

export interface AuthAppRuntime {
  readonly config: AuthEdgeConfig;
  close(): Promise<void>;
}

const productionDependencies: AuthAppDependencies = {
  createAuditModel: async () => { throw new Error("auth: 启用审计时必须由启动器提供分层模型配置"); },
  createStore: (databaseUrl) => new PostgresAuthStore(databaseUrl),
  createMailSender,
  createService: (options) => new AuthService(options),
  createEdgeServer: (options) => {
    const edge = createAuthEdgeServer(options);
    return {
      listen: () => edge.listen(),
      close: () => edge.close(),
      address: () => edge.server.address(),
    };
  },
};

export function bootCheckRequested(argv: readonly string[]): boolean {
  return argv.includes("--boot-check");
}

export async function startAuthApp(options: StartAuthAppOptions): Promise<AuthAppRuntime> {
  const dependencies = {
    ...productionDependencies,
    ...(options.bootCheck ? { createStore: () => new BootCheckAuthStore() } : {}),
    ...options.dependencies,
  };
  const config = runtimeConfig(options.config, options.bootCheck);
  const store = dependencies.createStore(config.databaseUrl);
  let edge: AuthEdgeLifecycle | undefined;
  let auditModel: PromptAuditModel | undefined;
  try {
    await store.migrate();
    const service = dependencies.createService({
      store,
      mail: dependencies.createMailSender(config.mail),
      resetBaseUrl: `${config.publicOrigin}/auth/reset`,
      userModelEncryptionKey: config.userModelEncryptionKey,
    });
    if (config.promptAudit?.enabled && !options.bootCheck) auditModel = await dependencies.createAuditModel();
    const promptAuditor = auditModel && config.promptAudit ? createPromptAuditor(auditModel, config.promptAudit) : undefined;
    edge = dependencies.createEdgeServer({ config, service, ...(promptAuditor ? { promptAuditor } : {}) });
    await edge.listen();
    if (options.bootCheck) await assertBootHealthy(edge);
    return createRuntime(config, edge, store, auditModel);
  } catch (error) {
    await closeInOrder(edge, store, auditModel).catch(() => undefined);
    throw error;
  }
}

/** 发布 boot-check 使用进程内存储，避免迁移或接触任何真实数据库。 */
class BootCheckAuthStore extends MemoryAuthStore implements AuthStoreLifecycle {
  async migrate(): Promise<void> {}
  async close(): Promise<void> {}
}

export async function runAuthApp(options: RunAuthAppOptions): Promise<AuthAppRuntime | undefined> {
  const runtime = await startAuthApp(options);
  const log = options.log ?? console.log;
  if (!options.bootCheck) {
    log(`[auth] listening on ${runtime.config.host}:${runtime.config.port} mailMode=${runtime.config.mail.mode}`);
    return runtime;
  }
  log("[auth] boot-check ready");
  await runtime.close();
  log("[auth] disposed");
  return undefined;
}

function runtimeConfig(config: AuthEdgeConfig, bootCheck: boolean): AuthEdgeConfig {
  if (!bootCheck) return config;
  // 冒烟只开放临时 loopback 监听，并彻底移除 SMTP 凭证与外发能力。
  return {
    ...config,
    host: BOOT_CHECK_HOST,
    port: BOOT_CHECK_PORT,
    mail: { mode: "console", port: config.mail.port, secure: config.mail.secure },
  };
}

function createRuntime(
  config: AuthEdgeConfig,
  edge: AuthEdgeLifecycle,
  store: AuthStoreLifecycle,
  auditModel?: PromptAuditModel,
): AuthAppRuntime {
  let closed = false;
  return {
    config,
    async close() {
      if (closed) return;
      closed = true;
      await closeInOrder(edge, store, auditModel);
    },
  };
}

async function closeInOrder(edge: AuthEdgeLifecycle | undefined, store: AuthStoreLifecycle, auditModel?: PromptAuditModel): Promise<void> {
  const edgeResult = edge ? await settle(() => edge.close()) : undefined;
  const auditResult = auditModel ? await settle(() => auditModel.close()) : undefined;
  const storeResult = await settle(() => store.close());
  if (edgeResult?.status === "rejected") throw edgeResult.reason;
  if (auditResult?.status === "rejected") throw auditResult.reason;
  if (storeResult.status === "rejected") throw storeResult.reason;
}

async function settle(operation: () => Promise<void>): Promise<PromiseSettledResult<void>> {
  try {
    await operation();
    return { status: "fulfilled", value: undefined };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

async function assertBootHealthy(edge: AuthEdgeLifecycle): Promise<void> {
  const address = edge.address();
  if (!address || typeof address === "string") throw new Error("auth: boot-check 未获得监听地址");
  // listen 完成后仍走一次真实 HTTP 路由，避免把“已绑定 socket”误报为应用 ready。
  const response = await fetch(`http://${BOOT_CHECK_HOST}:${address.port}/healthz`, {
    signal: AbortSignal.timeout(BOOT_CHECK_HEALTH_TIMEOUT_MS),
  });
  const body: unknown = await response.json();
  if (!response.ok || !body || typeof body !== "object" || (body as { ok?: unknown }).ok !== true) {
    throw new Error("auth: boot-check 健康检查失败");
  }
}
