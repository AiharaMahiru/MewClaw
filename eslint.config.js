import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/lib/**",
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
    files: ["apps/**/*.ts", "packages/**/*.ts", "infra/**/*.ts", "tests/**/*.ts", "vitest.config.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
