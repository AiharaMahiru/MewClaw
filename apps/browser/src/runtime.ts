import { access, constants } from "node:fs/promises";
import type { Server } from "node:http";

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

import { ChromiumRuntime } from "./cdp.js";
import { resolveBrowserConfig } from "./config.js";
import { BrowserManager } from "./manager.js";
import { createBrowserServer } from "./server.js";
import { UrlPolicy } from "./url-policy.js";

export const name = "browser-runtime";
export const Config = z.object({});

export async function apply(ctx: Context): Promise<void> {
  const config = resolveBrowserConfig(process.env);
  if (process.argv.includes("--boot-check")) {
    await access(config.chromiumPath, constants.X_OK);
    if (chromiumArgsForBootCheck().includes("--no-sandbox")) throw new Error("dsh-browser-app: 禁止 --no-sandbox");
    console.log("[dsh-browser] boot check passed");
    return;
  }
  const runtime = new ChromiumRuntime(config.chromiumPath, new UrlPolicy(), config.actionTimeoutMs, config.maxLogEntries, config.maxResultBytes);
  const manager = new BrowserManager(config, runtime);
  await manager.initialize();
  const server = createBrowserServer(config, manager);
  try {
    await listen(server, config.port, config.host);
  } catch (error) {
    await manager.dispose();
    throw error;
  }
  console.log(`[dsh-browser] listening on ${config.host}:${config.port}`);
  ctx.effect(() => async () => {
    await close(server);
    await manager.dispose();
  });
}

export function chromiumArgsForBootCheck(): string[] { return ["--headless=new", "--remote-debugging-pipe"]; }

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
