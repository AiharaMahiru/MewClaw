/**
 * 知识库 id 派生（lark-claw 语义平移）。
 *
 * 库 id = SHA-256(tenant ‖ bot ‖ deployment ‖ visibility ‖ owner) 前 32 hex
 * 的 UUID 形态。conversation 不参与（对话维度不改变知识可见性集合）；
 * owner 只在 user_private 时取 scope.userId。
 */
import { createHash } from "node:crypto";

import type { Scope } from "dsh-lark-contracts";
import type { KnowledgeVisibility } from "dsh-knowledge";

export function knowledgeBaseId(scope: Scope, visibility: KnowledgeVisibility): string {
  const owner = visibility === "user_private" ? scope.userId : "";
  const hex = createHash("sha256")
    .update([scope.tenantId, scope.botId, scope.deploymentId, visibility, owner].join("\0"))
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}
