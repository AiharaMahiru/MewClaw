/** 网关到 worker 的单次提交、控制与 NDJSON 消费客户端。 */
import { createHash } from "node:crypto";

import type {
  ArtifactImage,
  ArtifactReadRequest,
  CronControlCommand,
  CronDelivery,
  CronDeliveryAckRequest,
  CronDeliveryClaimRequest,
  InteractionId,
  RunId,
  RunRequest,
  RunStreamDone,
  RunStreamItem,
  Scope,
  SessionOverview,
  SessionOverviewRequest,
  SessionClaimRequest,
  SessionDirectoryCurrent,
  SessionDirectoryList,
  SessionDirectoryRequest,
  SessionUseRequest,
} from "dsh-lark-contracts";
import { isImageArtifactMimeType } from "dsh-lark-contracts";

import { RunClientError, type RunClientErrorCode } from "./errors.js";
import { readBinaryResponse, readJsonResponse } from "./response.js";
import { parseSessionDirectoryCurrent, parseSessionDirectoryList } from "./session-directory-validation.js";
import { streamFromResponse } from "./stream.js";
import { parseCronDeliveries, parseSessionOverview } from "./validation.js";

export { RunClientError, type RunClientErrorCode } from "./errors.js";

export type RunStreamYield = RunStreamItem | RunStreamDone;

export interface RunEventStream {
  [Symbol.asyncIterator](): AsyncIterator<RunStreamYield>;
}

export interface LarkRunClient {
  submit(request: RunRequest, signal?: AbortSignal): Promise<RunEventStream>;
  cancel(runId: RunId): Promise<void>;
  resolveInteraction(
    scope: Scope,
    interactionId: InteractionId,
    answer: { selected: string[]; custom?: string },
  ): Promise<void>;
  sessionOverview(input: SessionOverviewRequest): Promise<SessionOverview>;
  sessionCurrent(input: SessionDirectoryRequest): Promise<SessionDirectoryCurrent>;
  sessionList(input: SessionDirectoryRequest): Promise<SessionDirectoryList>;
  sessionClaim(input: SessionClaimRequest): Promise<SessionDirectoryCurrent>;
  sessionUse(input: SessionUseRequest): Promise<SessionDirectoryCurrent>;
  sessionNew(input: SessionDirectoryRequest): Promise<SessionDirectoryCurrent>;
  sessionUnlink(input: SessionDirectoryRequest): Promise<SessionDirectoryCurrent>;
  readArtifact(input: ArtifactReadRequest): Promise<ArtifactImage>;
  cronControl(command: CronControlCommand): Promise<unknown>;
  claimCronDeliveries(input: CronDeliveryClaimRequest): Promise<CronDelivery[]>;
  ackCronDelivery(input: CronDeliveryAckRequest): Promise<boolean>;
}

export interface RunClientOptions {
  baseURL: string;
  token?: string;
  connectTimeoutMs: number;
  heartbeatToleranceMs: number;
  maxEventBytes: number;
  maxResponseBytes: number;
  onStreamError?: (runId: RunId, code: RunClientErrorCode) => void;
  fetch?: typeof fetch;
}

interface RequestInput {
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}

function cronErrorMessage(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "cron 控制请求非法";
  const message = (input as Record<string, unknown>).message;
  return typeof message === "string" ? message.slice(0, 512) : "cron 控制请求非法";
}

function artifactMimeType(response: Response): ArtifactImage["mimeType"] {
  const header = response.headers.get("content-type");
  const mimeType = header?.split(";", 1)[0]?.trim().toLowerCase();
  if (!isImageArtifactMimeType(mimeType)) {
    throw new RunClientError("RESPONSE_SCHEMA_ERROR", "worker 图片响应 MIME 非法");
  }
  return mimeType;
}

class FetchRunClient implements LarkRunClient {
  readonly #fetch: typeof fetch;
  readonly #authHeader: Record<string, string>;

  constructor(private readonly options: RunClientOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#authHeader = options.token ? { authorization: `Bearer ${options.token}` } : {};
  }

  async #request(input: RequestInput): Promise<Response> {
    const hasBody = input.body !== undefined;
    const headers = hasBody
      ? { "content-type": "application/json", ...this.#authHeader }
      : this.#authHeader;
    const connectAbort = new AbortController();
    const connectTimer = setTimeout(() => connectAbort.abort(), this.options.connectTimeoutMs);
    const signal = input.signal
      ? AbortSignal.any([input.signal, connectAbort.signal])
      : connectAbort.signal;
    try {
      return await this.#fetch(`${this.options.baseURL}${input.path}`, {
        method: "POST",
        headers,
        ...(hasBody ? { body: JSON.stringify(input.body) } : {}),
        signal,
      });
    } catch {
      if (input.signal?.aborted) throw new RunClientError("STREAM_BROKEN", "提交被取消");
      throw new RunClientError("CONNECT_FAILED", "连接 worker 失败");
    } finally {
      clearTimeout(connectTimer);
    }
  }

  #requireOk(response: Response): void {
    if (!response.ok) {
      throw new RunClientError("HTTP_ERROR", `worker 返回 ${response.status}`, response.status);
    }
  }

  async submit(request: RunRequest, signal?: AbortSignal): Promise<RunEventStream> {
    const response = await this.#request({
      path: "/v1/runs",
      body: request,
      ...(signal ? { signal } : {}),
    });
    this.#requireOk(response);
    return streamFromResponse(response, request, {
      heartbeatToleranceMs: this.options.heartbeatToleranceMs,
      maxEventBytes: this.options.maxEventBytes,
      onStreamError: (code) => this.options.onStreamError?.(request.runId, code),
    });
  }

  async cancel(runId: RunId): Promise<void> {
    const response = await this.#request({ path: `/v1/runs/${encodeURIComponent(runId)}/cancel` });
    if (response.status === 200 || response.status === 404) return;
    this.#requireOk(response);
  }

  async resolveInteraction(
    scope: Scope,
    interactionId: InteractionId,
    answer: { selected: string[]; custom?: string },
  ): Promise<void> {
    const response = await this.#request({ path: "/v1/interaction/resolve", body: { scope, interactionId, answer } });
    if (response.status === 200 || response.status === 404) return;
    this.#requireOk(response);
  }

  async sessionOverview(input: SessionOverviewRequest): Promise<SessionOverview> {
    const response = await this.#request({ path: "/v1/session-overview", body: input });
    this.#requireOk(response);
    return parseSessionOverview(await readJsonResponse(response, this.options.maxResponseBytes));
  }

  async #sessionDirectory<T>(path: string, body: unknown, parse: (input: unknown) => T): Promise<T> {
    const response = await this.#request({ path: `/v1/session-directory/${path}`, body });
    this.#requireOk(response);
    return parse(await readJsonResponse(response, this.options.maxResponseBytes));
  }

  sessionCurrent(input: SessionDirectoryRequest): Promise<SessionDirectoryCurrent> {
    return this.#sessionDirectory("current", input, parseSessionDirectoryCurrent);
  }

  sessionList(input: SessionDirectoryRequest): Promise<SessionDirectoryList> {
    return this.#sessionDirectory("list", input, parseSessionDirectoryList);
  }

  sessionClaim(input: SessionClaimRequest): Promise<SessionDirectoryCurrent> {
    return this.#sessionDirectory("claim", input, parseSessionDirectoryCurrent);
  }

  sessionUse(input: SessionUseRequest): Promise<SessionDirectoryCurrent> {
    return this.#sessionDirectory("use", input, parseSessionDirectoryCurrent);
  }

  sessionNew(input: SessionDirectoryRequest): Promise<SessionDirectoryCurrent> {
    return this.#sessionDirectory("new", input, parseSessionDirectoryCurrent);
  }

  sessionUnlink(input: SessionDirectoryRequest): Promise<SessionDirectoryCurrent> {
    return this.#sessionDirectory("unlink", input, parseSessionDirectoryCurrent);
  }

  async readArtifact(input: ArtifactReadRequest): Promise<ArtifactImage> {
    const response = await this.#request({ path: "/v1/artifacts/read", body: input });
    this.#requireOk(response);
    const bytes = await readBinaryResponse(response, this.options.maxResponseBytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== input.bytes || digest !== input.digest) {
      throw new RunClientError("RESPONSE_SCHEMA_ERROR", "worker 图片响应摘要或长度不匹配");
    }
    return { bytes, mimeType: artifactMimeType(response) };
  }

  async cronControl(command: CronControlCommand): Promise<unknown> {
    const response = await this.#request({ path: "/v1/cron-control", body: command });
    if (response.status === 400) {
      const body = await readJsonResponse(response, this.options.maxResponseBytes).catch(() => undefined);
      throw new RunClientError("HTTP_ERROR", cronErrorMessage(body), 400);
    }
    this.#requireOk(response);
    return readJsonResponse(response, this.options.maxResponseBytes);
  }

  async claimCronDeliveries(input: CronDeliveryClaimRequest): Promise<CronDelivery[]> {
    const response = await this.#request({ path: "/v1/cron-deliveries/claim", body: input });
    this.#requireOk(response);
    return parseCronDeliveries(await readJsonResponse(response, this.options.maxResponseBytes));
  }

  async ackCronDelivery(input: CronDeliveryAckRequest): Promise<boolean> {
    const response = await this.#request({ path: "/v1/cron-deliveries/ack", body: input });
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    this.#requireOk(response);
    return false;
  }
}

export function createRunClient(options: RunClientOptions): LarkRunClient {
  return new FetchRunClient(options);
}
