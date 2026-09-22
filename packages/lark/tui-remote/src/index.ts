export { DshTuiRemoteClient, createMemoryRemoteClient } from './client.js';
export { FileCredentialStore, MemoryCredentialStore, defaultCredentialPath } from './credential-store.js';
export { RemoteClientError, isRemoteClientError, normalizeErrorCode } from './errors.js';
export { RemoteWorkspaceBridge } from './local-workspace.js';
export type { WorkspaceCommandTransport } from './local-workspace.js';
export { assertRelativeWorkspacePath, assertWorkspacePath } from './path-boundary.js';
export { RemoteStreamTransport } from './remote-stream.js';
export { normalizeEndpoint, RemoteHttpTransport } from './transport.js';
export type {
  CredentialCookie,
  CredentialStore,
  AgentPresetCatalog,
  AgentPresetEntry,
  CommandEntry,
  FetchLike,
  JsonPrimitive,
  JsonValue,
  LocalWorkspaceServeOptions,
  ModelCatalog,
  ModelProfile,
  QuotaSnapshot,
  RemoteCapabilities,
  RemoteClientOptions,
  RemoteUser,
  SessionCreateOptions,
  SessionCreateRequest,
  SessionListOptions,
  SessionModelSelection,
  SessionSummary,
  PermissionPresetCatalog,
  PermissionPresetEntry,
  RemoteModeSelection,
  StoredCredential,
  StreamOptions,
  WebSocketFactory,
  WebSocketFactoryOptions,
  WebSocketLike,
  WorkspaceCommandResult,
  WorkspaceCreateOptions,
  WorkspaceCreateRequest,
  WorkspaceEntry,
  WorkspaceOperationExecutor,
  WorkspacePollResult,
  WorkspaceStatus,
} from './types.js';
