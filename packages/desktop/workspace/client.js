"use strict";
(() => {
  // packages/desktop/workspace/src/client.ts
  var globals = globalThis;
  globals.__ModuleLoader__.load({ id: "dsh-lark-desktop-workspace", factory: (require2) => {
    const React = require2("react");
    function Location({ sessionId }) {
      const [text, setText] = React.useState("\u4E91\u7AEF\u5DE5\u4F5C\u533A");
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
            setText(state.mode === "desktop" ? state.connected ? "\u672C\u673A\u5DE5\u4F5C\u533A \xB7 \u684C\u9762\u5DF2\u8FDE\u63A5" : "\u672C\u673A\u5DE5\u4F5C\u533A \xB7 \u684C\u9762\u5DF2\u65AD\u7EBF" : "\u4E91\u7AEF\u5DE5\u4F5C\u533A");
            if (state.mode === "desktop") timer = setTimeout(() => {
              void refresh();
            }, 5e3);
          } catch {
            if (!abort.signal.aborted) setText("\u5DE5\u4F5C\u533A\u72B6\u6001\u4E0D\u53EF\u7528");
          }
        };
        setText("\u4E91\u7AEF\u5DE5\u4F5C\u533A");
        void refresh();
        return () => {
          abort.abort();
          clearTimeout(timer);
        };
      }, [sessionId]);
      return React.createElement("span", { role: "status", title: "\u672C\u673A\u76EE\u5F55\u3001Shell \u548C\u540C\u6B65\u6388\u6743\u53EA\u80FD\u5728\u684C\u9762\u5BA2\u6237\u7AEF\u7BA1\u7406\u3002" }, text);
    }
    return { inject: ["slots"], apply(ctx) {
      if (globals.__MEWCLAW_DESKTOP_WORKSPACE__) return;
      ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
        name: "conversation.session.header.actions",
        id: "mewclaw-workspace-location",
        order: -100,
        inject: (sessionId) => ({ sessionId })
      }, Location));
    } };
  } });
})();
