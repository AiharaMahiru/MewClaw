import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";

import { isImageArtifactMimeType, LarkError, toWire, type RunId, type RunRequest } from "dsh-lark-contracts";

import { QueueFullError } from "./queue.js";
import { parseRunRequest } from "./request.js";
import type { NdjsonWriter, RunServerOptions } from "./http-types.js";
import {
  checkAuth,
  HttpInputError,
  readBody,
  writeInvalid,
  writeJson,
  writeNotFound,
} from "./http-utils.js";
import {
  parseCronAckBody,
  parseCronClaimBody,
  parseCronControlBody,
  parseArtifactReadBody,
  parseInteractionBody,
  parseRouteRunId,
  parseSessionClaimBody,
  parseSessionDirectoryBody,
  parseSessionOverviewBody,
  parseSessionUseBody,
} from "./http-validation.js";

type RouteHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;
type SessionDirectoryAction = "current" | "list" | "claim" | "use" | "new" | "unlink";

interface RunChannel {
  writer: NdjsonWriter;
  signal: AbortSignal;
  close(): void;
}

function createRunChannel(response: ServerResponse, heartbeatMs: number): RunChannel {
  const abort = new AbortController();
  let closed = false;
  const writer: NdjsonWriter = {
    write(item) {
      if (!closed) response.write(`${JSON.stringify(item)}\n`);
    },
    end() {
      if (closed) return;
      closed = true;
      response.end();
    },
    get closed() {
      return closed;
    },
  };
  response.on("close", () => {
    if (!writer.closed) abort.abort();
  });
  const heartbeat = setInterval(() => {
    if (!writer.closed) response.write("\n");
  }, heartbeatMs);
  return {
    writer,
    signal: abort.signal,
    close: () => {
      clearInterval(heartbeat);
      writer.end();
    },
  };
}

function writeRunFailure(writer: NdjsonWriter, request: RunRequest, error: unknown): void {
  const outcome = error instanceof QueueFullError
    ? { code: "QUEUE_FULL" as const, message: error.message }
    : toWire(error);
  writer.write({ envelope: { runId: request.runId, scope: request.scope }, outcome });
}

export class RunHttpHandler {
  readonly #routes: Map<string, RouteHandler>;

  constructor(private readonly options: RunServerOptions) {
    this.#routes = new Map([
      ["POST /v1/session-overview", this.#sessionOverview.bind(this)],
      ["POST /v1/session-directory/current", (request, response) => this.#sessionDirectory(request, response, "current")],
      ["POST /v1/session-directory/list", (request, response) => this.#sessionDirectory(request, response, "list")],
      ["POST /v1/session-directory/claim", (request, response) => this.#sessionDirectory(request, response, "claim")],
      ["POST /v1/session-directory/use", (request, response) => this.#sessionDirectory(request, response, "use")],
      ["POST /v1/session-directory/new", (request, response) => this.#sessionDirectory(request, response, "new")],
      ["POST /v1/session-directory/unlink", (request, response) => this.#sessionDirectory(request, response, "unlink")],
      ["POST /v1/artifacts/read", this.#artifactRead.bind(this)],
      ["POST /v1/runs", this.#run.bind(this)],
      ["POST /v1/interaction/resolve", this.#interaction.bind(this)],
      ["POST /v1/cron-control", this.#cronControl.bind(this)],
      ["POST /v1/cron-deliveries/claim", this.#cronClaim.bind(this)],
      ["POST /v1/cron-deliveries/ack", this.#cronAck.bind(this)],
    ]);
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      await this.#dispatch(request, response);
    } catch (error) {
      if (error instanceof HttpInputError) return writeInvalid(response, error);
      if (error instanceof LarkError) {
        const status = error.code === "SESSION_NOT_AVAILABLE" ? 404
          : error.code === "SESSION_CLAIM_INVALID" ? 400 : 500;
        response.setHeader("cache-control", "no-store");
        return writeJson(response, status, toWire(error));
      }
      throw error;
    }
  }

  async #dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const method = request.method ?? "GET";
    if (method === "GET" && url.pathname === "/healthz") {
      return writeJson(response, 200, { ok: true, queueDepth: this.options.queueDepth() });
    }
    if (!checkAuth(this.options.token, request, response)) return;
    const cancelMatch = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
    if (method === "POST" && cancelMatch) return this.#cancel(response, parseRouteRunId(cancelMatch[1]!));
    const handler = this.#routes.get(`${method} ${url.pathname}`);
    if (!handler) return writeNotFound(response);
    await handler(request, response);
  }

  async #sessionOverview(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const input = parseSessionOverviewBody(await readBody(request));
    const overview = await this.options.sessionOverview(input);
    response.setHeader("cache-control", "no-store");
    writeJson(response, 200, overview);
  }

  async #sessionDirectory(
    request: IncomingMessage,
    response: ServerResponse,
    action: SessionDirectoryAction,
  ): Promise<void> {
    const body = await readBody(request);
    const service = this.options.sessionDirectory;
    let result: unknown;
    if (action === "claim") result = await service.claim(parseSessionClaimBody(body));
    else if (action === "use") result = await service.use(parseSessionUseBody(body));
    else {
      const input = parseSessionDirectoryBody(body);
      if (action === "current") result = await service.current(input);
      else if (action === "list") result = await service.list(input);
      else if (action === "new") result = await service.newSession(input);
      else result = await service.unlink(input);
    }
    response.setHeader("cache-control", "no-store");
    writeJson(response, 200, result);
  }

  async #artifactRead(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const input = parseArtifactReadBody(await readBody(request));
    const artifact = await this.options.readArtifact(input);
    if (!artifact || artifact.bytes.byteLength !== input.bytes || !isImageArtifactMimeType(artifact.mimeType)) {
      return writeNotFound(response);
    }
    response.writeHead(200, {
      "content-type": artifact.mimeType,
      "content-length": String(artifact.bytes.byteLength),
      "cache-control": "no-store",
    });
    response.end(artifact.bytes);
  }

  async #run(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsed = parseRunRequest(await readBody(request));
    if (!parsed.ok) throw new HttpInputError(400, parsed.error.message);
    response.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
    });
    const channel = createRunChannel(response, this.options.heartbeatIntervalMs);
    try {
      await this.options.enqueue(parsed.value, channel.signal, channel.writer);
    } catch (error) {
      writeRunFailure(channel.writer, parsed.value, error);
    } finally {
      channel.close();
    }
  }

  #cancel(response: ServerResponse, runId: RunId): void {
    const found = this.options.cancel(runId);
    writeJson(response, found ? 200 : 404, { ok: found });
  }

  async #interaction(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const input = parseInteractionBody(await readBody(request));
    const delivered = this.options.resolveInteraction(input.scope, input.interactionId, input.answer);
    writeJson(response, delivered ? 200 : 404, { ok: delivered });
  }

  async #cronControl(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.options.cron) return writeNotFound(response);
    const command = parseCronControlBody(await readBody(request));
    try {
      writeJson(response, 200, await this.options.cron.control(command));
    } catch (error) {
      throw new HttpInputError(400, toWire(error).message);
    }
  }

  async #cronClaim(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.options.cron) return writeNotFound(response);
    const input = parseCronClaimBody(await readBody(request));
    const deliveries = await this.options.cron.claimDeliveries(input);
    writeJson(response, 200, { deliveries });
  }

  async #cronAck(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.options.cron) return writeNotFound(response);
    const input = parseCronAckBody(await readBody(request));
    const ok = await this.options.cron.ackDelivery(input);
    writeJson(response, ok ? 200 : 404, { ok });
  }
}
