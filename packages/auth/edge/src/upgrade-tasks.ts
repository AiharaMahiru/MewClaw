import type { Duplex } from "node:stream";

export const UPGRADE_ABORTED = Symbol("upgrade-aborted");

export class UpgradeTaskTracker {
  readonly #controller = new AbortController();
  readonly #tasks = new Set<Promise<void>>();

  get closing(): boolean { return this.#controller.signal.aborted; }

  run(socket: Duplex, task: () => Promise<void>): void {
    if (this.closing) { socket.destroy(); return; }
    const pending = Promise.resolve()
      .then(task)
      .catch(() => { socket.destroy(); })
      .finally(() => { this.#tasks.delete(pending); });
    this.#tasks.add(pending);
  }

  async waitFor<T>(operation: Promise<T>): Promise<T | typeof UPGRADE_ABORTED> {
    const signal = this.#controller.signal;
    if (signal.aborted) return UPGRADE_ABORTED;
    return new Promise<T | typeof UPGRADE_ABORTED>((resolve, reject) => {
      const abort = (): void => resolve(UPGRADE_ABORTED);
      signal.addEventListener("abort", abort, { once: true });
      operation.then(
        (value) => { signal.removeEventListener("abort", abort); resolve(value); },
        (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
      );
    });
  }

  beginClose(): void { this.#controller.abort(); }

  async wait(): Promise<void> {
    await Promise.allSettled([...this.#tasks]);
  }
}
