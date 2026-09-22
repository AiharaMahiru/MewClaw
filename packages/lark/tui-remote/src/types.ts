/** dsh Web ↔ dsh-TUI 远程适配层的稳定公共类型。 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface RemoteUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: 'admin' | 'user';
  readonly defaultMode: 'full' | 'lightweight';
}

export interface ModelProfile {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly modelIds: readonly string[];
  readonly defaultModel: string;
  readonly keyConfigured: boolean;
  readonly revision: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly [key: string]: unknown;
}

export interface ModelCatalog {
  readonly profiles: readonly ModelProfile[];
  readonly sharedModels: readonly Record<string, unknown>[];
  readonly defaultProfileId?: string;
  readonly raw: unknown;
}

export interface QuotaSnapshot {
  /** 原始 `/api/billing/usage` 响应；其中不包含 API Key。 */
  readonly raw: unknown;
  readonly available?: boolean;
  readonly monthlyLimitUsd?: number;
  readonly monthlyUsedUsd?: number;
  readonly remainingUsd?: number;
  readonly currency?: string;
}

export interface RemoteCapabilities {
  readonly protocol: 'dsh-tui-remote/1';
  readonly location: 'remote';
  readonly features: readonly [
    'auth',
    'quota',
    'models',
    'sessions',
    'workspaces',
    'workspace-localization',
    ...string[],
  ];
  readonly user: RemoteUser;
  readonly quota: QuotaSnapshot;
  readonly models: ModelCatalog;
}

export interface SessionSummary {
  readonly id: string;
  readonly title?: string;
  readonly cwd?: string;
  readonly createdAt?: string | number;
  readonly updatedAt?: string | number;
  readonly model?: string;
  readonly workspaceId?: string;
  readonly kind?: string;
  readonly raw: Record<string, unknown>;
}

export interface SessionListOptions {
  readonly cursor?: string;
  readonly limit?: number;
  readonly query?: string;
  readonly workspaceId?: string;
}

/** 官方 `agentPresets/list` 返回的无路径预设行。 */
export interface AgentPresetEntry {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly trust?: string;
  readonly isDefault?: boolean;
  readonly broken?: string;
  readonly raw: Record<string, unknown>;
}

export interface AgentPresetCatalog {
  readonly presets: readonly AgentPresetEntry[];
  readonly authorable?: boolean;
  readonly modeSelectionEnabled?: boolean;
  readonly raw: unknown;
}

/** 官方 `permissionPresets/catalog` 的完整进程级目录。 */
export interface PermissionPresetEntry {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
  readonly raw: Record<string, unknown>;
}

export interface PermissionPresetCatalog {
  readonly options: readonly PermissionPresetEntry[];
  readonly raw: unknown;
}

export interface CommandEntry {
  readonly name: string;
  readonly description: string;
  readonly input?: Record<string, unknown>;
  readonly raw: Record<string, unknown>;
}

export interface SessionModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

/** TUI 可安全映射到官方 Remote 的模式动作。 */
export type RemoteModeSelection =
  | { readonly kind: 'agent-preset'; readonly value: string }
  | { readonly kind: 'permission-preset'; readonly value: string }
  | { readonly kind: 'plan'; readonly active: boolean };

export interface SessionCreateRequest {
  readonly sessionId?: string;
  readonly workspaceId?: string;
  readonly cwd?: string;
  readonly agentPreset?: string;
  readonly [key: string]: unknown;
}

export interface SessionCreateOptions {
  readonly request: SessionCreateRequest;
  /** 提供时在发送前做本地路径边界校验。 */
  readonly workspaceRoot?: string;
}

export interface WorkspaceEntry {
  readonly workspaceId: string;
  readonly path?: string;
  readonly title?: string;
  readonly sessionIds?: readonly string[];
  readonly raw: Record<string, unknown>;
}

export interface WorkspaceCreateRequest {
  readonly path: string;
  readonly title?: string;
  readonly [key: string]: unknown;
}

export interface WorkspaceCreateOptions {
  readonly request: WorkspaceCreateRequest;
  readonly workspaceRoot?: string;
}

export interface WorkspaceStatus {
  readonly mode: 'cloud' | 'desktop';
  readonly connected: boolean;
  readonly revision: string;
  readonly accountId: string;
  readonly [key: string]: unknown;
}

export interface WorkspacePollResult {
  readonly request: { readonly id: string; readonly operation: unknown } | null;
  readonly activeRequestId: string | null;
}

export interface WorkspaceCommandResult {
  readonly ok?: boolean;
  readonly value?: unknown;
  readonly [key: string]: unknown;
}

export interface CredentialCookie {
  readonly name: string;
  readonly value: string;
  readonly path: string;
  readonly secure: boolean;
  readonly expiresAt?: number;
}

export interface StoredCredential {
  readonly endpoint: string;
  readonly cookies: readonly CredentialCookie[];
}

export interface CredentialStore {
  load(): Promise<StoredCredential | undefined>;
  save(value: StoredCredential): Promise<void>;
  clear(): Promise<void>;
}

export interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface WebSocketLike {
  readonly readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
  on?: (type: string, listener: (...args: unknown[]) => void) => void;
  off?: (type: string, listener: (...args: unknown[]) => void) => void;
  onopen?: ((event: unknown) => void) | null;
  onmessage?: ((event: unknown) => void) | null;
  onerror?: ((event: unknown) => void) | null;
  onclose?: ((event: unknown) => void) | null;
}

export interface WebSocketFactoryOptions {
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export type WebSocketFactory = (url: string, options: WebSocketFactoryOptions) => WebSocketLike | Promise<WebSocketLike>;

export interface RemoteClientOptions {
  /** dsh Web 的公开 origin，例如 `https://chat.example.com`。 */
  readonly endpoint: string;
  /** 默认仅允许 HTTPS；loopback HTTP 仅用于本地开发和测试。 */
  readonly allowInsecureHttp?: boolean;
  readonly fetch?: FetchLike;
  readonly credentialStore?: CredentialStore;
  readonly websocketFactory?: WebSocketFactory;
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** 测试或宿主可注入的安全日志；调用方不得记录参数中的 Cookie。 */
  readonly logger?: (event: string, details?: Readonly<Record<string, string | number | boolean>>) => void;
}

export interface StreamOptions {
  readonly signal?: AbortSignal;
  /** 断线后最多重开次数；默认 0，避免无 cursor 流重复业务项。 */
  readonly maxReconnects?: number;
  /** 重开时生成新的 payload（例如带 cursor），用于避免重复。 */
  readonly resumePayload?: (lastItem: unknown) => unknown;
}

export interface LocalWorkspaceServeOptions {
  readonly signal?: AbortSignal;
  readonly pollIntervalMs?: number;
  readonly maxBackoffMs?: number;
  readonly autoRebind?: boolean;
}

export type WorkspaceOperationExecutor = (operation: unknown, signal: AbortSignal) => Promise<unknown>;
