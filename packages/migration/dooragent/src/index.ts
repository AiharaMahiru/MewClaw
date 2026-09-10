import type { Context } from "@deepseek-ai/cordis";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import z from "@deepseek-ai/schemastery";
import {
  makeBotId,
  makeConversationId,
  makeDeploymentId,
  makeTenantId,
  makeUserId,
} from "dsh-lark-contracts";

import { SqliteMigrationRunStore } from "./migration-state.js";
import { DefaultDoorAgentMigrationService } from "./service.js";
import { createOfficialWorkspaceProvider } from "./workspace-provider.js";
import type {
  DoorAgentMigrationService,
  MigrationActor,
  MigrationUserResultEvent,
} from "./types.js";

const MAX_ID_LENGTH = 256;

export const name = "dooragent-migration";
export const inject = ["auth", "credentials"];

export interface WorkspaceProviderConfig {
  baseUrl: string;
  tokenEnv: string;
  userRoot: string;
  adminRoot: string;
}

export interface Config {
  statePath: string;
  actor: {
    scope: {
      tenantId: string;
      botId: string;
      deploymentId: string;
      userId: string;
      conversationId: string;
    };
    operator: {
      userId: string;
      sessionId: string;
      requestId: string;
    };
  };
  workspaceProvider?: WorkspaceProviderConfig;
}

const actorSchema = z.object({
  scope: z.object({
    tenantId: z.string().required(),
    botId: z.string().required(),
    deploymentId: z.string().required(),
    userId: z.string().required(),
    conversationId: z.string().required(),
  }).required(),
  operator: z.object({
    userId: z.string().required(),
    sessionId: z.string().required(),
    requestId: z.string().required(),
  }).required(),
});

const workspaceProviderSchema: z<WorkspaceProviderConfig> = z.object({
  baseUrl: z.string().required(),
  tokenEnv: z.string().required(),
  userRoot: z.string().required(),
  adminRoot: z.string().required(),
});

export const Config: z<Config> = z.object({
  statePath: z.string().required(),
  actor: actorSchema.required(),
  // Schemastery 会把缺省 object 归一成 {}；never 分支保留未配置状态。
  workspaceProvider: z.union([z.never(), workspaceProviderSchema]),
});

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** 仅供一次性生产迁移组合装载的 DoorAgent 导入能力。 */
    dooragentMigration?: DoorAgentMigrationService;
  }
  interface Events {
    /**
     * 已提交的 DoorAgent 用户迁移结果；dispatcher 成功后 Auth outbox 才能 ack。
     * @param payload - 脱敏的用户迁移结果与服务端提交时间
     * @mode async
     */
    "migration/dooragent-user-result"(payload: MigrationUserResultEvent): void | Promise<void>;
  }
}

export function apply(ctx: Context, config: Config): void | Promise<void> {
  if (!ctx.auth) throw new Error("dooragent-migration: Auth capability 未激活");
  const actor = parseActor(config);
  const stateStore = new SqliteMigrationRunStore(config.statePath);
  let active = true;
  let service: DefaultDoorAgentMigrationService | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (service) service.dispose();
    else stateStore.close();
  };
  ctx.effect(() => () => {
    active = false;
    close();
  });

  const install = (workspaceProvider: ReturnType<typeof createOfficialWorkspaceProvider> | undefined): void => {
    if (!active) return;
    service = new DefaultDoorAgentMigrationService(ctx.auth!, actor, {
      stateStore,
      deliverUserResult: (event) => ctx.parallel("migration/dooragent-user-result", event),
      ...(workspaceProvider ? { workspaceProvider } : {}),
    });
    ctx.provide("dooragentMigration", service);
  };
  if (!config.workspaceProvider) {
    install(undefined);
    return;
  }
  return resolveWorkspaceProvider(ctx, config.workspaceProvider).then(install, (error) => {
    close();
    throw error;
  });
}

async function resolveWorkspaceProvider(
  ctx: Context,
  config: WorkspaceProviderConfig,
) {
  const resolved = await ctx.credentials!.resolve(config.tokenEnv as CredentialRef);
  if (!resolved?.value) {
    throw new Error(`dooragent-migration: 工作区 Provider 凭证引用未配置（${config.tokenEnv}）`);
  }
  return createOfficialWorkspaceProvider({
    baseUrl: config.baseUrl,
    token: resolved.value,
    userRoot: config.userRoot,
    adminRoot: config.adminRoot,
  });
}

function parseActor(config: Config): MigrationActor {
  const actor = config?.actor;
  const scope = actor?.scope;
  const operator = actor?.operator;
  const values = scope && operator ? [
    scope.tenantId, scope.botId, scope.deploymentId, scope.userId, scope.conversationId,
    operator.userId, operator.sessionId, operator.requestId,
  ] : [];
  if (values.length !== 8 || values.some((value) => !validId(value))
    || scope?.userId !== operator?.userId) invalidActor();
  return {
    scope: {
      tenantId: makeTenantId(scope.tenantId),
      botId: makeBotId(scope.botId),
      deploymentId: makeDeploymentId(scope.deploymentId),
      userId: makeUserId(scope.userId),
      conversationId: makeConversationId(scope.conversationId),
    },
    operator: { ...operator },
  };
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value.length <= MAX_ID_LENGTH && !/\s/.test(value);
}

function invalidActor(): never {
  throw new Error("dooragent-migration: actor 配置无效");
}

export * from "./auth-source.js";
export * from "./canonical-json.js";
export * from "./errors.js";
export * from "./planner.js";
export * from "./service.js";
export * from "./source.js";
export * from "./types.js";
export * from "./workspace-copy.js";
export * from "./workspace-provider.js";
export * from "./workspace-source.js";
