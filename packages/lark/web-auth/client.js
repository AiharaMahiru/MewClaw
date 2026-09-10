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
    const role2 = stringField(item.role);
    const defaultMode = stringField(item.defaultMode);
    if (role2 !== "admin" && role2 !== "user") throw new Error("invalid response");
    if (defaultMode !== "full" && defaultMode !== "lightweight") throw new Error("invalid response");
    return {
      id: stringField(item.id),
      email: stringField(item.email),
      displayName: stringField(item.displayName),
      role: role2,
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

  // packages/lark/web-auth/src/client-bot-data.ts
  function decodeAccountBot(input) {
    const b = input?.bot;
    if (b === null) return null;
    if (!b || typeof b !== "object") throw Error("INVALID_BOT_RESPONSE");
    const bot = b;
    if (typeof bot.id !== "string" || typeof bot.appId !== "string" || typeof bot.domain !== "string" || !Array.isArray(bot.authorizedOpenIds) || bot.authorizedOpenIds.some((id) => typeof id !== "string") || typeof bot.enabled !== "boolean" || typeof bot.secretConfigured !== "boolean" || !Number.isSafeInteger(bot.revision) || !["connected", "reconnecting", "failed", "unknown", "disabled"].includes(bot.state)) throw Error("INVALID_BOT_RESPONSE");
    return { id: bot.id, appId: bot.appId, domain: bot.domain, authorizedOpenIds: [...bot.authorizedOpenIds], secretConfigured: bot.secretConfigured, enabled: bot.enabled, revision: bot.revision, state: bot.state };
  }
  function useAccountBot(React, revision) {
    const [state, setState] = React.useState({ status: "loading" });
    React.useEffect(() => {
      let active = true;
      let busy = false;
      const controller = new AbortController();
      const load = async () => {
        if (busy) return;
        busy = true;
        try {
          const response = await fetch("/auth/feishu-bot", { credentials: "same-origin", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1e4)]) });
          if (!response.ok) throw Error("BOT_READ_FAILED");
          const data = decodeAccountBot(await response.json());
          if (active) setState({ status: "ready", data });
        } catch {
          if (active) setState({ status: "error" });
        } finally {
          busy = false;
        }
      };
      void load();
      const timer = setInterval(() => {
        if (!document.hidden) void load();
      }, 5e3);
      return () => {
        active = false;
        controller.abort();
        clearInterval(timer);
      };
    }, [revision]);
    return state;
  }
  async function mutateBot(path, method, body) {
    const response = await fetch(path, { method, credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": readCsrfToken() }, body: JSON.stringify(body), signal: AbortSignal.timeout(3e4) });
    const result = await response.json();
    if (!response.ok) throw Error(typeof result.error === "string" ? result.error : "BOT_REQUEST_FAILED");
    return result;
  }
  function botError(cause) {
    const code = cause instanceof Error ? cause.message : "";
    return { BOT_CONFIG_CONFLICT: "\u914D\u7F6E\u5DF2\u53D8\u66F4\u6216\u6B64\u5E94\u7528\u5DF2\u88AB\u4F7F\u7528\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5\u3002", BOT_APP_RESERVED: "\u8FD9\u662F\u90E8\u7F72\u7BA1\u7406\u5458\u6B63\u5728\u4F7F\u7528\u7684\u5E94\u7528\uFF0C\u8BF7\u52FF\u91CD\u590D\u8FDE\u63A5\u3002", BOT_DISCONNECT_FIRST: "\u8BF7\u5148\u65AD\u5F00\u673A\u5668\u4EBA\uFF0C\u518D\u4FEE\u6539\u914D\u7F6E\u3002", BOT_SECRET_REQUIRED: "\u9996\u6B21\u914D\u7F6E\u6216\u66F4\u6362\u5E94\u7528\u65F6\uFF0C\u8BF7\u586B\u5199 App Secret\u3002", BOT_CHECK_FAILED: "\u6821\u9A8C\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5 App ID\u3001App Secret\u3001\u673A\u5668\u4EBA\u80FD\u529B\u53CA\u5E94\u7528\u53D1\u5E03\u72B6\u6001\u540E\u91CD\u8BD5\u3002", INVALID_BOT_CONFIG: "\u8BF7\u68C0\u67E5\u5E94\u7528 ID\u3001\u57DF\u540D\u548C\u6388\u6743 Open ID \u7684\u683C\u5F0F\u3002", BOT_STORAGE_UNAVAILABLE: "\u51ED\u8BC1\u5B58\u50A8\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458\u3002", CSRF_INVALID: "\u767B\u5F55\u72B6\u6001\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u91CD\u65B0\u767B\u5F55\u3002" }[code] ?? "\u64CD\u4F5C\u672A\u5B8C\u6210\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u5E76\u5237\u65B0\u72B6\u6001\u540E\u91CD\u8BD5\u3002";
  }

  // packages/lark/web-auth/src/client-bot.ts
  var STATE_LABELS = { connected: "\u957F\u8FDE\u63A5\u5DF2\u8FDE\u63A5", reconnecting: "\u6B63\u5728\u8FDE\u63A5 / \u91CD\u8FDE", failed: "\u8FDE\u63A5\u5931\u8D25\uFF0C\u7F51\u5173\u5C06\u91CD\u8BD5\uFF1B\u8BF7\u68C0\u67E5\u5E94\u7528\u8BBE\u7F6E", unknown: "\u7B49\u5F85\u7F51\u5173\u72B6\u6001", disabled: "\u5DF2\u505C\u7528" };
  function BotForm({ React, bot, refresh }) {
    const [pending, setPending] = React.useState("");
    const [message, setMessage] = React.useState({ text: "", error: false });
    const execute = async (name, operation) => {
      if (pending) return;
      setPending(name);
      setMessage({ text: "", error: false });
      try {
        setMessage({ text: await operation(), error: false });
        refresh();
      } catch (cause) {
        setMessage({ text: botError(cause), error: true });
      } finally {
        setPending("");
      }
    };
    const submit = (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      void execute("\u4FDD\u5B58\u4E2D\u2026", async () => {
        await mutateBot("/auth/feishu-bot", "PUT", {
          expectedRevision: bot?.revision ?? 0,
          appId: String(data.get("appId") ?? "").trim(),
          domain: String(data.get("domain")),
          appSecret: String(data.get("appSecret") ?? "").trim(),
          authorizedOpenIds: String(data.get("openIds") ?? "").split(/[\s,，]+/).filter(Boolean)
        });
        const secret = form.elements.namedItem("appSecret");
        if (secret) secret.value = "";
        return "\u5DF2\u4FDD\u5B58\uFF0C\u673A\u5668\u4EBA\u5C1A\u672A\u8FDE\u63A5\u3002\u8BF7\u6821\u9A8C\u540E\u70B9\u51FB\u8FDE\u63A5\u3002";
      });
    };
    const input = (label, props) => React.createElement("label", null, React.createElement("span", null, label), React.createElement("input", { ...props, disabled: Boolean(pending) || Boolean(bot?.enabled) }));
    return React.createElement(
      "div",
      { className: "mewclaw-account-section" },
      React.createElement("p", { className: "mewclaw-account-message", role: "status" }, bot ? STATE_LABELS[bot.state] : "\u5C1A\u672A\u914D\u7F6E\u4E2A\u4EBA\u673A\u5668\u4EBA"),
      React.createElement(
        "form",
        { key: bot?.revision ?? 0, className: "mewclaw-account-form mewclaw-bot-form", onSubmit: submit },
        input("App ID *", { name: "appId", defaultValue: bot?.appId ?? "", placeholder: "cli_\u2026", required: true, pattern: "cli_[0-9a-fA-F]{16}", maxLength: 20, autoComplete: "off" }),
        input(bot ? "App Secret\uFF08\u7559\u7A7A\u4FDD\u7559\uFF09" : "App Secret *", { name: "appSecret", type: "password", required: !bot, maxLength: 256, autoComplete: "new-password" }),
        React.createElement("label", null, React.createElement("span", null, "\u5E94\u7528\u533A\u57DF"), React.createElement("select", { name: "domain", defaultValue: bot?.domain ?? "https://open.feishu.cn", disabled: Boolean(pending) || Boolean(bot?.enabled) }, React.createElement("option", { value: "https://open.feishu.cn" }, "\u98DE\u4E66 \xB7 \u4E2D\u56FD"), React.createElement("option", { value: "https://open.larksuite.com" }, "Lark \xB7 \u56FD\u9645"))),
        React.createElement("label", { className: "mewclaw-account-field-wide" }, React.createElement("span", null, "\u5141\u8BB8\u4F7F\u7528\u7684 Open ID *"), React.createElement("textarea", { name: "openIds", defaultValue: bot?.authorizedOpenIds.join("\n") ?? "", rows: 3, required: true, maxLength: 14e3, placeholder: "ou_\u2026\uFF0C\u591A\u4E2A\u4EE5\u9017\u53F7\u6216\u6362\u884C\u5206\u9694", disabled: Boolean(pending) || Boolean(bot?.enabled) })),
        React.createElement("p", { className: "mewclaw-account-message mewclaw-account-field-wide" }, "\u4F7F\u7528\u6B64\u5E94\u7528\u4E0B\u7684 Open ID\u3002\u540D\u5355\u4E2D\u7684\u7528\u6237\u53EF\u4EE5\u8C03\u7528\u673A\u5668\u4EBA\uFF1B\u4EA7\u751F\u7684\u4F1A\u8BDD\u5F52\u5F53\u524D MewClaw \u8D26\u53F7\u7BA1\u7406\u3002App Secret \u52A0\u5BC6\u4FDD\u5B58\uFF0C\u4E0D\u4F1A\u518D\u6B21\u663E\u793A\u3002"),
        React.createElement(
          "div",
          { className: "mewclaw-account-form-actions" },
          React.createElement("button", { type: "submit", className: "mewclaw-account-button primary", disabled: Boolean(pending) || Boolean(bot?.enabled) }, pending === "\u4FDD\u5B58\u4E2D\u2026" ? pending : "\u4FDD\u5B58\u914D\u7F6E"),
          bot ? React.createElement("button", { type: "button", className: "mewclaw-account-button", disabled: Boolean(pending), onClick: () => {
            void execute("\u6821\u9A8C\u4E2D\u2026", async () => {
              const result = await mutateBot("/auth/feishu-bot/test", "POST", { expectedRevision: bot.revision });
              return `\u51ED\u8BC1\u6821\u9A8C\u901A\u8FC7\uFF1A${String(result.botName)}\u3002\u4ECD\u9700\u786E\u8BA4\u957F\u8FDE\u63A5\u548C\u6D88\u606F\u6743\u9650\u3002`;
            });
          } }, pending === "\u6821\u9A8C\u4E2D\u2026" ? pending : "\u6821\u9A8C\u51ED\u8BC1") : null,
          bot ? React.createElement("button", { type: "button", className: "mewclaw-account-button", disabled: Boolean(pending), onClick: () => {
            if (bot.enabled && !window.confirm("\u65AD\u5F00\u540E\u673A\u5668\u4EBA\u5C06\u505C\u6B62\u63A5\u6536\u65B0\u6D88\u606F\uFF0C\u5386\u53F2\u4F1A\u8BDD\u4FDD\u7559\u3002\u786E\u5B9A\u65AD\u5F00\u5417\uFF1F")) return;
            void execute("\u5904\u7406\u4E2D\u2026", async () => {
              await mutateBot("/auth/feishu-bot/connection", "POST", { expectedRevision: bot.revision, enabled: !bot.enabled });
              return bot.enabled ? "\u5DF2\u8BF7\u6C42\u65AD\u5F00\uFF0C\u7F51\u5173\u5C06\u5728\u4E0B\u4E00\u6B21\u540C\u6B65\u65F6\u5173\u95ED\u8FDE\u63A5\u3002" : "\u5DF2\u8BF7\u6C42\u8FDE\u63A5\uFF0C\u6B63\u5728\u7B49\u5F85\u7F51\u5173\u72B6\u6001\u3002";
            });
          } }, pending === "\u5904\u7406\u4E2D\u2026" ? pending : bot.enabled ? "\u65AD\u5F00\u673A\u5668\u4EBA" : "\u8FDE\u63A5\u673A\u5668\u4EBA") : null
        )
      ),
      message.text ? React.createElement("p", { className: "mewclaw-account-message", role: message.error ? "alert" : "status", "data-state": message.error ? "error" : "success" }, message.text) : null
    );
  }
  function BotConfiguration({ React }) {
    const [revision, setRevision] = React.useState(0);
    const state = useAccountBot(React, revision);
    return React.createElement(
      "section",
      { className: "mewclaw-account-section", "aria-label": "\u81EA\u5EFA\u5E94\u7528\u673A\u5668\u4EBA\u914D\u7F6E" },
      React.createElement("div", { className: "mewclaw-feishu-section-head" }, React.createElement("h3", { className: "mewclaw-account-subtitle" }, "\u81EA\u5EFA\u5E94\u7528\u673A\u5668\u4EBA"), React.createElement("button", { type: "button", className: "mewclaw-account-button", onClick: () => {
        setRevision(revision + 1);
      } }, "\u5237\u65B0\u72B6\u6001")),
      state.status === "loading" ? React.createElement("p", { role: "status" }, "\u6B63\u5728\u8BFB\u53D6\u914D\u7F6E\u2026") : state.status === "error" ? React.createElement("p", { role: "alert", className: "mewclaw-account-message", "data-state": "error" }, "\u8BFB\u53D6\u914D\u7F6E\u5931\u8D25\uFF0C\u8BF7\u5237\u65B0\u72B6\u6001\u91CD\u8BD5\u3002") : React.createElement(BotForm, { React, bot: state.data, refresh: () => {
        setRevision(revision + 1);
      } }),
      React.createElement(
        "details",
        { className: "mewclaw-account-fold" },
        React.createElement("summary", null, "\u98DE\u4E66\u5F00\u653E\u5E73\u53F0\u914D\u7F6E\u6B65\u9AA4"),
        React.createElement(
          "ol",
          { className: "mewclaw-bot-guide" },
          React.createElement("li", null, "\u521B\u5EFA\u4F01\u4E1A\u81EA\u5EFA\u5E94\u7528\uFF0C\u542F\u7528\u673A\u5668\u4EBA\u80FD\u529B\u3002"),
          React.createElement("li", null, "\u4E8B\u4EF6\u8BA2\u9605\u9009\u62E9\u957F\u8FDE\u63A5\uFF0C\u8BA2\u9605 im.message.receive_v1\uFF1B\u5982\u4F7F\u7528\u5361\u7247\u4EA4\u4E92\uFF0C\u542F\u7528 card.action.trigger \u56DE\u8C03\u3002"),
          React.createElement("li", null, "\u5F00\u901A\u8BFB\u53D6\u7528\u6237\u53D1\u7ED9\u673A\u5668\u4EBA\u7684\u6D88\u606F\u3001\u4EE5\u5E94\u7528\u8EAB\u4EFD\u53D1\u9001\u6D88\u606F\u6743\u9650\uFF1B\u9644\u4EF6\u9700\u8981\u76F8\u5E94\u8D44\u6E90\u6743\u9650\u3002"),
          React.createElement("li", null, "\u53D1\u5E03\u5E94\u7528\u7248\u672C\u5E76\u5C06\u4F7F\u7528\u8005\u7EB3\u5165\u53EF\u7528\u8303\u56F4\uFF0C\u4FDD\u5B58\u4EE5\u4E0A\u51ED\u8BC1\u548C\u6388\u6743\u540D\u5355\u540E\u8FDE\u63A5\u3002")
        )
      ),
      React.createElement("p", { className: "mewclaw-account-message" }, "\u673A\u5668\u4EBA\u7EDF\u4E00\u901A\u8FC7\u6B64\u9875\u9762\u7BA1\u7406\uFF1B\u65E7\u5E94\u7528\u9700\u5728\u6B64\u4FDD\u5B58\u5E76\u8FDE\u63A5\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u5BFC\u5165\u3002\u8BF7\u52FF\u628A\u540C\u4E00\u4E2A\u5E94\u7528\u91CD\u590D\u8FDE\u63A5\u5230\u5176\u4ED6\u7F51\u5173\u3002")
    );
  }

  // packages/lark/web-auth/src/client-feishu.ts
  function maskIdentity(subject) {
    return subject.length > 12 ? `${subject.slice(0, 6)}...${subject.slice(-4)}` : subject;
  }
  function IdentitySection({ React }) {
    const [revision, setRevision] = React.useState(0);
    const [pending, setPending] = React.useState("");
    const [message, setMessage] = React.useState({ text: "", error: false });
    const state = useIdentities(React, revision);
    const remove = async (identity) => {
      if (pending || !window.confirm("\u786E\u5B9A\u89E3\u7ED1\u5F53\u524D\u98DE\u4E66\u8EAB\u4EFD\u5417\uFF1F\u89E3\u7ED1\u4E0D\u4F1A\u5220\u9664\u804A\u5929\u8BB0\u5F55\u3002")) return;
      setPending(identity.subject);
      setMessage({ text: "", error: false });
      try {
        await unlinkIdentity(identity);
        setMessage({ text: "\u98DE\u4E66\u8EAB\u4EFD\u5DF2\u89E3\u7ED1\u3002", error: false });
        setRevision(revision + 1);
      } catch (cause) {
        const code = cause instanceof Error ? cause.message : "";
        setMessage({ text: code === "IDENTITY_LAST_LOGIN_METHOD" ? "\u8FD9\u662F\u5F53\u524D\u8D26\u53F7\u6700\u540E\u7684\u767B\u5F55\u65B9\u5F0F\uFF0C\u4E0D\u80FD\u89E3\u7ED1\u3002" : "\u89E3\u7ED1\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002", error: true });
      } finally {
        setPending("");
      }
    };
    return React.createElement(
      "section",
      { className: "mewclaw-account-section", "aria-label": "\u5F53\u524D\u8D26\u53F7\u7684\u98DE\u4E66\u8EAB\u4EFD" },
      React.createElement(
        "div",
        { className: "mewclaw-feishu-section-head" },
        React.createElement(
          "div",
          null,
          React.createElement("h3", { className: "mewclaw-account-subtitle" }, "\u5DF2\u7ED1\u5B9A\u8EAB\u4EFD"),
          React.createElement("p", { className: "mewclaw-account-message" }, "\u4EC5\u663E\u793A\u5F53\u524D\u767B\u5F55\u8D26\u53F7\u7684\u7ED1\u5B9A\u5173\u7CFB\u3002")
        ),
        React.createElement("button", { type: "button", className: "mewclaw-account-button", disabled: state.status === "loading" || Boolean(pending), onClick: () => {
          setRevision(revision + 1);
        } }, state.status === "loading" ? "\u5237\u65B0\u4E2D\u2026" : "\u5237\u65B0")
      ),
      state.status === "loading" ? React.createElement("p", { className: "mewclaw-account-message", role: "status" }, "\u6B63\u5728\u8BFB\u53D6\u98DE\u4E66\u8EAB\u4EFD\u2026") : null,
      state.status === "error" ? React.createElement("p", { className: "mewclaw-account-message", "data-state": "error", role: "alert" }, "\u8BFB\u53D6\u5931\u8D25\uFF0C\u8BF7\u70B9\u51FB\u5237\u65B0\u91CD\u8BD5\u3002") : null,
      state.status === "ready" ? state.data.length ? React.createElement("ul", { className: "mewclaw-identity-list" }, state.data.map((identity) => React.createElement(
        "li",
        { className: "mewclaw-identity-row", key: identity.subject },
        React.createElement(
          "div",
          { className: "mewclaw-account-row-copy" },
          React.createElement("strong", null, "\u98DE\u4E66\u8EAB\u4EFD"),
          React.createElement("span", null, maskIdentity(identity.subject))
        ),
        React.createElement("button", { type: "button", className: "mewclaw-account-button danger", disabled: Boolean(pending), onClick: () => {
          void remove(identity);
        } }, pending === identity.subject ? "\u89E3\u7ED1\u4E2D\u2026" : "\u89E3\u7ED1")
      ))) : React.createElement(
        "div",
        { className: "mewclaw-feishu-empty" },
        React.createElement("strong", null, "\u5C1A\u672A\u7ED1\u5B9A\u98DE\u4E66\u8EAB\u4EFD"),
        React.createElement("p", { className: "mewclaw-account-message" }, "\u8FDE\u63A5\u4E2A\u4EBA\u673A\u5668\u4EBA\u65E0\u9700\u7ED1\u5B9A\u767B\u5F55\u8EAB\u4EFD\uFF1B\u673A\u5668\u4EBA\u4F1A\u8BDD\u81EA\u52A8\u5F52\u5F53\u524D\u914D\u7F6E\u8D26\u53F7\u3002")
      ) : null,
      message.text ? React.createElement("p", { className: "mewclaw-account-message", role: "status", "aria-live": "polite", "data-state": message.error ? "error" : "success" }, message.text) : null
    );
  }
  function FeishuConnectionsSection(React) {
    return React.createElement(
      "div",
      { className: "mewclaw-account-center mewclaw-feishu-center" },
      React.createElement(
        "header",
        { className: "mewclaw-account-center-header" },
        React.createElement("h2", null, "\u98DE\u4E66\u8FDE\u63A5"),
        React.createElement("p", { className: "mewclaw-account-message" }, "\u8FDE\u63A5\u81EA\u5EFA\u5E94\u7528\u673A\u5668\u4EBA\uFF0C\u7BA1\u7406\u4F60\u7684\u98DE\u4E66\u8EAB\u4EFD\u3002")
      ),
      React.createElement(BotConfiguration, { React }),
      React.createElement(IdentitySection, { React }),
      React.createElement(
        "aside",
        { className: "mewclaw-feishu-note" },
        React.createElement("h3", { className: "mewclaw-account-subtitle" }, "\u8EAB\u4EFD\u4E0E\u673A\u5668\u4EBA\u7BA1\u7406\u6743"),
        React.createElement("p", { className: "mewclaw-account-message" }, "\u5386\u53F2\u767B\u5F55\u8EAB\u4EFD\u548C\u804A\u5929\u8BB0\u5F55\u4FDD\u7559\u3002\u673A\u5668\u4EBA\u7EDF\u4E00\u5728\u4E0A\u65B9\u4FDD\u5B58\u3001\u6821\u9A8C\u548C\u8FDE\u63A5\uFF0C\u914D\u7F6E\u53CA\u65B0\u4F1A\u8BDD\u4EC5\u5F52\u5F53\u524D\u8D26\u53F7\u7BA1\u7406\u3002"),
        React.createElement("a", { className: "mewclaw-account-link", href: "https://open.feishu.cn/app", target: "_blank", rel: "noopener noreferrer" }, "\u98DE\u4E66\u5F00\u653E\u5E73\u53F0 \u2197")
      )
    );
  }

  // packages/lark/web-auth/src/client-account.ts
  var AREAS = [
    { id: "usage", label: "\u7528\u91CF\u4E0E\u989D\u5EA6" },
    { id: "models", label: "\u6211\u7684\u6A21\u578B" },
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
    const mode = user.defaultMode === "full" ? "\u901A\u7528\u5DE5\u4F5C" : "\u65E5\u5E38\u52A9\u624B";
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
    const percent2 = quota.monthlyLimitUsd > 0 ? Math.min(100, Math.max(0, quota.usedUsd / quota.monthlyLimitUsd * 100)) : 0;
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
          { className: "mewclaw-account-usage-progress-track", role: "progressbar", "aria-label": "\u672C\u6708\u989D\u5EA6\u4F7F\u7528\u6BD4\u4F8B", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(percent2) },
          React.createElement("div", { className: "mewclaw-account-usage-progress-fill", style: { width: `${percent2}%` } })
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
      models.length ? React.createElement(
        "details",
        { className: "mewclaw-account-model-detail" },
        React.createElement("summary", null, "\u6309\u6A21\u578B\u67E5\u770B\u660E\u7EC6", React.createElement("span", null, `${models.length} \u4E2A\u6A21\u578B`)),
        React.createElement("ul", { className: "mewclaw-account-models" }, models.map((model) => React.createElement(
          "li",
          { className: "mewclaw-account-model-row", key: `${model.provider}:${model.model}` },
          React.createElement("div", { className: "mewclaw-account-row-copy" }, React.createElement("strong", null, model.model), React.createElement("span", null, model.provider)),
          React.createElement("span", { className: "mewclaw-account-row-meta" }, `${formatCount(model.calls)} \u6B21`),
          React.createElement("span", null, formatUsd(model.totalUsd))
        )))
      ) : emptyState(React, "\u672C\u5468\u671F\u6682\u65E0\u6A21\u578B\u8C03\u7528")
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
    if (area === "security") return React.createElement(PasswordSection, { React });
    return React.createElement(AdminSection, { React });
  }
  function areaMeta(area) {
    if (area === "usage") return "\u672C\u6708";
    if (area === "models") return "\u4E2A\u4EBA\u914D\u7F6E";
    if (area === "security") return "\u5BC6\u7801";
    return "\u7BA1\u7406\u5458";
  }
  function AccountFold(React, entry) {
    return React.createElement(
      "details",
      { key: entry.id, className: "mewclaw-account-fold", open: entry.id === "usage" },
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
      React.createElement(
        "header",
        { className: "mewclaw-account-center-header" },
        React.createElement("h2", null, "\u8D26\u6237\u4E2D\u5FC3"),
        React.createElement("p", { className: "mewclaw-account-message" }, "\u67E5\u770B\u8D26\u6237\u7528\u91CF\uFF0C\u7BA1\u7406\u4E2A\u4EBA\u6A21\u578B\u4E0E\u767B\u5F55\u5B89\u5168\u3002")
      ),
      React.createElement(AccountOverview, { React, user: state.data }),
      React.createElement("div", { className: "mewclaw-account-folds" }, areas.map((entry) => AccountFold(React, entry)))
    );
  }
  function AccountCenterSection(React) {
    return renderAccount(React, useAccountUser(React));
  }

  // packages/lark/web-auth/src/client-styles.ts
  var ACCOUNT_STYLES = `
.mewclaw-bot-form select,.mewclaw-bot-form textarea{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}
.mewclaw-bot-form textarea{resize:vertical;min-height:84px}
.mewclaw-bot-form .mewclaw-account-field-wide{grid-column:1/-1}
.mewclaw-bot-form select:focus-visible,.mewclaw-bot-form textarea:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.mewclaw-bot-form :disabled{opacity:.6}
.mewclaw-bot-guide{padding:0 20px 16px;margin:0;display:grid;gap:10px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.mewclaw-network-status{position:fixed;z-index:2147483000;top:12px;left:50%;display:flex;max-width:min(520px,calc(100vw - 32px));min-height:34px;box-sizing:border-box;align-items:center;padding:7px 12px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:8px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 24px rgba(0,0,0,.14);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;transform:translateX(-50%)}
.mewclaw-network-status[hidden]{display:none}
.mewclaw-settings-trigger{display:flex;align-items:center;gap:9px;min-width:0;color:inherit}
.mewclaw-account-avatar{display:grid;width:28px;height:28px;flex:0 0 28px;place-items:center;border-radius:50%;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-size:12px;font-weight:600}
.mewclaw-account-avatar-large{width:44px;height:44px;flex-basis:44px;font-size:16px}
.mewclaw-account-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px}
.mewclaw-account-center{box-sizing:border-box;display:flex;flex-direction:column;gap:18px;width:100%;min-width:0;padding:2px 0 14px;color:var(--dsw-alias-label-primary)}
.mewclaw-account-center-header{display:grid;gap:6px}
.mewclaw-account-subtitle{margin:0;font-size:14px;font-weight:600;line-height:22px}
.mewclaw-feishu-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.mewclaw-feishu-section-head>div{display:grid;min-width:0;gap:4px}
.mewclaw-feishu-empty{display:grid;gap:8px;padding:20px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.mewclaw-feishu-empty strong{font-size:14px;font-weight:500}
.mewclaw-feishu-note{display:grid;gap:8px;padding:16px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.mewclaw-feishu-center .mewclaw-account-message{line-height:1.65;overflow-wrap:anywhere}
.mewclaw-account-fold>summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:6px}
.mewclaw-account-model-detail>summary::after{content:"+";font-size:16px}
.mewclaw-account-model-detail[open]>summary::after{content:"\u2212"}
.mewclaw-account-model-detail>summary span{margin-left:auto}
.mewclaw-feishu-guide{display:grid;gap:10px;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.mewclaw-feishu-guide ol{display:grid;gap:10px;margin:0;padding-left:20px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:22px}
.mewclaw-feishu-guide code{padding:2px 5px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.mewclaw-account-model-detail{border-top:1px solid var(--dsw-alias-border-l1)}
.mewclaw-account-model-detail>summary{display:flex;justify-content:space-between;gap:12px;padding:12px 0;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary)}
.mewclaw-account-model-detail>summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.mewclaw-account-model-detail>summary span{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.mewclaw-account-model-detail>.mewclaw-account-models{border-top:0}
.mewclaw-account-center-header h2{margin:0;font-size:18px;line-height:26px;font-weight:600}
.mewclaw-account-profile{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:12px;min-width:0;padding:4px 0 8px}
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
.mewclaw-account-facts dt{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}
.mewclaw-account-facts dd{margin:3px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px}
.mewclaw-account-message{min-height:18px;margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.mewclaw-account-message[data-state="error"]{color:var(--dsw-alias-state-error-primary)}
.mewclaw-account-message[data-state="success"]{color:var(--dsw-alias-state-success-primary)}
.mewclaw-account-folds{display:flex;flex-direction:column;width:100%;border-bottom:1px solid var(--dsw-alias-border-l2)}
.mewclaw-account-fold{border-top:1px solid var(--dsw-alias-border-l2)}
.mewclaw-account-fold>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:50px;padding:9px 2px;color:var(--dsw-alias-label-primary);list-style:none;cursor:pointer}
.mewclaw-account-fold>summary::-webkit-details-marker{display:none}
.mewclaw-account-fold>summary::after{content:"+";color:var(--dsw-alias-label-tertiary);font-size:18px;line-height:20px}
.mewclaw-account-fold[open]>summary::after{content:"-"}
.mewclaw-account-fold>summary:hover{color:var(--dsw-alias-state-business-primary)}
.mewclaw-account-fold-title{display:flex;align-items:center;gap:8px;font-size:14px;line-height:21px;font-weight:500}
.mewclaw-account-fold-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400}
.mewclaw-account-fold-content{padding:2px 2px 16px}
.mewclaw-account-section{box-sizing:border-box;display:flex;flex-direction:column;gap:16px;width:100%;color:var(--dsw-alias-label-primary)}
.mewclaw-account-form{box-sizing:border-box;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));width:100%;max-width:560px;gap:12px}
.mewclaw-account-form label{display:grid;min-width:0;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.mewclaw-account-form label:first-child{grid-column:1/-1}
.mewclaw-account-form input{box-sizing:border-box;width:100%;min-width:0;height:38px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}
.mewclaw-account-form input:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent)}
.mewclaw-account-form-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px;grid-column:1/-1}
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
.mewclaw-account-model-profile-badge{display:inline-flex;align-items:center;min-height:20px;padding:0 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap}
.mewclaw-account-model-profile-badge.primary{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 40%,var(--dsw-alias-border-l2));color:var(--dsw-alias-state-business-primary)}
.mewclaw-account-model-profile-actions{display:flex;grid-column:1/-1;flex-wrap:wrap;align-items:center;gap:8px}
.mewclaw-account-model-profile-actions .mewclaw-account-button{min-height:30px;padding:0 10px;font-size:12px}
.mewclaw-account-empty{display:grid;justify-items:start;gap:6px;padding:12px 0;color:var(--dsw-alias-label-secondary);font-size:12px}
.mewclaw-account-empty strong{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}
.mewclaw-account-usage-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.mewclaw-account-usage-stat{display:grid;gap:3px;min-width:0;margin:0;padding:11px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.mewclaw-account-usage-stat dt{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}
.mewclaw-account-usage-stat dd{margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:16px;line-height:23px;font-variant-numeric:tabular-nums}
.mewclaw-account-usage-progress{display:grid;gap:7px}
.mewclaw-account-usage-progress-head{display:flex;justify-content:space-between;gap:12px;font-size:12px;line-height:18px}
.mewclaw-account-usage-progress-head span:last-child{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.mewclaw-account-usage-progress-track{height:6px;overflow:hidden;border-radius:3px;background:var(--dsw-alias-interactive-bg-hover)}
.mewclaw-account-usage-progress-fill{height:100%;border-radius:inherit;background:var(--dsw-alias-state-business-primary)}
.mewclaw-account-token-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:0;border-top:1px solid var(--dsw-alias-border-l1)}
.mewclaw-account-token-grid>div{min-width:0;padding:10px 8px 4px;overflow-wrap:anywhere}
.mewclaw-account-token-grid dt{color:var(--dsw-alias-label-tertiary);font-size:12px}
.mewclaw-account-token-grid dd{margin:3px 0 0;font-size:13px;font-variant-numeric:tabular-nums}
.mewclaw-account-models,.mewclaw-account-admin-list,.mewclaw-identity-list{display:flex;flex-direction:column;margin:0;padding:0;list-style:none;border-top:1px solid var(--dsw-alias-border-l1)}
.mewclaw-account-model-row,.mewclaw-account-admin-row,.mewclaw-identity-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:14px;padding:11px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.mewclaw-account-model-row:last-child,.mewclaw-account-admin-row:last-child,.mewclaw-identity-row:last-child{border-bottom:0}
.mewclaw-account-row-copy{display:flex;flex-direction:column;min-width:0;gap:2px}
.mewclaw-account-row-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;font-weight:500}
.mewclaw-account-row-copy span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}
.mewclaw-account-row-meta{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;text-align:right}
.mewclaw-account-model-row{grid-template-columns:minmax(0,1fr) auto auto}
.mewclaw-account-link{display:inline-flex;width:fit-content;max-width:100%;overflow-wrap:anywhere;align-items:center;color:var(--dsw-alias-state-business-primary);font-size:13px;text-decoration:none}
.mewclaw-account-link:hover{text-decoration:underline}
@media(max-width:720px){div:has(>div>div>div>.mewclaw-account-center){flex-direction:column}div:has(>div>div>div>.mewclaw-account-center)>nav{box-sizing:border-box;width:100%;height:auto;gap:10px;padding:18px 16px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}div:has(>div>div>div>.mewclaw-account-center)>nav>div:first-child{width:auto;padding:0 8px}div:has(>div>div>div>.mewclaw-account-center)>nav>div:last-child{box-sizing:border-box;flex-direction:row;width:100%;height:auto;overflow-x:auto;gap:4px;padding-bottom:6px;scrollbar-width:none;overscroll-behavior-x:contain}div:has(>div>div>div>.mewclaw-account-center)>nav>div:last-child::-webkit-scrollbar{display:none}div:has(>div>div>div>.mewclaw-account-center)>nav>div:last-child>button{width:auto;min-width:max-content;flex:0 0 auto;white-space:nowrap}div:has(>div>div>div>.mewclaw-account-center)>nav+div{width:100%;height:auto;min-height:0;flex:1 1 auto}}
@media(max-width:720px){.mewclaw-account-profile{grid-template-columns:auto minmax(0,1fr)}.mewclaw-account-session-buttons{grid-column:1/-1;justify-content:flex-start}.mewclaw-account-usage-grid,.mewclaw-account-token-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.mewclaw-account-admin-row{grid-template-columns:1fr}.mewclaw-account-row-meta{justify-content:flex-start;text-align:left}.mewclaw-account-model-profile-row{grid-template-columns:1fr}.mewclaw-account-model-profile-badges{justify-content:flex-start}}
@media(max-width:480px){.mewclaw-account-facts,.mewclaw-account-form{grid-template-columns:1fr}.mewclaw-account-facts>div+div{border-top:1px solid var(--dsw-alias-border-l1);border-left:0}.mewclaw-account-form label:first-child,.mewclaw-account-form-actions,.mewclaw-account-model-form .mewclaw-account-field-wide{grid-column:auto}.mewclaw-account-usage-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.mewclaw-account-model-row{grid-template-columns:minmax(0,1fr) auto}.mewclaw-account-model-row .mewclaw-account-row-meta{grid-column:1/-1}.mewclaw-account-model-profile-toolbar{align-items:flex-start;flex-direction:column}}
@media(pointer:coarse){.mewclaw-account-button,.mewclaw-account-model-profile-actions .mewclaw-account-button{min-height:44px}.mewclaw-account-form input{height:44px;font-size:16px}}
`;
  function installAccountStyles() {
    if (typeof document === "undefined" || document.querySelector("style[data-mewclaw-account]") !== null) return;
    const style = document.createElement("style");
    style.dataset.mewclawAccount = "";
    style.textContent = ACCOUNT_STYLES;
    document.head.appendChild(style);
  }

  // node_modules/@deepseek-ai/cosmokit/lib/index.js
  function isNullable(value) {
    return value === null || value === void 0;
  }
  function isPlainObject(data) {
    return data && typeof data === "object" && !Array.isArray(data);
  }
  function filterKeys(object, filter) {
    return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
  }
  function mapValues(object, transform) {
    return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
  }
  function pick(source, keys, forced) {
    if (!keys) return { ...source };
    const result = {};
    for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
    return result;
  }
  function is(type, value) {
    if (arguments.length === 1) return (value2) => is(type, value2);
    return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
  }
  function isArrayBufferLike(value) {
    return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
  }
  function isArrayBufferSource(value) {
    return isArrayBufferLike(value) || ArrayBuffer.isView(value);
  }
  var Binary;
  (function(Binary2) {
    Binary2.is = isArrayBufferLike;
    Binary2.isSource = isArrayBufferSource;
    function fromSource(source) {
      if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
      else return source;
    }
    Binary2.fromSource = fromSource;
    function toBase64(source) {
      source = fromSource(source);
      if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
      let binary = "";
      const bytes = new Uint8Array(source);
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    }
    Binary2.toBase64 = toBase64;
    function fromBase64(source) {
      if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
      return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
    }
    Binary2.fromBase64 = fromBase64;
    function toHex(source) {
      source = fromSource(source);
      if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
      return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    Binary2.toHex = toHex;
    function fromHex(source) {
      if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
      const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
      const buffer = [];
      for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
      return Uint8Array.from(buffer).buffer;
    }
    Binary2.fromHex = fromHex;
  })(Binary || (Binary = {}));
  var base64ToArrayBuffer = Binary.fromBase64;
  var arrayBufferToBase64 = Binary.toBase64;
  var hexToArrayBuffer = Binary.fromHex;
  var arrayBufferToHex = Binary.toHex;
  function clone(source, refs = /* @__PURE__ */ new Map()) {
    if (!source || typeof source !== "object") return source;
    if (is("Date", source)) return new Date(source.valueOf());
    if (is("RegExp", source)) return new RegExp(source.source, source.flags);
    if (isArrayBufferLike(source)) return source.slice(0);
    if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    const cached = refs.get(source);
    if (cached) return cached;
    if (Array.isArray(source)) {
      const result2 = [];
      refs.set(source, result2);
      source.forEach((value, index) => {
        result2[index] = Reflect.apply(clone, null, [value, refs]);
      });
      return result2;
    }
    const result = Object.create(Object.getPrototypeOf(source));
    refs.set(source, result);
    for (const key of Reflect.ownKeys(source)) {
      const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
      if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
      Reflect.defineProperty(result, key, descriptor);
    }
    return result;
  }
  function deepEqual(a, b, strict) {
    if (a === b) return true;
    if (!strict && isNullable(a) && isNullable(b)) return true;
    if (typeof a !== typeof b) return false;
    if (typeof a !== "object") return false;
    if (!a || !b) return false;
    function check(test, then) {
      return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
    }
    return check(Array.isArray, (a2, b2) => a2.length === b2.length && a2.every((item, index) => deepEqual(item, b2[index]))) ?? check(is("Date"), (a2, b2) => a2.valueOf() === b2.valueOf()) ?? check(is("RegExp"), (a2, b2) => a2.source === b2.source && a2.flags === b2.flags) ?? check(isArrayBufferLike, (a2, b2) => {
      if (a2.byteLength !== b2.byteLength) return false;
      const viewA = new Uint8Array(a2);
      const viewB = new Uint8Array(b2);
      for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
      return true;
    }) ?? Object.keys({
      ...a,
      ...b
    }).every((key) => deepEqual(a[key], b[key], strict));
  }
  var Time;
  (function(Time2) {
    Time2.millisecond = 1;
    Time2.second = 1e3;
    Time2.minute = Time2.second * 60;
    Time2.hour = Time2.minute * 60;
    Time2.day = Time2.hour * 24;
    Time2.week = Time2.day * 7;
    let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
    function setTimezoneOffset(offset) {
      timezoneOffset = offset;
    }
    Time2.setTimezoneOffset = setTimezoneOffset;
    function getTimezoneOffset() {
      return timezoneOffset;
    }
    Time2.getTimezoneOffset = getTimezoneOffset;
    function getDateNumber(date2 = /* @__PURE__ */ new Date(), offset) {
      if (typeof date2 === "number") date2 = new Date(date2);
      if (offset === void 0) offset = timezoneOffset;
      return Math.floor((date2.valueOf() / Time2.minute - offset) / 1440);
    }
    Time2.getDateNumber = getDateNumber;
    function fromDateNumber(value, offset) {
      const date2 = new Date(value * Time2.day);
      if (offset === void 0) offset = timezoneOffset;
      return new Date(+date2 + offset * Time2.minute);
    }
    Time2.fromDateNumber = fromDateNumber;
    const numeric = /\d+(?:\.\d+)?/.source;
    const timeRegExp = new RegExp(`^${[
      "w(?:eek(?:s)?)?",
      "d(?:ay(?:s)?)?",
      "h(?:our(?:s)?)?",
      "m(?:in(?:ute)?(?:s)?)?",
      "s(?:ec(?:ond)?(?:s)?)?"
    ].map((unit) => `(${numeric}${unit})?`).join("")}$`);
    function parseTime(source) {
      const capture = timeRegExp.exec(source);
      if (!capture) return 0;
      return (parseFloat(capture[1]) * Time2.week || 0) + (parseFloat(capture[2]) * Time2.day || 0) + (parseFloat(capture[3]) * Time2.hour || 0) + (parseFloat(capture[4]) * Time2.minute || 0) + (parseFloat(capture[5]) * Time2.second || 0);
    }
    Time2.parseTime = parseTime;
    function parseDate(date2) {
      const parsed = parseTime(date2);
      if (parsed) date2 = Date.now() + parsed;
      else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date2)) date2 = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date2}`;
      else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date2)) date2 = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date2}`;
      return date2 ? new Date(date2) : /* @__PURE__ */ new Date();
    }
    Time2.parseDate = parseDate;
    function format(ms) {
      const abs = Math.abs(ms);
      if (abs >= Time2.day - Time2.hour / 2) return Math.round(ms / Time2.day) + "d";
      else if (abs >= Time2.hour - Time2.minute / 2) return Math.round(ms / Time2.hour) + "h";
      else if (abs >= Time2.minute - Time2.second / 2) return Math.round(ms / Time2.minute) + "m";
      else if (abs >= Time2.second) return Math.round(ms / Time2.second) + "s";
      return ms + "ms";
    }
    Time2.format = format;
    function toDigits(source, length = 2) {
      return source.toString().padStart(length, "0");
    }
    Time2.toDigits = toDigits;
    function template(template2, time = /* @__PURE__ */ new Date()) {
      return template2.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
    }
    Time2.template = template;
  })(Time || (Time = {}));

  // node_modules/@deepseek-ai/schemastery/lib/index.mjs
  var kSchema = /* @__PURE__ */ Symbol.for("schemastery");
  var kValidationError = /* @__PURE__ */ Symbol.for("ValidationError");
  globalThis.__schemastery_index__ ??= 0;
  globalThis.__schemastery_refs__ = void 0;
  var ValidationError = class extends TypeError {
    options;
    name = "ValidationError";
    constructor(message, options) {
      let prefix = "$";
      for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
      else if (typeof segment === "number") prefix += "[" + segment + "]";
      else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
      if (prefix.startsWith(".")) prefix = prefix.slice(1);
      super((prefix === "$" ? "" : `${prefix} `) + message);
      this.options = options;
    }
    static is(error) {
      return !!error?.[kValidationError];
    }
  };
  Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
  var Schema = function(options) {
    const schema = function(data, options2 = {}) {
      return Schema.resolve(data, schema, options2)[0];
    };
    if (options.refs) {
      const refs = mapValues(options.refs, (options2) => new Schema(options2));
      const getRef = (uid) => refs[uid];
      for (const key in refs) {
        const options2 = refs[key];
        options2.sKey = getRef(options2.sKey);
        options2.inner = getRef(options2.inner);
        options2.list = options2.list && options2.list.map(getRef);
        options2.dict = options2.dict && mapValues(options2.dict, getRef);
      }
      return refs[options.uid];
    }
    Object.assign(schema, options);
    if (typeof schema.callback === "string") try {
      schema.callback = new Function("return " + schema.callback)();
    } catch {
    }
    Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
    Object.setPrototypeOf(schema, Schema.prototype);
    schema.meta ||= {};
    schema.toString = schema.toString.bind(schema);
    return schema;
  };
  Schema.prototype = Object.create(Function.prototype);
  Schema.prototype[kSchema] = true;
  Object.defineProperty(Schema.prototype, "~standard", { get() {
    return {
      version: 1,
      vendor: "schemastery",
      validate: (value) => {
        try {
          return { value: Schema.resolve(value, this, {})[0] };
        } catch (error) {
          if (ValidationError.is(error)) return { issues: [{
            message: error.message,
            path: error.options.path
          }] };
          throw error;
        }
      }
    };
  } });
  Schema.ValidationError = ValidationError;
  Schema.prototype.toJSON = function toJSON() {
    if (globalThis.__schemastery_refs__) {
      globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
      return this.uid;
    }
    globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
    globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
    const result = {
      uid: this.uid,
      refs: globalThis.__schemastery_refs__
    };
    globalThis.__schemastery_refs__ = void 0;
    return result;
  };
  Schema.prototype.set = function set(key, value) {
    this.dict[key] = value;
    return this;
  };
  Schema.prototype.push = function push(value) {
    this.list.push(value);
    return this;
  };
  function mergeDesc(original, messages) {
    const result = typeof original === "string" ? { "": original } : { ...original };
    for (const locale in messages) {
      const value = messages[locale];
      if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
      else if (typeof value === "string") result[locale] = value;
    }
    return result;
  }
  function getInner(value) {
    return value?.$value ?? value?.$inner;
  }
  function extractKeys(data) {
    return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
  }
  Schema.prototype.i18n = function i18n(messages) {
    const schema = Schema(this);
    const desc = mergeDesc(schema.meta.description, messages);
    if (Object.keys(desc).length) schema.meta.description = desc;
    if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
      return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
    });
    if (schema.list) schema.list = schema.list.map((inner, index) => {
      return inner.i18n(mapValues(messages, (data = {}) => {
        if (Array.isArray(getInner(data))) return getInner(data)[index];
        if (Array.isArray(data)) return data[index];
        return extractKeys(data);
      }));
    });
    if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
      if (getInner(data)) return getInner(data);
      return extractKeys(data);
    }));
    if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
    return schema;
  };
  Schema.prototype.extra = function extra(key, value) {
    const schema = Schema(this);
    schema.meta = {
      ...schema.meta,
      [key]: value
    };
    return schema;
  };
  for (const key of [
    "required",
    "disabled",
    "collapse",
    "hidden",
    "loose"
  ]) Object.assign(Schema.prototype, { [key](value = true) {
    const schema = Schema(this);
    schema.meta = {
      ...schema.meta,
      [key]: value
    };
    return schema;
  } });
  Schema.prototype.deprecated = function deprecated() {
    const schema = Schema(this);
    schema.meta.badges ||= [];
    schema.meta.badges.push({
      text: "deprecated",
      type: "danger"
    });
    return schema;
  };
  Schema.prototype.experimental = function experimental() {
    const schema = Schema(this);
    schema.meta.badges ||= [];
    schema.meta.badges.push({
      text: "experimental",
      type: "warning"
    });
    return schema;
  };
  Schema.prototype.pattern = function pattern(regexp) {
    const schema = Schema(this);
    const pattern2 = pick(regexp, ["source", "flags"]);
    schema.meta = {
      ...schema.meta,
      pattern: pattern2
    };
    return schema;
  };
  Schema.prototype.simplify = function simplify(value) {
    if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
    if (isNullable(value)) return value;
    if (this.type === "object" || this.type === "dict") {
      const result = {};
      for (const key in value) {
        const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
        if (this.type === "dict" || !isNullable(item)) result[key] = item;
      }
      if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
      return result;
    } else if (this.type === "array" || this.type === "tuple") {
      const result = [];
      value.forEach((value2, index) => {
        const schema = this.type === "array" ? this.inner : this.list[index];
        const item = schema ? schema.simplify(value2) : value2;
        result.push(item);
      });
      return result;
    } else if (this.type === "intersect") {
      const result = {};
      for (const item of this.list) Object.assign(result, item.simplify(value));
      return result;
    } else if (this.type === "union") for (const schema of this.list) try {
      Schema.resolve(value, schema, {});
      return schema.simplify(value);
    } catch {
    }
    return value;
  };
  Schema.prototype.toString = function toString(inline) {
    return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
  };
  Schema.prototype.role = function role(role, extra2) {
    const schema = Schema(this);
    schema.meta = {
      ...schema.meta,
      role,
      extra: extra2
    };
    return schema;
  };
  for (const key of [
    "default",
    "link",
    "comment",
    "description",
    "max",
    "min",
    "step"
  ]) Object.assign(Schema.prototype, { [key](value) {
    const schema = Schema(this);
    schema.meta = {
      ...schema.meta,
      [key]: value
    };
    return schema;
  } });
  var resolvers = {};
  Schema.extend = function extend(type, resolve2) {
    resolvers[type] = resolve2;
  };
  Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
    if (!schema) return [data];
    if (options.ignore?.(data, schema)) return [data];
    if (isNullable(data) && schema.type !== "lazy") {
      if (schema.meta.required) throw new ValidationError(`missing required value`, options);
      let current = schema;
      let fallback = schema.meta.default;
      while (current?.type === "intersect" && isNullable(fallback)) {
        current = current.list[0];
        fallback = current?.meta.default;
      }
      if (isNullable(fallback)) return [data];
      data = clone(fallback);
    }
    const callback = resolvers[schema.type];
    if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
    try {
      return callback(data, schema, options, strict);
    } catch (error) {
      if (!schema.meta.loose) throw error;
      return [schema.meta.default];
    }
  };
  Schema.from = function from(source) {
    if (isNullable(source)) return Schema.any();
    else if ([
      "string",
      "number",
      "boolean"
    ].includes(typeof source)) return Schema.const(source).required();
    else if (source[kSchema]) return source;
    else if (typeof source === "function") switch (source) {
      case String:
        return Schema.string().required();
      case Number:
        return Schema.number().required();
      case Boolean:
        return Schema.boolean().required();
      case Function:
        return Schema.function().required();
      default:
        return Schema.is(source).required();
    }
    else throw new TypeError(`cannot infer schema from ${source}`);
  };
  Schema.lazy = function lazy(builder) {
    const toJSON2 = () => {
      if (!schema.inner[kSchema]) {
        schema.inner = schema.builder();
        schema.inner.meta = {
          ...schema.meta,
          ...schema.inner.meta
        };
      }
      return schema.inner.toJSON();
    };
    const schema = new Schema({
      type: "lazy",
      builder,
      inner: { toJSON: toJSON2 }
    });
    return schema;
  };
  Schema.natural = function natural() {
    return Schema.number().step(1).min(0);
  };
  Schema.percent = function percent() {
    return Schema.number().step(0.01).min(0).max(1).role("slider");
  };
  Schema.date = function date() {
    return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
      const date2 = new Date(value);
      if (isNaN(+date2)) throw new ValidationError(`invalid date "${value}"`, options);
      return date2;
    }, true)]);
  };
  Schema.regExp = function regExp(flag = "") {
    return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
      try {
        return new RegExp(value, flag);
      } catch (e) {
        throw new ValidationError(e.message, options);
      }
    }, true)]);
  };
  Schema.arrayBuffer = function arrayBuffer(encoding) {
    return Schema.union([
      Schema.is(ArrayBuffer),
      Schema.is(SharedArrayBuffer),
      Schema.transform(Schema.any(), (value, options) => {
        if (Binary.isSource(value)) return Binary.fromSource(value);
        throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
      }, true),
      ...encoding ? [Schema.transform(Schema.string(), (value, options) => {
        try {
          return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
        } catch (e) {
          throw new ValidationError(e.message, options);
        }
      }, true)] : []
    ]);
  };
  Schema.extend("lazy", (data, schema, options, strict) => {
    if (!schema.inner[kSchema]) {
      schema.inner = schema.builder();
      schema.inner.meta = {
        ...schema.meta,
        ...schema.inner.meta
      };
    }
    return Schema.resolve(data, schema.inner, options, strict);
  });
  Schema.extend("any", (data) => {
    return [data];
  });
  Schema.extend("never", (data, _, options) => {
    throw new ValidationError(`expected nullable but got ${data}`, options);
  });
  Schema.extend("const", (data, { value }, options) => {
    if (deepEqual(data, value)) return [value];
    throw new ValidationError(`expected ${value} but got ${data}`, options);
  });
  function checkWithinRange(data, meta, description, options, skipMin = false) {
    const { max = Infinity, min = -Infinity } = meta;
    if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
    if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
  }
  Schema.extend("string", (data, { meta }, options) => {
    if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
    if (meta.pattern) {
      const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
      if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
    }
    checkWithinRange(data.length, meta, "string length", options);
    return [data];
  });
  function decimalShift(data, digits) {
    const str = data.toString();
    if (str.includes("e")) return data * Math.pow(10, digits);
    const index = str.indexOf(".");
    if (index === -1) return data * Math.pow(10, digits);
    const frac = str.slice(index + 1);
    const integer = str.slice(0, index);
    if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
    return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
  }
  function isMultipleOf(data, min, step) {
    step = Math.abs(step);
    if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
    const index = step.toString().indexOf(".");
    const digits = step.toString().slice(index + 1).length;
    return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
  }
  Schema.extend("number", (data, { meta }, options) => {
    if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
    checkWithinRange(data, meta, "number", options);
    const { step } = meta;
    if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
    return [data];
  });
  Schema.extend("boolean", (data, _, options) => {
    if (typeof data === "boolean") return [data];
    throw new ValidationError(`expected boolean but got ${data}`, options);
  });
  Schema.extend("bitset", (data, { bits, meta }, options) => {
    let value = 0, keys = [];
    if (typeof data === "number") {
      value = data;
      for (const key in bits) if (data & bits[key]) keys.push(key);
    } else if (Array.isArray(data)) {
      keys = data;
      for (const key of keys) {
        if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
        if (key in bits) value |= bits[key];
      }
    } else throw new ValidationError(`expected number or array but got ${data}`, options);
    if (value === meta.default) return [value];
    return [value, keys];
  });
  Schema.extend("function", (data, _, options) => {
    if (typeof data === "function") return [data];
    throw new ValidationError(`expected function but got ${data}`, options);
  });
  Schema.extend("is", (data, { constructor }, options) => {
    if (typeof constructor === "function") {
      if (data instanceof constructor) return [data];
      throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
    } else {
      if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
      let prototype = Object.getPrototypeOf(data);
      while (prototype) {
        if (prototype.constructor?.name === constructor) return [data];
        prototype = Object.getPrototypeOf(prototype);
      }
      throw new ValidationError(`expected ${constructor} but got ${data}`, options);
    }
  });
  function property(data, key, schema, options) {
    try {
      const [value, adapted] = Schema.resolve(data[key], schema, {
        ...options,
        path: [...options.path || [], key]
      });
      if (adapted !== void 0) data[key] = adapted;
      return value;
    } catch (e) {
      if (!options?.autofix) throw e;
      delete data[key];
      return schema.meta.default;
    }
  }
  Schema.extend("array", (data, { inner, meta }, options) => {
    if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
    checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
    return [data.map((_, index) => property(data, index, inner, options))];
  });
  Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
    if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
    const result = {};
    for (const key in data) {
      let rKey;
      try {
        rKey = Schema.resolve(key, sKey, options)[0];
      } catch (error) {
        if (strict) continue;
        throw error;
      }
      result[rKey] = property(data, key, inner, options);
      data[rKey] = data[key];
      if (key !== rKey) delete data[key];
    }
    return [result];
  });
  Schema.extend("tuple", (data, { list }, options, strict) => {
    if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
    const result = list.map((inner, index) => property(data, index, inner, options));
    if (strict) return [result];
    result.push(...data.slice(list.length));
    return [result];
  });
  function merge(result, data) {
    for (const key in data) {
      if (key in result) continue;
      result[key] = data[key];
    }
  }
  Schema.extend("object", (data, { dict }, options, strict) => {
    if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
    const result = {};
    for (const key in dict) {
      const value = property(data, key, dict[key], options);
      if (!isNullable(value) || key in data) result[key] = value;
    }
    if (!strict) merge(result, data);
    return [result];
  });
  Schema.extend("union", (data, { list, toString: toString2 }, options, strict) => {
    const messages = [];
    for (const inner of list) try {
      return Schema.resolve(data, inner, options, strict);
    } catch (error) {
      messages.push(error);
    }
    throw new ValidationError(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
  });
  Schema.extend("intersect", (data, { list, toString: toString2 }, options, strict) => {
    if (!list.length) return [data];
    let result;
    for (const inner of list) {
      const value = Schema.resolve(data, inner, options, true)[0];
      if (isNullable(value)) continue;
      if (isNullable(result)) result = value;
      else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
      else if (typeof value === "object") merge(result ??= {}, value);
      else if (result !== value) throw new ValidationError(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
    }
    if (!strict && isPlainObject(data)) merge(result, data);
    return [result];
  });
  Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
    const [result, adapted = data] = Schema.resolve(data, inner, options, true);
    if (preserve) return [callback(result)];
    else return [callback(result), callback(adapted)];
  });
  var formatters = {};
  function defineMethod(name, keys, format) {
    formatters[name] = format;
    Object.assign(Schema, { [name](...args) {
      const schema = new Schema({ type: name });
      keys.forEach((key, index) => {
        switch (key) {
          case "sKey":
            schema.sKey = args[index] ?? Schema.string();
            break;
          case "inner":
            schema.inner = Schema.from(args[index]);
            break;
          case "list":
            schema.list = args[index].map(Schema.from);
            break;
          case "dict":
            schema.dict = mapValues(args[index], Schema.from);
            break;
          case "bits":
            schema.bits = {};
            for (const key2 in args[index]) {
              if (typeof args[index][key2] !== "number") continue;
              schema.bits[key2] = args[index][key2];
            }
            break;
          case "callback": {
            const callback = schema.callback = args[index];
            callback["toJSON"] ||= () => callback.toString();
            break;
          }
          case "constructor": {
            const constructor = schema.constructor = args[index];
            if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
            break;
          }
          default:
            schema[key] = args[index];
        }
      });
      if (name === "object" || name === "dict") schema.meta.default = {};
      else if (name === "array" || name === "tuple") schema.meta.default = [];
      else if (name === "bitset") schema.meta.default = 0;
      return schema;
    } });
  }
  defineMethod("is", ["constructor"], ({ constructor }) => {
    if (typeof constructor === "function") return constructor.name;
    else return constructor;
  });
  defineMethod("any", [], () => "any");
  defineMethod("never", [], () => "never");
  defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
  defineMethod("string", [], () => "string");
  defineMethod("number", [], () => "number");
  defineMethod("boolean", [], () => "boolean");
  defineMethod("bitset", ["bits"], () => "bitset");
  defineMethod("function", [], () => "function");
  defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
  defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
  defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
  defineMethod("object", ["dict"], ({ dict }) => {
    if (Object.keys(dict).length === 0) return "{}";
    return `{ ${Object.entries(dict).map(([key, inner]) => {
      return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
    }).join(", ")} }`;
  });
  defineMethod("union", ["list"], ({ list }, inline) => {
    const result = list.map(({ toString: format }) => format()).join(" | ");
    return inline ? `(${result})` : result;
  });
  defineMethod("intersect", ["list"], ({ list }) => {
    return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
  });
  defineMethod("transform", [
    "inner",
    "callback",
    "preserve"
  ], ({ inner }, isInner) => inner.toString(isInner));

  // packages/lark/web-auth/src/client-settings.ts
  var RemoteSettingsMirror = class {
    constructor(remote) {
      this.remote = remote;
    }
    remote;
    snapshot = { status: "idle", error: null };
    listeners = /* @__PURE__ */ new Set();
    pending;
    again = false;
    disposed = false;
    getSnapshot = () => this.snapshot;
    subscribe = (listener) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    };
    publish(snapshot) {
      if (this.disposed) return;
      this.snapshot = snapshot;
      for (const listener of this.listeners) listener();
    }
    ensure = () => this.pending ?? (this.snapshot.view ? Promise.resolve() : this.load());
    load = () => {
      if (this.disposed) return Promise.resolve();
      if (this.pending) {
        this.again = true;
        return this.pending;
      }
      this.pending = Promise.resolve().then(async () => {
        do {
          this.again = false;
          try {
            const result = await this.remote.describe();
            if (!result.ok) throw new Error(result.error.message);
            this.publish({ status: "ready", view: { ...result.value, hasDocument: false }, error: null });
          } catch (error) {
            this.publish({ ...this.snapshot, status: this.snapshot.view ? "ready" : "idle", error: String(error) });
          }
        } while (this.again && !this.disposed);
      }).finally(() => {
        this.pending = void 0;
      });
      return this.pending;
    };
    acceptView(view) {
      if (this.pending) this.again = true;
      const current = this.snapshot.view;
      if (!current) return;
      const namespaces = current.namespaces.filter((entry) => entry.ns !== view.ns);
      this.publish({ status: "ready", view: { ...current, namespaces: [...namespaces, view] }, error: null });
    }
    dispose() {
      this.disposed = true;
      this.listeners.clear();
    }
  };
  var RemoteSettingsSchema = class {
    rehydrate(value) {
      return new Schema(value);
    }
    validate(schema, value) {
      try {
        schema(value);
        return void 0;
      } catch (error) {
        return String(error);
      }
    }
    nodeAtPath(root, path) {
      let node = root;
      for (const key of path) {
        node = node?.type === "object" ? node.dict?.[key] : node?.type === "array" || node?.type === "dict" ? node.inner : void 0;
      }
      return node;
    }
    getPath(value, path) {
      let current = value;
      for (const key of path) {
        if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return void 0;
        current = current[key];
      }
      return current;
    }
    hasPath(value, path) {
      if (!path.length) return value !== void 0;
      const parent = this.getPath(value, path.slice(0, -1));
      return !!parent && typeof parent === "object" && Object.hasOwn(parent, path[path.length - 1]);
    }
    change(root, path, value, remove) {
      if (!path.length || path.some((key) => ["__proto__", "constructor", "prototype"].includes(key))) throw new Error("\u65E0\u6548\u8BBE\u7F6E\u8DEF\u5F84");
      if (remove && !this.hasPath(root, path)) return root;
      const copy = structuredClone(root);
      let parent = copy;
      for (let i = 0; i < path.length - 1; i++) {
        const key = path[i];
        if (!parent[key] || typeof parent[key] !== "object") parent[key] = /^\d+$/.test(path[i + 1]) ? [] : {};
        parent = parent[key];
      }
      const leaf = path[path.length - 1];
      if (remove) {
        if (Array.isArray(parent)) parent.splice(Number(leaf), 1);
        else delete parent[leaf];
      } else parent[leaf] = value;
      return copy;
    }
    setPath(root, path, value) {
      return this.change(root, path, value, false);
    }
    deletePath(root, path) {
      return this.change(root, path, void 0, true);
    }
  };
  var RemoteSettingsScope = class {
    constructor(mirror, spec, schema) {
      this.mirror = mirror;
      this.spec = spec;
      this.schema = schema;
      this.unsubscribe = mirror.subscribe(() => this.derive());
      this.derive();
    }
    mirror;
    spec;
    schema;
    snapshot = { status: "loading", value: void 0, base: void 0, user: void 0, writable: false, mode: "host" };
    listeners = /* @__PURE__ */ new Set();
    tail = Promise.resolve();
    disposed = false;
    unsubscribe;
    getSnapshot = () => this.snapshot;
    subscribe = (listener) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    };
    derive() {
      const document2 = this.mirror.getSnapshot().view;
      if (!document2 || this.disposed) return;
      const view = document2.namespaces.find((entry) => entry.ns === this.spec.namespace);
      let value;
      if (view) {
        try {
          value = this.spec.decode ? this.spec.decode(view.value) : this.schema.validate(this.schema.rehydrate(view.schema), view.value) === void 0 ? view.value : void 0;
        } catch {
          value = void 0;
        }
      }
      this.snapshot = { status: view && value !== void 0 ? "ready" : "unavailable", value, base: view?.base, user: view?.user, revision: view?.revision, writable: document2.writable, mode: "host" };
      for (const listener of this.listeners) listener();
    }
    mutate(ops, expectedRevision) {
      const owned = structuredClone(ops);
      const task = this.tail.then(async () => {
        if (this.disposed || !this.snapshot.writable) return;
        try {
          const result = await this.mirror.remote.mutate(this.spec.namespace, owned, expectedRevision ?? this.snapshot.revision);
          if (!result.ok) {
            await this.mirror.load();
            return;
          }
          if (!this.disposed) this.mirror.acceptView(result.value);
        } catch {
          await this.mirror.load();
        }
      });
      this.tail = task.catch(() => {
      });
      return task;
    }
    set(field, value) {
      return this.mutate([{ op: "set", path: [field], value }]);
    }
    unset(field) {
      return this.mutate([{ op: "unset", path: [field] }]);
    }
    async dispose() {
      this.disposed = true;
      this.unsubscribe();
      this.listeners.clear();
      await this.tail;
    }
  };
  function installRemoteSettings(ctx, Service) {
    const schema = new RemoteSettingsSchema();
    const mirror = new RemoteSettingsMirror(ctx.remote.settings);
    class SchemaProvider extends Service {
      rehydrate = schema.rehydrate.bind(schema);
      validate = schema.validate.bind(schema);
      nodeAtPath = schema.nodeAtPath.bind(schema);
      getPath = schema.getPath.bind(schema);
      hasPath = schema.hasPath.bind(schema);
      setPath = schema.setPath.bind(schema);
      deletePath = schema.deletePath.bind(schema);
    }
    class ScopeProvider extends Service {
      describe() {
        return mirror;
      }
      bind(spec) {
        const scope = new RemoteSettingsScope(mirror, spec, schema);
        this.ctx.effect(() => {
          void mirror.ensure();
          return () => scope.dispose();
        }, "remote settings scope");
        return scope;
      }
    }
    new SchemaProvider(ctx, "settingsSchema");
    new ScopeProvider(ctx, "settingsScope");
    ctx.effect(() => {
      const refresh = () => {
        void mirror.load();
      };
      const disposers = [ctx.remote.$on("settings/document-updated", refresh), ctx.on("connection/reset", refresh)];
      return () => {
        mirror.dispose();
        disposers.forEach((dispose) => dispose());
      };
    }, "remote settings invalidation");
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
        if (globalThis.__DSH_AUTH_EDGE__?.remoteSettings) {
          const { Service } = require2("@deepseek-ai/cordis");
          installRemoteSettings(ctx, Service);
        }
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
        ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "mewclaw-feishu",
          order: -20,
          label: () => "\u98DE\u4E66\u8FDE\u63A5"
        }, () => FeishuConnectionsSection(React))), "dsh-lark-web-auth: feishu section");
      }
      return { apply, inject: ["slots", "connection", "remote", "remote.settings"] };
    }
  });
})();
