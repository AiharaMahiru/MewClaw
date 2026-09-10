import type { Server } from "node:http";

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
} from "dsh-lark-contracts";
import type { LarkSessionDirectory } from "dsh-lark-session-directory";

export interface NdjsonWriter {
  write(item: RunStreamItem | RunStreamDone): void;
  end(): void;
  readonly closed: boolean;
}

export interface CronHttpService {
  control(command: CronControlCommand): Promise<unknown>;
  claimDeliveries(input: CronDeliveryClaimRequest): Promise<CronDelivery[]>;
  ackDelivery(input: CronDeliveryAckRequest): Promise<boolean>;
}

export interface RunServerOptions {
  host: string;
  port: number;
  token?: string;
  enqueue: (request: RunRequest, signal: AbortSignal, writer: NdjsonWriter) => Promise<void>;
  cancel: (runId: RunId) => boolean;
  resolveInteraction: (
    scope: Scope,
    interactionId: InteractionId,
    answer: { selected: string[]; custom?: string },
  ) => boolean;
  sessionOverview: (input: SessionOverviewRequest) => Promise<SessionOverview>;
  sessionDirectory: Pick<
    LarkSessionDirectory,
    "current" | "list" | "claim" | "use" | "newSession" | "unlink"
  >;
  /** 仅 Worker 内部读取并重验的图片 artifact。 */
  readArtifact: (input: ArtifactReadRequest) => Promise<ArtifactImage | undefined>;
  queueDepth: () => number;
  heartbeatIntervalMs: number;
  cron?: CronHttpService;
}

export interface RunServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}
