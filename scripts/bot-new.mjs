/**
 * bot:new 生成器（SPEC presets.md §6）：新建/修订 bot 模板。
 *
 * 用法：
 *   node scripts/bot-new.mjs <name> [--template coding-assistant|knowledge-assistant]
 *   node scripts/bot-new.mjs --revision <name>   # 重算并写入修订号
 *
 * 修订纪律：revision = preset.json 内容 SHA-256；手工修改后必须重算，
 * 否则装载校验拒绝（fail closed）。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const presetsRoot = join(repoRoot, "presets");

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

function revisionOf(content) {
  // 排除 revision 字段的规范哈希（与 dsh-lark-presets 校验同算法）。
  const parsed = JSON.parse(content);
  delete parsed.revision;
  return createHash("sha256").update(`${JSON.stringify(parsed, null, 2)}\n`).digest("hex");
}

/** 重算某模板修订号（唯一更新入口；模板不存在报错）。 */
async function updateRevision(name) {
  const path = join(presetsRoot, name, "preset.json");
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch {
    throw new Error(`模板不存在：${name}`);
  }
  const parsed = JSON.parse(content);
  parsed.revision = revisionOf(JSON.stringify(parsed, null, 2) + "\n");
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  console.log(`revision 已更新：${name} → ${parsed.revision}`);
}

async function create(name, template) {
  if (!NAME_PATTERN.test(name)) throw new Error("模板名非法（kebab-case）");
  const source = join(presetsRoot, template, "preset.json");
  let base;
  try {
    base = JSON.parse(await readFile(source, "utf8"));
  } catch {
    throw new Error(`参考模板不存在：${template}`);
  }
  const target = join(presetsRoot, name);
  try {
    await readFile(join(target, "preset.json"), "utf8");
    throw new Error(`模板已存在（不覆盖）：${name}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("模板已存在")) throw error;
    // ENOENT = 可创建。
  }
  const preset = {
    ...base,
    name,
    version: "1.0.0",
  };
  preset.revision = revisionOf(`${JSON.stringify(preset, null, 2)}\n`);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "preset.json"), `${JSON.stringify(preset, null, 2)}\n`, "utf8");
  console.log(`模板已创建：${name}（revision ${preset.revision.slice(0, 12)}…）`);
}

const args = process.argv.slice(2);
if (args[0] === "--revision") {
  await updateRevision(args[1]);
} else {
  const name = args[0];
  const templateIndex = args.indexOf("--template");
  const template = templateIndex >= 0 ? args[templateIndex + 1] : "knowledge-assistant";
  if (!name) {
    console.error("用法：node scripts/bot-new.mjs <name> [--template coding-assistant|knowledge-assistant]");
    process.exit(1);
  }
  await create(name, template);
}
