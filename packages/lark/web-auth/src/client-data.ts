import type {
  AccountAdminUser,
  AccountIdentity,
  AccountModelProfile,
  AccountModelProfileDraft,
  AccountModelProfiles,
  AccountModelProfileUpdate,
  AccountUsage,
  AccountUser,
  ReactApi,
  ResourceState,
} from "./client-contracts.js";

type JsonRecord = Record<string, unknown>;
type Decoder<T> = (value: unknown) => T;

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid response");
  }
  return value as JsonRecord;
}

function stringField(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid response");
  return value;
}

function numberField(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid response");
  return value;
}

function booleanField(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("invalid response");
  return value;
}

function decodeUser(value: unknown): AccountUser {
  const item = record(value);
  const role = stringField(item.role);
  const defaultMode = stringField(item.defaultMode);
  if (role !== "admin" && role !== "user") throw new Error("invalid response");
  if (defaultMode !== "full" && defaultMode !== "lightweight") throw new Error("invalid response");
  return {
    id: stringField(item.id),
    email: stringField(item.email),
    displayName: stringField(item.displayName),
    role,
    defaultMode,
  };
}

const decodeMe: Decoder<AccountUser> = (value) => decodeUser(record(value).user);

const decodeUsage: Decoder<AccountUsage> = (value) => {
  const item = record(value);
  const quota = record(item.quota);
  const totals = record(item.totals);
  if (!Array.isArray(item.models)) throw new Error("invalid response");
  return {
    periodStart: stringField(item.periodStart),
    quota: {
      periodStart: stringField(quota.periodStart),
      monthlyLimitUsd: numberField(quota.monthlyLimitUsd),
      usedUsd: numberField(quota.usedUsd),
      remainingUsd: numberField(quota.remainingUsd),
    },
    totals: {
      calls: numberField(totals.calls),
      inputTokens: numberField(totals.inputTokens),
      outputTokens: numberField(totals.outputTokens),
      cacheReadTokens: numberField(totals.cacheReadTokens),
      cacheWriteTokens: numberField(totals.cacheWriteTokens),
      reasoningTokens: numberField(totals.reasoningTokens),
      totalTokens: numberField(totals.totalTokens),
      totalUsd: numberField(totals.totalUsd),
    },
    models: item.models.map((model) => {
      const row = record(model);
      return {
        provider: stringField(row.provider), model: stringField(row.model),
        calls: numberField(row.calls), inputTokens: numberField(row.inputTokens),
        outputTokens: numberField(row.outputTokens), cacheReadTokens: numberField(row.cacheReadTokens),
        cacheWriteTokens: numberField(row.cacheWriteTokens), reasoningTokens: numberField(row.reasoningTokens),
        totalTokens: numberField(row.totalTokens), totalUsd: numberField(row.totalUsd),
      };
    }),
  };
};

const decodeAdminUsers: Decoder<AccountAdminUser[]> = (value) => {
  const users = record(value).users;
  if (!Array.isArray(users)) throw new Error("invalid response");
  return users.map((source) => {
    const item = record(source);
    const user = decodeUser(item);
    const status = stringField(item.status);
    if (status !== "pending" && status !== "active" && status !== "disabled") {
      throw new Error("invalid response");
    }
    return {
      ...user,
      status,
      sessionCount: numberField(item.sessionCount),
      workspaceCount: numberField(item.workspaceCount),
      identityCount: numberField(item.identityCount),
    };
  });
};

const decodeIdentities: Decoder<AccountIdentity[]> = (value) => {
  const identities = record(value).identities;
  if (!Array.isArray(identities)) throw new Error("invalid response");
  return identities.map((source) => {
    const item = record(source);
    if (item.provider !== "feishu") throw new Error("invalid response");
    return {
      provider: "feishu",
      subject: stringField(item.subject),
      unionId: item.unionId === null ? null : stringField(item.unionId),
      createdAt: stringField(item.createdAt),
      ...(item.user ? { user: decodeUser(item.user) } : {}),
    };
  });
};

function decodeAccountModelProfile(value: unknown): AccountModelProfile {
  const item = record(value);
  if (!Array.isArray(item.modelIds)) throw new Error("invalid response");
  return {
    id: stringField(item.id),
    displayName: stringField(item.displayName),
    baseUrl: stringField(item.baseUrl),
    modelIds: item.modelIds.map(stringField),
    defaultModel: stringField(item.defaultModel),
    keyConfigured: booleanField(item.keyConfigured),
    revision: numberField(item.revision),
    createdAt: stringField(item.createdAt),
    updatedAt: stringField(item.updatedAt),
  };
}

export const decodeAccountModelProfiles: Decoder<AccountModelProfiles> = (value) => {
  const item = record(value);
  if (!Array.isArray(item.profiles)) throw new Error("invalid response");
  const defaultProfileId = item.defaultProfileId;
  if (defaultProfileId !== undefined && defaultProfileId !== null && typeof defaultProfileId !== "string") {
    throw new Error("invalid response");
  }
  return {
    profiles: item.profiles.map(decodeAccountModelProfile),
    // 在 Auth 服务切换完成前兼容旧响应；新契约始终显式返回 null 或 id。
    defaultProfileId: defaultProfileId ?? null,
  };
};

function useJson<T>(options: {
  React: ReactApi;
  path: string;
  decode: Decoder<T>;
  revision?: number;
}): ResourceState<T> {
  const { React, path, decode, revision = 0 } = options;
  const [state, setState] = React.useState<ResourceState<T>>({ status: "loading" });
  React.useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    void fetch(path, { credentials: "same-origin" }).then(async (response) => {
      if (!response.ok) throw new Error("request failed");
      const data = decode(await response.json());
      if (active) setState({ status: "ready", data });
    }).catch(() => { if (active) setState({ status: "error" }); });
    return () => { active = false; };
  }, [path, revision]);
  return state;
}

export function useAccountUser(React: ReactApi): ResourceState<AccountUser> {
  return useJson({ React, path: "/auth/me", decode: decodeMe });
}

export function useAccountUsage(React: ReactApi): ResourceState<AccountUsage> {
  return useJson({ React, path: "/api/billing/usage", decode: decodeUsage });
}

export function useAdminUsers(React: ReactApi): ResourceState<AccountAdminUser[]> {
  return useJson({ React, path: "/api/admin/users", decode: decodeAdminUsers });
}

export function useIdentities(React: ReactApi, revision: number): ResourceState<AccountIdentity[]> {
  return useJson({ React, path: "/auth/identities", decode: decodeIdentities, revision });
}

export function useAccountModelProfiles(React: ReactApi, revision: number): ResourceState<AccountModelProfiles> {
  return useJson({ React, path: "/auth/models", decode: decodeAccountModelProfiles, revision });
}

export async function signOut(): Promise<void> {
  const response = await fetch("/auth/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: { "x-csrf-token": readCsrfToken() },
  });
  if (!response.ok) throw new Error("logout failed");
}

export async function unlinkIdentity(identity: AccountIdentity): Promise<void> {
  const response = await fetch("/auth/identities", {
    method: "DELETE",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-csrf-token": readCsrfToken() },
    body: JSON.stringify({ provider: identity.provider, subject: identity.subject }),
  });
  if (response.ok) return;
  const body = await response.json().catch(() => ({})) as { error?: string };
  throw new Error(body.error || "IDENTITY_UNLINK_FAILED");
}

export async function createAccountModelProfile(input: AccountModelProfileDraft): Promise<void> {
  await mutateAccountModels("/auth/models", "POST", {
    displayName: input.displayName,
    baseUrl: input.baseUrl,
    modelIds: input.modelIds,
    defaultModel: input.defaultModel,
    apiKey: input.apiKey,
  });
}

export async function updateAccountModelProfile(profileId: string, input: AccountModelProfileUpdate): Promise<void> {
  const apiKey = input.apiKey?.trim();
  await mutateAccountModels(`/auth/models/${encodeURIComponent(profileId)}`, "PATCH", {
    expectedRevision: input.expectedRevision,
    displayName: input.displayName,
    baseUrl: input.baseUrl,
    modelIds: input.modelIds,
    defaultModel: input.defaultModel,
    ...(apiKey ? { apiKey } : {}),
  });
}

export async function deleteAccountModelProfile(profileId: string, expectedRevision: number): Promise<void> {
  await mutateAccountModels(`/auth/models/${encodeURIComponent(profileId)}`, "DELETE", { expectedRevision });
}

export async function setAccountModelDefault(profileId: string): Promise<void> {
  await mutateAccountModels(`/auth/models/${encodeURIComponent(profileId)}/default`, "POST", {});
}

async function mutateAccountModels(path: string, method: "POST" | "PATCH" | "DELETE", body: object): Promise<void> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-csrf-token": readCsrfToken() },
    body: JSON.stringify(body),
  });
  if (response.ok) return;
  const result = await response.json().catch(() => ({})) as { error?: string };
  throw new Error(result.error || "MODEL_PROFILE_REQUEST_FAILED");
}

export function readCsrfToken(): string {
  return decodeURIComponent((document.cookie.match(/(?:^|; )dsh_csrf=([^;]+)/) || [])[1] || "");
}
