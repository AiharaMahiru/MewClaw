import { describe, expect, it, vi } from "vitest";

const createTransport = vi.hoisted(() => vi.fn(() => ({
  sendMail: vi.fn(async () => undefined),
})));

vi.mock("nodemailer", () => ({ default: { createTransport } }));

import nodemailer from "nodemailer";

import { createMailSender } from "./mail.js";

describe("createMailSender", () => {
  it("keeps TLS verification enabled while including the system CA store", async () => {
    const sender = createMailSender({ mode: "smtp", host: "smtp.example.test", port: 465, secure: true, user: "user", password: "password", from: "user@example.test" });
    await sender.sendVerification({ to: "recipient@example.test", displayName: "User", code: "123456", expiresInMinutes: 30 });

    expect(vi.mocked(nodemailer.createTransport)).toHaveBeenCalledWith(expect.objectContaining({
      tls: expect.objectContaining({ ca: expect.arrayContaining([expect.any(String)]) }),
    }));
  });
});
