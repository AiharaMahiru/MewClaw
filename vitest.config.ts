import { configDefaults, defineConfig } from "vitest/config";

const TEST_TIMEOUT_MS = 30_000;

export default defineConfig({
  test: {
    coverage: { enabled: false },
    environment: "node",
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "packages/**/*.test.mjs", "infra/**/*.test.ts", "tests/**/*.test.ts"],
    // 真实 Provider E2E 只能通过专用命令、显式授权环境变量运行；默认门禁不得读取 .env 或消耗外部额度。
    exclude: [...configDefaults.exclude, "tests/knowledge-e2e.test.ts", "apps/desktop/**"],
    hookTimeout: TEST_TIMEOUT_MS,
    testTimeout: TEST_TIMEOUT_MS,
    // 这些测试会启动临时 PG/Podman/worker 组合；文件级并行会让共享端口和
    // 资源窗口互相争用。显式串行文件，maxConcurrency 只负责文件内并发。
    fileParallelism: false,
    maxConcurrency: 2,
  },
});
