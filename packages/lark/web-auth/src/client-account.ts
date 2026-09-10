import type {
  AccountModelProfile,
  AccountUser,
  ReactApi,
  ResourceState,
} from "./client-contracts.js";
import {
  createAccountModelProfile,
  deleteAccountModelProfile,
  readCsrfToken,
  setAccountModelDefault,
  signOut,
  useAccountUsage,
  useAccountUser,
  useAdminUsers,
  useAccountModelProfiles,
  updateAccountModelProfile,
} from "./client-data.js";

export { maskIdentity } from "./client-feishu.js";

type AccountArea = "usage" | "models" | "security" | "admin";
const AREAS: ReadonlyArray<{ id: AccountArea; label: string }> = [
  { id: "usage", label: "用量与额度" },
  { id: "models", label: "我的模型" },
  { id: "security", label: "安全与登录" },
  { id: "admin", label: "用户与权限" },
];

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4,
  }).format(value);
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function loading(React: ReactApi, error = false): unknown {
  return React.createElement("p", {
    className: "mewclaw-account-message", "data-state": error ? "error" : undefined,
  }, error ? "数据暂时不可用。" : "正在读取数据…");
}

function AccountActions({ React }: { React: ReactApi }): unknown {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const leave = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError("");
    try { await signOut(); location.href = "/"; }
    catch { setError("退出失败，请稍后重试。"); setBusy(false); }
  };
  return React.createElement("div", { className: "mewclaw-account-session-buttons" },
    React.createElement("button", { type: "button", className: "mewclaw-account-button primary", disabled: busy, onClick: () => { void leave(); } }, "切换账号"),
    React.createElement("button", { type: "button", className: "mewclaw-account-button", disabled: busy, onClick: () => { void leave(); } }, "退出登录"),
    error ? React.createElement("p", { className: "mewclaw-account-message", "data-state": "error" }, error) : null);
}

function AccountOverview({ React, user }: { React: ReactApi; user: AccountUser }): unknown {
  const initial = Array.from(user.displayName.trim())[0] || "M";
  const mode = user.defaultMode === "full" ? "通用工作" : "日常助手";
  return React.createElement("div", { className: "mewclaw-account-section" },
    React.createElement("div", { className: "mewclaw-account-profile" },
      React.createElement("span", { className: "mewclaw-account-avatar mewclaw-account-avatar-large", "aria-hidden": "true" }, initial),
      React.createElement("div", { className: "mewclaw-account-profile-copy" },
        React.createElement("strong", null, user.displayName),
        React.createElement("span", { className: "mewclaw-account-muted" }, user.email)),
      React.createElement(AccountActions, { React })),
    React.createElement("dl", { className: "mewclaw-account-facts" },
      fact(React, "角色", user.role === "admin" ? "管理员" : "成员"),
      fact(React, "默认模式", mode),
      fact(React, "账户状态", "已验证")));
}

function fact(React: ReactApi, label: string, value: string): unknown {
  return React.createElement("div", null,
    React.createElement("dt", null, label), React.createElement("dd", null, value));
}

function PasswordSection({ React }: { React: ReactApi }): unknown {
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<{ text: string; state?: string }>({ text: "" });
  const submit = async (event: { preventDefault(): void; currentTarget: HTMLFormElement }): Promise<void> => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const newPassword = String(values.get("newPassword") || "");
    if (newPassword !== String(values.get("confirmPassword") || "")) {
      setMessage({ text: "两次新密码不一致。", state: "error" }); return;
    }
    setBusy(true); setMessage({ text: "" });
    try {
      const response = await fetch("/auth/password/change", {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": readCsrfToken() },
        body: JSON.stringify({ oldPassword: values.get("oldPassword"), newPassword }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || "PASSWORD_CHANGE_FAILED");
      setMessage({ text: "密码已更新，请重新登录。", state: "success" });
      setTimeout(() => { location.href = "/"; }, 700);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "PASSWORD_CHANGE_FAILED";
      setMessage({ text: code === "PASSWORD_INVALID" ? "当前密码不正确。" : "更新失败，请检查密码后重试。", state: "error" });
      setBusy(false);
    }
  };
  return React.createElement("form", { className: "mewclaw-account-form", onSubmit: (event: { preventDefault(): void; currentTarget: HTMLFormElement }) => { void submit(event); } },
    passwordField(React, "当前密码", "oldPassword", "current-password"),
    passwordField(React, "新密码", "newPassword", "new-password"),
    passwordField(React, "确认新密码", "confirmPassword", "new-password"),
    React.createElement("div", { className: "mewclaw-account-form-actions" },
      React.createElement("button", { type: "submit", className: "mewclaw-account-button primary", disabled: busy }, busy ? "更新中" : "更新密码"),
      React.createElement("p", { className: "mewclaw-account-message", role: "status", "aria-live": "polite", "data-state": message.state }, message.text)));
}

function passwordField(React: ReactApi, label: string, name: string, autoComplete: string): unknown {
  return React.createElement("label", null, label,
    React.createElement("input", { name, type: "password", autoComplete, minLength: 12, maxLength: 256, required: true }));
}

type ModelProfileFormProps = {
  React: ReactApi;
  profile: AccountModelProfile | null;
  onSaved(): void;
  onCancel(): void;
};

export function parseModelIds(value: string): string[] {
  const modelIds: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value.split(/[\n,]/u)) {
    const modelId = candidate.trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    modelIds.push(modelId);
  }
  return modelIds;
}

export function isDefaultModelInList(modelIds: readonly string[], defaultModel: string): boolean {
  return Boolean(defaultModel.trim()) && modelIds.includes(defaultModel.trim());
}

function modelFormValue(values: FormData, name: string): string {
  const value = values.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function modelErrorMessage(cause: unknown, fallback: string): string {
  const code = cause instanceof Error ? cause.message : "";
  if (code === "MODEL_PROFILE_CONFLICT" || code === "MODEL_PROFILE_REVISION_CONFLICT") return "配置已被其他操作更新，请刷新后重试。";
  if (code === "MODEL_PROFILE_NOT_FOUND") return "该模型配置已不存在，请刷新列表。";
  return fallback;
}

function ModelProfileForm({ React, profile, onSaved, onCancel }: ModelProfileFormProps): unknown {
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<{ text: string; state?: string }>({ text: "" });
  const isEditing = profile !== null;
  const submit = async (event: { preventDefault(): void; currentTarget: HTMLFormElement }): Promise<void> => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const displayName = modelFormValue(values, "displayName");
    const baseUrl = modelFormValue(values, "baseUrl");
    const modelIds = parseModelIds(modelFormValue(values, "modelIds"));
    const defaultModel = modelFormValue(values, "defaultModel");
    const apiKey = modelFormValue(values, "apiKey");
    if (!displayName || !baseUrl || !modelIds.length || !defaultModel) {
      setMessage({ text: "请完整填写名称、地址、模型列表和默认模型。", state: "error" });
      return;
    }
    if (!isDefaultModelInList(modelIds, defaultModel)) {
      setMessage({ text: "默认模型必须包含在模型列表中。", state: "error" });
      return;
    }
    if (!isEditing && !apiKey) {
      setMessage({ text: "新增模型配置时必须填写 API Key。", state: "error" });
      return;
    }
    setBusy(true);
    setMessage({ text: "" });
    try {
      if (profile) {
        await updateAccountModelProfile(profile.id, {
          expectedRevision: profile.revision,
          displayName,
          baseUrl,
          modelIds,
          defaultModel,
          ...(apiKey ? { apiKey } : {}),
        });
      } else {
        await createAccountModelProfile({ displayName, baseUrl, modelIds, defaultModel, apiKey });
      }
      onSaved();
    } catch (cause) {
      setMessage({ text: modelErrorMessage(cause, isEditing ? "更新失败，请稍后重试。" : "新增失败，请稍后重试。"), state: "error" });
      setBusy(false);
    }
  };
  return React.createElement("form", {
    className: "mewclaw-account-form mewclaw-account-model-form",
    // 使用下方的中文校验提示，避免浏览器原生气泡遮挡相邻输入框。
    noValidate: true,
    onSubmit: (event: { preventDefault(): void; currentTarget: HTMLFormElement }) => { void submit(event); },
  },
  React.createElement("label", null, "配置名称",
    React.createElement("input", { name: "displayName", type: "text", defaultValue: profile?.displayName || "", maxLength: 80, required: true, autoComplete: "off" })),
  React.createElement("label", null, "Base URL",
    React.createElement("input", { name: "baseUrl", type: "url", defaultValue: profile?.baseUrl || "", maxLength: 2048, required: true, autoComplete: "off", spellCheck: false })),
  React.createElement("label", { className: "mewclaw-account-field-wide" }, "模型列表（每行一个，或用逗号分隔）",
    React.createElement("textarea", { name: "modelIds", defaultValue: profile?.modelIds.join("\n") || "", rows: 4, required: true, spellCheck: false })),
  React.createElement("label", null, "默认模型",
    React.createElement("input", { name: "defaultModel", type: "text", defaultValue: profile?.defaultModel || "", maxLength: 256, required: true, autoComplete: "off", spellCheck: false })),
  React.createElement("label", null, isEditing ? "更换 API Key（留空则保留原密钥）" : "API Key",
    React.createElement("input", { name: "apiKey", type: "password", required: !isEditing, autoComplete: "off", spellCheck: false })),
  React.createElement("div", { className: "mewclaw-account-form-actions" },
    React.createElement("button", { type: "submit", className: "mewclaw-account-button primary", disabled: busy }, busy ? "保存中" : isEditing ? "保存修改" : "新增模型"),
    React.createElement("button", { type: "button", className: "mewclaw-account-button", disabled: busy, onClick: onCancel }, "取消"),
    React.createElement("p", { className: "mewclaw-account-message", role: "status", "aria-live": "polite", "data-state": message.state }, message.text)));
}

function ModelProfilesSection({ React }: { React: ReactApi }): unknown {
  const [revision, setRevision] = React.useState(0);
  const [editing, setEditing] = React.useState<AccountModelProfile | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [pendingId, setPendingId] = React.useState("");
  const [message, setMessage] = React.useState<{ text: string; state?: string }>({ text: "" });
  const state = useAccountModelProfiles(React, revision);
  const refresh = (text: string): void => {
    setEditing(null);
    setCreating(false);
    setMessage({ text, state: "success" });
    setRevision(revision + 1);
  };
  const setDefault = async (profile: AccountModelProfile): Promise<void> => {
    if (pendingId) return;
    setPendingId(profile.id);
    setMessage({ text: "" });
    try {
      await setAccountModelDefault(profile.id);
      refresh("默认模型配置已更新。");
    } catch (cause) {
      setMessage({ text: modelErrorMessage(cause, "设置默认配置失败，请稍后重试。"), state: "error" });
    } finally { setPendingId(""); }
  };
  const remove = async (profile: AccountModelProfile): Promise<void> => {
    if (pendingId || !window.confirm(`确定删除“${profile.displayName}”吗？`)) return;
    setPendingId(profile.id);
    setMessage({ text: "" });
    try {
      await deleteAccountModelProfile(profile.id, profile.revision);
      refresh("模型配置已删除。");
    } catch (cause) {
      setMessage({ text: modelErrorMessage(cause, "删除失败，请稍后重试。"), state: "error" });
    } finally { setPendingId(""); }
  };
  if (state.status !== "ready") return loading(React, state.status === "error");
  const { profiles, defaultProfileId } = state.data;
  const isEditing = creating || editing !== null;
  return React.createElement("div", { className: "mewclaw-account-section" },
    React.createElement("div", { className: "mewclaw-account-model-profile-toolbar" },
      React.createElement("p", { className: "mewclaw-account-message" }, "仅支持 OpenAI 兼容的 Chat Completions 接口。"),
      !isEditing ? React.createElement("button", { type: "button", className: "mewclaw-account-button primary", onClick: () => { setCreating(true); setMessage({ text: "" }); } }, "新增模型") : null),
    isEditing ? React.createElement(ModelProfileForm, {
      key: editing?.id || "new",
      React,
      profile: editing,
      onSaved: () => { refresh(editing ? "模型配置已更新。" : "模型配置已新增。"); },
      onCancel: () => { setEditing(null); setCreating(false); },
    }) : null,
    message.text ? React.createElement("p", { className: "mewclaw-account-message", role: "status", "aria-live": "polite", "data-state": message.state }, message.text) : null,
    profiles.length ? React.createElement("ul", { className: "mewclaw-account-model-profile-list" }, profiles.map((profile) => {
      const isDefault = profile.id === defaultProfileId;
      const isPending = pendingId === profile.id;
      return React.createElement("li", { className: "mewclaw-account-model-profile-row", key: profile.id },
        React.createElement("div", { className: "mewclaw-account-row-copy" },
          React.createElement("strong", null, profile.displayName),
          React.createElement("span", null, profile.baseUrl),
          React.createElement("span", null, `默认模型：${profile.defaultModel} · 可用模型：${profile.modelIds.join("、")}`)),
        React.createElement("div", { className: "mewclaw-account-model-profile-badges" },
          isDefault ? React.createElement("span", { className: "mewclaw-account-model-profile-badge primary" }, "当前默认") : null,
          React.createElement("span", { className: "mewclaw-account-model-profile-badge" }, profile.keyConfigured ? "密钥已配置" : "未配置密钥")),
        React.createElement("div", { className: "mewclaw-account-model-profile-actions" },
          !isDefault ? React.createElement("button", { type: "button", className: "mewclaw-account-button", disabled: Boolean(pendingId), onClick: () => { void setDefault(profile); } }, isPending ? "设置中" : "设为默认") : null,
          React.createElement("button", { type: "button", className: "mewclaw-account-button", disabled: Boolean(pendingId), onClick: () => { setEditing(profile); setCreating(false); setMessage({ text: "" }); } }, "编辑"),
          React.createElement("button", { type: "button", className: "mewclaw-account-button danger", disabled: Boolean(pendingId), onClick: () => { void remove(profile); } }, isPending ? "删除中" : "删除")));
    })) : !isEditing ? emptyState(React, "尚未配置个人模型") : null);
}

function UsageSection({ React }: { React: ReactApi }): unknown {
  const state = useAccountUsage(React);
  if (state.status !== "ready") return loading(React, state.status === "error");
  const { quota, totals, models } = state.data;
  const percent = quota.monthlyLimitUsd > 0 ? Math.min(100, Math.max(0, quota.usedUsd / quota.monthlyLimitUsd * 100)) : 0;
  return React.createElement("div", { className: "mewclaw-account-section" },
    React.createElement("div", { className: "mewclaw-account-usage-grid" },
      usageStat(React, "已用额度", formatUsd(quota.usedUsd)), usageStat(React, "剩余额度", formatUsd(quota.remainingUsd)),
      usageStat(React, "模型调用", formatCount(totals.calls)), usageStat(React, "总 Token", formatCount(totals.totalTokens))),
    React.createElement("div", { className: "mewclaw-account-usage-progress" },
      React.createElement("div", { className: "mewclaw-account-usage-progress-head" }, React.createElement("span", null, state.data.periodStart), React.createElement("span", null, `${formatUsd(quota.usedUsd)} / ${formatUsd(quota.monthlyLimitUsd)}`)),
      React.createElement("div", { className: "mewclaw-account-usage-progress-track", role: "progressbar", "aria-label": "本月额度使用比例", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(percent) },
        React.createElement("div", { className: "mewclaw-account-usage-progress-fill", style: { width: `${percent}%` } }))),
    React.createElement("dl", { className: "mewclaw-account-token-grid" },
      fact(React, "输入 Token", formatCount(totals.inputTokens)), fact(React, "输出 Token", formatCount(totals.outputTokens)),
      fact(React, "缓存 Token", formatCount(totals.cacheReadTokens + totals.cacheWriteTokens)), fact(React, "推理 Token", formatCount(totals.reasoningTokens))),
    models.length ? React.createElement("details", { className: "mewclaw-account-model-detail" },
      React.createElement("summary", null, "按模型查看明细", React.createElement("span", null, `${models.length} 个模型`)),
      React.createElement("ul", { className: "mewclaw-account-models" }, models.map((model) =>
      React.createElement("li", { className: "mewclaw-account-model-row", key: `${model.provider}:${model.model}` },
        React.createElement("div", { className: "mewclaw-account-row-copy" }, React.createElement("strong", null, model.model), React.createElement("span", null, model.provider)),
        React.createElement("span", { className: "mewclaw-account-row-meta" }, `${formatCount(model.calls)} 次`),
        React.createElement("span", null, formatUsd(model.totalUsd)))))) : emptyState(React, "本周期暂无模型调用"));
}

function usageStat(React: ReactApi, label: string, value: string): unknown {
  return React.createElement("dl", { className: "mewclaw-account-usage-stat" },
    React.createElement("dt", null, label), React.createElement("dd", null, value));
}

function AdminSection({ React }: { React: ReactApi }): unknown {
  const state = useAdminUsers(React);
  if (state.status !== "ready") return loading(React, state.status === "error");
  return React.createElement("div", { className: "mewclaw-account-section" },
    state.data.length ? React.createElement("ul", { className: "mewclaw-account-admin-list" }, state.data.map((user) =>
      React.createElement("li", { className: "mewclaw-account-admin-row", key: user.id },
        React.createElement("div", { className: "mewclaw-account-row-copy" }, React.createElement("strong", null, user.displayName), React.createElement("span", null, user.email)),
        React.createElement("div", { className: "mewclaw-account-row-meta" }, React.createElement("span", null, user.role === "admin" ? "管理员" : "成员"), React.createElement("span", null, `${user.workspaceCount} 工作区`), React.createElement("span", null, `${user.sessionCount} 会话`), React.createElement("span", null, `${user.identityCount} 飞书绑定`))))) : emptyState(React, "暂无用户"),
    React.createElement("a", { className: "mewclaw-account-link", href: "/admin" }, "进入管理工作台 →"));
}

function emptyState(React: ReactApi, text: string): unknown {
  return React.createElement("div", { className: "mewclaw-account-empty" }, React.createElement("strong", null, text));
}

function areaContent(React: ReactApi, area: AccountArea): unknown {
  if (area === "usage") return React.createElement(UsageSection, { React });
  if (area === "models") return React.createElement(ModelProfilesSection, { React });
  if (area === "security") return React.createElement(PasswordSection, { React });
  return React.createElement(AdminSection, { React });
}

function areaMeta(area: AccountArea): string {
  if (area === "usage") return "本月";
  if (area === "models") return "个人配置";
  if (area === "security") return "密码";
  return "管理员";
}

function AccountFold(React: ReactApi, entry: { id: AccountArea; label: string }): unknown {
  return React.createElement("details", { key: entry.id, className: "mewclaw-account-fold", open: entry.id === "usage" },
    React.createElement("summary", null,
      React.createElement("span", { className: "mewclaw-account-fold-title" }, entry.label, React.createElement("span", { className: "mewclaw-account-fold-meta" }, areaMeta(entry.id)))),
    React.createElement("div", { className: "mewclaw-account-fold-content" }, areaContent(React, entry.id)));
}

function renderAccount(React: ReactApi, state: ResourceState<AccountUser>): unknown {
  if (state.status !== "ready") return loading(React, state.status === "error");
  const areas = AREAS.filter((entry) => entry.id !== "admin" || state.data.role === "admin");
  return React.createElement("div", { className: "mewclaw-account-center" },
    React.createElement("header", { className: "mewclaw-account-center-header" },
      React.createElement("h2", null, "账户中心"),
      React.createElement("p", { className: "mewclaw-account-message" }, "查看账户用量，管理个人模型与登录安全。")),
    React.createElement(AccountOverview, { React, user: state.data }),
    React.createElement("div", { className: "mewclaw-account-folds" }, areas.map((entry) => AccountFold(React, entry))));
}

export function AccountCenterSection(React: ReactApi): unknown {
  return renderAccount(React, useAccountUser(React));
}
