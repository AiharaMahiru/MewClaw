/**
 * cron 投递轮询（lark-claw cron-delivery-poller 平移）：
 * 认领 outbox（授权用户集合）→ 先验 scope → 发结果卡 → 确认。
 * send-before-ack：发送成功才 ack；失败保留行待下轮重试（at-least-once）。
 */
import type { CronDelivery, MessageId, Scope, UserId } from "dsh-lark-contracts";
import type { LarkRunClient } from "dsh-lark-run-client";

import type { GatewaySecurity } from "./config.js";

const MAX_CARD_MARKDOWN_LENGTH = 18_000;

export interface CronDeliveryPollerOptions {
  identity: GatewaySecurity["identity"];
  authorizedOpenIds: readonly UserId[];
  /** 每轮认领上限（默认 20）。 */
  batch?: number;
  reportInfo?: (message: string) => void;
  reportError?: (error: unknown) => void;
}

export class CronDeliveryPoller {
  private running = false;

  constructor(
    private readonly worker: LarkRunClient,
    private readonly sendCard: (chatId: Scope["conversationId"], markdown: string) => Promise<MessageId>,
    private readonly options: CronDeliveryPollerOptions,
  ) {}

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const deliveries = await this.worker.claimCronDeliveries({
        tenantId: this.options.identity.tenantId,
        botId: this.options.identity.botId,
        deploymentId: this.options.identity.deploymentId,
        userIds: [...this.options.authorizedOpenIds],
      });
      let count = 0;
      for (const delivery of deliveries) {
        try {
          this.assertAllowed(delivery.scope);
          await this.sendCard(delivery.scope.conversationId, this.render(delivery));
          await this.worker.ackCronDelivery({ runId: delivery.runId, deliveryToken: delivery.deliveryToken });
          this.options.reportInfo?.(`lark-gateway: cron delivered run=${delivery.runId} status=${delivery.status}`);
          count += 1;
        } catch (error) {
          this.options.reportError?.(error);
        }
      }
      return count;
    } catch (error) {
      this.options.reportError?.(error);
      return 0;
    } finally {
      this.running = false;
    }
  }

  /** 先验：投递 scope 必须属于本部署 + 授权用户（fail closed）。 */
  private assertAllowed(scope: Scope): void {
    const allowed = scope.tenantId === this.options.identity.tenantId
      && scope.botId === this.options.identity.botId
      && scope.deploymentId === this.options.identity.deploymentId
      && this.options.authorizedOpenIds.includes(scope.userId);
    if (!allowed) throw new Error("cron 投递 scope 不匹配");
  }

  private render(delivery: CronDelivery): string {
    const fallback = delivery.status === "failed"
      ? `> 定时任务执行失败：${delivery.error || "未返回错误详情。"}`
      : "> 定时任务已执行，但未返回文本结果。";
    const title = delivery.status === "failed" ? "**定时任务执行失败**" : "**定时任务结果**";
    const body = delivery.output.trim() || fallback;
    return `${title}\n\n${body}`.slice(0, MAX_CARD_MARKDOWN_LENGTH);
  }
}
