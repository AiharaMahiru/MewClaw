import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['mewclaw-cloud/src/**/*.test.ts', 'mewclaw-workspace/src/**/*.test.ts', 'workspace-integration.test.mjs'],
    server: { deps: { inline: ['@deepseek-ai/dsh-client-ui-primitives'] } },
  },
});
