import type { Server } from "node:http";

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

import { resolveAppConfig } from "./config.js";
import { PreviewManager } from "./manager.js";
import { PodmanRuntime } from "./podman.js";
import { createPreviewServer } from "./server.js";

export const name = "preview-runtime";
export const Config = z.object({});

export async function apply(ctx: Context): Promise<void> {
  const config = resolveAppConfig(process.env);
  if (process.argv.includes("--boot-check")) {
    console.log("[dsh-preview] boot check passed");
    return;
  }
  const manager = new PreviewManager(config, new PodmanRuntime(config), Date.now, (event) => {
    const line = `[dsh-preview:audit] ${JSON.stringify(event)}`;
    if (event.type === "preview/cleanup-failed") console.warn(line); else console.log(line);
  });
  await manager.initialize();
  const server = createPreviewServer(config, manager, (failure) => console.warn(`[dsh-preview:request-failed] ${JSON.stringify(failure)}`));
  try {
    await listen(server, config.port, config.host);
  } catch (error) {
    await manager.dispose();
    throw error;
  }
  console.log(`[dsh-preview] listening on ${config.host}:${config.port}`);
  ctx.effect(() => async () => {
    await close(server);
    await manager.dispose();
  });
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
