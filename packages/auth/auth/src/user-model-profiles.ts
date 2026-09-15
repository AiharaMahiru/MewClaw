import { randomUUID } from "node:crypto";

import type {
  AuthStore,
  AuthUserModelProfilePublic,
  AuthUserModelProfileRecord,
  RequestMetadata,
  UserModelProfileDraft,
  UserModelProfilePatch,
  UserModelProfileUpdateResult,
  UserModelRuntimeRoute,
  UserModelRuntimeRouteRef,
} from "./types.js";
import type { UserModelCrypto } from "./user-model-crypto.js";
import { nowIso } from "./service-helpers.js";

export type AuditFn = (action: string, userId: string | null, metadata: RequestMetadata, details?: Record<string, string>) => Promise<void>;

export interface UserModelProfilesDeps {
  store: AuthStore;
  crypto: UserModelCrypto | undefined;
  now: () => number;
  audit: AuditFn;
}

/**
 * 用户私有模型档案域：CRUD、默认档案、以及面向 Worker 的路由解析。
 * API Key 只在此域内经 AEAD 解密，公开投影永不含密钥。
 */
export class UserModelProfiles {
  constructor(private readonly deps: UserModelProfilesDeps) {}

  /** 仅返回脱敏投影；用户密钥从不离开 Auth Service。 */
  async list(userId: string): Promise<AuthUserModelProfilePublic[]> {
    return (await this.deps.store.listUserModelProfiles(userId)).map(publicUserModelProfile);
  }

  /** 仅返回当前用户默认 Profile 的不透明 ID；不存在时为 undefined。 */
  async defaultId(userId: string): Promise<string | undefined> {
    return this.deps.store.getUserModelDefault(userId);
  }

  async create(userId: string, input: UserModelProfileDraft, metadata: RequestMetadata): Promise<AuthUserModelProfilePublic> {
    const draft = normalizeUserModelDraft(input);
    const now = nowIso(this.deps.now());
    const id = randomUUID();
    const revision = 1;
    const secret = this.crypto().encrypt(draft.apiKey, { userId, profileId: id, revision });
    const profile = await this.deps.store.createUserModelProfile({
      id,
      userId,
      displayName: draft.displayName,
      baseUrl: draft.baseUrl,
      modelIds: draft.modelIds,
      defaultModel: draft.defaultModel,
      ...secret,
      revision,
      createdAt: now,
      updatedAt: now,
    });
    // 第一个档案自动成为账户默认值；后续创建由显式“设为默认”控制。
    if (!await this.deps.store.getUserModelDefault(userId)) {
      await this.deps.store.setUserModelDefault(userId, profile.id, now);
    }
    await this.deps.audit("user-model-profile-created", userId, metadata, { profileId: profile.id });
    return publicUserModelProfile(profile);
  }

  async update(userId: string, profileId: string, patch: UserModelProfilePatch, metadata: RequestMetadata): Promise<UserModelProfileUpdateResult> {
    const current = await this.deps.store.findUserModelProfile(userId, profileId);
    if (!current) return { status: "not-found" };
    if (!Number.isSafeInteger(patch.expectedRevision) || patch.expectedRevision < 1) {
      throw new Error("INVALID_USER_MODEL_PROFILE_REVISION");
    }
    if (patch.expectedRevision !== current.revision) return { status: "conflict" };
    const next = normalizeUserModelPatch(current, patch);
    const revision = current.revision + 1;
    // 即使本次未替换 Key，也会以新的 revision 重封装，使 AEAD 绑定保持精确。
    const apiKey = next.apiKey ?? this.crypto().decrypt(current, {
      userId,
      profileId: current.id,
      revision: current.revision,
    });
    const secret = this.crypto().encrypt(apiKey, { userId, profileId: current.id, revision });
    const updated = await this.deps.store.updateUserModelProfile({
      ...current,
      displayName: next.displayName,
      baseUrl: next.baseUrl,
      modelIds: next.modelIds,
      defaultModel: next.defaultModel,
      ...secret,
      revision,
      updatedAt: nowIso(this.deps.now()),
      expectedRevision: patch.expectedRevision,
    });
    if (!updated) return { status: "conflict" };
    await this.deps.audit("user-model-profile-updated", userId, metadata, { profileId: updated.id });
    return { status: "updated", profile: publicUserModelProfile(updated) };
  }

  async delete(userId: string, profileId: string, expectedRevision: number, metadata: RequestMetadata): Promise<"deleted" | "not-found" | "conflict"> {
    const current = await this.deps.store.findUserModelProfile(userId, profileId);
    if (!current) return "not-found";
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("INVALID_USER_MODEL_PROFILE_REVISION");
    if (current.revision !== expectedRevision) return "conflict";
    if (!await this.deps.store.deleteUserModelProfile(userId, profileId, expectedRevision)) return "conflict";
    await this.deps.audit("user-model-profile-deleted", userId, metadata, { profileId });
    return "deleted";
  }

  async setDefault(userId: string, profileId: string, metadata: RequestMetadata): Promise<boolean> {
    const set = await this.deps.store.setUserModelDefault(userId, profileId, nowIso(this.deps.now()));
    if (set) await this.deps.audit("user-model-profile-defaulted", userId, metadata, { profileId });
    return set;
  }

  /** 仅供 Auth Edge 组装可信 Worker scope，严禁透过浏览器响应调用。 */
  async resolveDefaultRoute(userId: string): Promise<UserModelRuntimeRoute | undefined> {
    const profileId = await this.deps.store.getUserModelDefault(userId);
    if (!profileId) return undefined;
    const profile = await this.deps.store.findUserModelProfile(userId, profileId);
    if (!profile) return undefined;
    return this.resolveRecord(profile, userId, profile.id, profile.revision, profile.defaultModel);
  }

  /** 供 Auth Edge 填充 scope：只读 Profile 元数据，绝不解密 API Key。 */
  async resolveDefaultRouteRef(userId: string): Promise<UserModelRuntimeRouteRef | undefined> {
    const profileId = await this.deps.store.getUserModelDefault(userId);
    if (!profileId) return undefined;
    const profile = await this.deps.store.findUserModelProfile(userId, profileId);
    return profile ? { profileId: profile.id, revision: profile.revision, model: profile.defaultModel } : undefined;
  }

  /**
   * 供 Auth Edge 桌面推理：按当前版本解析本人 profile 内任意已声明模型；
   * `model` 缺省取 `defaultModel`。与 resolveRoute 不同，不校验版本钉扎——
   * 桌面请求是实时调用，不存在先取 scope 后排队执行的重定向风险。
   */
  async resolveProfileModelRoute(
    userId: string,
    profileId: string,
    model?: string,
  ): Promise<UserModelRuntimeRoute | undefined> {
    const profile = await this.deps.store.findUserModelProfile(userId, profileId);
    if (!profile) return undefined;
    const target = model ?? profile.defaultModel;
    if (!profile.modelIds.includes(target)) return undefined;
    return this.resolveRecord(profile, userId, profile.id, profile.revision, target);
  }

  /**
   * 仅供 Worker loopback 回调。版本和模型必须与此前的 scope 引用相同，避免
   * 排队 prompt 被后来的账户设置重定向到别的端点或密钥。
   */
  async resolveRoute(
    userId: string,
    profileId: string,
    revision: number,
    model: string,
  ): Promise<UserModelRuntimeRoute | undefined> {
    if (!Number.isSafeInteger(revision) || revision < 1 || !model) return undefined;
    const profile = await this.deps.store.findUserModelProfile(userId, profileId);
    if (!profile || profile.revision !== revision || profile.defaultModel !== model) return undefined;
    return this.resolveRecord(profile, userId, profileId, revision, model);
  }

  private resolveRecord(
    profile: AuthUserModelProfileRecord,
    userId: string,
    profileId: string,
    revision: number,
    model: string,
  ): UserModelRuntimeRoute {
    return {
      profileId: profile.id,
      baseUrl: profile.baseUrl,
      model,
      apiKey: this.crypto().decrypt(profile, { userId, profileId, revision }),
      revision,
    };
  }

  private crypto(): UserModelCrypto {
    if (!this.deps.crypto) throw new Error("USER_MODEL_ENCRYPTION_NOT_CONFIGURED");
    return this.deps.crypto;
  }
}

function publicUserModelProfile(profile: AuthUserModelProfileRecord): AuthUserModelProfilePublic {
  return {
    id: profile.id,
    displayName: profile.displayName,
    baseUrl: profile.baseUrl,
    modelIds: [...profile.modelIds],
    defaultModel: profile.defaultModel,
    keyConfigured: true,
    revision: profile.revision,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function normalizeUserModelDraft(input: UserModelProfileDraft): Required<UserModelProfileDraft> {
  const modelIds = normalizeUserModelIds(input.modelIds);
  return {
    displayName: normalizeUserModelDisplayName(input.displayName),
    baseUrl: normalizeUserModelBaseUrl(input.baseUrl),
    modelIds,
    defaultModel: normalizeUserModelDefault(input.defaultModel, modelIds),
    apiKey: normalizeUserModelApiKey(input.apiKey),
  };
}

function normalizeUserModelPatch(current: AuthUserModelProfileRecord, input: UserModelProfilePatch): {
  displayName: string;
  baseUrl: string;
  modelIds: string[];
  defaultModel: string;
  apiKey?: string;
} {
  const modelIds = input.modelIds === undefined ? [...current.modelIds] : normalizeUserModelIds(input.modelIds);
  return {
    displayName: input.displayName === undefined ? current.displayName : normalizeUserModelDisplayName(input.displayName),
    baseUrl: input.baseUrl === undefined ? current.baseUrl : normalizeUserModelBaseUrl(input.baseUrl),
    modelIds,
    defaultModel: normalizeUserModelDefault(input.defaultModel ?? current.defaultModel, modelIds),
    ...(input.apiKey === undefined ? {} : { apiKey: normalizeUserModelApiKey(input.apiKey) }),
  };
}

function normalizeUserModelDisplayName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("INVALID_USER_MODEL_PROFILE_NAME");
  return name;
}

function normalizeUserModelBaseUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { throw new Error("INVALID_USER_MODEL_BASE_URL"); }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("INVALID_USER_MODEL_BASE_URL");
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizeUserModelIds(value: string[]): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new Error("INVALID_USER_MODEL_LIST");
  const seen = new Set<string>();
  return value.map((raw) => {
    if (typeof raw !== "string") throw new Error("INVALID_USER_MODEL_LIST");
    const model = raw.trim();
    if (!model || model.length > 256 || /[\u0000-\u001f\u007f]/.test(model) || seen.has(model)) throw new Error("INVALID_USER_MODEL_LIST");
    seen.add(model);
    return model;
  });
}

function normalizeUserModelDefault(value: string, modelIds: readonly string[]): string {
  if (typeof value !== "string") throw new Error("INVALID_USER_MODEL_DEFAULT");
  const model = value.trim();
  if (!modelIds.includes(model)) throw new Error("INVALID_USER_MODEL_DEFAULT");
  return model;
}

function normalizeUserModelApiKey(value: string): string {
  if (typeof value !== "string") throw new Error("INVALID_USER_MODEL_KEY");
  const key = value.trim();
  if (!key || key.length > 16_384 || /[\u0000-\u001f\u007f]/.test(key)) throw new Error("INVALID_USER_MODEL_KEY");
  return key;
}
