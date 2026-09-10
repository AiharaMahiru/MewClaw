import type { ReactApi } from "./client-contracts.js";
import { botError, mutateBot, useAccountBot, type AccountBot } from "./client-bot-data.js";

const STATE_LABELS = { connected: "长连接已连接", reconnecting: "正在连接 / 重连", failed: "连接失败，网关将重试；请检查应用设置", unknown: "等待网关状态", disabled: "已停用" };

/** 真实账号配置表单：密钥只写不读，不写浏览器持久存储。 */
function BotForm({ React, bot, refresh }: { React: ReactApi; bot: AccountBot | null; refresh: () => void }): unknown {
  const [pending, setPending] = React.useState("");
  const [message, setMessage] = React.useState({ text: "", error: false });
  const execute = async (name: string, operation: () => Promise<string>) => {
    if (pending) return;
    setPending(name); setMessage({ text: "", error: false });
    try { setMessage({ text: await operation(), error: false }); refresh(); }
    catch (cause) { setMessage({ text: botError(cause), error: true }); }
    finally { setPending(""); }
  };
  const submit = (event: { preventDefault(): void; currentTarget: HTMLFormElement }) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void execute("保存中…", async () => {
      await mutateBot("/auth/feishu-bot", "PUT", {
        expectedRevision: bot?.revision ?? 0, appId: String(data.get("appId") ?? "").trim(),
        domain: String(data.get("domain")), appSecret: String(data.get("appSecret") ?? "").trim(),
        authorizedOpenIds: String(data.get("openIds") ?? "").split(/[\s,，]+/).filter(Boolean),
      });
      const secret = form.elements.namedItem("appSecret") as HTMLInputElement | null;
      if (secret) secret.value = "";
      return "已保存，机器人尚未连接。请校验后点击连接。";
    });
  };
  const input = (label: string, props: Record<string, unknown>) => React.createElement("label", null, React.createElement("span", null, label), React.createElement("input", { ...props, disabled: Boolean(pending) || Boolean(bot?.enabled) }));
  return React.createElement("div", { className: "mewclaw-account-section" },
    React.createElement("p", { className: "mewclaw-account-message", role: "status" }, bot ? STATE_LABELS[bot.state] : "尚未配置个人机器人"),
    React.createElement("form", { key: bot?.revision ?? 0, className: "mewclaw-account-form mewclaw-bot-form", onSubmit: submit },
      input("App ID *", { name: "appId", defaultValue: bot?.appId ?? "", placeholder: "cli_…", required: true, pattern: "cli_[0-9a-fA-F]{16}", maxLength: 20, autoComplete: "off" }),
      input(bot ? "App Secret（留空保留）" : "App Secret *", { name: "appSecret", type: "password", required: !bot, maxLength: 256, autoComplete: "new-password" }),
      React.createElement("label", null, React.createElement("span", null, "应用区域"), React.createElement("select", { name: "domain", defaultValue: bot?.domain ?? "https://open.feishu.cn", disabled: Boolean(pending) || Boolean(bot?.enabled) }, React.createElement("option", { value: "https://open.feishu.cn" }, "飞书 · 中国"), React.createElement("option", { value: "https://open.larksuite.com" }, "Lark · 国际"))),
      React.createElement("label", { className: "mewclaw-account-field-wide" }, React.createElement("span", null, "允许使用的 Open ID *"), React.createElement("textarea", { name: "openIds", defaultValue: bot?.authorizedOpenIds.join("\n") ?? "", rows: 3, required: true, maxLength: 14000, placeholder: "ou_…，多个以逗号或换行分隔", disabled: Boolean(pending) || Boolean(bot?.enabled) })),
      React.createElement("p", { className: "mewclaw-account-message mewclaw-account-field-wide" }, "使用此应用下的 Open ID。名单中的用户可以调用机器人；产生的会话归当前 MewClaw 账号管理。App Secret 加密保存，不会再次显示。"),
      React.createElement("div", { className: "mewclaw-account-form-actions" },
        React.createElement("button", { type: "submit", className: "mewclaw-account-button primary", disabled: Boolean(pending) || Boolean(bot?.enabled) }, pending === "保存中…" ? pending : "保存配置"),
        bot ? React.createElement("button", { type: "button", className: "mewclaw-account-button", disabled: Boolean(pending), onClick: () => { void execute("校验中…", async () => { const result = await mutateBot("/auth/feishu-bot/test", "POST", { expectedRevision: bot.revision }); return `凭证校验通过：${String(result.botName)}。仍需确认长连接和消息权限。`; }); } }, pending === "校验中…" ? pending : "校验凭证") : null,
        bot ? React.createElement("button", { type: "button", className: "mewclaw-account-button", disabled: Boolean(pending), onClick: () => {
          if (bot.enabled && !window.confirm("断开后机器人将停止接收新消息，历史会话保留。确定断开吗？")) return;
          void execute("处理中…", async () => { await mutateBot("/auth/feishu-bot/connection", "POST", { expectedRevision: bot.revision, enabled: !bot.enabled }); return bot.enabled ? "已请求断开，网关将在下一次同步时关闭连接。" : "已请求连接，正在等待网关状态。"; });
        } }, pending === "处理中…" ? pending : bot.enabled ? "断开机器人" : "连接机器人") : null)),
    message.text ? React.createElement("p", { className: "mewclaw-account-message", role: message.error ? "alert" : "status", "data-state": message.error ? "error" : "success" }, message.text) : null);
}

export function BotConfiguration({ React }: { React: ReactApi }): unknown {
  const [revision, setRevision] = React.useState(0);
  const state = useAccountBot(React, revision);
  return React.createElement("section", { className: "mewclaw-account-section", "aria-label": "自建应用机器人配置" },
    React.createElement("div", { className: "mewclaw-feishu-section-head" }, React.createElement("h3", { className: "mewclaw-account-subtitle" }, "自建应用机器人"), React.createElement("button", { type: "button", className: "mewclaw-account-button", onClick: () => { setRevision(revision + 1); } }, "刷新状态")),
    state.status === "loading" ? React.createElement("p", { role: "status" }, "正在读取配置…") : state.status === "error" ? React.createElement("p", { role: "alert", className: "mewclaw-account-message", "data-state": "error" }, "读取配置失败，请刷新状态重试。") : React.createElement(BotForm, { React, bot: state.data, refresh: () => { setRevision(revision + 1); } }),
    React.createElement("details", { className: "mewclaw-account-fold" }, React.createElement("summary", null, "飞书开放平台配置步骤"),
      React.createElement("ol", { className: "mewclaw-bot-guide" },
        React.createElement("li", null, "创建企业自建应用，启用机器人能力。"),
        React.createElement("li", null, "事件订阅选择长连接，订阅 im.message.receive_v1；如使用卡片交互，启用 card.action.trigger 回调。"),
        React.createElement("li", null, "开通读取用户发给机器人的消息、以应用身份发送消息权限；附件需要相应资源权限。"),
        React.createElement("li", null, "发布应用版本并将使用者纳入可用范围，保存以上凭证和授权名单后连接。"))),
    React.createElement("p", { className: "mewclaw-account-message" }, "机器人统一通过此页面管理；旧应用需在此保存并连接，不会自动导入。请勿把同一个应用重复连接到其他网关。"));
}
