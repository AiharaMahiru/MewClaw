/**
 * 发行版清单与版本解析。
 * 来源：lark-claw packages/postgres-runtime（整体平移，M0）。
 */
import { POSTGRES_VERSION, PGVECTOR_VERSION, PGWEB_VERSION } from "./config.js";

export const POSTGRES_ARCHIVE = {
  url: `https://get.enterprisedb.com/postgresql/postgresql-${POSTGRES_VERSION}-windows-x64-binaries.zip`,
  bytes: 334_313_473,
  md5: "25998f9e9ee62c508d60d6dcfce90704",
  sha256: "e4b31879202d87894375eee6cfc88adf5afbb030687a3674361d78e427357f24",
} as const;

export const PGVECTOR_SOURCE = {
  repository: "https://github.com/pgvector/pgvector.git",
  tag: `v${PGVECTOR_VERSION}`,
  commit: "778dacf20c07caf904557a88705142631818d8cb",
} as const;

export const PGWEB_ARCHIVE = {
  version: PGWEB_VERSION,
  url: `https://github.com/sosedoff/pgweb/releases/download/v${PGWEB_VERSION}/pgweb_windows_amd64.zip`,
  bytes: 6_983_325,
  sha256: "7471bb79175549622f90877f5aec69c20ec014b3d4b3df288c1121f8775728bc",
} as const;
