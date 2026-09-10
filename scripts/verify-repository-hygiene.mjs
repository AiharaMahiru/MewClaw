#!/usr/bin/env node
/**
 * 检查 Git 索引中的路径、文件大小和常见凭据形态。
 * 只报告文件路径与规则名，绝不输出命中的秘密内容。
 */
import { execFileSync } from "node:child_process";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const allowedGeneratedPath = /^infra\/linux\/deploy\/lib\/[^/]+\.sh$/;
const forbiddenPaths = [
  [/(^|\/)node_modules\//, "dependency-directory"],
  [/(^|\/)(dist|coverage|build|\.codex-tasks|\.workspaces-test)\//, "generated-or-runtime-directory"],
  [/(^|\/)docs\/evidence\//, "production-evidence"],
  [/(^|\/)D:\//, "accidental-windows-path"],
  [/(^|\/)\.env(?:\.|$)/, "environment-secret-file"],
  [/(^|\/)(Cookies|Login Data|History)(?:$|\/)/, "browser-profile-data"],
];
const secretPatterns = [
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private-key"],
  [/\bsk-(?!test-)[A-Za-z0-9_-]{20,}\b/, "openai-style-key"],
  [/\bfc-(?!test-)[A-Za-z0-9_-]{20,}\b/, "firecrawl-key"],
  [/\bgh[oprsu]_[A-Za-z0-9]{30,}\b/, "github-token"],
  [/\b(?:PASSWORD|API_KEY|ACCESS_TOKEN|SECRET_KEY)\s*=\s*["'][^\s'"`<>{}]{12,}["']/i, "assigned-secret"],
];

function git(args, options = {}) {
  return execFileSync("git", args, { ...options, maxBuffer: 128 * 1024 * 1024 });
}

const paths = git(["ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean);
const failures = [];
for (const path of paths) {
  for (const [pattern, rule] of forbiddenPaths) {
    if (pattern.test(path) && !(rule === "generated-or-runtime-directory" && allowedGeneratedPath.test(path))) {
      failures.push({ path, rule });
    }
  }
  let content;
  try {
    content = git(["show", `:${path}`]);
  } catch {
    failures.push({ path, rule: "unreadable-index-entry" });
    continue;
  }
  if (content.length > MAX_FILE_BYTES) failures.push({ path, rule: "oversized-file" });
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  for (const [pattern, rule] of secretPatterns) {
    if (rule === "assigned-secret" && /\.test\.[cm]?[jt]sx?$/.test(path)) {
      const matches = text.match(new RegExp(pattern.source, `${pattern.flags}g`)) ?? [];
      if (matches.length > 0 && matches.every((value) => /(?:test|example|fake|dummy|mock|fixture|secret|sentinel)/i.test(value))) continue;
    }
    if (pattern.test(text)) failures.push({ path, rule });
  }
}

if (failures.length > 0) {
  console.error(`repository hygiene failed: ${failures.length} issue(s)`);
  for (const item of failures) console.error(`${item.rule}: ${item.path}`);
  process.exit(1);
}
console.log(`repository hygiene passed: ${paths.length} staged file(s), no forbidden paths or secret patterns`);
