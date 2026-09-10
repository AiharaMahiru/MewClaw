import { DEFAULT_CHUNK_OPTIONS, type ChunkOptions } from "./chunker.js";

export interface KnowledgePipelineConfigInput {
  chunkOptions?: Partial<ChunkOptions> | undefined;
  topK?: number | undefined;
  candidateCount?: number | undefined;
  rerank?: boolean | undefined;
  ingestionConcurrency?: number | undefined;
  maxSourceBytes?: number | undefined;
}

interface Bounds {
  field: string;
  minimum: number;
  maximum: number;
}

interface RetrievalDefaults {
  topK: number;
  candidateCount: number;
}

export type ResolvedRetrievalOptions = RetrievalDefaults;

export interface ResolvedKnowledgePipelineOptions extends ResolvedRetrievalOptions {
  chunkOptions: ChunkOptions;
  rerank: boolean;
  ingestionConcurrency: number;
  maxSourceBytes: number;
}

const DEFAULT_TOP_K = 5;
const DEFAULT_CANDIDATE_COUNT = 20;
const DEFAULT_INGESTION_CONCURRENCY = 2;
const DEFAULT_MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const MIN_TOP_K = 1;
const MAX_TOP_K = 20;
const MIN_CANDIDATE_COUNT = 1;
const MAX_CANDIDATE_COUNT = 100;
const MIN_INGESTION_CONCURRENCY = 1;
const MAX_INGESTION_CONCURRENCY = 8;
const MIN_SOURCE_BYTES = 1;
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const MIN_CHUNK_CHARACTERS = 1;
const MAX_CHUNK_CHARACTERS = 100_000;
const MIN_OVERLAP_CHARACTERS = 0;

const TOP_K_BOUNDS: Bounds = { field: "topK", minimum: MIN_TOP_K, maximum: MAX_TOP_K };
const CANDIDATE_COUNT_BOUNDS: Bounds = {
  field: "candidateCount",
  minimum: MIN_CANDIDATE_COUNT,
  maximum: MAX_CANDIDATE_COUNT,
};
const CONCURRENCY_BOUNDS: Bounds = {
  field: "ingestionConcurrency",
  minimum: MIN_INGESTION_CONCURRENCY,
  maximum: MAX_INGESTION_CONCURRENCY,
};
const SOURCE_SIZE_BOUNDS: Bounds = { field: "maxSourceBytes", minimum: MIN_SOURCE_BYTES, maximum: MAX_SOURCE_BYTES };
const CHUNK_SIZE_BOUNDS: Bounds = {
  field: "maxCharacters",
  minimum: MIN_CHUNK_CHARACTERS,
  maximum: MAX_CHUNK_CHARACTERS,
};

function requireInteger(value: number, bounds: Bounds): number {
  if (!Number.isSafeInteger(value) || value < bounds.minimum || value > bounds.maximum) {
    throw new Error(`knowledge-postgres: ${bounds.field} must be an integer in [${bounds.minimum}, ${bounds.maximum}]`);
  }
  return value;
}

function resolveInteger(value: number | undefined, bounds: Bounds, fallback: number): number {
  return requireInteger(value === undefined ? fallback : value, bounds);
}

function resolveChunkOptions(value: Partial<ChunkOptions> | undefined): ChunkOptions {
  if (value === undefined) return { ...DEFAULT_CHUNK_OPTIONS };
  const maxCharacters = resolveInteger(value.maxCharacters, CHUNK_SIZE_BOUNDS, DEFAULT_CHUNK_OPTIONS.maxCharacters);
  const overlapCharacters = resolveInteger(value.overlapCharacters, {
    field: "overlapCharacters",
    minimum: MIN_OVERLAP_CHARACTERS,
    maximum: maxCharacters - 1,
  }, DEFAULT_CHUNK_OPTIONS.overlapCharacters);
  return { maxCharacters, overlapCharacters };
}

function resolveRerank(value: boolean | undefined): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean") throw new Error("knowledge-postgres: rerank must be a boolean");
  return value;
}

export function resolveRetrievalOptions(
  input: Pick<KnowledgePipelineConfigInput, "topK" | "candidateCount">,
  defaults: RetrievalDefaults,
): ResolvedRetrievalOptions {
  return {
    topK: resolveInteger(input.topK, TOP_K_BOUNDS, defaults.topK),
    candidateCount: resolveInteger(input.candidateCount, CANDIDATE_COUNT_BOUNDS, defaults.candidateCount),
  };
}

export function resolveKnowledgePipelineOptions(input: KnowledgePipelineConfigInput): ResolvedKnowledgePipelineOptions {
  return {
    chunkOptions: resolveChunkOptions(input.chunkOptions),
    ...resolveRetrievalOptions(input, { topK: DEFAULT_TOP_K, candidateCount: DEFAULT_CANDIDATE_COUNT }),
    rerank: resolveRerank(input.rerank),
    ingestionConcurrency: resolveInteger(input.ingestionConcurrency, CONCURRENCY_BOUNDS, DEFAULT_INGESTION_CONCURRENCY),
    maxSourceBytes: resolveInteger(input.maxSourceBytes, SOURCE_SIZE_BOUNDS, DEFAULT_MAX_SOURCE_BYTES),
  };
}
