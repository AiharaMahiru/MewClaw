/**
 * 构建沙箱 OCI 镜像（Podman）。
 * 来源：lark-claw infra/sandbox（整体平移，M0）。
 */
import { spawn } from "node:child_process";

const IMAGE = "localhost/dsh-lark-sandbox:1.0.0";
const WINDOWS_PODMAN = "C:\\Program Files\\RedHat\\Podman\\podman.exe";

function execute(command, args, stdio = "pipe") {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio, windowsHide: true });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode));
  });
}

async function findPodman() {
  const candidates = [process.env.PI_SANDBOX_RUNTIME, "podman", WINDOWS_PODMAN].filter(Boolean);
  for (const candidate of candidates) {
    const exitCode = await execute(candidate, ["--version"]).catch(() => undefined);
    if (exitCode === 0) return candidate;
  }
  throw new Error("Podman is not installed or not available on PATH");
}

const podman = await findPodman();
const exitCode = await execute(podman, [
  "build", "-f", "infra/sandbox/Containerfile", "-t", IMAGE, ".",
], "inherit");
if (exitCode !== 0) process.exitCode = exitCode ?? 1;
