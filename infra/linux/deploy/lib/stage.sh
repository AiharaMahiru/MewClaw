#!/usr/bin/env bash
set -euo pipefail

assert_release_id() {
  local value="$1"
  [[ "${value}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die "release id is invalid"
}

assert_archive_safe() {
  local archive="$1"
  require_regular_file "${archive}" "release archive" || return 1
  require_command tar || return 1
  local listing
  listing="$(tar --quoting-style=escape -tf "${archive}")"
  if [[ -z "${listing}" ]]; then
    die "release archive is empty"
    return 1
  fi
  if grep -Eq '(^|/)\.\.(/|$)|^/' <(printf '%s\n' "${listing}"); then
    die "release archive contains an unsafe path"
    return 1
  fi
  if tar --quoting-style=escape -tvf "${archive}" | awk 'substr($1, 1, 1) ~ /^[lhbcps]$/ { found = 1 } END { exit(found ? 0 : 1) }'; then
    die "release archive contains a link or special file"
    return 1
  fi
}

validate_runtime_manifest_for_stage() {
  local runtime_manifest="$1"
  local artifact_sha="$2"
  local production_lock_sha="$3"
  require_regular_file "${runtime_manifest}" "runtime manifest" || return 1
  require_linux_build || return 1
  node --input-type=module - "${DSH_LINUX_DIST}" "${runtime_manifest}" \
    "${artifact_sha}" "${production_lock_sha}" \
    "${DSH_REPO_ROOT}/infra/linux/production.lock.json" <<'NODE'
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [, , modulePath, manifestPath, artifactSha, productionLockSha, lockPath] = process.argv;
const { parseProductionPackageLock, parseProductionRuntimeManifest } = await import(pathToFileURL(modulePath));
let manifest;
let lock;
try {
  manifest = parseProductionRuntimeManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  lock = parseProductionPackageLock(JSON.parse(readFileSync(lockPath, "utf8")));
} catch (error) {
  console.error(`dsh-deploy: runtime manifest is invalid: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
}
if (manifest.release.artifactSha256 !== artifactSha || manifest.release.productionLockSha256 !== productionLockSha) {
  console.error("dsh-deploy: runtime manifest release digests do not match staged inputs");
  process.exit(1);
}
const packageVersion = (name) => lock.packages.find((entry) => entry.name === name)?.version;
if (manifest.database.version !== packageVersion("postgresql-17") ||
    manifest.database.vectorVersion !== packageVersion("postgresql-17-pgvector")) {
  console.error("dsh-deploy: runtime manifest database versions do not match the production lock");
  process.exit(1);
}
NODE
}

snapshot_stage_inputs() {
  local archive="$1" runtime_manifest="$2" approval="$3" input_dir="$4"
  local archive_snapshot="${input_dir}/release.tar"
  local runtime_snapshot="${input_dir}/runtime-manifest.json"
  local approval_snapshot="${input_dir}/release-approval.json"
  if [[ "${DSH_DEPLOY_TESTING:-0}" == "1" ]]; then
    cp --no-clobber -- "${archive}" "${archive_snapshot}"
    cp --no-clobber -- "${runtime_manifest}" "${runtime_snapshot}"
    cp --no-clobber -- "${approval}" "${approval_snapshot}"
  else
    install -m 0400 -- "${archive}" "${archive_snapshot}"
    install -m 0400 -- "${runtime_manifest}" "${runtime_snapshot}"
    install -m 0400 -- "${approval}" "${approval_snapshot}"
  fi
}

after_stage_input_snapshot() { :; }

validate_release_inputs() {
  local archive="$1" runtime_manifest="$2" approval="$3" artifact_sha="$4"
  local production_lock_sha="$5" source_sha="$6" release_id="$7"
  if [[ "$(sha256_file "${archive}")" != "${artifact_sha}" ]]; then
    die "RELEASE_DIGEST_MISMATCH"
    return 1
  fi
  assert_archive_safe "${archive}" || return 1
  validate_runtime_manifest_for_stage \
    "${runtime_manifest}" "${artifact_sha}" "${production_lock_sha}" || return 1
  local runtime_sha
  runtime_sha="$(sha256_file "${runtime_manifest}")"
  assert_release_stage_gate "${approval}" "${source_sha}" "${artifact_sha}" \
    "${runtime_sha}" "${release_id}" "${release_id}"
}

extract_stage_snapshot() {
  local input_dir="$1" stage_dir="$2"
  local runtime_target="${stage_dir}/.dsh-runtime-manifest.json"
  tar --extract --file "${input_dir}/release.tar" --directory "${stage_dir}" \
    --no-same-owner --no-same-permissions
  assert_new_path "${runtime_target}" "staged runtime manifest" || return 1
  if [[ "${DSH_DEPLOY_TESTING:-0}" == "1" ]]; then
    cp --no-clobber -- "${input_dir}/runtime-manifest.json" "${runtime_target}"
  else
    install -m 0440 -- "${input_dir}/runtime-manifest.json" "${runtime_target}"
  fi
}

restore_release_executable_modes() {
  local stage_dir="$1"
  local node_modules="${stage_dir}/node_modules"
  [[ -d "${node_modules}" ]] || return 0
  while IFS= read -r -d '' path; do
    if [[ -L "${path}" ]]; then
      local target
      target="$(readlink -f -- "${path}")"
      [[ "${target}" == "${node_modules}/"* && -f "${target}" ]] || continue
      chmod a+rx -- "${target}"
    else
      chmod a+rx -- "${path}"
    fi
  done < <(find "${node_modules}" \( -path '*/.bin/*' -o -path '*/bin/*' \) \( -type f -o -type l \) -print0)
}

commit_release_stage() {
  local archive="$1"
  local runtime_manifest="$2"
  local approval="$3" artifact_sha="$4" production_lock_sha="$5" source_sha="$6"
  local release_id="$7" releases_root="$8"
  local target="${releases_root}/${release_id}"
  local stage_dir="${releases_root}/.stage-${release_id}.$$"
  local input_dir="${releases_root}/.inputs-${release_id}.$$"
  assert_new_path "${stage_dir}" "release stage directory" || return 1
  assert_new_path "${input_dir}" "release input directory" || return 1
  (
    local cleanup_stage_target="${stage_dir}" cleanup_input_target="${input_dir}"
    cleanup_stage() {
      if [[ -n "${cleanup_stage_target}" && "${cleanup_stage_target}" == "${releases_root}/.stage-"* ]]; then
        rm -rf -- "${cleanup_stage_target}"
      fi
      if [[ -n "${cleanup_input_target}" && "${cleanup_input_target}" == "${releases_root}/.inputs-"* ]]; then
        rm -rf -- "${cleanup_input_target}"
      fi
    }
    trap cleanup_stage EXIT
    if [[ "${DSH_DEPLOY_TESTING:-0}" == "1" ]]; then
      mkdir -- "${stage_dir}" "${input_dir}"
    else
      install -d -m 0750 -- "${stage_dir}"
      install -d -m 0700 -- "${input_dir}"
    fi
    snapshot_stage_inputs "${archive}" "${runtime_manifest}" "${approval}" "${input_dir}"
    after_stage_input_snapshot "${archive}" "${runtime_manifest}" "${approval}"
    validate_release_inputs "${input_dir}/release.tar" "${input_dir}/runtime-manifest.json" \
      "${input_dir}/release-approval.json" "${artifact_sha}" "${production_lock_sha}" \
      "${source_sha}" "${release_id}" || return 1
    extract_stage_snapshot "${input_dir}" "${stage_dir}" || return 1
    if [[ "${DSH_DEPLOY_TESTING:-0}" != "1" ]]; then
      restore_release_executable_modes "${stage_dir}"
      chown -R root:dsh -- "${stage_dir}"
      chmod -R a-w -- "${stage_dir}"
    fi
    mv -T -n -- "${stage_dir}" "${target}"
    if [[ -e "${stage_dir}" ]]; then
      die "release target appeared during stage: ${target}"
      return 1
    fi
    cleanup_stage_target=""
  ) || return 1
  if [[ "${DSH_DEPLOY_TESTING:-0}" != "1" ]]; then
    sync -d "${releases_root}"
  fi
}

stage_release() {
  local archive="$1"
  local artifact_sha="$2"
  local runtime_manifest="$3"
  local release_id="$4"
  local releases_root="$5"
  local freeze_manifest="$6"
  local release_approval="$7"
  local freeze_sha="$8"
  local dry_run="${9:-0}"
  assert_file_sha256 "${freeze_manifest}" "${freeze_sha}" "source-freeze manifest" || return 1
  assert_release_id "${release_id}" || return 1
  assert_release_root "${releases_root}" || return 1
  if [[ ! -d "${releases_root}" || -L "${releases_root}" ]]; then
    die "releases root is missing or invalid"
    return 1
  fi
  assert_new_path "${releases_root}/${release_id}" "release target" || return 1
  assert_sha256 "${artifact_sha}" "artifact SHA-256" || return 1
  local production_lock_sha
  production_lock_sha="$(sha256_file "${DSH_REPO_ROOT}/infra/linux/production.lock.json")"
  if [[ "${dry_run}" == "1" ]]; then
    validate_release_inputs "${archive}" "${runtime_manifest}" "${release_approval}" \
      "${artifact_sha}" "${production_lock_sha}" "${freeze_sha}" "${release_id}" || return 1
    print_argv tar --extract --file "${archive}" --directory "${releases_root}/${release_id}"
    return 0
  fi
  if [[ "${DSH_DEPLOY_TESTING:-0}" != "1" ]]; then
    require_root || return 1
  fi
  commit_release_stage "${archive}" "${runtime_manifest}" "${release_approval}" "${artifact_sha}" \
    "${production_lock_sha}" "${freeze_sha}" "${release_id}" "${releases_root}" || return 1
  log "release staged without activating current: ${release_id}"
}
