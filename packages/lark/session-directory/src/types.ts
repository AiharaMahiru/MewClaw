import type { EpochHeader, SessionId } from "@deepseek-ai/dsh-session";
import type {
  SessionClaimRequest,
  SessionDirectoryCurrent,
  SessionDirectoryList,
  SessionDirectoryRequest,
  SessionUseRequest,
} from "dsh-lark-contracts";

export interface SessionClaim {
  code: string;
  expiresAt: string;
}

export type SessionModelSelection = Pick<
  EpochHeader["config"],
  "provider" | "model" | "reasoningEffort"
>;

export type SessionResolution = { mode: "deterministic" } | {
  mode: "shared";
  sessionId: SessionId;
  cwd: string;
  selection?: SessionModelSelection;
};

export interface LarkSessionDirectory {
  issueClaim(sessionId: SessionId): Promise<SessionClaim>;
  current(input: SessionDirectoryRequest): Promise<SessionDirectoryCurrent>;
  list(input: SessionDirectoryRequest): Promise<SessionDirectoryList>;
  claim(input: SessionClaimRequest): Promise<SessionDirectoryCurrent>;
  use(input: SessionUseRequest): Promise<SessionDirectoryCurrent>;
  newSession(input: SessionDirectoryRequest): Promise<SessionDirectoryCurrent>;
  unlink(input: SessionDirectoryRequest): Promise<SessionDirectoryCurrent>;
  resolve(input: SessionDirectoryRequest): Promise<SessionResolution>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    larkSessionDirectory: LarkSessionDirectory;
  }
}
