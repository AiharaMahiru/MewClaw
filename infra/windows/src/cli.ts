#!/usr/bin/env node
/**
 * Windows 服务监督器命令行入口（run）。
 * 来源：lark-claw packages/service-runtime（整体平移，M0）。
 */

import { resolve } from "node:path";

import { appendSupervisorFatal } from "./supervisor-files.js";
import { ServiceSupervisor } from "./supervisor.js";

const command = process.argv[2];

if (command !== "run") {
  console.error("Usage: dsh-lark-service run");
  process.exit(2);
}

const root = resolve(process.env.DSH_LARK_ROOT || process.cwd());
let supervisor: ServiceSupervisor | undefined;
let shuttingDown = false;
let failing = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await supervisor?.stop();
  process.exit(0);
}

async function fail(error: unknown): Promise<never> {
  if (!failing) {
    failing = true;
    await appendSupervisorFatal(root, error).catch(() => undefined);
  }
  console.error("Service supervisor failed", {
    type: error instanceof Error ? error.name : "unknown",
  });
  process.exit(1);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.once("uncaughtException", (error) => {
  void fail(error);
});
process.once("unhandledRejection", (error) => {
  void fail(error);
});

try {
  supervisor = new ServiceSupervisor(root);
  await supervisor.run();
} catch (error) {
  await fail(error);
}
