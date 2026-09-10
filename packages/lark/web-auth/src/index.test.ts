import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { apply } from "./index.js";

describe("Worker Web Auth 公开契约桥", () => {
  it("注册启动 URL 与 scope 两个精确端点，不替换官方对象方法", async () => {
    const routes: Array<{ path: string; handler: (req: never, res: never) => unknown }> = [];
    const bindWeb = vi.fn();
    const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("./index.ts", import.meta.url), "utf8"));
    expect(source).not.toMatch(/\.emit\s*=|requestRejection\s*=|authorizeIndex\s*=/u);
    const ctx = {
      credentials: { resolve: async () => ({ value: "worker-token" }) },
      connection: { authenticatedUrl: (base: string) => `${base}/?token=official` },
      larkScopeIndex: { bindWeb },
      webServer: { port: 13081, register: (route: typeof routes[number]) => { routes.push(route); return () => undefined; } },
      effect: (callback: () => unknown) => { callback(); },
    };
    await apply(ctx as never, { tokenEnv: "WORKER_TOKEN" });
    expect(routes.map(({ path }) => path)).toEqual(["/internal/web-auth/session", "/internal/web-auth/scope"]);

    const session = await invoke(routes[0]!, "", "worker-token");
    expect(session.status).toBe(200);
    expect(JSON.parse(session.body)).toEqual({ url: "http://127.0.0.1:13081/?token=official" });
    const binding = { sessionId: "s", scope: { userId: "u" } };
    const scope = await invoke(routes[1]!, JSON.stringify(binding), "worker-token");
    expect(scope.status).toBe(204);
    expect(bindWeb).toHaveBeenCalledWith(binding);
  });

  it("错误 Bearer 在桥端点 fail closed", async () => {
    const routes: Array<{ path: string; handler: (req: never, res: never) => unknown }> = [];
    await apply({
      credentials: { resolve: async () => ({ value: "worker-token" }) }, connection: { authenticatedUrl: () => "" },
      larkScopeIndex: { bindWeb: vi.fn() }, webServer: { port: 1, register: (route: typeof routes[number]) => { routes.push(route); return () => undefined; } },
      effect: (callback: () => unknown) => { callback(); },
    } as never, { tokenEnv: "WORKER_TOKEN" });
    expect((await invoke(routes[0]!, "", "wrong")).status).toBe(401);
  });
});

async function invoke(route: { handler: (req: never, res: never) => unknown }, body: string, token: string): Promise<{ status: number; body: string }> {
  const req = Readable.from(body ? [Buffer.from(body)] : []) as Readable & { method: string; headers: Record<string, string> };
  req.method = "POST";
  req.headers = { authorization: `Bearer ${token}` };
  const output = { status: 0, body: "" };
  const res = { writeHead: (status: number) => { output.status = status; }, end: (value = "") => { output.body = String(value); } };
  await route.handler(req as never, res as never);
  return output;
}
