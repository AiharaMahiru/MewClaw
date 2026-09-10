export type AccountUser = {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "user";
  defaultMode: "full" | "lightweight";
};

export type AccountIdentity = {
  provider: "feishu";
  subject: string;
  unionId: string | null;
  createdAt: string;
  user?: AccountUser;
};

export type AccountUsage = {
  periodStart: string;
  quota: {
    periodStart: string;
    monthlyLimitUsd: number;
    usedUsd: number;
    remainingUsd: number;
  };
  totals: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    totalUsd: number;
  };
  models: Array<{
    provider: string;
    model: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    totalUsd: number;
  }>;
};

export type AccountAdminUser = AccountUser & {
  sessionCount: number;
  workspaceCount: number;
  identityCount: number;
  status: "pending" | "active" | "disabled";
};

/** 账户自行维护的 OpenAI 兼容模型配置；响应中绝不包含 API Key。 */
export type AccountModelProfile = {
  id: string;
  displayName: string;
  baseUrl: string;
  modelIds: string[];
  defaultModel: string;
  keyConfigured: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type AccountModelProfiles = {
  profiles: AccountModelProfile[];
  defaultProfileId: string | null;
};

export type AccountModelProfileDraft = {
  displayName: string;
  baseUrl: string;
  modelIds: string[];
  defaultModel: string;
  apiKey: string;
};

export type AccountModelProfileUpdate = {
  expectedRevision: number;
  displayName: string;
  baseUrl: string;
  modelIds: string[];
  defaultModel: string;
  /** 留空或省略时，服务端保留既有密钥。 */
  apiKey?: string;
};

export type ResourceState<T> =
  | { status: "loading"; data?: T }
  | { status: "ready"; data: T }
  | { status: "error"; data?: T };

export type ReactApi = {
  createElement(
    type: string | ((props: never) => unknown),
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown;
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]): void;
  useState<T>(initial: T): [T, (next: T) => void];
};

export type ClientContext = {
  get(name: "connection"): {
    isLoopback: boolean;
    /** Alpha 版连接包把 Host 描述放在 generation；旧版仍使用 hostDescription。 */
    generation?: {
      getSnapshot(): unknown | undefined;
      subscribe(listener: () => void): () => void;
    };
    /** Alpha 版连接包的连接状态源。 */
    state?: {
      getSnapshot(): unknown | undefined;
      subscribe(listener: () => void): () => void;
    };
    hostDescription?: {
      getSnapshot(): unknown | undefined;
      subscribe(listener: () => void): () => void;
    };
  };
  slots: {
    inject(name: "settings.trigger" | "settings.section", callback: () => () => void): () => void;
    register<T>(
      options: {
        name: string;
        id?: string;
        order?: number;
        priority?: number;
        label?: () => unknown;
        locale?: string;
      },
      component: (props: T) => unknown,
    ): () => void;
  };
  effect(effect: () => void | (() => void), label?: string): void;
};

export type ModuleLoader = {
  load(input: {
    id: string;
    factory: (require: (specifier: string) => unknown) => {
      apply: (ctx: ClientContext) => void;
      inject: string[];
    };
  }): void;
};
