import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/lib/**",
      // esbuild 生成且包含第三方代码；源入口仍由 TypeScript/ESLint 检查。
      "packages/lark/web-auth/client.js",
      "packages/lark/atw-brand/client.js",
      "examples/**",
      "node_modules/**",
      "var/**",
      ".data/**",
      ".workspaces/**",
      ".uploads/**",
      ".artifacts/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["apps/**/*.ts", "packages/**/*.ts", "infra/**/*.ts", "tests/**/*.ts", "scripts/session-upgrade/**/*.ts", "vitest.config.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
