#!/usr/bin/env bash
set -euo pipefail

readonly DSH_DEPLOY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly DSH_REPO_ROOT="$(cd -- "${DSH_DEPLOY_ROOT}/../../.." && pwd -P)"
readonly DSH_LINUX_DIST="${DSH_REPO_ROOT}/infra/linux/dist/index.js"

die() {
  printf 'dsh-deploy: %s\n' "$*" >&2
  return 1
}

log() {
  printf 'dsh-deploy: %s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

require_root() {
  [[ "${EUID}" -eq 0 ]] || die "this operation must run as root"
}

require_absolute_path() {
  local path="$1"
  local label="$2"
  if [[ "${path}" != /* ]]; then
    die "${label} must be an absolute path"
    return 1
  fi
  if [[ "${path}" == *$'\n'* || "${path}" == *$'\r'* ]]; then
    die "${label} contains a line break"
    return 1
  fi
}

require_regular_file() {
  local path="$1"
  local label="$2"
  require_absolute_path "${path}" "${label}" || return 1
  if [[ ! -f "${path}" || -L "${path}" ]]; then
    die "${label} must be a non-symlink regular file"
    return 1
  fi
}

assert_new_path() {
  local path="$1"
  local label="$2"
  require_absolute_path "${path}" "${label}" || return 1
  if [[ -e "${path}" || -L "${path}" ]]; then
    die "${label} already exists: ${path}"
    return 1
  fi
}

assert_sha256() {
  local value="$1"
  local label="$2"
  if [[ ! "${value}" =~ ^[a-f0-9]{64}$ ]]; then
    die "${label} must be a lowercase SHA-256"
    return 1
  fi
}

sha256_file() {
  local path="$1"
  require_regular_file "${path}" "digest input" || return 1
  sha256sum -- "${path}" | awk '{print $1}'
}

assert_file_sha256() {
  local path="$1" expected_sha="$2" label="$3"
  require_regular_file "${path}" "${label}" || return 1
  assert_sha256 "${expected_sha}" "${label} SHA-256" || return 1
  if [[ "$(sha256_file "${path}")" != "${expected_sha}" ]]; then
    die "${label} SHA-256 drifted"
    return 1
  fi
}

file_size() {
  local path="$1"
  require_regular_file "${path}" "size input" || return 1
  wc -c <"${path}" | tr -d '[:space:]'
}

verify_file_record() {
  local path="$1"
  local expected_size="$2"
  local expected_sha="$3"
  require_regular_file "${path}" "closure file" || return 1
  if [[ ! "${expected_size}" =~ ^[0-9]+$ ]]; then
    die "expected size is invalid"
    return 1
  fi
  assert_sha256 "${expected_sha}" "expected digest" || return 1
  if [[ "$(file_size "${path}")" != "${expected_size}" ]]; then
    die "size mismatch: ${path}"
    return 1
  fi
  if [[ "$(sha256_file "${path}")" != "${expected_sha}" ]]; then
    die "SHA-256 mismatch: ${path}"
    return 1
  fi
}

assert_source_freeze_gate() {
  local manifest="$1"
  local approval="$2"
  local expected_sha="$3"
  require_regular_file "${manifest}" "source-freeze manifest" || return 1
  require_regular_file "${approval}" "source-freeze approval" || return 1
  assert_sha256 "${expected_sha}" "source-freeze SHA-256" || return 1
  if [[ "$(sha256_file "${manifest}")" != "${expected_sha}" ]]; then
    die "source-freeze manifest SHA-256 drifted"
    return 1
  fi
  require_command node || return 1
  node --input-type=module - "${approval}" "${expected_sha}" <<'NODE'
import { readFileSync } from "node:fs";

const [, , approvalPath, expectedSha] = process.argv;
let value;
try {
  value = JSON.parse(readFileSync(approvalPath, "utf8"));
} catch {
  console.error("dsh-deploy: source-freeze approval is not valid JSON");
  process.exit(1);
}
const keys = Object.keys(value).sort().join(",");
const expectedKeys = "reviewedBy,schemaVersion,scope,sourceManifestSha256,status";
if (keys !== expectedKeys || value.schemaVersion !== 1 || value.status !== "green" ||
    value.reviewedBy !== "root" || value.scope !== "bootstrap-stage") {
  console.error("dsh-deploy: rehearsal approval is not root green for bootstrap-stage");
  process.exit(1);
}
if (value.sourceManifestSha256 !== expectedSha) {
  console.error("dsh-deploy: source-freeze approval SHA-256 does not match");
  process.exit(1);
}
NODE
}

assert_release_stage_gate() {
  local approval="$1" source_sha="$2" artifact_sha="$3" runtime_sha="$4"
  local release_id="$5" run_id="$6"
  require_regular_file "${approval}" "release-stage approval" || return 1
  assert_sha256 "${source_sha}" "source manifest SHA-256" || return 1
  assert_sha256 "${artifact_sha}" "artifact SHA-256" || return 1
  assert_sha256 "${runtime_sha}" "runtime manifest SHA-256" || return 1
  [[ "${release_id}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { die "release id is invalid"; return 1; }
  [[ "${run_id}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { die "release run id is invalid"; return 1; }
  node --input-type=module - "${approval}" "${source_sha}" "${artifact_sha}" \
    "${runtime_sha}" "${release_id}" "${run_id}" <<'NODE'
import { readFileSync } from "node:fs";

const [, , path, sourceSha, artifactSha, runtimeSha, releaseId, runId] = process.argv;
let value;
try {
  value = JSON.parse(readFileSync(path, "utf8"));
} catch {
  console.error("dsh-deploy: release-stage approval is not valid JSON");
  process.exit(1);
}
const expectedKeys = ["artifactSha256", "releaseId", "reviewedBy", "runId", "runtimeManifestSha256",
  "schemaVersion", "scope", "sourceManifestSha256", "status"].sort().join(",");
const valid = Object.keys(value).sort().join(",") === expectedKeys && value.schemaVersion === 1 &&
  value.status === "green" && value.reviewedBy === "root" && value.scope === "release-stage" &&
  value.sourceManifestSha256 === sourceSha && value.artifactSha256 === artifactSha &&
  value.runtimeManifestSha256 === runtimeSha && value.releaseId === releaseId && value.runId === runId;
if (!valid) {
  console.error("dsh-deploy: release-stage approval does not match the staged release");
  process.exit(1);
}
NODE
}

print_argv() {
  printf 'DRY-RUN:'
  printf ' %q' "$@"
  printf '\n'
}

apt_transaction() {
  DEBIAN_FRONTEND=noninteractive apt-get -y --no-remove --no-install-recommends "$@"
}

assert_release_root() {
  local root="$1"
  require_absolute_path "${root}" "releases root" || return 1
  if [[ "${DSH_DEPLOY_TESTING:-0}" != "1" && "${root}" != "/opt/dsh/releases" ]]; then
    die "production releases root must be /opt/dsh/releases"
    return 1
  fi
}

require_linux_build() {
  require_regular_file "${DSH_LINUX_DIST}" "built Linux runtime module"
}
