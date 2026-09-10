import type { Context } from "@deepseek-ai/cordis";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import type {} from "dsh-lark-uploads";

import { createCronHttpService } from "./cron-adapter.js";
import type { ResolvedRunConfig } from "./config.js";
import { createRunServer, type RunServer } from "./http.js";
import { readSessionOverview } from "./session-overview.js";
import type { RunCoordinator } from "./run-coordinator.js";

async function resolveToken(ctx: Context, config: ResolvedRunConfig): Promise<string | undefined> {
  if (!config.tokenEnv) {
    ctx.logger.warn("lark-run: 未配置 tokenEnv，HTTP 面无鉴权（仅限本机开发；生产必须配置）");
    return undefined;
  }
  const resolved = await ctx.credentials!.resolve(config.tokenEnv as CredentialRef);
  if (!resolved) {
    throw new Error(`lark-run: 凭证引用未配置（${config.tokenEnv}）——token 值绝不写入配置`);
  }
  return resolved.value;
}

export async function startRunServer(
  ctx: Context,
  config: ResolvedRunConfig,
  coordinator: RunCoordinator,
): Promise<RunServer> {
  const token = await resolveToken(ctx, config);
  return createRunServer({
    host: config.host,
    port: config.port,
    ...(token ? { token } : {}),
    enqueue: (request, signal, writer) => coordinator.run(request, signal, writer),
    sessionOverview: (input) => readSessionOverview(ctx.sessionPersistence!, ctx.larkSessionDirectory!, input),
    sessionDirectory: ctx.larkSessionDirectory!,
    readArtifact: (input) => ctx.larkUploads!.readImageArtifact({
      ...input,
      workspaceRoot: config.workspaceRoot,
    }),
    resolveInteraction: (scope, interactionId, answer) => {
      ctx.emit("lark/interaction/resolved", { scope, interactionId, answer });
      return true;
    },
    cancel: (runId) => coordinator.cancel(runId),
    queueDepth: () => coordinator.queueDepth(),
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    cron: createCronHttpService(ctx),
  });
}
