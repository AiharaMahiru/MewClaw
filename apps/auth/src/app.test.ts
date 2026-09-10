import { describe, expect, it, vi } from "vitest";

import { MemoryAuthStore, type MailSender } from "dsh-lark-auth";
import {
  createAuthEdgeServer,
  type AuthEdgeConfig,
  type AuthEdgeServer,
  type MailConfig,
} from "dsh-lark-auth-edge";

import { bootCheckRequested, runAuthApp, startAuthApp } from "./app.js";

const FIXED_PORT = 43_121;
const REQUEST_BODY_LIMIT = 1_024;
const SMTP_PORT = 465;

const config: AuthEdgeConfig = {
  host: "0.0.0.0",
  port: FIXED_PORT,
  workerBaseUrl: "http://127.0.0.1:9",
  publicOrigin: `http://127.0.0.1:${FIXED_PORT}`,
  databaseUrl: "postgres://unused.invalid/auth",
  userModelEncryptionKey: "A".repeat(43),
  trustedOrigins: [`http://127.0.0.1:${FIXED_PORT}`],
  sessionCookieSecure: false,
  userWorkspaceRoot: "D:/auth-test/users",
  adminWorkspaceRoot: "D:/auth-test/admin",
  requestBodyLimit: REQUEST_BODY_LIMIT,
  mail: {
    mode: "smtp",
    host: "smtp.invalid",
    port: SMTP_PORT,
    secure: true,
    user: "unused",
    password: "unused",
    from: "unused@example.invalid",
  },
};

class LifecycleStore extends MemoryAuthStore {
  constructor(private readonly events: string[]) { super(); }

  async migrate(): Promise<void> { this.events.push("store:migrate"); }
  async close(): Promise<void> { this.events.push("store:close"); }
}

describe("Auth App lifecycle", () => {
  it("把独立审计器交给代理，并在退出时释放模型资源", async () => {
    const events: string[] = [];
    const store = new LifecycleStore(events);
    const generate = vi.fn(async () => '{"decision":"block"}');
    const runtime = await startAuthApp({
      config: { ...config, promptAudit: { enabled: true, timeoutMs: 1000, maxConcurrent: 2 } },
      bootCheck: false,
      dependencies: {
        createStore: () => store,
        createMailSender: fakeMail,
        createAuditModel: async () => ({ generate, close: async () => { events.push("audit:close"); } }),
        createEdgeServer: (options) => {
          expect(options.promptAuditor).toBeDefined();
          return { ...fakeEdge(events), listen: async () => {
            expect(await options.promptAuditor!.audit("受禁提示词")).toBe("block");
            events.push("edge:listen");
          } };
        },
      },
    });
    await runtime.close();
    await runtime.close();
    expect(generate).toHaveBeenCalledOnce();
    expect(events).toEqual(["store:migrate", "edge:listen", "edge:close", "audit:close", "store:close"]);
  });

  it("启用审计但没有模型启动工厂时不启动代理", async () => {
    const events: string[] = [];
    const createEdgeServer = vi.fn(() => fakeEdge(events));
    await expect(startAuthApp({
      config: { ...config, promptAudit: { enabled: true, timeoutMs: 1000, maxConcurrent: 2 } },
      bootCheck: false,
      dependencies: { createStore: () => new LifecycleStore(events), createMailSender: fakeMail, createEdgeServer },
    })).rejects.toThrow("分层模型配置");
    expect(createEdgeServer).not.toHaveBeenCalled();
    expect(events).toEqual(["store:migrate", "store:close"]);
  });

  it("boots on an ephemeral loopback port and shuts down without sending mail", async () => {
    const events: string[] = [];
    const logs: string[] = [];
    const store = new LifecycleStore(events);
    const mail = fakeMail();
    let edge: AuthEdgeServer | undefined;
    let runtimeConfig: AuthEdgeConfig | undefined;
    let listeningPort = 0;

    const result = await runAuthApp({
      config: { ...config, promptAudit: { enabled: true, timeoutMs: 1000, maxConcurrent: 2 } },
      bootCheck: true,
      dependencies: {
        createAuditModel: async () => { throw new Error("冒烟不得加载模型或凭证"); },
        createStore: () => store,
        createMailSender: () => mail,
        createEdgeServer: (options) => {
          runtimeConfig = options.config;
          edge = createAuthEdgeServer(options);
          edge.server.on("request", (request) => {
            if (request.url === "/healthz") events.push("edge:health");
          });
          return wrapEdge(edge, events, (port) => { listeningPort = port; });
        },
      },
      log: (line) => logs.push(line),
    });

    expect(bootCheckRequested(["node", "main.js", "--boot-check"])).toBe(true);
    expect(result).toBeUndefined();
    expect(runtimeConfig).toMatchObject({ host: "127.0.0.1", port: 0, mail: { mode: "console" } });
    expect(runtimeConfig?.mail).not.toHaveProperty("password");
    expect(listeningPort).not.toBe(FIXED_PORT);
    expect(edge?.server.address()).toBeNull();
    expect(events).toEqual([
      "store:migrate", "edge:listen", "edge:ready", "edge:health", "edge:close", "store:close",
    ]);
    expect(logs).toEqual(["[auth] boot-check ready", "[auth] disposed"]);
    expect(mail.sendVerification).not.toHaveBeenCalled();
    expect(mail.sendPasswordReset).not.toHaveBeenCalled();
  });

  it("preserves production configuration and direct lifecycle construction", async () => {
    const events: string[] = [];
    const store = new LifecycleStore(events);
    let edgeConfig: AuthEdgeConfig | undefined;
    let mailConfig: MailConfig | undefined;
    const runtime = await startAuthApp({
      config,
      bootCheck: false,
      dependencies: {
        createStore: () => store,
        createMailSender: (value) => { mailConfig = value; return fakeMail(); },
        createEdgeServer: (options) => {
          edgeConfig = options.config;
          return fakeEdge(events);
        },
      },
    });

    expect(runtime.config).toBe(config);
    expect(edgeConfig).toBe(config);
    expect(mailConfig).toBe(config.mail);
    await runtime.close();
    await runtime.close();
    expect(events).toEqual(["store:migrate", "edge:listen", "edge:close", "store:close"]);
  });

  it("closes every created dependency when startup fails", async () => {
    const events: string[] = [];
    const store = new LifecycleStore(events);

    await expect(startAuthApp({
      config,
      bootCheck: false,
      dependencies: {
        createStore: () => store,
        createMailSender: fakeMail,
        createEdgeServer: () => ({
          async listen() { events.push("edge:listen"); throw new Error("LISTEN_FAILED"); },
          async close() { events.push("edge:close"); },
          address() { return null; },
        }),
      },
    })).rejects.toThrow("LISTEN_FAILED");

    expect(events).toEqual(["store:migrate", "edge:listen", "edge:close", "store:close"]);
  });
});

function fakeMail(): MailSender {
  return {
    sendVerification: vi.fn(async () => undefined),
    sendPasswordReset: vi.fn(async () => undefined),
  };
}

function fakeEdge(events: string[]): {
  listen(): Promise<void>;
  close(): Promise<void>;
  address(): null;
} {
  return {
    async listen() { events.push("edge:listen"); },
    async close() { events.push("edge:close"); },
    address() { return null; },
  };
}

function wrapEdge(edge: AuthEdgeServer, events: string[], ready: (port: number) => void) {
  return {
    async listen() {
      events.push("edge:listen");
      await edge.listen();
      const address = edge.server.address();
      if (!address || typeof address === "string") throw new Error("Auth Edge did not bind");
      ready(address.port);
      events.push("edge:ready");
    },
    async close() {
      events.push("edge:close");
      await edge.close();
    },
    address() { return edge.server.address(); },
  };
}
