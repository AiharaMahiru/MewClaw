import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { scopeKey, type Scope } from "dsh-lark-contracts";

import type { BrowserConfig } from "./config.js";
import type { BrowserPage, BrowserRuntime } from "./cdp.js";
import { BrowserAppError } from "./errors.js";
export { BrowserAppError, type BrowserErrorCode } from "./errors.js";

export type BrowserOperation = "open" | "snapshot" | "click" | "type" | "wait" | "evaluate" | "console" | "network" | "screenshot" | "close";

export interface BrowserAction {
  operation: BrowserOperation;
  workspace?: string;
  url?: string;
  selector?: string;
  text?: string;
  expression?: string;
  milliseconds?: number;
  filename?: string;
}

interface Entry {
  page: BrowserPage;
  workspace: string;
  profile: string;
  timer: NodeJS.Timeout;
  closing?: Promise<void>;
  screenshotQueue: Promise<void>;
}

export class BrowserManager {
  readonly #entries = new Map<string, Entry>();
  #disposed = false;

  constructor(private readonly config: BrowserConfig, private readonly runtime: BrowserRuntime) {}

  async initialize(): Promise<void> {
    await mkdir(this.config.profileRoot, { recursive: true, mode: 0o700 });
  }

  async execute(scope: Scope, action: BrowserAction): Promise<unknown> {
    this.#assertActive();
    if (action.operation === "open") return this.#open(scope, action);
    const key = scopeKey(scope);
    const entry = this.#entries.get(key);
    if (!entry) throw new BrowserAppError("BROWSER_NOT_OPEN");
    this.#touch(key, entry);
    switch (action.operation) {
      case "snapshot": return entry.page.snapshot();
      case "click": return entry.page.click(required(action.selector));
      case "type": return entry.page.type(required(action.selector), requiredDefined(action.text));
      case "wait": return entry.page.wait({ ...(action.selector === undefined ? {} : { selector: action.selector }), ...(action.milliseconds === undefined ? {} : { milliseconds: action.milliseconds }) });
      case "evaluate": return entry.page.evaluate(required(action.expression));
      case "console": return { entries: entry.page.logs("console") };
      case "network": return { entries: entry.page.logs("network") };
      case "screenshot": return this.#queueScreenshot(scope, entry, action.filename);
      case "close": await this.#close(key, entry); return { closed: true };
      default: return exhaustive(action.operation);
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await Promise.allSettled([...this.#entries].map(([key, entry]) => this.#close(key, entry)));
  }

  async #open(scope: Scope, action: BrowserAction): Promise<unknown> {
    const workspace = await authorizeWorkspace(this.config.workspaceRoot, required(action.workspace), scope);
    const url = required(action.url);
    const key = scopeKey(scope);
    const existing = this.#entries.get(key);
    if (existing && existing.workspace !== workspace) await this.#close(key, existing);
    const current = this.#entries.get(key);
    if (current) {
      this.#touch(key, current);
      return current.page.open(url);
    }
    if (this.#entries.size >= this.config.maxSessions) throw new BrowserAppError("BROWSER_QUOTA");
    const scopeHash = createHash("sha256").update(key).digest("hex").slice(0, 16);
    const profile = await mkdtemp(join(this.config.profileRoot, `${scopeHash}-`));
    try {
      const page = await this.runtime.launch(profile);
      const timer = this.#timer(key);
      const entry: Entry = { page, workspace, profile, timer, screenshotQueue: Promise.resolve() };
      this.#entries.set(key, entry);
      try {
        return await page.open(url);
      } catch (error) {
        await this.#close(key, entry);
        throw error;
      }
    } catch (error) {
      await removeProfile(profile);
      throw error;
    }
  }

  async #screenshot(scope: Scope, entry: Entry, filenameInput: string | undefined): Promise<{ path: string }> {
    const filename = filenameInput ?? `screenshot-${Date.now()}.png`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.png$/i.test(filename) || filename.includes("..")) throw new BrowserAppError("BROWSER_INVALID_INPUT");
    // 会话期间目录可能被替换，写入前必须重新验证当前真实路径的所有权。
    const workspace = await authorizeWorkspace(this.config.workspaceRoot, entry.workspace, scope);
    const outputDir = join(workspace, ".dsh", "browser");
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    const realWorkspace = await realpath(workspace);
    const realOutput = await realpath(outputDir);
    if (!contained(realWorkspace, realOutput)) throw new BrowserAppError("BROWSER_FORBIDDEN");
    await assertScreenshotQuota(realOutput, this.config.maxScreenshotCount ?? 100, this.config.maxScreenshotBytes ?? 100 * 1024 * 1024);
    const directory = await open(realOutput, "r");
    const target = `/proc/self/fd/${directory.fd}/${filename}`;
    try {
      await writeFile(target, await entry.page.screenshot(), { mode: 0o600, flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") throw new BrowserAppError("BROWSER_CONFLICT");
        throw error;
      });
      const realTarget = await realpath(target);
      if (!contained(realOutput, realTarget)) {
        await rm(target, { force: true });
        throw new BrowserAppError("BROWSER_FORBIDDEN");
      }
      return { path: relative(workspace, realTarget) };
    } finally {
      await directory.close();
    }
  }

  async #queueScreenshot(scope: Scope, entry: Entry, filename: string | undefined): Promise<{ path: string }> {
    const result = entry.screenshotQueue.then(() => this.#screenshot(scope, entry, filename));
    entry.screenshotQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  #touch(key: string, entry: Entry): void {
    clearTimeout(entry.timer);
    entry.timer = this.#timer(key);
  }

  #timer(key: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const entry = this.#entries.get(key);
      if (entry) void this.#close(key, entry).catch(() => undefined);
    }, this.config.idleTimeoutMs);
    timer.unref();
    return timer;
  }

  async #close(key: string, entry: Entry): Promise<void> {
    if (entry.closing) return entry.closing;
    this.#entries.delete(key);
    clearTimeout(entry.timer);
    entry.closing = (async () => {
      try { await entry.page.close(); } finally { await removeProfile(entry.profile); }
    })();
    return entry.closing;
  }

  #assertActive(): void {
    if (this.#disposed) throw new BrowserAppError("BROWSER_UNAVAILABLE");
  }
}

async function authorizeWorkspace(rootInput: string, workspaceInput: string, scope: Scope): Promise<string> {
  if (!isAbsolute(rootInput) || !isAbsolute(workspaceInput)) throw new BrowserAppError("BROWSER_FORBIDDEN");
  const root = await realpath(resolve(rootInput)).catch(forbidden);
  const lexical = resolve(workspaceInput);
  const adminRoot = resolve(root, "admin");
  if (lexical === adminRoot) {
    const admin = await realpath(adminRoot).catch(forbidden);
    if (admin !== adminRoot || !contained(root, admin)) forbidden();
    return admin;
  }
  const expectedUserRoot = resolve(root, "users", scope.userId);
  if (!contained(root, expectedUserRoot)) forbidden();
  const userRoot = await realpath(expectedUserRoot).catch(forbidden);
  if (!contained(userRoot, lexical)) forbidden();
  const workspace = await realpath(lexical).catch(forbidden);
  if (!contained(userRoot, workspace)) forbidden();
  return workspace;
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function forbidden(): never {
  throw new BrowserAppError("BROWSER_FORBIDDEN");
}

function required(value: string | undefined): string {
  if (typeof value !== "string" || !value || value.length > 100_000) throw new BrowserAppError("BROWSER_INVALID_INPUT");
  return value;
}

function requiredDefined(value: string | undefined): string {
  if (typeof value !== "string" || value.length > 100_000) throw new BrowserAppError("BROWSER_INVALID_INPUT");
  return value;
}

function exhaustive(value: never): never {
  throw new BrowserAppError("BROWSER_INVALID_INPUT", `未知操作: ${String(value)}`);
}

async function assertScreenshotQuota(directory: string, maxCount: number, maxBytes: number): Promise<void> {
  const names = await readdir(directory);
  let count = 0;
  let bytes = 0;
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".png")) continue;
    const info = await lstat(join(directory, name));
    if (!info.isFile()) continue;
    count++;
    bytes += info.size;
  }
  if (count >= maxCount || bytes >= maxBytes) throw new BrowserAppError("BROWSER_QUOTA");
}

async function removeProfile(profile: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      return;
    } catch (error) {
      if (attempt >= 4 || !(error instanceof Error) || !("code" in error)
        || ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" && (error as NodeJS.ErrnoException).code !== "EBUSY")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}
