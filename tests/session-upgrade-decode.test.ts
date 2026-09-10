import { zstdCompressSync } from "node:zlib";
import { expect, it } from "vitest";
import { decodeRows } from "../scripts/session-upgrade/decode.js";

it("多帧解码保留所有行，也允许 JSON 行跨帧", () => {
  const source = Buffer.concat([zstdCompressSync('{"a":1}\n{"'), zstdCompressSync('b":2}\n')]);
  expect(decodeRows(source, true)).toEqual([{ a: 1 }, { b: 2 }]);
});
it("拒绝损坏尾帧和多余垃圾，不返回第一帧的部分成功", () => {
  const first = zstdCompressSync('{}\n');
  const second = zstdCompressSync('{"body":"正文"}\n');
  expect(() => decodeRows(Buffer.concat([first, second.subarray(0, second.length - 2)]), true)).toThrow();
  expect(() => decodeRows(Buffer.concat([first, Buffer.from('garbage')]), true)).toThrow();
});
it("累计所有帧实施上限", () => {
  const frame = zstdCompressSync('{}\n');
  expect(() => decodeRows(Buffer.concat([frame, frame]), true, 5)).toThrow();
  expect(decodeRows(Buffer.concat([frame, frame]), true, 6)).toEqual([{}, {}]);
  expect(() => decodeRows(Buffer.from('{}\n'), false, 2)).toThrow();
});
it("拒绝非法 UTF8、非法 JSON 和未完成尾行", () => {
  expect(() => decodeRows(Buffer.from([255, 10]), false)).toThrow();
  expect(() => decodeRows(Buffer.from('secret-invalid\n'), false)).toThrow("invalid JSONL row");
  expect(() => decodeRows(Buffer.from('{}'), false)).toThrow("tail");
});
