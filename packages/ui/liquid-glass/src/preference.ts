/** 个人主题偏好只属于当前浏览器、当前账号，不写全站 settings。 */
import type { Branded } from "@deepseek-ai/dsh-brand";

type AccountId = Branded<"GlassAccountId">;
export interface PreferenceSnapshot {
  enabled: boolean;
  loading: boolean;
  notice: string;
}

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * 从同源身份响应提取账号标识，拒绝错误响应或非协议标识。
 * @param input - /auth/me 返回的 JSON。
 * @returns 可用于主题本地存储的账号 ID；无效时抛 TypeError。
 */
export function parseAccountId(input: unknown): AccountId {
  if (!input || typeof input !== "object" || !("user" in input)) throw new TypeError("未获取到当前账号");
  const user = input.user;
  if (!user || typeof user !== "object" || !("id" in user) || typeof user.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(user.id)) throw new TypeError("当前账号标识无效");
  return user.id as AccountId;
}

/**
 * 插件自有偏好存储，订阅稳定快照；主题 token 仍由官方服务管理。
 * @param defaultEnabled - 没有个人记录时的默认选择。
 */
export class GlassPreference {
  private snapshot: PreferenceSnapshot;
  private storage: PreferenceStorage | undefined;
  private key: string | undefined;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly defaultEnabled: boolean) {
    this.snapshot = { enabled: false, loading: true, notice: "正在读取主题偏好…" };
  }

  /** 供 React useSyncExternalStore 读取的稳定不可变快照。 */
  getSnapshot = (): PreferenceSnapshot => this.snapshot;
  /** 注册视图订阅，返回只释放本次订阅的函数。 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** 绑定已验证的账号及本浏览器存储；存储失败时明确降级为本页偏好。 */
  bind(accountId: AccountId, storage: PreferenceStorage): void {
    this.key = `mewclaw.liquid-glass.v1.${accountId}`;
    this.storage = storage;
    try { this.adopt(storage.getItem(this.key)); }
    catch { this.useSession("浏览器无法读取偏好，本次更改仅在当前页面有效。"); }
  }

  /** 未取得身份或存储权限时，使用明确提示的本页状态。 */
  useSession(notice: string): void {
    this.key = undefined;
    this.storage = undefined;
    this.publish({ enabled: this.defaultEnabled, loading: false, notice });
  }

  /** 用户切换；存储失败不影响本页显示，但不会声称已保存。 */
  setEnabled(enabled: boolean): void {
    if (this.snapshot.loading) return;
    let notice = "仅当前页面有效，无法保存到浏览器。";
    if (this.storage && this.key) {
      try { this.storage.setItem(this.key, enabled ? "on" : "off"); notice = "已保存在当前浏览器，仅影响当前账号。"; }
      catch { notice = "保存失败，本次更改仅在当前页面有效。"; }
    }
    this.publish({ enabled, loading: false, notice });
  }

  /** 只接收同账号存储键；清空存储时恢复默认。 */
  acceptStorage(key: string | null, value: string | null): void {
    if (!this.key || (key !== null && key !== this.key)) return;
    this.adopt(key === null ? null : value);
  }

  private adopt(value: string | null): void {
    this.publish({
      enabled: value === "on" || (value !== "off" && this.defaultEnabled), loading: false,
      notice: value === "on" || value === "off" ? "已保存在当前浏览器，仅影响当前账号。"
        : value === null ? "使用默认外观；切换后保存在当前浏览器，仅影响当前账号。"
          : "浏览器中的主题记录无效，已恢复默认外观。",
    });
  }
  private publish(snapshot: PreferenceSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
