/** 有界的服务就绪探针，避免进程已启动但依赖尚未可用。 */
export interface ReadinessOptions {
  timeoutMs: number;
  retryDelayMs: number;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (delayMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, delayMs));

export async function waitForReady(
  probe: () => Promise<boolean>,
  options: ReadinessOptions,
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  while (true) {
    if (await probe()) return;
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error(`Service did not become ready within ${options.timeoutMs}ms`);
    await sleep(Math.min(options.retryDelayMs, remaining));
  }
}
