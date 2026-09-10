/**
 * 富格式提取测试（内容驱动）：PDF/DOCX/XLSX 在扩展名缺失或错误时仍按
 * 真实内容分派到对应解析器。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectContent } from "./detect.js";
import { extractFile, MAX_RICH_EXTRACTED_TEXT_CHARS } from "./extract.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dsh-lark-extract-rich-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 最小合法 PDF（含一行可提取文本）。 */
function minimalPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n`;
    body += objects[index]!;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    body += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** 最小 DOCX（Content_Types + word/document.xml）。 */
function minimalDocx(text: string): Buffer {
  return Buffer.from(zipSync({
    "[Content_Types].xml": new TextEncoder().encode(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + "</Types>",
    ),
    "word/document.xml": new TextEncoder().encode(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ),
  }));
}

/** 最小 XLSX（Content_Types + workbook + 一个 sheet）。 */
function minimalXlsx(): Buffer {
  return Buffer.from(zipSync({
    "[Content_Types].xml": new TextEncoder().encode(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + "</Types>",
    ),
    "xl/workbook.xml": new TextEncoder().encode(
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    "xl/_rels/workbook.xml.rels": new TextEncoder().encode(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + "</Relationships>",
    ),
    "xl/worksheets/sheet1.xml": new TextEncoder().encode(
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>名称</t></is></c><c r="B1" t="inlineStr"><is><t>数量</t></is></c></row>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>苹果</t></is></c><c r="B2"><v>3</v></c></row>'
      + "</sheetData></worksheet>",
    ),
  }));
}

describe("detectContent 富格式", () => {
  it("扩展名缺失或错误时按真实内容分派", async () => {
    const pdfPath = join(dir, "sample");
    await writeFile(pdfPath, minimalPdf("HelloPDF"));
    expect((await detectContent(pdfPath)).kind).toBe("pdf");

    const docxPath = join(dir, "fake.txt");
    await writeFile(docxPath, minimalDocx("DocText"));
    const docxDetected = await detectContent(docxPath);
    expect(docxDetected.kind).toBe("docx");
    expect(docxDetected.mimeType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");

    const xlsxPath = join(dir, "table");
    await writeFile(xlsxPath, minimalXlsx());
    expect((await detectContent(xlsxPath)).kind).toBe("xlsx");
  });

  it("普通 zip（非 Office）→ binary 明确类型", async () => {
    const path = join(dir, "archive.zip");
    await writeFile(path, Buffer.from(zipSync({ "a.txt": new TextEncoder().encode("x") })));
    const detection = await detectContent(path);
    expect(detection.kind).toBe("binary");
    expect(detection.mimeType).toBe("application/zip");
  });
});

describe("extractFile 富格式", () => {
  it("pdf 按内容提取文本（无扩展名）", async () => {
    const path = join(dir, "sample");
    await writeFile(path, minimalPdf("HelloPDF"));
    const result = await extractFile(path);
    expect(result.text).toContain("HelloPDF");
    expect(result.mimeType).toBe("text/plain");
  });

  it("docx 按内容提取（扩展名伪装 .txt 不影响分派）", async () => {
    const path = join(dir, "note.txt");
    await writeFile(path, minimalDocx("DocText"));
    const result = await extractFile(path);
    expect(result.text).toContain("DocText");
    expect(result.mimeType).toBe("text/plain");
  });

  it("xlsx 按内容提取（无扩展名）", async () => {
    const path = join(dir, "table");
    await writeFile(path, minimalXlsx());
    const result = await extractFile(path);
    expect(result.text).toContain("名称");
    expect(result.text).toContain("苹果");
  });

  it("富格式解压后的文本有独立输出预算", async () => {
    const path = join(dir, "oversized.txt");
    await writeFile(path, minimalDocx("x".repeat(MAX_RICH_EXTRACTED_TEXT_CHARS + 1)));
    await expect(extractFile(path)).rejects.toThrow(/富格式提取文本超过/);
  });
});
