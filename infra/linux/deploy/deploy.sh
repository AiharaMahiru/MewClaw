#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

# shellcheck source=lib/common.sh
source "${SCRIPT_ROOT}/lib/common.sh"
# shellcheck source=lib/debian-archive.sh
source "${SCRIPT_ROOT}/lib/debian-archive.sh"
# shellcheck source=lib/closure-manifest.sh
source "${SCRIPT_ROOT}/lib/closure-manifest.sh"
# shellcheck source=lib/closure.sh
source "${SCRIPT_ROOT}/lib/closure.sh"
# shellcheck source=lib/preflight.sh
source "${SCRIPT_ROOT}/lib/preflight.sh"
# shellcheck source=lib/bootstrap.sh
source "${SCRIPT_ROOT}/lib/bootstrap.sh"
# shellcheck source=lib/stage.sh
source "${SCRIPT_ROOT}/lib/stage.sh"

usage() {
  printf '%s\n' \
    'Usage:' \
    '  deploy.sh preflight [--production-lock ABS] [--dry-run]' \
    '  deploy.sh closure --closure-dir ABS --source-freeze-manifest ABS' \
    '    --source-freeze-approval ABS --source-freeze-sha256 HEX [--production-lock ABS] [--dry-run]' \
    '  deploy.sh bootstrap --closure-dir ABS --source-freeze-manifest ABS' \
    '    --source-freeze-approval ABS --source-freeze-sha256 HEX [--production-lock ABS] [--dry-run]' \
    '  deploy.sh stage --archive ABS --artifact-sha256 HEX --runtime-manifest ABS --release-id ID' \
    '    --source-freeze-manifest ABS --release-stage-approval ABS --source-freeze-sha256 HEX [--dry-run]'
}

run_closure_command() {
  local production_lock="${DSH_REPO_ROOT}/infra/linux/production.lock.json"
  local closure_dir="" freeze_manifest="" freeze_approval="" freeze_sha="" dry_run=0
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --production-lock) production_lock="$(parse_value "$1" "${2:-}")"; shift 2 ;;
      --closure-dir) closure_dir="$(parse_value "$1" "${2:-}")"; shift 2 ;;
      --source-freeze-manifest) freeze_manifest="$(parse_value "$1" "${2:-}")"; shift 2 ;;
      --source-freeze-approval) freeze_approval="$(parse_value "$1" "${2:-}")"; shift 2 ;;
      --source-freeze-sha256) freeze_sha="$(parse_value "$1" "${2:-}")"; shift 2 ;;
      --dry-run) dry_run=1; shift ;;
      *) die "unknown closure option: $1" ;;
    esac
  done
  [[ -n "${closure_dir}" && -n "${freeze_manifest}" && -n "${freeze_approval}" && -n "${freeze_sha}" ]] || \
    die "closure requires target and source-freeze arguments"
  prepare_bootstrap_closure "${production_lock}" "${closure_dir}" "${freeze_manifest}" \
    "${freeze_approval}" "${freeze_sha}" "${dry_run}"
}

parse_value() {
  local option="$1"
  local value="${2:-}"
  [[ -n "${value}" && "${value}" != --* ]] || die "missing value for ${option}"
  printf '%s\n' "${value}"
}

run_preflight_command() {
  local production_lock="${DSH_REPO_ROOT}/infra/linux/production.lock.json"
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --production-lock) production_lock="$(parse_value "$1" "${2:-}")"; shift 2 ;;
      --dry-run) shift ;;
      *) die "unknown preflight option: $1" ;;
    esac
  done
  run_host_preflight "${production_lock}"
}

run_bootstrap_command() {
  local production_lock="${DSH_REPO_ROOT}/infra/linux/production.lock.json"
  local closure_dir="" freeze_manifest="" freeze_approval="" freeze_sha="" dry_run=0
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --production-lock) production_lock="$(parse_value "$1" "${2:-}")"; shift 2 ;;
      --closure-dir) closure_dir="$(parse_value "$1" "${2:-}")"; shift 2 ;;
      --source-freeze-manifest) freeze_manifest="$(parse_value "$1" "${2:-}")"; shift 2 ;;
      --source-freeze-approval) freeze_approval="$(parse_value "$1" "${2:-}")"; shift 2 ;;
      --source-freeze-sha256) freeze_sha="$(parse_value "$1" "${2:-}")"; shift 2 ;;
      --dry-run) dry_run=1; shift ;;
      *) die "unknown bootstrap option: $1" ;;
    esac
  done
  [[ -n "${closure_dir}" && -n "${freeze_manifest}" && -n "${freeze_approval}" && -n "${freeze_sha}" ]] || \
    die "bootstrap requires closure and source-freeze arguments"
  bootstrap_runtime "${production_lock}" "${closure_dir}" "${freeze_manifest}" "${freeze_approval}" "${freeze_sha}" "${dry_run}"
}

run_stage_command() {
  local archive="" artifact_sha="" runtime_manifest="" release_id=""
  local freeze_manifest="" release_approval="" freeze_sha="" dry_run=0
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --archive) archive="$(parse_value "$1" "${2:-}")"; shift 2 ;;
      --artifact-sha256) artifact_sha="$(parse_value "$1" "${2:-}")"; shift 2 ;;
      --runtime-manifest) runtime_manifest="$(parse_value "$1" "${2:-}")"; shift 2 ;;
      --release-id) release_id="$(parse_value "$1" "${2:-}")"; shift 2 ;;
      --source-freeze-manifest) freeze_manifest="$(parse_value "$1" "${2:-}")"; shift 2 ;;
      --release-stage-approval) release_approval="$(parse_value "$1" "${2:-}")"; shift 2 ;;
      --source-freeze-sha256) freeze_sha="$(parse_value "$1" "${2:-}")"; shift 2 ;;
      --dry-run) dry_run=1; shift ;;
      *) die "unknown stage option: $1" ;;
    esac
  done
  [[ -n "${archive}" && -n "${artifact_sha}" && -n "${runtime_manifest}" && -n "${release_id}" ]] || \
    die "stage requires archive, artifact digest, runtime manifest, and release id"
  [[ -n "${freeze_manifest}" && -n "${release_approval}" && -n "${freeze_sha}" ]] || \
    die "stage requires source-freeze manifest and artifact-bound release approval"
  stage_release "${archive}" "${artifact_sha}" "${runtime_manifest}" "${release_id}" \
    "/opt/dsh/releases" "${freeze_manifest}" "${release_approval}" "${freeze_sha}" "${dry_run}"
}

main() {
  local command="${1:-}"
  [[ -n "${command}" ]] || { usage >&2; return 1; }
  shift
  case "${command}" in
    preflight) run_preflight_command "$@" ;;
    closure) run_closure_command "$@" ;;
    bootstrap) run_bootstrap_command "$@" ;;
    stage) run_stage_command "$@" ;;
    --help|-h|help) usage ;;
    *) die "unknown command: ${command}" ;;
  esac
}

main "$@"
