import type {
  AuthImportActionDefinition,
  AuthImportOutboxLease,
} from "dsh-lark-auth";

import { throwIfAborted } from "./errors.js";
import {
  actionDefinitions,
  leaseInput,
  manifestContext,
  objectResultEvent,
  planInvalid,
  runBusy,
  userResultEvent,
  validateOutbox,
  validTimestamp,
} from "./user-action-helpers.js";
import type { UserActionRunInput } from "./user-action-runner.js";

export async function acknowledgeUserActionRun(
  input: UserActionRunInput,
  outbox: readonly AuthImportOutboxLease[],
  onAcknowledged: (sequence: number, receiptKind: "user" | "object") => void,
): Promise<void> {
  const definitions = actionDefinitions(input.plan);
  let expected = 1;
  for (const event of [...outbox].sort((left, right) => left.sequence - right.sequence)) {
    const definition = definitions.get(event.actionId);
    if (!definition || event.sequence !== expected) runBusy();
    await deliverAndAcknowledge(input, event, definitions);
    onAcknowledged(event.sequence, definition.operation === "apply-user" ? "user" : "object");
    expected += 1;
  }
}

export async function resumeUserActionAcknowledgements(input: {
  run: UserActionRunInput;
  acknowledgedSequence: number;
  actionCount: number;
  onAcknowledged(sequence: number, receiptKind: "user" | "object"): void;
}): Promise<void> {
  const definitions = actionDefinitions(input.run.plan);
  let current = await recoverAcknowledgedReceipts(input, definitions);
  while (current < input.actionCount) {
    input.run.options.renewLease();
    throwIfAborted(input.run.signal);
    const leased = await input.run.auth.leaseImportOutbox(leaseInput(input.run));
    if (leased.length === 0) runBusy();
    for (const event of [...leased].sort((left, right) => left.sequence - right.sequence)) {
      const definition = definitions.get(event.actionId);
      if (!definition || event.sequence !== current + 1) runBusy();
      validateOutbox(event, definition);
      await deliverAndAcknowledge(input.run, event, definitions);
      input.onAcknowledged(event.sequence, definition.operation === "apply-user" ? "user" : "object");
      current = event.sequence;
    }
  }
}

async function recoverAcknowledgedReceipts(
  input: Parameters<typeof resumeUserActionAcknowledgements>[0],
  definitions: ReadonlyMap<string, AuthImportActionDefinition>,
): Promise<number> {
  let current = input.acknowledgedSequence;
  while (current < input.actionCount) {
    input.run.options.renewLease();
    throwIfAborted(input.run.signal);
    const receipts = await input.run.auth.listImportOutboxReceipts({
      ...manifestContext(input.run),
      cutoverEpochId: input.run.approval.cutoverEpochId,
      afterSequence: current,
      limit: input.run.options.batchSize,
    });
    if (receipts.length === 0) return current;
    for (const receipt of receipts) {
      const definition = definitions.get(receipt.actionId);
      if (!definition || receipt.sequence !== current + 1) runBusy();
      validateOutbox(receipt, definition);
      if (receipt.acknowledgedAt === null) return current;
      if (!validTimestamp(receipt.acknowledgedAt)) planInvalid();
      input.onAcknowledged(receipt.sequence, definition.operation === "apply-user" ? "user" : "object");
      current = receipt.sequence;
    }
  }
  return current;
}

async function deliverAndAcknowledge(
  input: UserActionRunInput,
  event: AuthImportOutboxLease,
  definitions: ReadonlyMap<string, AuthImportActionDefinition>,
): Promise<void> {
  const definition = definitions.get(event.actionId);
  if (!definition) planInvalid();
  validateOutbox(event, definition);
  input.options.renewLease();
  if (definition.operation === "apply-user") {
    const resultEvent = userResultEvent(input, event, definition);
    // receipt 先于 Cordis 投递，确保进程在任意外部 ack 前已有可恢复审计事实。
    input.options.saveUserResultReceipt(resultEvent);
    await input.options.deliverUserResult(resultEvent);
  } else {
    input.options.saveObjectResultReceipt(objectResultEvent(input, event, definition));
  }
  await acknowledgeEvent(input, event);
}

async function acknowledgeEvent(
  input: UserActionRunInput,
  event: AuthImportOutboxLease,
): Promise<void> {
  input.options.renewLease();
  throwIfAborted(input.signal);
  await input.auth.ackImportOutbox({
    ...manifestContext(input),
    cutoverEpochId: input.approval.cutoverEpochId,
    eventId: event.eventId,
    leaseToken: event.leaseToken,
  });
}
