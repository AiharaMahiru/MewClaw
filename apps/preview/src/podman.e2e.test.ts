import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PodmanRuntime } from "./podman.js";
import type { AppConfig } from "./config.js";

it.skipIf(process.env.DSH_PREVIEW_E2E !== "1")("真实Preview容器启动Python并经受控字节桥返回UTF8文件", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dsh-preview-e2e-"));
  const runtime = new PodmanRuntime({
    podmanPath: "/usr/bin/podman", image: process.env.DSH_SANDBOX_E2E_IMAGE,
    startupTimeoutMs: 25000, resources: { cpus: 1, memoryMiB: 256, pids: 64, tmpfsMiB: 64 },
  } as AppConfig);
  let container: string | undefined;
  try {
    await writeFile(join(workspace, "index.html"), '<meta charset="utf-8"><h1>预览正常 PREVIEW_OK</h1>');
    container = await runtime.create({ id: randomBytes(16).toString("hex"), userId: "release-test", workspace, command: "python3 -m http.server 8000 --bind 127.0.0.1", port: 8000 });
    const bridge = runtime.bridge(container, 8000);
    const output = await new Promise<string>((resolve, reject) => {
      let result = "";
      const timeout = setTimeout(() => { bridge.kill("SIGKILL"); reject(new Error("preview bridge timeout")); }, 10000);
      bridge.stdout.on("data", (chunk: Buffer) => { result += chunk.toString(); });
      bridge.once("error", (error) => { clearTimeout(timeout); reject(error); });
      bridge.once("close", () => { clearTimeout(timeout); resolve(result); });
      bridge.stdin.write("GET / HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    });
    expect(output).toContain("200 OK");
    expect(output).toContain("预览正常 PREVIEW_OK");
  } finally {
    if (container) await runtime.remove(container);
    await rm(workspace, { recursive: true, force: true });
  }
}, 45000);
