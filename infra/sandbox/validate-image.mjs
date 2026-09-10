/**
 * 校验沙箱镜像内容（入口点/缓存种子/目录权限）。
 * 来源：lark-claw infra/sandbox（整体平移，M0）。
 */
import { readFile } from "node:fs/promises";

const containerfile = await readFile(new URL("./Containerfile", import.meta.url), "utf8");
const required = [
  "node:24.11.1-bookworm-slim",
  "python:3.13.7-slim-bookworm",
  "mcr.microsoft.com/dotnet/sdk:10.0.302",
  "rust:1.93.0-bookworm",
  "ghcr.io/astral-sh/uv:0.12.1",
  "bash build-essential",
  "git jq",
  "ripgrep unzip",
  "SANDBOX_NPM_CACHE_SEED=/opt/dsh-lark/npm-cache",
  "NPM_CONFIG_BIN_LINKS=false",
  "/usr/local/bin/vite",
  "/usr/local/bin/tsc",
  "react@19.2.8",
  "vite@8.2.1",
  "USER ${SANDBOX_UID}:${SANDBOX_GID}",
  "WORKDIR /workspace",
  "ENTRYPOINT [\"/bin/sh\"]",
];

const missing = required.filter((marker) => !containerfile.includes(marker));
if (missing.length > 0) {
  throw new Error(`Sandbox image definition missing: ${missing.join(", ")}`);
}
if (/:(latest)(?:\s|$)/i.test(containerfile)) {
  throw new Error("Sandbox image definition uses a mutable latest tag");
}
for (const removed of ["sandbox-mcp", "cdgbridge-mcp", "COPY skills/cdg-bridge"]) {
  if (containerfile.includes(removed)) {
    throw new Error(`Sandbox image definition still contains retired host-plane asset: ${removed}`);
  }
}
if (containerfile.includes("chown -R ${SANDBOX_UID}:${SANDBOX_GID} /opt/dsh-lark")) {
  throw new Error("Sandbox runtime directory must remain root-owned");
}
console.log("Sandbox image definition validated");
