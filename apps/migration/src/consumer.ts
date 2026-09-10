import type { Context } from "@deepseek-ai/cordis";
import type { DoorAgentMigrationService } from "dsh-dooragent-migration";

export const name = "dooragent-migration-consumer";
export const inject = ["dooragentMigration"];

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** 一次性迁移 App 唯一消费入口；不向 Gateway、Web 或普通 Worker 暴露。 */
    dooragentMigrationCommand?: DoorAgentMigrationService;
  }
}

export function apply(ctx: Context): void {
  const service = ctx.dooragentMigration;
  if (!service) throw new Error("migration-consumer: MIGRATION_SERVICE_UNAVAILABLE");
  ctx.provide("dooragentMigrationCommand", service);
}
