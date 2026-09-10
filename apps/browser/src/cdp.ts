import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import type { UrlPolicy } from "./url-policy.js";
import { BrowserAppError } from "./errors.js";
import { BrowserEgressProxy } from "./proxy.js";

type JsonObject = Record<string, unknown>;
type PipeProcess = ChildProcessByStdio<null, null, Readable> & ChildProcess & { stdio: [null, null, Readable, Writable, Readable] };

interface PendingCall {
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface BrowserLogs {
  console: readonly JsonObject[];
  network: readonly JsonObject[];
}

export interface BrowserPage {
  open(url: string): Promise<JsonObject>;
  snapshot(): Promise<JsonObject>;
  click(selector: string): Promise<JsonObject>;
  type(selector: string, text: string): Promise<JsonObject>;
  wait(input: { selector?: string; milliseconds?: number }): Promise<JsonObject>;
  evaluate(expression: string): Promise<unknown>;
  logs(kind: "console" | "network"): readonly JsonObject[];
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}

export interface BrowserRuntime {
  launch(profilePath: string): Promise<BrowserPage>;
}

export class ChromiumRuntime implements BrowserRuntime {
  constructor(
    private readonly chromiumPath: string,
    private readonly policy: UrlPolicy,
    private readonly timeoutMs: number,
    private readonly maxLogEntries: number,
    private readonly maxResultBytes: number,
  ) {}

  async launch(profilePath: string): Promise<BrowserPage> {
    const proxy = new BrowserEgressProxy(this.policy);
    const proxyPort = await proxy.listen();
    const child = spawn(this.chromiumPath, chromiumArgs(profilePath, proxyPort), {
      env: sanitizedSpawnEnv(profilePath),
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as PipeProcess;
    const transport = new CdpTransport(child, this.timeoutMs);
    try {
      const targets = await transport.call("Target.getTargets");
      const target = array(targets.targetInfos).find((item) => object(item).type === "page");
      const targetId = string(object(target).targetId);
      const attached = await transport.call("Target.attachToTarget", { targetId, flatten: true });
      const sessionId = string(attached.sessionId);
      const page = new CdpBrowserPage(transport, sessionId, targetId, this.policy, this.timeoutMs, this.maxLogEntries, this.maxResultBytes, () => proxy.close());
      await page.initialize();
      return page;
    } catch (error) {
      await transport.close();
      await proxy.close();
      throw error;
    }
  }
}

export function sanitizedSpawnEnv(profilePath: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: profilePath,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
  };
}

export function chromiumArgs(profilePath: string, proxyPort = 9): string[] {
  return [
    "--headless=new",
    "--remote-debugging-pipe",
    `--user-data-dir=${profilePath}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-sync",
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    "--proxy-bypass-list=<-loopback>",
    "--metrics-recording-only",
    "--password-store=basic",
    "about:blank",
  ];
}

export class CdpTransport {
  readonly #pending = new Map<number, PendingCall>();
  readonly #listeners = new Set<(method: string, params: JsonObject, sessionId?: string) => void>();
  #nextId = 1;
  #buffer = Buffer.alloc(0);
  #closed = false;
  #closing?: Promise<void>;

  constructor(private readonly child: PipeProcess, private readonly timeoutMs: number) {
    // Chromium stderr 只用于本地诊断，服务不转发且必须持续排空，避免管道写满阻塞。
    child.stdio[2].resume();
    child.stdio[4].on("data", (chunk: Buffer) => this.#consume(chunk));
    child.stdio[4].once("error", (error) => this.#failAll(error));
    child.once("error", (error) => this.#failAll(error));
    child.once("exit", () => this.#failAll(new Error("Chromium 已退出")));
  }

  call(method: string, params: JsonObject = {}, sessionId?: string): Promise<JsonObject> {
    if (this.#closed) return Promise.reject(new Error("CDP 已关闭"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BrowserAppError("BROWSER_TIMEOUT", `CDP 调用超时: ${method}`));
      }, this.timeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
      this.child.stdio[3].write(`${payload}\0`, (error) => {
        if (error) this.#reject(id, error);
      });
    });
  }

  onEvent(listener: (method: string, params: JsonObject, sessionId?: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      if (!this.#closed) {
        this.#closed = true;
        this.#failAll(new Error("CDP 已关闭"));
        this.child.stdio[3].end();
        this.child.kill("SIGTERM");
      }
      if (this.child.exitCode !== null || this.child.signalCode !== null) return;
      await Promise.race([childExit(this.child), delay(2_000)]);
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill("SIGKILL");
        await Promise.race([childExit(this.child), delay(2_000)]);
      }
    })();
    return this.#closing;
  }

  #consume(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > 16 * 1024 * 1024) {
      this.#failAll(new Error("CDP 帧超过上限"));
      void this.close();
      return;
    }
    for (;;) {
      const boundary = this.#buffer.indexOf(0);
      if (boundary < 0) return;
      const frame = this.#buffer.subarray(0, boundary).toString("utf8");
      this.#buffer = this.#buffer.subarray(boundary + 1);
      if (!frame) continue;
      let message: JsonObject;
      try { message = object(JSON.parse(frame)); } catch { this.#failAll(new Error("CDP 返回非法 JSON")); return; }
      const id = typeof message.id === "number" ? message.id : undefined;
      if (id !== undefined) {
        const pending = this.#pending.get(id);
        if (!pending) continue;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(string(object(message.error).message) || "CDP 调用失败"));
        else pending.resolve(object(message.result));
      } else if (typeof message.method === "string") {
        for (const listener of this.#listeners) listener(message.method, object(message.params), typeof message.sessionId === "string" ? message.sessionId : undefined);
      }
    }
  }

  #reject(id: number, error: Error): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  #failAll(error: Error): void {
    for (const [id] of this.#pending) this.#reject(id, error);
  }
}

class CdpBrowserPage implements BrowserPage {
  readonly #console: JsonObject[] = [];
  readonly #network: JsonObject[] = [];
  readonly #popupSessions = new Map<string, string>();
  readonly #removeListener: () => void;
  #closed = false;

  constructor(
    private readonly transport: CdpTransport,
    private readonly sessionId: string,
    private readonly targetId: string,
    private readonly policy: UrlPolicy,
    private readonly timeoutMs: number,
    private readonly maxLogEntries: number,
    private readonly maxResultBytes: number,
    private readonly closeProxy: () => Promise<void>,
  ) {
    this.#removeListener = transport.onEvent((method, params, session) => {
      if (method === "Target.attachedToTarget" || session === this.sessionId || (session !== undefined && this.#popupSessions.has(session))) {
        void this.#event(method, params, session);
      }
    });
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.#call("Page.enable"),
      this.#call("Runtime.enable"),
      this.#call("Network.enable", { maxTotalBufferSize: 1_048_576, maxResourceBufferSize: 262_144 }),
      this.#call("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }),
      this.transport.call("Browser.setDownloadBehavior", { behavior: "deny" }),
      this.transport.call("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: "page" }, { exclude: true }],
      }),
    ]);
    await this.#call("Runtime.runIfWaitingForDebugger");
  }

  async open(input: string): Promise<JsonObject> {
    const url = await this.policy.assertAllowed(input, true)
      .catch(() => { throw new BrowserAppError("BROWSER_FORBIDDEN"); });
    const result = await this.#call("Page.navigate", { url: url.href });
    if (result.errorText) throw new Error("页面导航失败");
    await this.#waitForLoad();
    return { url: await this.#currentUrl(), title: await this.#title() };
  }

  async snapshot(): Promise<JsonObject> {
    const [result, domValue] = await Promise.all([
      this.#call("Accessibility.getFullAXTree"),
      this.#evaluateInternal(`(() => {
        const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"]')]
          .slice(0, 500)
          .map((element, index) => {
            const ref = 'e' + (index + 1);
            element.setAttribute('data-dsh-ref', ref);
            const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
            return {
              selector: '[data-dsh-ref="' + ref + '"]',
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute('role') || undefined,
              name: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 500) || undefined,
              value: input && element instanceof HTMLInputElement && element.type !== 'password' ? element.value.slice(0, 500) : undefined,
            };
          });
        return { text: document.body?.innerText?.slice(0, 100000) || '', elements };
      })()`),
    ]);
    const nodes = array(result.nodes).slice(0, 1_000).map((value) => {
      const node = object(value);
      return compact({
        role: object(node.role).value,
        name: object(node.name).value,
        value: object(node.value).value,
        description: object(node.description).value,
      });
    });
    const dom = object(domValue);
    return bounded({
      url: await this.#currentUrl(),
      title: await this.#title(),
      text: dom.text,
      elements: dom.elements,
      nodes,
    }, this.maxResultBytes) as JsonObject;
  }

  async click(selector: string): Promise<JsonObject> {
    validateText(selector, 2_048, "selector");
    await this.#evaluateInternal(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) throw new Error('元素不存在'); element.click(); return true; })()`);
    return { clicked: true };
  }

  async type(selector: string, text: string): Promise<JsonObject> {
    validateText(selector, 2_048, "selector");
    validateText(text, 100_000, "text", true);
    await this.#evaluateInternal(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLElement && element.isContentEditable)) throw new Error('元素不可输入'); if ('value' in element) element.value = ${JSON.stringify(text)}; else element.textContent = ${JSON.stringify(text)}; element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} })); element.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    return { typed: true };
  }

  async wait(input: { selector?: string; milliseconds?: number }): Promise<JsonObject> {
    if (input.selector !== undefined) {
      validateText(input.selector, 2_048, "selector");
      const deadline = Date.now() + this.timeoutMs;
      while (Date.now() < deadline) {
        const found = await this.#evaluateInternal(`Boolean(document.querySelector(${JSON.stringify(input.selector)}))`);
        if (found === true) return { found: true };
        await delay(100);
      }
      throw new BrowserAppError("BROWSER_TIMEOUT", "等待元素超时");
    }
    const milliseconds = input.milliseconds;
    if (!Number.isSafeInteger(milliseconds) || milliseconds === undefined || milliseconds < 0 || milliseconds > this.timeoutMs) throw new Error("等待时间非法");
    await delay(milliseconds);
    return { waited: milliseconds };
  }

  async evaluate(expression: string): Promise<unknown> {
    validateText(expression, 100_000, "expression");
    return bounded(await this.#evaluateInternal(expression), this.maxResultBytes);
  }

  logs(kind: "console" | "network"): readonly JsonObject[] {
    return structuredClone(kind === "console" ? this.#console : this.#network);
  }

  async screenshot(): Promise<Buffer> {
    const result = await this.#call("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    const data = string(result.data);
    if (!data) throw new Error("截图失败");
    const buffer = Buffer.from(data, "base64");
    if (buffer.length > this.maxResultBytes * 4) throw new Error("截图过大");
    return buffer;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#removeListener();
    await this.transport.close();
    await this.closeProxy();
  }

  async #event(method: string, params: JsonObject, eventSession?: string): Promise<void> {
    if (method === "Target.attachedToTarget") {
      const target = object(params.targetInfo);
      const targetId = string(target.targetId);
      const attachedSession = string(params.sessionId);
      if (targetId === this.targetId && attachedSession) {
        await this.transport.call("Runtime.runIfWaitingForDebugger", {}, attachedSession).catch(() => undefined);
      } else if (target.type === "page" && targetId && attachedSession) {
        this.#popupSessions.set(attachedSession, targetId);
        await this.transport.call("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, attachedSession).catch(() => undefined);
        await this.transport.call("Runtime.runIfWaitingForDebugger", {}, attachedSession).catch(() => undefined);
      }
      return;
    }
    if (method === "Fetch.requestPaused") {
      const requestId = string(params.requestId);
      const popupTarget = eventSession === undefined ? undefined : this.#popupSessions.get(eventSession);
      if (popupTarget) {
        this.#popupSessions.delete(eventSession!);
        await this.transport.call("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, eventSession).catch(() => undefined);
        await this.transport.call("Target.closeTarget", { targetId: popupTarget }).catch(() => undefined);
        return;
      }
      try {
        const request = object(params.request);
        await this.policy.assertAllowed(string(request.url), false);
        await this.#call("Fetch.continueRequest", { requestId });
      } catch {
        await this.#call("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
      }
      return;
    }
    if (method === "Runtime.consoleAPICalled") {
      this.#push(this.#console, compact({
        type: params.type,
        timestamp: params.timestamp,
        values: array(params.args).slice(0, 20).map((arg) => redactValue(object(arg).value ?? object(arg).description)),
      }));
    } else if (method === "Network.responseReceived") {
      const response = object(params.response);
      this.#push(this.#network, compact({
        url: safeUrl(string(response.url)),
        status: response.status,
        mimeType: response.mimeType,
        type: params.type,
      }));
    } else if (method === "Network.loadingFailed") {
      this.#push(this.#network, compact({ requestId: params.requestId, failed: true, errorText: redactString(string(params.errorText)) }));
    }
  }

  #push(target: JsonObject[], value: JsonObject): void {
    target.push(bounded(value, 16_384) as JsonObject);
    if (target.length > this.maxLogEntries) target.splice(0, target.length - this.maxLogEntries);
  }

  async #evaluateInternal(expression: string): Promise<unknown> {
    const result = await this.#call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    return evaluateResult(result);
  }

  async #currentUrl(): Promise<string> {
    const value = await this.#evaluateInternal("location.href");
    return safeUrl(typeof value === "string" ? value : "");
  }

  async #title(): Promise<string> {
    const value = await this.#evaluateInternal("document.title");
    return typeof value === "string" ? redactString(value).slice(0, 1_000) : "";
  }

  async #waitForLoad(): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.#evaluateInternal("document.readyState");
      if (state === "complete" || state === "interactive") return;
      await delay(50);
    }
    throw new Error("页面加载超时");
  }

  #call(method: string, params: JsonObject = {}): Promise<JsonObject> {
    return this.transport.call(method, params, this.sessionId);
  }
}

/** 页面异常不是传输故障；不回传脚本、页面正文或可能含凭证的异常文本。 */
export function evaluateResult(result: JsonObject): unknown {
  if (result.exceptionDetails) throw new BrowserAppError("BROWSER_SCRIPT_ERROR", "页面脚本执行失败，请检查语法与变量，不要重试同一表达式");
  const value = object(result.result);
  return value.value ?? value.unserializableValue ?? null;
}

function bounded(value: unknown, maxBytes: number): unknown {
  const sanitized = sanitize(value, 0);
  const encoded = JSON.stringify(sanitized);
  if (Buffer.byteLength(encoded) <= maxBytes) return sanitized;
  return { truncated: true, preview: redactString(encoded.slice(0, Math.max(0, maxBytes - 64))) };
}

function sanitize(value: unknown, depth: number): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return redactString(value).slice(0, 32_768);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 1_000).map((entry) => sanitize(entry, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as JsonObject).slice(0, 1_000).map(([key, entry]) => [key, sensitiveKey(key) ? "[redacted]" : sanitize(entry, depth + 1)]));
  }
  return String(value);
}

function sensitiveKey(key: string): boolean {
  return /authorization|cookie|password|passwd|secret|token|api[-_]?key/i.test(key);
}

function redactValue(value: unknown): unknown {
  return sanitize(value, 0);
}

function redactString(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|key|token)[-_][A-Za-z0-9_-]{12,}\b/gi, "[redacted]");
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch { return ""; }
}

function validateText(value: string, max: number, field: string, empty = false): void {
  if (typeof value !== "string" || (!empty && !value) || value.length > max) throw new Error(`${field} 非法`);
}

function compact(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ""));
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function childExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once("exit", () => resolve()));
}
