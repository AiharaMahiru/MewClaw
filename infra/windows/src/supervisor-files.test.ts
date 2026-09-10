import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appendSupervisorFatal } from "./supervisor-files.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("appendSupervisorFatal", () => {
  it("persists a bounded fatal event without credential values", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-supervisor-fatal-"));
    roots.push(root);
    const secret = "should-not-appear";

    await appendSupervisorFatal(root, new Error(
      `worker failed at postgres://user:${secret}@127.0.0.1/db\nBearer ${secret}`,
    ));

    const line = await readFile(join(root, "var/services/supervisor.log"), "utf8");
    const event = JSON.parse(line) as Record<string, unknown>;
    expect(event).toMatchObject({ phase: "fatal", type: "Error" });
    expect(String(event.message)).not.toContain(secret);
    expect(String(event.message)).not.toContain("\n");
    expect(String(event.message).length).toBeLessThanOrEqual(512);
  });
});
