import { describe, it, expect } from "vitest";
import Schema from "@deepseek-ai/schemastery";
import { RemoteSettingsMirror, RemoteSettingsSchema, RemoteSettingsScope, type SettingsRemote } from "./client-settings.js";

const namespace = { ns: "example", revision: 1, value: { enabled: true }, base: {}, user: {}, schema: Schema.object({ enabled: Schema.boolean() }).toJSON() };
describe("公网设置 Provider", () => {
  it("合流首次读取且不暴露本机设置文档", async () => {
    let reads = 0;
    const remote: SettingsRemote = { describe: async () => { reads++; return { ok: true, value: { namespaces: [namespace], writable: false, hasDocument: true } }; }, mutate: async () => { throw new Error("不应写入"); } };
    const mirror = new RemoteSettingsMirror(remote);
    await Promise.all([mirror.ensure(), mirror.ensure()]);
    expect(reads).toBe(1);
    expect(mirror.getSnapshot().view?.hasDocument).toBe(false);
    const scope = new RemoteSettingsScope(mirror, { namespace: "example" }, new RemoteSettingsSchema());
    expect(scope.getSnapshot()).toMatchObject({ status: "ready", writable: false, value: { enabled: true } });
    await scope.set("enabled", false);
    await scope.dispose(); mirror.dispose();
  });
  it("失败可重试，写入按最新 revision 排队", async () => {
    let reads = 0;
    let revision = 1;
    const revisions: Array<number | undefined> = [];
    const remote: SettingsRemote = {
      describe: async () => { reads++; if (reads === 1) throw new Error("offline"); return { ok: true, value: { namespaces: [namespace], writable: true, hasDocument: true } }; },
      mutate: async (_ns, _ops, expected) => { revisions.push(expected); return { ok: true, value: { ...namespace, revision: ++revision } }; },
    };
    const mirror = new RemoteSettingsMirror(remote);
    await mirror.ensure(); expect(mirror.getSnapshot().error).toContain("offline");
    await mirror.ensure();
    const scope = new RemoteSettingsScope(mirror, { namespace: "example" }, new RemoteSettingsSchema());
    await Promise.all([scope.set("enabled", false), scope.set("enabled", true)]);
    expect(revisions).toEqual([1, 2]);
    await scope.dispose(); await scope.set("enabled", false);
    expect(revisions).toHaveLength(2);
    mirror.dispose();
  });
  it("草稿编辑不改原对象并拒绝原型路径", () => {
    const schema = new RemoteSettingsSchema();
    const original = { models: [{ id: "one" }] };
    expect(schema.setPath(original, ["models", "0", "id"], "two")).toEqual({ models: [{ id: "two" }] });
    expect(original.models[0]?.id).toBe("one");
    expect(() => schema.setPath({}, ["__proto__", "bad"], true)).toThrow();
  });
});
