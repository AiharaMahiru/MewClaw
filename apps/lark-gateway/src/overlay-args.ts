import { isAbsolute, resolve } from "node:path";

const PATCH_FLAG = "--patch";

export function resolveOverlayArguments(argv: readonly string[], cwd: string): string[] {
  const files: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== PATCH_FLAG) continue;
    const value = argv[index + 1];
    if (!value || value === PATCH_FLAG) throw new Error("lark-gateway: --patch requires a file path");
    files.push(isAbsolute(value) ? value : resolve(cwd, value));
    index += 1;
  }
  return files;
}
