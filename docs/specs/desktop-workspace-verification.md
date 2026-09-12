# 桌面工作区源码与 Release 验收（2026-09-12）

范围：Web 与独立桌面候选统一使用 DSH `0.1.5-rc.2`；Windows x64、Node 24；官方 DSH 包和用户数据未修改。唯一候选为 `D:\AI\dsh\MewClaw-desktop-candidate`，Release 目录为 `release\MewClaw-1.0.0-win-x64`。

## Web 与共享能力

- `pnpm install --frozen-lockfile --ignore-scripts`、`pnpm typecheck`、`pnpm build`、`pnpm lint`：通过。
- DSH rc.2 品牌与官方完整性门禁、桌面 Host 定向测试和 Auth Edge 定向测试：通过；本轮不把真实生产部署或真实模型请求当作验收结果。
- Web 端必须继续提供 Auth Edge 的 `POST /auth/desktop-inference/chat/completions`。请求只携带 `cloud-default` 占位模型和会话 Cookie/CSRF；Edge 按认证账号解析默认模型与服务端加密 API Key，再在服务端代理 SSE。

## 唯一桌面候选

- 在候选目录执行 `npm ci --ignore-scripts --no-audit --no-fund`、`npm run build`：通过。
- `node apps/desktop/verify-workspace.mjs D:/AI/dsh/MewClaw-desktop-candidate`：21 个测试文件、58 个测试通过，输出 `WORKSPACE_OFFLINE_VERIFIED`。上游包缺失 source map 的 Vite warning 不影响结果。
- Release 构建命令：

  ```text
  node node_modules/electron-builder/cli.js --config electron-builder.cjs --win --x64 --publish never
  ```

- `verify-package.mjs`：输出 `ASAR_ENTRYPOINTS_OK`、`OFFICIAL_RUNTIME_UNCHANGED 731`、`NATIVE_SPAWN_OK CLOUD_PROVIDER_IMPORT_OK`、4 个 Runtime smoke、`ZIP_PAYLOAD_MATCHES_VERIFIED_APP`、`MEWCLAW_PACKAGE_OK`。
- `local-ui-smoke.mjs ... advanced --directory --switch`：输出 `DIRECTORY_COMPOSER_EDITABLE`、`RENDERER_ERRORS 0`、`LOCATION_SWITCH_OK local-to-cloud`、`LOCATION_SWITCH_OK cloud-to-local`、`LOCAL_UI_OK advanced Release`。

## Release 产物

| 产物 | 字节 | SHA-256 |
| --- | ---: | --- |
| MewClaw-1.0.0-win-x64-Portable.exe | 142872199 | d9b1db86207aac46fb7473b60e596e3c4b8427ec7e83f7c84e8a00558fc72612 |
| MewClaw-1.0.0-win-x64-Setup.exe | 143116135 | c44ae2cda79b5600836b7ca79faca20537e3877c51a9bafacdce05fce0df6f15 |
| MewClaw-1.0.0-win-x64.zip | 187022948 | 74003c18bc80abe02b2b5e44d9496509c8ad96c155ef6468399a3911a0df410d |

安装包未签名。验包过程中 Node 报 `fs.Stats` 弃用警告，但退出码为 0，且 ZIP 与已验证 `win-unpacked` 内容一致。

## 候选目录收敛

- 已删除 `MewClaw-desktop-candidate-20260912`、`-r2`、`-r3` 以及旧的无后缀候选。
- r4 通过验证后改名为唯一的 `MewClaw-desktop-candidate`；改名造成的 Windows workspace Junction 已用 `npm install --ignore-scripts --no-audit --no-fund` 按最终路径重建，并重新通过工作区、验包和 Release UI 门禁。
- `C:\Users\ATWER\AppData\Roaming\MewClaw` 未触碰。

## 未完成边界

- Auth Edge 推理配套尚未部署生产；真实登录、真实账号模型、原生目录选择对话框和模型驱动文件写入仍需 Windows 实机人工验收。
- GitHub HTTPS 443 在本轮不可达，`origin/desktop-dev` 的实时 SHA 未核验；不能据此声称已推送。
- 构建包为未签名开发 Release，不代表正式发布或代码签名完成。
