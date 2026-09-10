/** 显式离线入口：不读取环境文件，不输出上游可能包含正文的异常。 */
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { migrateCopies } from "./runner.js";

const [sourceRoot, outputRoot, planPath, ...extra] = process.argv.slice(2);
try {
  if (!sourceRoot || !outputRoot || !planPath || extra.length || !isAbsolute(planPath)) throw new Error("invalid arguments");
  const stat = await lstat(planPath);
  if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o077) !== 0 || await realpath(planPath) !== planPath) throw new Error("plan must be a small private regular file");
  const plan: unknown = JSON.parse(await readFile(planPath, "utf8"));
  const manifest = await migrateCopies({ sourceRoot, outputRoot, plan });
  console.log(JSON.stringify(manifest));
} catch {
  console.error("副本迁移未通过，未生成成功报告；生产与源文件未写入。请用无敏感数据测试定位失败阶段。");
  process.exitCode = 1;
}
