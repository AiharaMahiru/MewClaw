# infra/sandbox — OCI 沙箱镜像资产

自 lark-claw `infra/sandbox` 平移（M0）：

- `Containerfile`：沙箱镜像定义（Podman rootless、降权、常用工程运行时与工具）；读写根、资源上限、单挂载和默认断网由 `dsh-sandbox-oci` 的运行参数强制执行；
- `build.mjs`：构建镜像（`pnpm sandbox:build`），镜像名 `localhost/dsh-lark-sandbox:1.0.0`；
- `validate-image.mjs`：镜像内容校验（入口点/缓存种子/目录权限/禁 latest 标签），`pnpm sandbox:validate-image`。

镜像不再复制旧 Lark Claw 的 `sandbox-mcp` 或宿主 CdgBridge 二进制；当前 Provider 通过受控 Podman `exec` 执行工具。
