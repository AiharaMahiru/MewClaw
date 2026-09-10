/**
 * PgCronDatabase 池生命周期测试：close 后连接池终结、查询拒绝
 * （插件 disposer 依赖该语义；不触网——pg Pool 只在查询时连接）。
 */
import { describe, expect, it } from "vitest";

import { PgCronDatabase } from "./store-pg.js";

describe("PgCronDatabase", () => {
  it("close() 终结连接池，后续查询拒绝（disposer 语义）", async () => {
    const database = new PgCronDatabase("postgres://127.0.0.1:1/cron");
    await database.close();
    await expect(database.query("SELECT 1")).rejects.toThrow();
    // pg 池契约：重复 end 拒绝（effect disposer 只执行一次，不防御二次关闭）。
    await expect(database.close()).rejects.toThrow("more than once");
  });
});
