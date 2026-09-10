import type { MemoryModality, MemoryNodeKind, MemoryPart } from "dsh-memory";

export const MAX_PARTS = 16;
export const MAX_TEXT = 100_000;
export const MAX_URI = 2_048;
export const MAX_METADATA_BYTES = 64 * 1024;

export function assertParts(parts: MemoryPart[]): void {
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_PARTS) {
    throw new Error("MEMORY_PARTS_INVALID");
  }
  for (const part of parts) {
    if (part.modality === "text") {
      if (!part.text.trim() || part.text.length > MAX_TEXT) throw new Error("MEMORY_TEXT_INVALID");
    } else if (part.modality === "image") {
      if (!part.uri.trim() || part.uri.length > MAX_URI) throw new Error("MEMORY_IMAGE_URI_INVALID");
    } else if (part.modality === "tool_trace") {
      if (!part.tool.trim() || part.tool.length > 256) throw new Error("MEMORY_TOOL_TRACE_INVALID");
    } else if (part.modality === "persona") {
      if (!part.trait.trim() || !part.value.trim() || part.confidence !== undefined && (part.confidence < 0 || part.confidence > 1)) throw new Error("MEMORY_PERSONA_INVALID");
    } else {
      throw new Error("MEMORY_MODALITY_INVALID");
    }
  }
}

export function assertMetadata(value: Record<string, unknown> | undefined): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("MEMORY_METADATA_INVALID");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_METADATA_BYTES) {
    throw new Error("MEMORY_METADATA_TOO_LARGE");
  }
}

export function searchableText(parts: MemoryPart[]): string {
  return parts.map((part) => {
    if (part.modality === "text") return part.text;
    if (part.modality === "image") return [part.alt, part.uri].filter(Boolean).join(" ");
    if (part.modality === "persona") return `${part.trait}: ${part.value}`;
    return `${part.tool} ${JSON.stringify(part.output ?? part.input ?? "")}`;
  }).join("\n").slice(0, MAX_TEXT);
}

export function primaryModality(parts: MemoryPart[]): MemoryModality {
  return parts[0]?.modality ?? "text";
}

export function inferKind(text: string): MemoryNodeKind {
  if (/偏好|喜欢|prefer|like/i.test(text)) return "preference";
  if (/目标|计划|goal|todo/i.test(text)) return "goal";
  if (/人格|性格|persona|称呼/i.test(text)) return "profile";
  return "fact";
}
