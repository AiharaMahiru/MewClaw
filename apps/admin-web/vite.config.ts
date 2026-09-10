/**
 * admin-web 构建配置：规范入口为 /admin，静态资源固定挂在 /admin/ 下；
 * 开发代理 /api 与 /healthz 到 admin 进程（8790）。
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8791",
      "/healthz": "http://127.0.0.1:8791",
    },
  },
});
