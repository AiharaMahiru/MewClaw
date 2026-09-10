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

export class BrowserAppError extends Error {
  constructor(readonly code: BrowserErrorCode, message: string = code) {
    super(message);
    this.name = "BrowserAppError";
  }
}
