import { describe, expect, it } from "vitest";

import {
  validateEnvironmentReplica,
  validateRuntimePaths,
  validateRuntimePorts,
} from "./validation.js";

const SHA = "d".repeat(64);

const PATHS = {
  backupsRoot: "/var/lib/dsh/backups",
  currentLink: "/opt/dsh/current",
  environmentFile: "/etc/dsh/dsh.env",
  releasesRoot: "/opt/dsh/releases",
  sessionsRoot: "/var/lib/dsh/sessions",
  stateRoot: "/var/lib/dsh",
  uploadsRoot: "/var/lib/dsh/uploads",
  workspacesRoot: "/var/lib/dsh/workspaces",
};

describe("Linux runtime validation", () => {
  it("accepts the production path and port overlay", () => {
    expect(validateRuntimePaths(PATHS)).toEqual(PATHS);
    expect(
      validateRuntimePorts({ admin: 18791, authEdge: 13080, browser: 13083, preview: 13082, postgres: 15432, workerRun: 18788, workerWeb: 13081 }),
    ).toEqual({ admin: 18791, authEdge: 13080, browser: 13083, preview: 13082, postgres: 15432, workerRun: 18788, workerWeb: 13081 });
  });

  it("rejects relative, root, and non-normalized paths", () => {
    expect(() => validateRuntimePaths({ ...PATHS, stateRoot: "var/lib/dsh" })).toThrow(/absolute/);
    expect(() => validateRuntimePaths({ ...PATHS, stateRoot: "/" })).toThrow(/filesystem root/);
    expect(() => validateRuntimePaths({ ...PATHS, uploadsRoot: "/var/lib/dsh/../escape" })).toThrow(/normalized/);
  });

  it("rejects duplicate and invalid ports", () => {
    const ports = { admin: 18791, authEdge: 13080, browser: 13083, preview: 13082, postgres: 15432, workerRun: 18788, workerWeb: 13081 };

    expect(() => validateRuntimePorts({ ...ports, admin: ports.authEdge })).toThrow(/unique/);
    expect(() => validateRuntimePorts({ ...ports, postgres: 65_536 })).toThrow(/1\.\.65535/);
  });

  it("compares env files by metadata without accepting weak permissions", () => {
    const source = { bytes: 200, path: "D:/AI/dsh/.env", sha256: SHA };
    const target = { ...source, group: "dsh", mode: "0600", owner: "dsh", path: "/etc/dsh/dsh.env" };

    expect(validateEnvironmentReplica(source, target, "/etc/dsh/dsh.env")).toEqual(target);
    expect(() => validateEnvironmentReplica(source, { ...target, mode: "0640" }, target.path)).toThrow(/0600/);
    expect(() => validateEnvironmentReplica(source, { ...target, sha256: "e".repeat(64) }, target.path)).toThrow(/digest/);
  });
});
