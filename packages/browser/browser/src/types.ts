import type { Scope } from "dsh-lark-contracts";

export interface BrowserPage {
  url: string;
  title: string;
}

export interface BrowserSnapshot extends BrowserPage {
  content: string;
  truncated: boolean;
}

export interface BrowserEvaluateResult {
  result: string;
  truncated: boolean;
}

export type BrowserConsoleLevel = "error" | "warning" | "info" | "debug";

export interface BrowserConsoleResult {
  entries: string[];
  truncated: boolean;
}

export interface BrowserNetworkResult {
  entries: string[];
  truncated: boolean;
}

export interface BrowserScreenshotResult {
  path: string;
}

/** Browser Definition。Consumer 不感知浏览器 daemon 或内部认证。 */
export interface BrowserService {
  open(input: { scope: Scope; workspace: string; url: string }): Promise<BrowserPage>;
  snapshot(input: { scope: Scope }): Promise<BrowserSnapshot>;
  click(input: { scope: Scope; selector: string }): Promise<{ clicked: boolean }>;
  type(input: { scope: Scope; selector: string; text: string }): Promise<{ typed: boolean }>;
  wait(input: { scope: Scope; selector?: string; milliseconds?: number }): Promise<{ found?: boolean; waited?: number }>;
  evaluate(input: { scope: Scope; expression: string }): Promise<BrowserEvaluateResult>;
  console(input: { scope: Scope; level?: BrowserConsoleLevel; limit?: number }): Promise<BrowserConsoleResult>;
  network(input: { scope: Scope; limit?: number }): Promise<BrowserNetworkResult>;
  screenshot(input: {
    scope: Scope;
    workspace: string;
    filename?: string;
  }): Promise<BrowserScreenshotResult>;
  close(input: { scope: Scope }): Promise<{ closed: boolean }>;
  dispose(): Promise<void>;
}

export type BrowserErrorCode =
  | "BROWSER_INVALID_INPUT"
  | "BROWSER_SCRIPT_ERROR"
  | "BROWSER_FORBIDDEN"
  | "BROWSER_NOT_OPEN"
  | "BROWSER_NOT_FOUND"
  | "BROWSER_TIMEOUT"
  | "BROWSER_QUOTA"
  | "BROWSER_CONFLICT"
  | "BROWSER_UNAVAILABLE"
  | "BROWSER_UPSTREAM";

/** 可供工具层和运行层稳定分类的 daemon 错误。 */
export class BrowserError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    message: string = code,
    readonly status?: number,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "BrowserError";
  }
}
