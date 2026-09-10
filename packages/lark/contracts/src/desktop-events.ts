/** 桌面绑定的持久化事件；所有云端组合均能识别，关闭桥接不丢失执行地点。 */
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
(KNOWN_SESSION_EVENT_TYPES as Set<string>).add('desktop/workspace');
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * @mode persisted
     * @param owner - 服务端生成的完整 Scope 编码。
     * @param mode - 执行地点，不代表活跃连接。
     * @param generation - 公开修订号，不是连接凭证。
     * @dshScopeScan unsupported
     */
    'desktop/workspace': { owner: string; mode: 'cloud' | 'desktop'; generation: string };
  }
}
