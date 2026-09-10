const MAX_WORKER_RESPONSE_BYTES = 256 * 1024;

/** worker 响应不能作为管理面错误详情向浏览器透传。 */
export class WorkerResponseError extends Error {
  constructor() {
    super("worker response invalid");
    this.name = "WorkerResponseError";
  }
}

function declaredBodySize(response: Response): number {
  const header = response.headers.get("content-length");
  if (header === null) return 0;
  if (!/^\d+$/.test(header)) throw new WorkerResponseError();
  const size = Number(header);
  if (!Number.isSafeInteger(size)) throw new WorkerResponseError();
  return size;
}

/** 在跨进程边界限制 JSON 体，避免异常 worker 放大 admin 进程。 */
export async function readWorkerJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new WorkerResponseError();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    if (declaredBodySize(response) > MAX_WORKER_RESPONSE_BYTES) throw new WorkerResponseError();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_WORKER_RESPONSE_BYTES) throw new WorkerResponseError();
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    throw new WorkerResponseError();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new WorkerResponseError();
  }
}
