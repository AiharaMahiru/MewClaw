import { expect, it } from "vitest";
import { requestImage } from "./client.js";

it("上游500分类为可重试但不自动重复收费请求，也不泄露凭证", async () => {
  let calls = 0;
  const config = { baseUrl: "https://image.example", apiKey: "synthetic-secret", model: "test" };
  const fetch = async () => { calls++; return new Response("synthetic-secret", { status: 500 }); };
  try { await requestImage(config, "test", [], fetch); throw new Error("unexpected success"); }
  catch (error) {
    expect(error).toMatchObject({ status: 500, retryable: true });
    expect(String(error)).not.toContain(config.apiKey);
    expect(String(error)).toContain("相同提示词重试");
  }
  expect(calls).toBe(1);
});
