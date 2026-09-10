import type { PreviewErrorCode } from "dsh-preview";

/** daemon 内部错误；wire code 与 dsh-preview Definition 保持同一联合类型。 */
export class PreviewAppError extends Error {
  constructor(readonly code: PreviewErrorCode, message: string = code) {
    super(message);
    this.name = "PreviewAppError";
  }
}
