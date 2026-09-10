export interface SkillCapabilities {
  filesystem?: string[];
  network?: string[];
  credentialRefs?: string[];
  subprocess?: boolean;
}

export type SkillMetadataField = "version" | "capabilities";

export class SkillMetadataError extends Error {
  readonly field: SkillMetadataField;
  constructor(field: SkillMetadataField, message: string);
}

export function normalizeCapabilities(value: unknown): SkillCapabilities;
export function parseSkillMetadata(content: string): {
  version: string;
  capabilities: SkillCapabilities;
};
