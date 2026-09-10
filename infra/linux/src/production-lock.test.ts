import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseProductionPackageLock, productionPackageLockDigest } from "./production-lock.js";

async function readLock(): Promise<unknown> {
  const value = await readFile(new URL("../production.lock.json", import.meta.url), "utf8");
  return JSON.parse(value) as unknown;
}

describe("Debian production package lock", () => {
  it("locks the exact candidates observed on the production host", async () => {
    const lock = parseProductionPackageLock(await readLock());
    const versions = Object.fromEntries(lock.packages.map((entry) => [entry.name, entry.version]));

    expect(lock.host).toEqual({ architecture: "amd64", os: "Debian GNU/Linux 13 (trixie)" });
    expect(versions).toMatchObject({
      chromium: "147.0.7727.55-1~deb13u1",
      "chromium-common": "147.0.7727.55-1~deb13u1",
      "chromium-sandbox": "147.0.7727.55-1~deb13u1",
      podman: "5.4.2+ds1-2+b2",
      "postgresql-17": "17.9-0+deb13u1",
      "postgresql-client-17": "17.9-0+deb13u1",
      "postgresql-17-pgvector": "0.8.0-1",
    });
    const packages = Object.fromEntries(lock.packages.map((entry) => [entry.name, entry]));
    expect(packages["postgresql-17"]).toMatchObject({
      archiveContentSha1: "8e78f206f6767f2a958c36696872c56ce2af5264",
      archiveUrl: "https://snapshot.debian.org/file/8e78f206f6767f2a958c36696872c56ce2af5264",
      filename: "pool/main/p/postgresql-17/postgresql-17_17.9-0+deb13u1_amd64.deb",
      sha256: "8e2662369a54db8d81ac6b5c8756f07e12e7a6ce5506e77345e7008cee001970",
      size: 16_582_844,
    });
    expect(packages["postgresql-client-17"]).toMatchObject({
      archiveContentSha1: "cdffd4959b739d72f91a5f8602b80047bf68b2a7",
      archiveUrl: "https://snapshot.debian.org/file/cdffd4959b739d72f91a5f8602b80047bf68b2a7",
      filename: "pool/main/p/postgresql-17/postgresql-client-17_17.9-0+deb13u1_amd64.deb",
      sha256: "91e708dcf6a0be20f1d40e771cf7c7011976ceb8d68846f4af3b0ea50d3f929a",
      size: 2_042_340,
    });
    expect(packages.chromium).toMatchObject({
      archiveContentSha1: "57ce5bdd2e20a6ea0aa27dc85a1ee84058ae8ed7",
      filename: "pool/updates/main/c/chromium/chromium_147.0.7727.55-1~deb13u1_amd64.deb",
      sha256: "c9bc37e9a9a3cbda7e664afaf846e4cca50fbe764637bb5bdfc01b62fe7e6d7e",
      size: 84_342_856,
    });
    expect(lock.runtimes).toEqual([
      {
        architecture: "x64",
        name: "node",
        platform: "linux",
        sha256: "14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647",
        size: 31_633_904,
        url: "https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz",
        version: "24.19.0",
      },
    ]);
    expect(productionPackageLockDigest(lock)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects duplicate packages and malformed repository metadata", async () => {
    const lock = parseProductionPackageLock(await readLock());

    expect(() => parseProductionPackageLock({ ...lock, packages: [...lock.packages, lock.packages[0]] })).toThrow(/unique/);
    expect(() =>
      parseProductionPackageLock({
        ...lock,
        packages: lock.packages.map((entry, index) =>
          index === 0 ? { ...entry, repository: "trixie; rm -rf" } : entry,
        ),
      }),
    ).toThrow(/repository/);
    expect(() =>
      parseProductionPackageLock({
        ...lock,
        packages: lock.packages.map((entry, index) =>
          index === 0 ? { ...entry, archiveUrl: "https://example.invalid/package.deb" } : entry,
        ),
      }),
    ).toThrow(/archiveUrl/);
    expect(() =>
      parseProductionPackageLock({
        ...lock,
        packages: lock.packages.map((entry, index) =>
          index === 0 ? { ...entry, archiveContentSha1: "not-a-content-id" } : entry,
        ),
      }),
    ).toThrow(/archiveContentSha1/);
  });

  it("rejects an unpinned or unsupported Node runtime", async () => {
    const lock = parseProductionPackageLock(await readLock());
    const node = lock.runtimes[0]!;

    expect(() => parseProductionPackageLock({
      ...lock,
      runtimes: [{ ...node, url: "https://nodejs.org/dist/latest-v24.x/node.tar.xz" }],
    })).toThrow(/runtime url/);
    expect(() => parseProductionPackageLock({
      ...lock,
      runtimes: [{ ...node, version: "22.21.1" }],
    })).toThrow(/Node 24/);
  });
});
