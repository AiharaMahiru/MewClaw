/** 独立飞书设置页：统一管理当前账号机器人，保留历史身份关系。 */
import type { AccountIdentity, ReactApi } from "./client-contracts.js";
import { unlinkIdentity, useIdentities } from "./client-data.js";
import { BotConfiguration } from "./client-bot.js";

/** 在页面中缩略展示飞书身份，不暴露完整 Open ID。 */
export function maskIdentity(subject: string): string {
  return subject.length > 12 ? `${subject.slice(0, 6)}...${subject.slice(-4)}` : subject;
}

function IdentitySection({ React }: { React: ReactApi }): unknown {
  const [revision, setRevision] = React.useState(0);
  const [pending, setPending] = React.useState("");
  const [message, setMessage] = React.useState({ text: "", error: false });
  const state = useIdentities(React, revision);
  const remove = async (identity: AccountIdentity): Promise<void> => {
    if (pending || !window.confirm("确定解绑当前飞书身份吗？解绑不会删除聊天记录。")) return;
    setPending(identity.subject);
    setMessage({ text: "", error: false });
    try {
      await unlinkIdentity(identity);
      setMessage({ text: "飞书身份已解绑。", error: false });
      setRevision(revision + 1);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      setMessage({ text: code === "IDENTITY_LAST_LOGIN_METHOD" ? "这是当前账号最后的登录方式，不能解绑。" : "解绑失败，请稍后重试。", error: true });
    } finally { setPending(""); }
  };
  return React.createElement("section", { className: "mewclaw-account-section", "aria-label": "当前账号的飞书身份" },
    React.createElement("div", { className: "mewclaw-feishu-section-head" },
      React.createElement("div", null,
        React.createElement("h3", { className: "mewclaw-account-subtitle" }, "已绑定身份"),
        React.createElement("p", { className: "mewclaw-account-message" }, "仅显示当前登录账号的绑定关系。")),
      React.createElement("button", { type: "button", className: "mewclaw-account-button", disabled: state.status === "loading" || Boolean(pending), onClick: () => { setRevision(revision + 1); } }, state.status === "loading" ? "刷新中…" : "刷新")),
    state.status === "loading" ? React.createElement("p", { className: "mewclaw-account-message", role: "status" }, "正在读取飞书身份…") : null,
    state.status === "error" ? React.createElement("p", { className: "mewclaw-account-message", "data-state": "error", role: "alert" }, "读取失败，请点击刷新重试。") : null,
    state.status === "ready" ? state.data.length ? React.createElement("ul", { className: "mewclaw-identity-list" }, state.data.map((identity) =>
      React.createElement("li", { className: "mewclaw-identity-row", key: identity.subject },
        React.createElement("div", { className: "mewclaw-account-row-copy" },
          React.createElement("strong", null, "飞书身份"),
          React.createElement("span", null, maskIdentity(identity.subject))),
        React.createElement("button", { type: "button", className: "mewclaw-account-button danger", disabled: Boolean(pending), onClick: () => { void remove(identity); } }, pending === identity.subject ? "解绑中…" : "解绑"))))
      : React.createElement("div", { className: "mewclaw-feishu-empty" },
        React.createElement("strong", null, "尚未绑定飞书身份"),
        React.createElement("p", { className: "mewclaw-account-message" }, "连接个人机器人无需绑定登录身份；机器人会话自动归当前配置账号。")) : null,
    message.text ? React.createElement("p", { className: "mewclaw-account-message", role: "status", "aria-live": "polite", "data-state": message.error ? "error" : "success" }, message.text) : null);
}

/** 通过 settings.section 注册；身份请求不携带可由客户端指定的 owner。 */
export function FeishuConnectionsSection(React: ReactApi): unknown {
  return React.createElement("div", { className: "mewclaw-account-center mewclaw-feishu-center" },
    React.createElement("header", { className: "mewclaw-account-center-header" },
      React.createElement("h2", null, "飞书连接"),
      React.createElement("p", { className: "mewclaw-account-message" }, "连接自建应用机器人，管理你的飞书身份。")),
    React.createElement(BotConfiguration, { React }),
    React.createElement(IdentitySection, { React }),
    React.createElement("aside", { className: "mewclaw-feishu-note" },
      React.createElement("h3", { className: "mewclaw-account-subtitle" }, "身份与机器人管理权"),
      React.createElement("p", { className: "mewclaw-account-message" }, "历史登录身份和聊天记录保留。机器人统一在上方保存、校验和连接，配置及新会话仅归当前账号管理。"),
      React.createElement("a", { className: "mewclaw-account-link", href: "https://open.feishu.cn/app", target: "_blank", rel: "noopener noreferrer" }, "飞书开放平台 ↗")));
}
