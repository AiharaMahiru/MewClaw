import { describe, expect, it } from "vitest";

import { planNginxUpstreamSwitch, planReleaseSwitch } from "./switch-plan.js";

describe("atomic switch planning", () => {
  it("plans current release replacement and rollback as filesystem operations", () => {
    const plan = planReleaseSwitch({
      currentLink: "/opt/dsh/current",
      nextRelease: "/opt/dsh/releases/20260824-a1b2c3d",
      previousRelease: "/opt/dsh/releases/20260823-9f8e7d6",
      transactionId: "deploy-20260824-01",
    });

    expect(plan.prepare).toEqual([
      {
        kind: "create-symlink",
        linkPath: "/opt/dsh/.current.next.deploy-20260824-01",
        target: "/opt/dsh/releases/20260824-a1b2c3d",
      },
      { kind: "fsync-directory", path: "/opt/dsh" },
    ]);
    expect(plan.commit).toEqual([
      {
        destination: "/opt/dsh/current",
        kind: "rename",
        source: "/opt/dsh/.current.next.deploy-20260824-01",
      },
      { kind: "fsync-directory", path: "/opt/dsh" },
    ]);
    expect(plan.rollback[0]).toMatchObject({ kind: "create-symlink", target: "/opt/dsh/releases/20260823-9f8e7d6" });
  });

  it("adds argv-based Nginx validation and reload without a shell", () => {
    const plan = planNginxUpstreamSwitch({
      activeConfigSha256: "a".repeat(64),
      activeConfigPath: "/www/server/panel/vhost/nginx/chat.rwr.ink.conf",
      backupPath: "/www/server/panel/vhost/nginx/.chat.rwr.ink.conf.dooragent.epoch-7.bak",
      candidateSha256: "b".repeat(64),
      candidatePath: "/www/server/panel/vhost/nginx/.chat.rwr.ink.conf.dsh.epoch-7",
      killPath: "/bin/kill",
      masterPid: 2468,
      nginxConfigPath: "/www/server/nginx/conf/nginx.conf",
      nginxPath: "/www/server/nginx/sbin/nginx",
      psPath: "/usr/bin/ps",
      transactionId: "epoch-7",
    });

    expect(plan.prepare).toEqual([
      {
        kind: "verify-sha256",
        path: "/www/server/panel/vhost/nginx/chat.rwr.ink.conf",
        sha256: "a".repeat(64),
      },
      {
        destination: "/www/server/panel/vhost/nginx/.chat.rwr.ink.conf.dooragent.epoch-7.bak",
        kind: "copy-file",
        overwrite: false,
        source: "/www/server/panel/vhost/nginx/chat.rwr.ink.conf",
      },
      {
        kind: "verify-sha256",
        path: "/www/server/panel/vhost/nginx/.chat.rwr.ink.conf.dooragent.epoch-7.bak",
        sha256: "a".repeat(64),
      },
      {
        kind: "verify-sha256",
        path: "/www/server/panel/vhost/nginx/.chat.rwr.ink.conf.dsh.epoch-7",
        sha256: "b".repeat(64),
      },
      { kind: "fsync-directory", path: "/www/server/panel/vhost/nginx" },
    ]);
    expect(plan.verify).toEqual([
      {
        args: ["-p", "2468", "-o", "pid=,ppid=,args="],
        executable: "/usr/bin/ps",
        expectedStdoutIncludes: [
          "/www/server/nginx/sbin/nginx",
          "-c",
          "/www/server/nginx/conf/nginx.conf",
        ],
        kind: "exec",
        requiredEnvironment: [],
      },
      {
        args: ["-t", "-c", "/www/server/nginx/conf/nginx.conf"],
        executable: "/www/server/nginx/sbin/nginx",
        kind: "exec",
        requiredEnvironment: [],
      },
    ]);
    expect(plan.activate).toEqual([
      { args: ["-HUP", "2468"], executable: "/bin/kill", kind: "exec", requiredEnvironment: [] },
    ]);
    expect(plan.rollback).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "copy-file",
          source: "/www/server/panel/vhost/nginx/.chat.rwr.ink.conf.dooragent.epoch-7.bak",
        }),
      ]),
    );
    expect(plan.verify.map(({ executable }) => executable)).not.toContain("/usr/bin/systemctl");
  });

  it("rejects switch targets outside their controlled parent", () => {
    expect(() =>
      planReleaseSwitch({
        currentLink: "/opt/dsh/current",
        nextRelease: "/tmp/foreign",
        previousRelease: "/opt/dsh/releases/old",
        transactionId: "deploy-1",
      }),
    ).toThrow(/release root/);
  });
});
