"use strict";
(() => {
  // packages/desktop/workspace/src/client.ts
  var globals = globalThis;
  globals.__ModuleLoader__.load({ id: "dsh-lark-desktop-workspace", factory: (require2) => {
    const React = require2("react");
    const LABEL_STYLE = { display: "inline-flex", alignItems: "center", gap: "4px", maxWidth: "180px", height: "22px", padding: "0 2px 0 0", borderRadius: "6px", background: "var(--dsw-alias-fill-tsp-secondary)", color: "var(--dsw-alias-label-secondary)", fontSize: "12px", lineHeight: "22px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
    const ICON_STYLE = { opacity: 0.7, flex: "none", fontSize: "14px" };
    function Location({ sessionId }) {
      const [text, setText] = React.useState("\u2601\uFE0F \u4E91\u7AEF");
      React.useEffect(() => {
        if (!globals.__MEWCLAW_WORKSPACE_ENABLED__) return;
        const abort = new AbortController();
        let timer;
        const refresh = async () => {
          try {
            const csrf = document.cookie.split(";").map((s) => s.trim()).find((s) => s.startsWith("dsh_csrf="))?.slice(9) ?? "";
            const response = await fetch("/desktop-workspace", {
              method: "POST",
              headers: { "content-type": "application/json", "x-csrf-token": csrf },
              body: JSON.stringify({ action: "status", sessionId }),
              signal: abort.signal
            });
            if (!response.ok) return;
            const state = await response.json();
            if (abort.signal.aborted) return;
            setText(state.mode === "desktop" ? state.connected ? "\u672C\u673A\u5DE5\u4F5C\u533A \xB7 \u684C\u9762\u5DF2\u8FDE\u63A5" : "\u672C\u673A\u5DE5\u4F5C\u533A \xB7 \u684C\u9762\u5DF2\u65AD\u7EBF" : "\u2601\uFE0F \u4E91\u7AEF");
            if (state.mode === "desktop") timer = setTimeout(() => {
              void refresh();
            }, 5e3);
          } catch {
            if (!abort.signal.aborted) setText("\u5DE5\u4F5C\u533A\u72B6\u6001\u4E0D\u53EF\u7528");
          }
        };
        setText("\u2601\uFE0F \u4E91\u7AEF");
        void refresh();
        return () => {
          abort.abort();
          clearTimeout(timer);
        };
      }, [sessionId]);
      return React.createElement(
        "span",
        { role: "status", title: "\u672C\u673A\u76EE\u5F55\u3001Shell \u548C\u540C\u6B65\u6388\u6743\u53EA\u80FD\u5728\u684C\u9762\u5BA2\u6237\u7AEF\u7BA1\u7406\u3002", style: LABEL_STYLE },
        text.startsWith("\u2601\uFE0F") ? [React.createElement("span", { key: "icon", style: ICON_STYLE }, "\u2601\uFE0F"), text.slice(2).trimStart()] : text
      );
    }
    return { inject: ["slots"], apply(ctx) {
      if (globals.__MEWCLAW_DESKTOP_WORKSPACE__) return;
      ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
        name: "conversation.session.header.actions",
        id: "mewclaw-workspace-location",
        order: -5,
        inject: (sessionId) => ({ sessionId })
      }, Location));
    } };
  } });
})();
