import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Context } from "@deepseek-ai/cordis";
import { boot } from "@deepseek-ai/dsh-app-boot";
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from "@deepseek-ai/dsh-launch-environment";
import type {
  DoorAgentMigrationService,
  WorkspaceProviderConfig,
} from "dsh-dooragent-migration";

import type {} from "./consumer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(root, "cordis.yml");

export interface MigrationActorInput {
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
}

export interface MigrationRuntime {
  service: DoorAgentMigrationService;
  dispose(): Promise<void>;
}

export interface MigrationRuntimeOptions {
  boot?: typeof boot;
  environment?: Readonly<Record<string, string | undefined>>;
}

export async function startMigrationRuntime(
  actor: MigrationActorInput,
  statePath: string,
  options: MigrationRuntimeOptions = {},
): Promise<MigrationRuntime> {
  const bootApp = options.boot ?? boot;
  const snapshot = createLaunchEnvironmentSnapshot([{
    source: "process",
    values: definedEnvironment(options.environment ?? process.env),
  }]);
  const workspaceProvider = workspaceProviderConfig(options.environment ?? process.env);
  const patches = [{
    id: "dooragent-migration",
    config: { actor, statePath, ...(workspaceProvider ? { workspaceProvider } : {}) },
  }];
  const ctx = await bootApp("dooragent-migration", configPath, patches, (hostCtx) => {
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, snapshot);
  });
  return runtimeFromContext(ctx);
}

function workspaceProviderConfig(
  environment: Readonly<Record<string, string | undefined>>,
): WorkspaceProviderConfig | undefined {
  const baseUrl = environment.DSH_WORKSPACE_PROVIDER_URL;
  const userRoot = environment.DSH_USER_WORKSPACE_ROOT;
  const adminRoot = environment.DSH_ADMIN_WORKSPACE_ROOT;
  const tokenEnv = environment.DSH_WORKSPACE_PROVIDER_TOKEN_ENV;
  const hasOverride = [baseUrl, userRoot, adminRoot, tokenEnv].some((value) => value !== undefined);
  if (process.platform !== "linux" && !hasOverride) return undefined;
  if (hasOverride && (!baseUrl || !userRoot || !adminRoot)) {
    throw new Error("MIGRATION_WORKSPACE_PROVIDER_CONFIG_INCOMPLETE");
  }
  return {
    baseUrl: baseUrl ?? "http://127.0.0.1:13081",
    tokenEnv: tokenEnv ?? "WORKER_TOKEN",
    userRoot: userRoot ?? "/var/lib/dsh/workspaces/users",
    adminRoot: adminRoot ?? "/var/lib/dsh/workspaces/admin",
  };
}

function definedEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

async function runtimeFromContext(ctx: Context): Promise<MigrationRuntime> {
  const service = ctx.dooragentMigrationCommand;
  if (!service) {
    await ctx.fiber.dispose();
    throw new Error("MIGRATION_SERVICE_UNAVAILABLE");
  }
  let disposed = false;
  return {
    service,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await ctx.fiber.dispose();
    },
  };
}
