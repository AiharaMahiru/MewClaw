import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type {
  AuthCredentialRollbackSnapshot,
  AuthCredentialRollbackStore,
} from "./capability.js";

const ALGORITHM = "aes-256-gcm";
const VERSION = 1;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const DIGEST = /^[a-f0-9]{64}$/;
const ENCODED_KEY = /^[A-Za-z0-9_-]{43}$/;
const HEX_KEY = /^[a-f0-9]{64}$/;

export type CredentialRollbackSnapshot = AuthCredentialRollbackSnapshot;

interface Envelope {
  version: 1;
  algorithm: typeof ALGORITHM;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class CredentialRollbackStoreError extends Error {
  constructor(readonly code: "INVALID_KEY" | "INVALID_PATH" | "CORRUPT" | "CONFLICT" | "CLOSED") {
    super(`credential rollback store: ${code}`);
    this.name = "CredentialRollbackStoreError";
  }
}

export class FileCredentialRollbackStore implements AuthCredentialRollbackStore {
  private readonly key: Buffer;
  private closed = false;

  constructor(private readonly root: string, keyMaterial: string) {
    if (!isAbsolute(root)) throw new CredentialRollbackStoreError("INVALID_PATH");
    this.key = decodeKey(keyMaterial);
  }

  async save(input: CredentialRollbackSnapshot): Promise<void> {
    this.assertOpen();
    validateSnapshot(input);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    const target = this.filePath(input.snapshotRef);
    const existing = await this.readIfPresent(target, input.snapshotRef);
    if (existing) {
      if (sameSnapshot(existing, input)) return;
      throw new CredentialRollbackStoreError("CONFLICT");
    }
    const envelope = this.encrypt(input);
    const temporary = join(this.root, `.${this.fileName(input.snapshotRef)}.${randomBytes(8).toString("hex")}.tmp`);
    await this.writeAtomic(temporary, target, envelope, input.snapshotRef, input);
  }

  async load(snapshotRef: string): Promise<CredentialRollbackSnapshot | undefined> {
    this.assertOpen();
    validateRef(snapshotRef);
    return this.readIfPresent(this.filePath(snapshotRef), snapshotRef);
  }

  read(snapshotRef: string): Promise<CredentialRollbackSnapshot | undefined> {
    return this.load(snapshotRef);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.key.fill(0);
  }

  private encrypt(snapshot: CredentialRollbackSnapshot): Envelope {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(aad(snapshot.snapshotRef));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(snapshot), "utf8"), cipher.final()]);
    return {
      version: VERSION,
      algorithm: ALGORITHM,
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
  }

  private decrypt(envelope: Envelope, snapshotRef: string): CredentialRollbackSnapshot {
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(envelope.iv, "base64url"));
      decipher.setAAD(aad(snapshotRef));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      const value = JSON.parse(plaintext) as unknown;
      if (!isSnapshot(value) || value.snapshotRef !== snapshotRef) throw new Error("invalid payload");
      return value;
    } catch {
      throw new CredentialRollbackStoreError("CORRUPT");
    }
  }

  private async readIfPresent(path: string, snapshotRef: string): Promise<CredentialRollbackSnapshot | undefined> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new CredentialRollbackStoreError("CORRUPT");
    }
    let envelope: unknown;
    try { envelope = JSON.parse(raw); } catch { throw new CredentialRollbackStoreError("CORRUPT"); }
    if (!isEnvelope(envelope)) throw new CredentialRollbackStoreError("CORRUPT");
    return this.decrypt(envelope, snapshotRef);
  }

  private async writeAtomic(
    temporary: string,
    target: string,
    envelope: Envelope,
    snapshotRef: string,
    expected: CredentialRollbackSnapshot,
  ): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify(envelope), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await link(temporary, target);
      await chmod(target, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const current = await this.readIfPresent(target, snapshotRef);
        if (current && sameSnapshot(current, expected)) return;
        throw new CredentialRollbackStoreError("CONFLICT");
      }
      throw new CredentialRollbackStoreError("CORRUPT");
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  private fileName(snapshotRef: string): string {
    return createHash("sha256").update(snapshotRef, "utf8").digest("hex");
  }

  private filePath(snapshotRef: string): string {
    return join(this.root, `${this.fileName(snapshotRef)}.json`);
  }

  private assertOpen(): void {
    if (this.closed) throw new CredentialRollbackStoreError("CLOSED");
  }
}

export function decodeCredentialRollbackKey(value: string): Buffer {
  return decodeKey(value);
}

function decodeKey(value: string): Buffer {
  if (HEX_KEY.test(value)) return Buffer.from(value, "hex");
  if (ENCODED_KEY.test(value)) {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length === KEY_BYTES && decoded.toString("base64url") === value) return decoded;
  }
  throw new CredentialRollbackStoreError("INVALID_KEY");
}

function aad(snapshotRef: string): Buffer {
  return Buffer.from(`dsh-credential-rollback:v${VERSION}\0${snapshotRef}`, "utf8");
}

function validateSnapshot(value: CredentialRollbackSnapshot): void {
  validateRef(value.snapshotRef);
  validateText(value.targetUserId);
  validateText(value.encoded);
  if (!DIGEST.test(value.sourceDigest) || !DIGEST.test(value.snapshotDigest)) {
    throw new CredentialRollbackStoreError("CORRUPT");
  }
}

function validateRef(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\r\n]/.test(value)) {
    throw new CredentialRollbackStoreError("CORRUPT");
  }
}

function validateText(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new CredentialRollbackStoreError("CORRUPT");
  }
}

function isEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.version === VERSION && item.algorithm === ALGORITHM
    && typeof item.iv === "string" && typeof item.tag === "string"
    && typeof item.ciphertext === "string";
}

function isSnapshot(value: unknown): value is CredentialRollbackSnapshot {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.snapshotRef === "string" && typeof item.targetUserId === "string"
    && typeof item.encoded === "string" && typeof item.sourceDigest === "string"
    && typeof item.snapshotDigest === "string";
}

function sameSnapshot(left: CredentialRollbackSnapshot, right: CredentialRollbackSnapshot): boolean {
  return left.snapshotRef === right.snapshotRef && left.targetUserId === right.targetUserId
    && left.encoded === right.encoded && left.sourceDigest === right.sourceDigest
    && left.snapshotDigest === right.snapshotDigest;
}
