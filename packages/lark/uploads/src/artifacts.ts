/** 工作区交付物的运行差异收集与 Worker 内部图片读取。 */
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { fileTypeFromBuffer } from "file-type";
import {
  isArtifactName,
  isImageArtifactMimeType,
  makeArtifactId,
  MAX_ARTIFACT_BYTES,
  scopeKey,
  type ArtifactId,
  type ArtifactImage,
  type ArtifactReadRequest,
  type Scope,
} from "dsh-lark-contracts";

/** 单个交付物与图片读取响应的固定上限。 */
export { MAX_ARTIFACT_BYTES };
const MAX_ARTIFACTS_PER_RUN = 10;

/** 一条落盘 `lark/artifact/created` 事件的数据。 */
export type CollectedArtifact = ArtifactReadRequest;

/** 运行前的可交付文件指纹；仅在同一 Worker 进程内使用。 */
export interface ArtifactSnapshot {
  files: ReadonlyMap<string, ArtifactFingerprint>;
}

interface ArtifactFingerprint {
  bytes: number;
  digest: string;
}

interface ArtifactFile extends ArtifactFingerprint {
  name: string;
  path: string;
  content: Buffer;
}

/** Worker 内部调用的读取参数；workspaceRoot 永不进入 Gateway wire。 */
export interface ArtifactReadInput extends ArtifactReadRequest {
  workspaceRoot: string;
}

function artifactId(digest: string, name: string): ArtifactId {
  return makeArtifactId(createHash("sha256").update(digest).update("\0").update(name).digest("hex"));
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readArtifactFile(workspace: string, name: string): Promise<ArtifactFile | undefined> {
  if (!isArtifactName(name)) return undefined;
  const path = join(workspace, name);
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_ARTIFACT_BYTES) return undefined;
    const content = await readFile(path);
    if (content.byteLength !== metadata.size) return undefined;
    return {
      name,
      path,
      content,
      bytes: content.byteLength,
      digest: createHash("sha256").update(content).digest("hex"),
    };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function topLevelFiles(workspace: string): Promise<ArtifactFile[]> {
  let entries;
  try {
    entries = await readdir(workspace, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const files: ArtifactFile[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile()) continue;
    const file = await readArtifactFile(workspace, entry.name);
    if (file) files.push(file);
  }
  return files;
}

/** 运行前记录当前可交付顶层文件，旧产物由此排除。 */
export async function snapshotArtifacts(workspace: string): Promise<ArtifactSnapshot> {
  const files = await topLevelFiles(workspace);
  return { files: new Map(files.map((file) => [file.name, { bytes: file.bytes, digest: file.digest }])) };
}

function changedSince(snapshot: ArtifactSnapshot, file: ArtifactFile): boolean {
  const previous = snapshot.files.get(file.name);
  return !previous || previous.bytes !== file.bytes || previous.digest !== file.digest;
}

/** 仅收集本轮新增或内容变化的顶层常规文件。 */
export async function collectArtifacts(
  scope: Scope,
  workspace: string,
  snapshot: ArtifactSnapshot | undefined,
): Promise<CollectedArtifact[]> {
  if (!snapshot) return [];
  const artifacts: CollectedArtifact[] = [];
  for (const file of await topLevelFiles(workspace)) {
    if (!changedSince(snapshot, file)) continue;
    artifacts.push({
      scope,
      artifactId: artifactId(file.digest, file.name),
      name: file.name,
      digest: file.digest,
      bytes: file.bytes,
    });
    if (artifacts.length === MAX_ARTIFACTS_PER_RUN) break;
  }
  return artifacts;
}

/** 以 Scope 派生目录后读取精确匹配的图片；任一不符都不泄露字节。 */
export async function readImageArtifact(input: ArtifactReadInput): Promise<ArtifactImage | undefined> {
  const workspace = resolve(input.workspaceRoot, scopeKey(input.scope));
  const file = await readArtifactFile(workspace, input.name).catch(() => undefined);
  if (!file || file.bytes !== input.bytes || file.digest !== input.digest) return undefined;
  if (artifactId(file.digest, file.name) !== input.artifactId) return undefined;
  const detected = await fileTypeFromBuffer(file.content).catch(() => undefined);
  if (!detected || !isImageArtifactMimeType(detected.mime)) return undefined;
  return { bytes: file.content, mimeType: detected.mime };
}
