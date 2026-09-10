"use strict";
(() => {
  // packages/lark/web-auth/src/client-data.ts
  function record(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("invalid response");
    }
    return value;
  }
  function stringField(value) {
    if (typeof value !== "string") throw new Error("invalid response");
    return value;
  }
  function numberField(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid response");
    return value;
  }
  function booleanField(value) {
    if (typeof value !== "boolean") throw new Error("invalid response");
    return value;
  }
  function decodeUser(value) {
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
      defaultMode
    };
  }
  var decodeMe = (value) => decodeUser(record(value).user);
  var decodeUsage = (value) => {
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
        remainingUsd: numberField(quota.remainingUsd)
      },
      totals: {
        calls: numberField(totals.calls),
        inputTokens: numberField(totals.inputTokens),
        outputTokens: numberField(totals.outputTokens),
        cacheReadTokens: numberField(totals.cacheReadTokens),
        cacheWriteTokens: numberField(totals.cacheWriteTokens),
        reasoningTokens: numberField(totals.reasoningTokens),
        totalTokens: numberField(totals.totalTokens),
        totalUsd: numberField(totals.totalUsd)
      },
      models: item.models.map((model) => {
        const row = record(model);
        return {
          provider: stringField(row.provider),
          model: stringField(row.model),
          calls: numberField(row.calls),
          inputTokens: numberField(row.inputTokens),
          outputTokens: numberField(row.outputTokens),
          cacheReadTokens: numberField(row.cacheReadTokens),
          cacheWriteTokens: numberField(row.cacheWriteTokens),
          reasoningTokens: numberField(row.reasoningTokens),
          totalTokens: numberField(row.totalTokens),
          totalUsd: numberField(row.totalUsd)
        };
      })
    };
  };
  var decodeAdminUsers = (value) => {
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
        identityCount: numberField(item.identityCount)
      };
    });
  };
  var decodeIdentities = (value) => {
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
        ...item.user ? { user: decodeUser(item.user) } : {}
      };
    });
  };
  function decodeAccountModelProfile(value) {
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
      updatedAt: stringField(item.updatedAt)
    };
  }
  var decodeAccountModelProfiles = (value) => {
    const item = record(value);
    if (!Array.isArray(item.profiles)) throw new Error("invalid response");
    const defaultProfileId = item.defaultProfileId;
    if (defaultProfileId !== void 0 && defaultProfileId !== null && typeof defaultProfileId !== "string") {
      throw new Error("invalid response");
    }
    return {
      profiles: item.profiles.map(decodeAccountModelProfile),
      // 在 Auth 服务切换完成前兼容旧响应；新契约始终显式返回 null 或 id。
      defaultProfileId: defaultProfileId ?? null
    };
  };
  function useJson(options) {
    const { React, path, decode, revision = 0 } = options;
    const [state, setState] = React.useState({ status: "loading" });
    React.useEffect(() => {
      let active = true;
      setState({ status: "loading" });
      void fetch(path, { credentials: "same-origin" }).then(async (response) => {
        if (!response.ok) throw new Error("request failed");
        const data = decode(await response.json());
        if (active) setState({ status: "ready", data });
      }).catch(() => {
        if (active) setState({ status: "error" });
      });
      return () => {
        active = false;
      };
    }, [path, revision]);
    return state;
  }
  function useAccountUser(React) {
    return useJson({ React, path: "/auth/me", decode: decodeMe });
  }
  function useAccountUsage(React) {
    return useJson({ React, path: "/api/billing/usage", decode: decodeUsage });
  }
  function useAdminUsers(React) {
    return useJson({ React, path: "/api/admin/users", decode: decodeAdminUsers });
  }
  function useIdentities(React, revision) {
    return useJson({ React, path: "/auth/identities", decode: decodeIdentities, revision });
  }
  function useAccountModelProfiles(React, revision) {
    return useJson({ React, path: "/auth/models", decode: decodeAccountModelProfiles, revision });
  }
  async function signOut() {
    const response = await fetch("/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-csrf-token": readCsrfToken() }
    });
    if (!response.ok) throw new Error("logout failed");
  }
  async function unlinkIdentity(identity) {
    const response = await fetch("/auth/identities", {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": readCsrfToken() },
      body: JSON.stringify({ provider: identity.provider, subject: identity.subject })
    });
    if (response.ok) return;
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "IDENTITY_UNLINK_FAILED");
  }
  async function createAccountModelProfile(input) {
    await mutateAccountModels("/auth/models", "POST", {
      displayName: input.displayName,
      baseUrl: input.baseUrl,
      modelIds: input.modelIds,
      defaultModel: input.defaultModel,
      apiKey: input.apiKey
    });
  }
  async function updateAccountModelProfile(profileId, input) {
    const apiKey = input.apiKey?.trim();
    await mutateAccountModels(`/auth/models/${encodeURIComponent(profileId)}`, "PATCH", {
      expectedRevision: input.expectedRevision,
      displayName: input.displayName,
      baseUrl: input.baseUrl,
      modelIds: input.modelIds,
      defaultModel: input.defaultModel,
      ...apiKey ? { apiKey } : {}
    });
  }
  async function deleteAccountModelProfile(profileId, expectedRevision) {
    await mutateAccountModels(`/auth/models/${encodeURIComponent(profileId)}`, "DELETE", { expectedRevision });
  }
  async function setAccountModelDefault(profileId) {
    await mutateAccountModels(`/auth/models/${encodeURIComponent(profileId)}/default`, "POST", {});
  }
  async function mutateAccountModels(path, method, body) {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": readCsrfToken() },
      body: JSON.stringify(body)
    });
    if (response.ok) return;
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || "MODEL_PROFILE_REQUEST_FAILED");
  }
  function readCsrfToken() {
    return decodeURIComponent((document.cookie.match(/(?:^|; )dsh_csrf=([^;]+)/) || [])[1] || "");
  }

  // packages/lark/web-auth/src/client-account.ts
  var AREAS = [
    { id: "usage", label: "\u7528\u91CF\u4E0E\u989D\u5EA6" },
    { id: "models", label: "\u6211\u7684\u6A21\u578B" },
    { id: "feishu", label: "\u98DE\u4E66\u8FDE\u63A5" },
    { id: "security", label: "\u5B89\u5168\u4E0E\u767B\u5F55" },
    { id: "admin", label: "\u7528\u6237\u4E0E\u6743\u9650" }
  ];
  function formatUsd(value) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 4
    }).format(value);
  }
  function formatCount(value) {
    return new Intl.NumberFormat("zh-CN").format(value);
  }
  function loading(React, error = false) {
    return React.createElement("p", {
      className: "mewclaw-account-message",
      "data-state": error ? "error" : void 0
    }, error ? "\u6570\u636E\u6682\u65F6\u4E0D\u53EF\u7528\u3002" : "\u6B63\u5728\u8BFB\u53D6\u6570\u636E\u2026");
  }
  function AccountActions({ React }) {
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const leave = async () => {
      if (busy) return;
      setBusy(true);
      setError("");
      try {
        await signOut();
        location.href = "/";
      } catch {
        setError("\u9000\u51FA\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
        setBusy(false);
      }
    };
    return React.createElement(
      "div",
      { className: "mewclaw-account-session-buttons" },
      React.createElement("button", { type: "button", className: "mewclaw-account-button primary", disabled: busy, onClick: () => {
        void leave();
      } }, "\u5207\u6362\u8D26\u53F7"),
      React.createElement("button", { type: "button", className: "mewclaw-account-button", disabled: busy, onClick: () => {
        void leave();
      } }, "\u9000\u51FA\u767B\u5F55"),
      error ? React.createElement("p", { className: "mewclaw-account-message", "data-state": "error" }, error) : null
    );
  }
  function AccountOverview({ React, user }) {
    const initial = Array.from(user.displayName.trim())[0] || "M";
    const mode = user.defaultMode === "full" ? "Full / OCI roster" : "\u8F7B\u91CF\u6A21\u5F0F";
    return React.createElement(
      "div",
      { className: "mewclaw-account-section" },
      React.createElement(
        "div",
        { className: "mewclaw-account-profile" },
        React.createElement("span", { className: "mewclaw-account-avatar mewclaw-account-avatar-large", "aria-hidden": "true" }, initial),
        React.createElement(
          "div",
          { className: "mewclaw-account-profile-copy" },
          React.createElement("strong", null, user.displayName),
          React.createElement("span", { className: "mewclaw-account-muted" }, user.email)
        ),
        React.createElement(AccountActions, { React })
      ),
      React.createElement(
        "dl",
        { className: "mewclaw-account-facts" },
        fact(React, "\u89D2\u8272", user.role === "admin" ? "\u7BA1\u7406\u5458" : "\u6210\u5458"),
        fact(React, "\u9ED8\u8BA4\u6A21\u5F0F", mode),
        fact(React, "\u8D26\u6237\u72B6\u6001", "\u5DF2\u9A8C\u8BC1")
      )
    );
  }
  function fact(React, label, value) {
    return React.createElement(
      "div",
      null,
      React.createElement("dt", null, label),
      React.createElement("dd", null, value)
    );
  }
  function PasswordSection({ React }) {
    const [busy, setBusy] = React.useState(false);
    const [message, setMessage] = React.useState({ text: "" });
    const submit = async (event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      const newPassword = String(values.get("newPassword") || "");
      if (newPassword !== String(values.get("confirmPassword") || "")) {
        setMessage({ text: "\u4E24\u6B21\u65B0\u5BC6\u7801\u4E0D\u4E00\u81F4\u3002", state: "error" });
        return;
      }
      setBusy(true);
      setMessage({ text: "" });
      try {
        const response = await fetch("/auth/password/change", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-csrf-token": readCsrfToken() },
          body: JSON.stringify({ oldPassword: values.get("oldPassword"), newPassword })
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "PASSWORD_CHANGE_FAILED");
        setMessage({ text: "\u5BC6\u7801\u5DF2\u66F4\u65B0\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u3002", state: "success" });
        setTimeout(() => {
          location.href = "/";
        }, 700);
      } catch (cause) {
        const code = cause instanceof Error ? cause.message : "PASSWORD_CHANGE_FAILED";
        setMessage({ text: code === "PASSWORD_INVALID" ? "\u5F53\u524D\u5BC6\u7801\u4E0D\u6B63\u786E\u3002" : "\u66F4\u65B0\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u5BC6\u7801\u540E\u91CD\u8BD5\u3002", state: "error" });
        setBusy(false);
      }
    };
    return React.createElement(
      "form",
      { className: "mewclaw-account-form", onSubmit: (event) => {
        void submit(event);
      } },
      passwordField(React, "\u5F53\u524D\u5BC6\u7801", "oldPassword", "current-password"),
      passwordField(React, "\u65B0\u5BC6\u7801", "newPassword", "new-password"),
      passwordField(React, "\u786E\u8BA4\u65B0\u5BC6\u7801", "confirmPassword", "new-password"),
      React.createElement(
        "div",
        { className: "mewclaw-account-form-actions" },
        React.createElement("button", { type: "submit", className: "mewclaw-account-button primary", disabled: busy }, busy ? "\u66F4\u65B0\u4E2D" : "\u66F4\u65B0\u5BC6\u7801"),
        React.createElement("p", { className: "mewclaw-account-message", role: "status", "aria-live": "polite", "data-state": message.state }, message.text)
      )
    );
  }
  function passwordField(React, label, name, autoComplete) {
    return React.createElement(
      "label",
      null,
      label,
      React.createElement("input", { name, type: "password", autoComplete, minLength: 12, maxLength: 256, required: true })
    );
  }
  function IdentitySection({ React }) {
    const [revision, setRevision] = React.useState(0);
    const state = useIdentities(React, revision);
    if (state.status !== "ready") return loading(React, state.status === "error");
    if (!state.data.length) return emptyState(React, "\u6682\u65E0\u98DE\u4E66\u7ED1\u5B9A");
    const remove = async (identity) => {
      if (!window.confirm("\u786E\u5B9A\u89E3\u7ED1\u5F53\u524D\u98DE\u4E66\u8D26\u53F7\u5417\uFF1F")) return;
      try {
        await unlinkIdentity(identity);
        setRevision(revision + 1);
      } catch (cause) {
        const code = cause instanceof Error ? cause.message : "";
        window.alert(code === "IDENTITY_LAST_LOGIN_METHOD" ? "\u8FD9\u662F\u5F53\u524D\u8D26\u53F7\u6700\u540E\u7684\u767B\u5F55\u65B9\u5F0F\uFF0C\u4E0D\u80FD\u89E3\u7ED1\u3002" : "\u89E3\u7ED1\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
      }
    };
    return React.createElement("ul", { className: "mewclaw-identity-list" }, state.data.map((identity) => React.createElement(
      "li",
      { className: "mewclaw-identity-row", key: identity.subject },
      React.createElement(
        "div",
        { className: "mewclaw-account-row-copy" },
        React.createElement("strong", null, "\u98DE\u4E66"),
        React.createElement("span", null, maskIdentity(identity.subject))
      ),
      React.createElement("button", { type: "button", className: "mewclaw-account-button danger", onClick: () => {
        void remove(identity);
      } }, "\u89E3\u7ED1")
    )));
  }
  function parseModelIds(value) {
    const modelIds = [];
    const seen = /* @__PURE__ */ new Set();
    for (const candidate of value.split(/[\n,]/u)) {
      const modelId = candidate.trim();
      if (!modelId || seen.has(modelId)) continue;
      seen.add(modelId);
      modelIds.push(modelId);
    }
    return modelIds;
  }
  function isDefaultModelInList(modelIds, defaultModel) {
    return Boolean(defaultModel.trim()) && modelIds.includes(defaultModel.trim());
  }
  function modelFormValue(values, name) {
    const value = values.get(name);
    return typeof value === "string" ? value.trim() : "";
  }
  function modelErrorMessage(cause, fallback) {
    const code = cause instanceof Error ? cause.message : "";
    if (code === "MODEL_PROFILE_CONFLICT" || code === "MODEL_PROFILE_REVISION_CONFLICT") return "\u914D\u7F6E\u5DF2\u88AB\u5176\u4ED6\u64CD\u4F5C\u66F4\u65B0\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5\u3002";
    if (code === "MODEL_PROFILE_NOT_FOUND") return "\u8BE5\u6A21\u578B\u914D\u7F6E\u5DF2\u4E0D\u5B58\u5728\uFF0C\u8BF7\u5237\u65B0\u5217\u8868\u3002";
    return fallback;
  }
  function ModelProfileForm({ React, profile, onSaved, onCancel }) {
    const [busy, setBusy] = React.useState(false);
    const [message, setMessage] = React.useState({ text: "" });
    const isEditing = profile !== null;
    const submit = async (event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      const displayName = modelFormValue(values, "displayName");
      const baseUrl = modelFormValue(values, "baseUrl");
      const modelIds = parseModelIds(modelFormValue(values, "modelIds"));
      const defaultModel = modelFormValue(values, "defaultModel");
      const apiKey = modelFormValue(values, "apiKey");
      if (!displayName || !baseUrl || !modelIds.length || !defaultModel) {
        setMessage({ text: "\u8BF7\u5B8C\u6574\u586B\u5199\u540D\u79F0\u3001\u5730\u5740\u3001\u6A21\u578B\u5217\u8868\u548C\u9ED8\u8BA4\u6A21\u578B\u3002", state: "error" });
        return;
      }
      if (!isDefaultModelInList(modelIds, defaultModel)) {
        setMessage({ text: "\u9ED8\u8BA4\u6A21\u578B\u5FC5\u987B\u5305\u542B\u5728\u6A21\u578B\u5217\u8868\u4E2D\u3002", state: "error" });
        return;
      }
      if (!isEditing && !apiKey) {
        setMessage({ text: "\u65B0\u589E\u6A21\u578B\u914D\u7F6E\u65F6\u5FC5\u987B\u586B\u5199 API Key\u3002", state: "error" });
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
            ...apiKey ? { apiKey } : {}
          });
        } else {
          await createAccountModelProfile({ displayName, baseUrl, modelIds, defaultModel, apiKey });
        }
        onSaved();
      } catch (cause) {
        setMessage({ text: modelErrorMessage(cause, isEditing ? "\u66F4\u65B0\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002" : "\u65B0\u589E\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002"), state: "error" });
        setBusy(false);
      }
    };
    return React.createElement(
      "form",
      {
        className: "mewclaw-account-form mewclaw-account-model-form",
        // 使用下方的中文校验提示，避免浏览器原生气泡遮挡相邻输入框。
        noValidate: true,
        onSubmit: (event) => {
          void submit(event);
        }
      },
      React.createElement(
        "label",
        null,
        "\u914D\u7F6E\u540D\u79F0",
        React.createElement("input", { name: "displayName", type: "text", defaultValue: profile?.displayName || "", maxLength: 80, required: true, autoComplete: "off" })
      ),
      React.createElement(
        "label",
        null,
        "Base URL",
        React.createElement("input", { name: "baseUrl", type: "url", defaultValue: profile?.baseUrl || "", maxLength: 2048, required: true, autoComplete: "off", spellCheck: false })
      ),
      React.createElement(
        "label",
        { className: "mewclaw-account-field-wide" },
        "\u6A21\u578B\u5217\u8868\uFF08\u6BCF\u884C\u4E00\u4E2A\uFF0C\u6216\u7528\u9017\u53F7\u5206\u9694\uFF09",
        React.createElement("textarea", { name: "modelIds", defaultValue: profile?.modelIds.join("\n") || "", rows: 4, required: true, spellCheck: false })
      ),
      React.createElement(
        "label",
        null,
        "\u9ED8\u8BA4\u6A21\u578B",
        React.createElement("input", { name: "defaultModel", type: "text", defaultValue: profile?.defaultModel || "", maxLength: 256, required: true, autoComplete: "off", spellCheck: false })
      ),
      React.createElement(
        "label",
        null,
        isEditing ? "\u66F4\u6362 API Key\uFF08\u7559\u7A7A\u5219\u4FDD\u7559\u539F\u5BC6\u94A5\uFF09" : "API Key",
        React.createElement("input", { name: "apiKey", type: "password", required: !isEditing, autoComplete: "off", spellCheck: false })
      ),
      React.createElement(
        "div",
        { className: "mewclaw-account-form-actions" },
        React.createElement("button", { type: "submit", className: "mewclaw-account-button primary", disabled: busy }, busy ? "\u4FDD\u5B58\u4E2D" : isEditing ? "\u4FDD\u5B58\u4FEE\u6539" : "\u65B0\u589E\u6A21\u578B"),
        React.createElement("button", { type: "button", className: "mewclaw-account-button", disabled: busy, onClick: onCancel }, "\u53D6\u6D88"),
        React.createElement("p", { className: "mewclaw-account-message", role: "status", "aria-live": "polite", "data-state": message.state }, message.text)
      )
    );
  }
  function ModelProfilesSection({ React }) {
    const [revision, setRevision] = React.useState(0);
    const [editing, setEditing] = React.useState(null);
    const [creating, setCreating] = React.useState(false);
    const [pendingId, setPendingId] = React.useState("");
    const [message, setMessage] = React.useState({ text: "" });
    const state = useAccountModelProfiles(React, revision);
    const refresh = (text) => {
      setEditing(null);
      setCreating(false);
      setMessage({ text, state: "success" });
      setRevision(revision + 1);
    };
    const setDefault = async (profile) => {
      if (pendingId) return;
      setPendingId(profile.id);
      setMessage({ text: "" });
      try {
        await setAccountModelDefault(profile.id);
        refresh("\u9ED8\u8BA4\u6A21\u578B\u914D\u7F6E\u5DF2\u66F4\u65B0\u3002");
      } catch (cause) {
        setMessage({ text: modelErrorMessage(cause, "\u8BBE\u7F6E\u9ED8\u8BA4\u914D\u7F6E\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002"), state: "error" });
      } finally {
        setPendingId("");
      }
    };
    const remove = async (profile) => {
      if (pendingId || !window.confirm(`\u786E\u5B9A\u5220\u9664\u201C${profile.displayName}\u201D\u5417\uFF1F`)) return;
      setPendingId(profile.id);
      setMessage({ text: "" });
      try {
        await deleteAccountModelProfile(profile.id, profile.revision);
        refresh("\u6A21\u578B\u914D\u7F6E\u5DF2\u5220\u9664\u3002");
      } catch (cause) {
        setMessage({ text: modelErrorMessage(cause, "\u5220\u9664\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002"), state: "error" });
      } finally {
        setPendingId("");
      }
    };
    if (state.status !== "ready") return loading(React, state.status === "error");
    const { profiles, defaultProfileId } = state.data;
    const isEditing = creating || editing !== null;
    return React.createElement(
      "div",
      { className: "mewclaw-account-section" },
      React.createElement(
        "div",
        { className: "mewclaw-account-model-profile-toolbar" },
        React.createElement("p", { className: "mewclaw-account-message" }, "\u4EC5\u652F\u6301 OpenAI \u517C\u5BB9\u7684 Chat Completions \u63A5\u53E3\u3002"),
        !isEditing ? React.createElement("button", { type: "button", className: "mewclaw-account-button primary", onClick: () => {
          setCreating(true);
          setMessage({ text: "" });
        } }, "\u65B0\u589E\u6A21\u578B") : null
      ),
      isEditing ? React.createElement(ModelProfileForm, {
        key: editing?.id || "new",
        React,
        profile: editing,
        onSaved: () => {
          refresh(editing ? "\u6A21\u578B\u914D\u7F6E\u5DF2\u66F4\u65B0\u3002" : "\u6A21\u578B\u914D\u7F6E\u5DF2\u65B0\u589E\u3002");
        },
        onCancel: () => {
          setEditing(null);
          setCreating(false);
        }
      }) : null,
      message.text ? React.createElement("p", { className: "mewclaw-account-message", role: "status", "aria-live": "polite", "data-state": message.state }, message.text) : null,
      profiles.length ? React.createElement("ul", { className: "mewclaw-account-model-profile-list" }, profiles.map((profile) => {
        const isDefault = profile.id === defaultProfileId;
        const isPending = pendingId === profile.id;
        return React.createElement(
          "li",
          { className: "mewclaw-account-model-profile-row", key: profile.id },
          React.createElement(
            "div",
            { className: "mewclaw-account-row-copy" },
            React.createElement("strong", null, profile.displayName),
            React.createElement("span", null, profile.baseUrl),
            React.createElement("span", null, `\u9ED8\u8BA4\u6A21\u578B\uFF1A${profile.defaultModel} \xB7 \u53EF\u7528\u6A21\u578B\uFF1A${profile.modelIds.join("\u3001")}`)
          ),
          React.createElement(
            "div",
            { className: "mewclaw-account-model-profile-badges" },
            isDefault ? React.createElement("span", { className: "mewclaw-account-model-profile-badge primary" }, "\u5F53\u524D\u9ED8\u8BA4") : null,
            React.createElement("span", { className: "mewclaw-account-model-profile-badge" }, profile.keyConfigured ? "\u5BC6\u94A5\u5DF2\u914D\u7F6E" : "\u672A\u914D\u7F6E\u5BC6\u94A5")
          ),
          React.createElement(
            "div",
            { className: "mewclaw-account-model-profile-actions" },
            !isDefault ? React.createElement("button", { type: "button", className: "mewclaw-account-button", disabled: Boolean(pendingId), onClick: () => {
              void setDefault(profile);
            } }, isPending ? "\u8BBE\u7F6E\u4E2D" : "\u8BBE\u4E3A\u9ED8\u8BA4") : null,
            React.createElement("button", { type: "button", className: "mewclaw-account-button", disabled: Boolean(pendingId), onClick: () => {
              setEditing(profile);
              setCreating(false);
              setMessage({ text: "" });
            } }, "\u7F16\u8F91"),
            React.createElement("button", { type: "button", className: "mewclaw-account-button danger", disabled: Boolean(pendingId), onClick: () => {
              void remove(profile);
            } }, isPending ? "\u5220\u9664\u4E2D" : "\u5220\u9664")
          )
        );
      })) : !isEditing ? emptyState(React, "\u5C1A\u672A\u914D\u7F6E\u4E2A\u4EBA\u6A21\u578B") : null
    );
  }
  function UsageSection({ React }) {
    const state = useAccountUsage(React);
    if (state.status !== "ready") return loading(React, state.status === "error");
    const { quota, totals, models } = state.data;
    const percent = quota.monthlyLimitUsd > 0 ? Math.min(100, Math.max(0, quota.usedUsd / quota.monthlyLimitUsd * 100)) : 0;
    return React.createElement(
      "div",
      { className: "mewclaw-account-section" },
      React.createElement(
        "div",
        { className: "mewclaw-account-usage-grid" },
        usageStat(React, "\u5DF2\u7528\u989D\u5EA6", formatUsd(quota.usedUsd)),
        usageStat(React, "\u5269\u4F59\u989D\u5EA6", formatUsd(quota.remainingUsd)),
        usageStat(React, "\u6A21\u578B\u8C03\u7528", formatCount(totals.calls)),
        usageStat(React, "\u603B Token", formatCount(totals.totalTokens))
      ),
      React.createElement(
        "div",
        { className: "mewclaw-account-usage-progress" },
        React.createElement("div", { className: "mewclaw-account-usage-progress-head" }, React.createElement("span", null, state.data.periodStart), React.createElement("span", null, `${formatUsd(quota.usedUsd)} / ${formatUsd(quota.monthlyLimitUsd)}`)),
        React.createElement(
          "div",
          { className: "mewclaw-account-usage-progress-track", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(percent) },
          React.createElement("div", { className: "mewclaw-account-usage-progress-fill", style: { width: `${percent}%` } })
        )
      ),
      React.createElement(
        "dl",
        { className: "mewclaw-account-token-grid" },
        fact(React, "\u8F93\u5165 Token", formatCount(totals.inputTokens)),
        fact(React, "\u8F93\u51FA Token", formatCount(totals.outputTokens)),
        fact(React, "\u7F13\u5B58 Token", formatCount(totals.cacheReadTokens + totals.cacheWriteTokens)),
        fact(React, "\u63A8\u7406 Token", formatCount(totals.reasoningTokens))
      ),
      models.length ? React.createElement("ul", { className: "mewclaw-account-models" }, models.map((model) => React.createElement(
        "li",
        { className: "mewclaw-account-model-row", key: `${model.provider}:${model.model}` },
        React.createElement("div", { className: "mewclaw-account-row-copy" }, React.createElement("strong", null, model.model), React.createElement("span", null, model.provider)),
        React.createElement("span", { className: "mewclaw-account-row-meta" }, `${formatCount(model.calls)} \u6B21`),
        React.createElement("span", null, formatUsd(model.totalUsd))
      ))) : emptyState(React, "\u672C\u5468\u671F\u6682\u65E0\u6A21\u578B\u8C03\u7528")
    );
  }
  function usageStat(React, label, value) {
    return React.createElement(
      "dl",
      { className: "mewclaw-account-usage-stat" },
      React.createElement("dt", null, label),
      React.createElement("dd", null, value)
    );
  }
  function AdminSection({ React }) {
    const state = useAdminUsers(React);
    if (state.status !== "ready") return loading(React, state.status === "error");
    return React.createElement(
      "div",
      { className: "mewclaw-account-section" },
      state.data.length ? React.createElement("ul", { className: "mewclaw-account-admin-list" }, state.data.map((user) => React.createElement(
        "li",
        { className: "mewclaw-account-admin-row", key: user.id },
        React.createElement("div", { className: "mewclaw-account-row-copy" }, React.createElement("strong", null, user.displayName), React.createElement("span", null, user.email)),
        React.createElement("div", { className: "mewclaw-account-row-meta" }, React.createElement("span", null, user.role === "admin" ? "\u7BA1\u7406\u5458" : "\u6210\u5458"), React.createElement("span", null, `${user.workspaceCount} \u5DE5\u4F5C\u533A`), React.createElement("span", null, `${user.sessionCount} \u4F1A\u8BDD`), React.createElement("span", null, `${user.identityCount} \u98DE\u4E66\u7ED1\u5B9A`))
      ))) : emptyState(React, "\u6682\u65E0\u7528\u6237"),
      React.createElement("a", { className: "mewclaw-account-link", href: "/admin" }, "\u8FDB\u5165\u7BA1\u7406\u5DE5\u4F5C\u53F0 \u2192")
    );
  }
  function emptyState(React, text) {
    return React.createElement("div", { className: "mewclaw-account-empty" }, React.createElement("strong", null, text));
  }
  function areaContent(React, area) {
    if (area === "usage") return React.createElement(UsageSection, { React });
    if (area === "models") return React.createElement(ModelProfilesSection, { React });
    if (area === "feishu") return React.createElement(IdentitySection, { React });
    if (area === "security") return React.createElement(PasswordSection, { React });
    return React.createElement(AdminSection, { React });
  }
  function areaMeta(area) {
    if (area === "usage") return "\u672C\u6708";
    if (area === "models") return "\u4E2A\u4EBA\u914D\u7F6E";
    if (area === "feishu") return "\u4E2A\u4EBA\u8FDE\u63A5";
    if (area === "security") return "\u5BC6\u7801";
    return "\u7BA1\u7406\u5458";
  }
  function AccountFold(React, entry) {
    return React.createElement(
      "details",
      { className: "mewclaw-account-fold", open: entry.id === "usage" },
      React.createElement(
        "summary",
        null,
        React.createElement("span", { className: "mewclaw-account-fold-title" }, entry.label, React.createElement("span", { className: "mewclaw-account-fold-meta" }, areaMeta(entry.id)))
      ),
      React.createElement("div", { className: "mewclaw-account-fold-content" }, areaContent(React, entry.id))
    );
  }
  function renderAccount(React, state) {
    if (state.status !== "ready") return loading(React, state.status === "error");
    const areas = AREAS.filter((entry) => entry.id !== "admin" || state.data.role === "admin");
    return React.createElement(
      "div",
      { className: "mewclaw-account-center" },
      React.createElement("header", { className: "mewclaw-account-center-header" }, React.createElement("h2", null, "\u8D26\u6237\u4E2D\u5FC3")),
      React.createElement(AccountOverview, { React, user: state.data }),
      React.createElement("div", { className: "mewclaw-account-folds" }, areas.map((entry) => AccountFold(React, entry)))
    );
  }
  function AccountCenterSection(React) {
    return renderAccount(React, useAccountUser(React));
  }
  function maskIdentity(subject) {
    return subject.length > 12 ? `${subject.slice(0, 6)}...${subject.slice(-4)}` : subject;
  }

  // packages/lark/web-auth/src/client-styles.ts
  var ACCOUNT_STYLES = `
.mewclaw-network-status{position:fixed;z-index:2147483000;top:12px;left:50%;display:flex;max-width:min(520px,calc(100vw - 32px));min-height:34px;box-sizing:border-box;align-items:center;padding:7px 12px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:8px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 24px rgba(0,0,0,.14);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;transform:translateX(-50%)}
.mewclaw-network-status[hidden]{display:none}
.mewclaw-settings-trigger{display:flex;align-items:center;gap:9px;min-width:0;color:inherit}
.mewclaw-account-avatar{display:grid;width:28px;height:28px;flex:0 0 28px;place-items:center;border-radius:50%;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-size:12px;font-weight:600}
.mewclaw-account-avatar-large{width:44px;height:44px;flex-basis:44px;font-size:16px}
.mewclaw-account-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px}
.mewclaw-account-center{box-sizing:border-box;display:flex;flex-direction:column;gap:20px;width:100%;padding:2px 0 14px;color:var(--dsw-alias-label-primary)}
.mewclaw-account-center-header h2{margin:0;font-size:18px;line-height:26px;font-weight:600}
.mewclaw-account-profile{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:12px;min-width:0}
.mewclaw-account-profile-copy{display:flex;flex-direction:column;min-width:0;gap:2px}
.mewclaw-account-profile-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;line-height:22px;font-weight:600}
.mewclaw-account-muted{overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-overflow:ellipsis;white-space:nowrap}
.mewclaw-account-session-buttons{display:flex;align-items:center;flex-wrap:wrap;justify-content:flex-end;gap:8px}
.mewclaw-account-button{box-sizing:border-box;min-height:34px;padding:0 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.mewclaw-account-button:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover-solid)}
.mewclaw-account-button.primary{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.mewclaw-account-button.primary:hover{background:var(--dsw-alias-button-primary-hover)}
.mewclaw-account-button.danger:hover{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.mewclaw-account-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.mewclaw-account-button:disabled{cursor:wait;opacity:.55}
.mewclaw-account-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:0;border-top:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.mewclaw-account-facts>div{min-width:0;padding:12px 10px}
.mewclaw-account-facts>div+div{border-left:1px solid var(--dsw-alias-border-l1)}
.mewclaw-account-facts dt{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.mewclaw-account-facts dd{margin:3px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px}
.mewclaw-account-message{min-height:18px;margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.mewclaw-account-message[data-state="error"]{color:var(--dsw-alias-state-error-primary)}
.mewclaw-account-message[data-state="success"]{color:var(--dsw-alias-state-success-primary)}
.mewclaw-account-folds{display:flex;flex-direction:column;width:100%;border-bottom:1px solid var(--dsw-alias-border-l2)}
.mewclaw-account-fold{border-top:1px solid var(--dsw-alias-border-l2)}
.mewclaw-account-fold summary{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:50px;padding:9px 2px;color:var(--dsw-alias-label-primary);list-style:none;cursor:pointer}
.mewclaw-account-fold summary::-webkit-details-marker{display:none}
.mewclaw-account-fold summary::after{content:"+";color:var(--dsw-alias-label-tertiary);font-size:18px;line-height:20px}
.mewclaw-account-fold[open] summary::after{content:"-"}
.mewclaw-account-fold summary:hover{color:var(--dsw-alias-state-business-primary)}
.mewclaw-account-fold-title{display:flex;align-items:center;gap:8px;font-size:14px;line-height:21px;font-weight:500}
.mewclaw-account-fold-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400}
.mewclaw-account-fold-content{padding:2px 2px 16px}
.mewclaw-account-section{box-sizing:border-box;display:flex;flex-direction:column;gap:16px;width:100%;color:var(--dsw-alias-label-primary)}
.mewclaw-account-form{box-sizing:border-box;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));width:100%;max-width:560px;gap:12px}
.mewclaw-account-form label{display:grid;min-width:0;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.mewclaw-account-form label:first-child{grid-column:1/-1}
.mewclaw-account-form input{box-sizing:border-box;width:100%;min-width:0;height:38px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}
.mewclaw-account-form input:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent)}
.mewclaw-account-form-actions{display:flex;align-items:center;gap:10px;grid-column:1/-1}
.mewclaw-account-model-profile-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px}
.mewclaw-account-model-profile-toolbar .mewclaw-account-message{min-height:0}
.mewclaw-account-model-form{max-width:680px}
.mewclaw-account-model-form label:first-child{grid-column:auto}
.mewclaw-account-model-form .mewclaw-account-field-wide{grid-column:1/-1}
.mewclaw-account-model-form textarea{box-sizing:border-box;width:100%;min-width:0;min-height:92px;padding:9px 11px;resize:vertical;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;line-height:20px}
.mewclaw-account-model-form textarea:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent)}
.mewclaw-account-model-profile-list{display:flex;flex-direction:column;margin:0;padding:0;list-style:none;border-top:1px solid var(--dsw-alias-border-l1)}
.mewclaw-account-model-profile-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 14px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.mewclaw-account-model-profile-row:last-child{border-bottom:0}
.mewclaw-account-model-profile-badges{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:flex-end;gap:6px}
.mewclaw-account-model-profile-badge{display:inline-flex;align-items:center;min-height:20px;padding:0 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;white-space:nowrap}
.mewclaw-account-model-profile-badge.primary{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 40%,var(--dsw-alias-border-l2));color:var(--dsw-alias-state-business-primary)}
.mewclaw-account-model-profile-actions{display:flex;grid-column:1/-1;flex-wrap:wrap;align-items:center;gap:8px}
.mewclaw-account-model-profile-actions .mewclaw-account-button{min-height:30px;padding:0 10px;font-size:12px}
.mewclaw-account-empty{display:grid;justify-items:start;gap:6px;padding:12px 0;color:var(--dsw-alias-label-secondary);font-size:12px}
.mewclaw-account-empty strong{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}
.mewclaw-account-usage-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.mewclaw-account-usage-stat{display:grid;gap:3px;min-width:0;margin:0;padding:11px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.mewclaw-account-usage-stat dt{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.mewclaw-account-usage-stat dd{margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:16px;line-height:23px;font-variant-numeric:tabular-nums}
.mewclaw-account-usage-progress{display:grid;gap:7px}
.mewclaw-account-usage-progress-head{display:flex;justify-content:space-between;gap:12px;font-size:12px;line-height:18px}
.mewclaw-account-usage-progress-head span:last-child{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.mewclaw-account-usage-progress-track{height:6px;overflow:hidden;border-radius:3px;background:var(--dsw-alias-interactive-bg-hover)}
.mewclaw-account-usage-progress-fill{height:100%;border-radius:inherit;background:var(--dsw-alias-state-business-primary);transition:width .2s ease}
.mewclaw-account-token-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:0;border-top:1px solid var(--dsw-alias-border-l1)}
.mewclaw-account-token-grid>div{padding:10px 8px 4px}
.mewclaw-account-token-grid dt{color:var(--dsw-alias-label-tertiary);font-size:11px}
.mewclaw-account-token-grid dd{margin:3px 0 0;font-size:13px;font-variant-numeric:tabular-nums}
.mewclaw-account-models,.mewclaw-account-admin-list,.mewclaw-identity-list{display:flex;flex-direction:column;margin:0;padding:0;list-style:none;border-top:1px solid var(--dsw-alias-border-l1)}
.mewclaw-account-model-row,.mewclaw-account-admin-row,.mewclaw-identity-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:14px;padding:11px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.mewclaw-account-model-row:last-child,.mewclaw-account-admin-row:last-child,.mewclaw-identity-row:last-child{border-bottom:0}
.mewclaw-account-row-copy{display:flex;flex-direction:column;min-width:0;gap:2px}
.mewclaw-account-row-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;font-weight:500}
.mewclaw-account-row-copy span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.mewclaw-account-row-meta{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;text-align:right}
.mewclaw-account-model-row{grid-template-columns:minmax(0,1fr) auto auto}
.mewclaw-account-link{display:inline-flex;width:max-content;align-items:center;color:var(--dsw-alias-state-business-primary);font-size:13px;text-decoration:none}
.mewclaw-account-link:hover{text-decoration:underline}
@media(max-width:720px){div:has(>div>div>div>.mewclaw-account-center){flex-direction:column}div:has(>div>div>div>.mewclaw-account-center)>nav{box-sizing:border-box;width:100%;height:auto;gap:10px;padding:18px 16px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}div:has(>div>div>div>.mewclaw-account-center)>nav>div:first-child{width:auto;padding:0 8px}div:has(>div>div>div>.mewclaw-account-center)>nav>div:last-child{box-sizing:border-box;flex-direction:row;width:100%;height:auto;overflow-x:auto;gap:4px;padding-bottom:6px;scrollbar-width:none;overscroll-behavior-x:contain}div:has(>div>div>div>.mewclaw-account-center)>nav>div:last-child::-webkit-scrollbar{display:none}div:has(>div>div>div>.mewclaw-account-center)>nav>div:last-child>button{width:auto;min-width:max-content;flex:0 0 auto;white-space:nowrap}div:has(>div>div>div>.mewclaw-account-center)>nav+div{width:100%;height:auto;min-height:0;flex:1 1 auto}}
@media(max-width:720px){.mewclaw-account-profile{grid-template-columns:auto minmax(0,1fr)}.mewclaw-account-session-buttons{grid-column:1/-1;justify-content:flex-start}.mewclaw-account-usage-grid,.mewclaw-account-token-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.mewclaw-account-admin-row{grid-template-columns:1fr}.mewclaw-account-row-meta{justify-content:flex-start;text-align:left}.mewclaw-account-model-profile-row{grid-template-columns:1fr}.mewclaw-account-model-profile-badges{justify-content:flex-start}}
@media(max-width:480px){.mewclaw-account-facts,.mewclaw-account-form{grid-template-columns:1fr}.mewclaw-account-facts>div+div{border-top:1px solid var(--dsw-alias-border-l1);border-left:0}.mewclaw-account-form label:first-child,.mewclaw-account-form-actions,.mewclaw-account-model-form .mewclaw-account-field-wide{grid-column:auto}.mewclaw-account-usage-grid{grid-template-columns:1fr}.mewclaw-account-model-row{grid-template-columns:minmax(0,1fr) auto}.mewclaw-account-model-row .mewclaw-account-row-meta{grid-column:1/-1}.mewclaw-account-model-profile-toolbar{align-items:flex-start;flex-direction:column}}
`;
  function installAccountStyles() {
    if (typeof document === "undefined" || document.querySelector("style[data-mewclaw-account]") !== null) return;
    const style = document.createElement("style");
    style.dataset.mewclawAccount = "";
    style.textContent = ACCOUNT_STYLES;
    document.head.appendChild(style);
  }

  // packages/lark/web-auth/src/client.ts
  var loader = globalThis.__ModuleLoader__;
  function isObservableSource(value) {
    if (typeof value !== "object" || value === null) return false;
    const source = value;
    return typeof source.getSnapshot === "function" && typeof source.subscribe === "function";
  }
  function selectConnectionSource(connection) {
    if (typeof connection !== "object" || connection === null) return void 0;
    const record2 = connection;
    const generation = isObservableSource(record2.generation) ? record2.generation : void 0;
    const state = isObservableSource(record2.state) ? record2.state : void 0;
    const hostDescription = isObservableSource(record2.hostDescription) ? record2.hostDescription : void 0;
    const source = generation ?? state ?? hostDescription;
    if (source === void 0) return void 0;
    return state === void 0 ? { source } : { source, stateSource: state };
  }
  function installNetworkStatus(ctx) {
    const connection = ctx.get("connection");
    const selected = selectConnectionSource(connection);
    if (selected === void 0) return () => {
    };
    const { source, stateSource } = selected;
    const status = document.createElement("div");
    status.className = "mewclaw-network-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.hidden = true;
    status.textContent = "\u7F51\u7EDC\u8FDE\u63A5\u5DF2\u4E2D\u65AD\uFF0C\u6B63\u5728\u91CD\u8FDE...";
    document.body.appendChild(status);
    const isConnected = () => {
      let snapshot;
      try {
        snapshot = source.getSnapshot();
      } catch {
        return false;
      }
      if (source === stateSource) return snapshot === "connected";
      return snapshot !== void 0;
    };
    let connectedOnce = isConnected();
    const refresh = () => {
      if (isConnected()) {
        connectedOnce = true;
        status.hidden = true;
        return;
      }
      status.hidden = !connectedOnce;
    };
    let unsubscribe = () => {
    };
    try {
      unsubscribe = source.subscribe(refresh);
    } catch {
    }
    refresh();
    return () => {
      unsubscribe();
      status.remove();
    };
  }
  loader?.load({
    id: "dsh-lark-web-auth",
    factory: (require2) => {
      const React = require2("react");
      installAccountStyles();
      function AccountTrigger({ wide }) {
        const state = useAccountUser(React);
        const user = state.data;
        const name = user?.displayName || "\u8D26\u6237";
        const initial = Array.from(name.trim())[0] || "M";
        return React.createElement(
          "span",
          {
            className: "mewclaw-settings-trigger",
            title: user?.displayName || "\u8D26\u6237\u8BBE\u7F6E"
          },
          React.createElement("span", {
            className: "mewclaw-account-avatar",
            "aria-hidden": "true"
          }, initial),
          wide ? React.createElement("span", { className: "mewclaw-account-label" }, "\u8BBE\u7F6E") : null
        );
      }
      function apply(ctx) {
        ctx.effect(() => installNetworkStatus(ctx), "dsh-lark-web-auth: network status");
        ctx.effect(() => ctx.slots.inject("settings.trigger", () => ctx.slots.register({
          name: "settings.trigger",
          id: "mewclaw-account",
          priority: -1
        }, AccountTrigger)), "dsh-lark-web-auth: account trigger");
        ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "mewclaw-account",
          order: -30,
          label: () => "\u8D26\u6237\u4E2D\u5FC3"
        }, () => AccountCenterSection(React))), "dsh-lark-web-auth: account center section");
      }
      return { apply, inject: ["slots", "connection"] };
    }
  });
})();
