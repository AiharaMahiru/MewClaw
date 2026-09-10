export function manifestPatches(manifest: unknown): Record<string, unknown>;
export function lockfilePatches(lockfile: unknown): Record<string, unknown>;
export function verifyPatchPolicy(
  manifest: unknown,
  lockfile: unknown,
  allowlist: readonly string[],
): string[];
