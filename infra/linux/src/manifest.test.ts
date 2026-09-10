import { describe, expect, it } from "vitest";

import {
  digestJson,
  parseProductionRuntimeManifest,
  runtimeManifestDigest,
} from "./manifest.js";
import type { ProductionRuntimeManifest } from "./types.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function manifestFixture(): ProductionRuntimeManifest {
  return {
    schemaVersion: 1,
    createdAt: "2026-08-24T03:45:59.000Z",
    host: {
      architecture: "amd64",
      bootId: "a93c4c1c-b983-4c03-9002-08ae5de3150c",
      hostname: "production.example",
      osRelease: "Debian GNU/Linux 13 (trixie)",
    },
    release: {
      artifactSha256: SHA_A,
      gitCommit: SHA_B,
      lockfileSha256: SHA_C,
      productionLockSha256: SHA_A,
    },
    paths: {
      backupsRoot: "/var/lib/dsh/backups",
      currentLink: "/opt/dsh/current",
      environmentFile: "/etc/dsh/dsh.env",
      releasesRoot: "/opt/dsh/releases",
      sessionsRoot: "/var/lib/dsh/sessions",
      stateRoot: "/var/lib/dsh",
      uploadsRoot: "/var/lib/dsh/uploads",
      workspacesRoot: "/var/lib/dsh/workspaces",
    },
    ports: { admin: 18791, authEdge: 13080, browser: 13083, preview: 13082, postgres: 15432, workerRun: 18788, workerWeb: 13081 },
    database: {
      bindHost: "127.0.0.1",
      cluster: "dsh",
      vectorVersion: "0.8.0-1",
      version: "17.9-0+deb13u1",
    },
    sandbox: { imageDigest: `sha256:${SHA_A}`, network: "none", rootless: true },
    units: [
      { configSha256: SHA_B, entrypoint: "/opt/dsh/current/apps/auth/dist/main.js", name: "dsh-auth.service" },
    ],
    environment: {
      bytes: 1024,
      group: "dsh",
      mode: "0600",
      owner: "dsh",
      path: "/etc/dsh/dsh.env",
      sha256: SHA_C,
    },
  };
}

describe("production runtime manifest", () => {
  it("parses the complete schema and returns detached data", () => {
    const source = manifestFixture();
    const parsed = parseProductionRuntimeManifest(source);

    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
  });

  it("produces a canonical digest independent of object key order", () => {
    const source = manifestFixture();
    const reordered = {
      units: source.units,
      sandbox: source.sandbox,
      release: source.release,
      ports: source.ports,
      paths: source.paths,
      host: source.host,
      environment: source.environment,
      database: source.database,
      createdAt: source.createdAt,
      schemaVersion: 1,
    };

    expect(runtimeManifestDigest(reordered)).toBe(runtimeManifestDigest(source));
    expect(runtimeManifestDigest(source)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects duplicate ports at the manifest boundary", () => {
    const source = manifestFixture();
    const invalid = { ...source, ports: { ...source.ports, workerWeb: source.ports.authEdge } };

    expect(() => parseProductionRuntimeManifest(invalid)).toThrow(/ports must be unique/);
  });

  it("rejects values that cannot be represented as canonical JSON", () => {
    expect(() => digestJson({ invalid: undefined })).toThrow(/JSON-compatible/);
    expect(() => digestJson({ invalid: Number.NaN })).toThrow(/finite/);
  });
});
