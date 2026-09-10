/** Node 公共 zstd API 按实际消耗字节逐帧解码，禁止静默丢弃尾部。 */
import { zstdDecompressSync } from "node:zlib";
import { TextDecoder } from "node:util";

/**
 * 有界读取物理 JSONL 行，拒绝损坏压缩帧、非法 UTF-8 和不完整尾行。
 * @param source 完整源文件字节。
 * @param compressed 是否为 zstd 多帧文件。
 * @param maxDecodedBytes 所有帧累计明文上限。
 * @returns 尚未执行格式迁移的物理行。
 */
export function decodeRows(source: Buffer, compressed: boolean, maxDecodedBytes = 67108864): unknown[] {
  if (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 1) throw new Error("invalid decoded byte limit");
  const chunks: Buffer[] = [];
  let size = 0;
  if (compressed) {
    for (let offset = 0; offset < source.length;) {
      if (size >= maxDecodedBytes) throw new Error("decoded byte limit exceeded");
      // Node 的 info 返回引擎实际消耗字节；不能将单次成功当作整个多帧文件成功。
      const decoded = zstdDecompressSync(source.subarray(offset), { info: true, maxOutputLength: maxDecodedBytes - size }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      const consumed = decoded.engine.bytesWritten;
      if (!Number.isSafeInteger(consumed) || consumed <= 0 || consumed > source.length - offset) throw new Error("invalid zstd consumed byte count");
      offset += consumed;
      size += decoded.buffer.length;
      chunks.push(decoded.buffer);
    }
  } else {
    size = source.length;
    chunks.push(source);
  }
  if (size > maxDecodedBytes) throw new Error("decoded byte limit exceeded");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
  if (!text.endsWith("\n")) throw new Error("incomplete JSONL tail");
  try { return text.slice(0, -1).split("\n").map((line) => JSON.parse(line) as unknown); }
  catch { throw new Error("invalid JSONL row"); }
}
