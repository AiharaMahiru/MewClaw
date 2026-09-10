import { spawnSync } from "node:child_process";

const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const useWindowsShell = process.platform === "win32";
const windowsCommandShell = process.env.ComSpec ?? "cmd.exe";
const windowsCommandShellArgs = ["/d", "/s", "/c"];
const commands = [
  // 干净克隆不提交 lib/dist；先构建所有 workspace 引用，测试再经包 exports 装载。
  [packageManager, ["build"], useWindowsShell],
  [packageManager, ["test"], useWindowsShell],
  [packageManager, ["typecheck"], useWindowsShell],
  [packageManager, ["lint"], useWindowsShell],
  [packageManager, ["build:admin-web"], useWindowsShell],
  [process.execPath, ["scripts/verify-capability-matrix.mjs"], false],
  [process.execPath, ["scripts/verify-official-integrity.mjs"], false],
  [process.execPath, ["scripts/verify-plugin-boundaries.mjs"], false],
  ["git", ["diff", "--check"], false],
];

function runCommand(command, args, shell) {
  if (!shell) return spawnSync(command, args, { stdio: "inherit" });

  // Windows 的 .cmd 只能经 cmd.exe 执行；参数来自上方的固定命令表。
  return spawnSync(
    windowsCommandShell,
    [...windowsCommandShellArgs, `${command} ${args.join(" ")}`],
    { stdio: "inherit" },
  );
}

for (const [command, args, shell] of commands) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = runCommand(command, args, shell);

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
