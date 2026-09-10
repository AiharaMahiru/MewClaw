const ACCOUNT_STYLES = `
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
.mewclaw-account-model-detail[open]>summary::after{content:"−"}
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

export function installAccountStyles(): void {
  if (typeof document === "undefined" || document.querySelector("style[data-mewclaw-account]") !== null) return;
  const style = document.createElement("style");
  style.dataset.mewclawAccount = "";
  style.textContent = ACCOUNT_STYLES;
  document.head.appendChild(style);
}
