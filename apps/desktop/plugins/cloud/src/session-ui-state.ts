/** 仅隔离会话视图选择；不触碰账号、Cookie 或真实会话持久化。 */
export function sessionUiStateScript(location: 'cloud' | 'local'): string {
  const keys = ['dsh.sessions.current', 'dsh.workspace.view.v5', 'dsh.conversation.chat'];
  return `(()=>{const mode=${JSON.stringify(location)},keys=${JSON.stringify(keys)},active='mewclaw.sessions.active-location',prefix='mewclaw.session-ui.';const previous=localStorage.getItem(active)||'cloud';if(previous!==mode){const saved={};for(const key of keys)saved[key]=localStorage.getItem(key);localStorage.setItem(prefix+previous,JSON.stringify(saved));let next={};try{next=JSON.parse(localStorage.getItem(prefix+mode)||'{}')||{};}catch{}for(const key of keys){if(typeof next[key]==='string')localStorage.setItem(key,next[key]);else localStorage.removeItem(key);}}localStorage.setItem(active,mode);})();`;
}
