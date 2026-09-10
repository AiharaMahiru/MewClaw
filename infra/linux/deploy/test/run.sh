#!/usr/bin/env bash
set -euo pipefail

readonly TEST_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly DEPLOY_ROOT="$(cd -- "${TEST_ROOT}/.." && pwd -P)"
readonly REPO_ROOT="$(cd -- "${DEPLOY_ROOT}/../../.." && pwd -P)"
readonly FIXTURE_ROOT="${TEST_ROOT}/fixtures"
readonly TMP_ROOT="$(mktemp -d)"

cleanup() {
  rm -rf -- "${TMP_ROOT}"
}
trap cleanup EXIT

# shellcheck source=../lib/common.sh
source "${DEPLOY_ROOT}/lib/common.sh"
# shellcheck source=../lib/debian-archive.sh
source "${DEPLOY_ROOT}/lib/debian-archive.sh"
# shellcheck source=../lib/closure-manifest.sh
source "${DEPLOY_ROOT}/lib/closure-manifest.sh"
# shellcheck source=../lib/preflight.sh
source "${DEPLOY_ROOT}/lib/preflight.sh"
# shellcheck source=../lib/closure.sh
source "${DEPLOY_ROOT}/lib/closure.sh"
# shellcheck source=../lib/bootstrap.sh
source "${DEPLOY_ROOT}/lib/bootstrap.sh"
# shellcheck source=../lib/stage.sh
source "${DEPLOY_ROOT}/lib/stage.sh"

assert_fails() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'not ok - expected failure: %s\n' "${label}" >&2
    return 1
  fi
}

test_preflight_fixtures() {
  assert_supported_host "${FIXTURE_ROOT}/os-release-debian-13" "amd64"
  assert_trusted_os_release_resolution "/usr/lib/os-release" "/usr/lib/os-release" 0 644 1
  assert_fails "os-release symlink escape" assert_trusted_os_release_resolution \
    "/tmp/escape/os-release" "/usr/lib/os-release" 0 644 1
  assert_fails "writable os-release target" assert_trusted_os_release_resolution \
    "/usr/lib/os-release" "/usr/lib/os-release" 0 666 1
  assert_candidate_ports_free "${FIXTURE_ROOT}/sockets-safe.txt"
  assert_fails "occupied candidate port" assert_candidate_ports_free "${FIXTURE_ROOT}/sockets-conflict.txt"
  assert_protected_legacy_postgres \
    "${FIXTURE_ROOT}/sockets-safe.txt" "${FIXTURE_ROOT}/processes-protected.txt"
  assert_fails "5432 ownership drift" assert_protected_legacy_postgres \
    "${FIXTURE_ROOT}/sockets-safe.txt" "${FIXTURE_ROOT}/processes-wrong.txt"
  assert_apt_transaction_safe "${FIXTURE_ROOT}/apt-new-install.txt"
  assert_fails "existing package upgrade" assert_apt_transaction_safe "${FIXTURE_ROOT}/apt-upgrade.txt"
}

write_freeze_fixtures() {
  local manifest="$1"
  local approval="$2"
  printf '{"snapshot":"fixture"}\n' >"${manifest}"
  local digest
  digest="$(sha256_file "${manifest}")"
  printf '{"schemaVersion":1,"status":"green","reviewedBy":"root","scope":"bootstrap-stage","sourceManifestSha256":"%s"}\n' \
    "${digest}" >"${approval}"
  printf '%s\n' "${digest}"
}

test_source_freeze_gate() {
  local manifest="${TMP_ROOT}/source-manifest.json"
  local approval="${TMP_ROOT}/source-freeze-approval.json"
  local digest
  digest="$(write_freeze_fixtures "${manifest}" "${approval}")"
  assert_source_freeze_gate "${manifest}" "${approval}" "${digest}"
  printf 'drift\n' >>"${manifest}"
  assert_fails "source manifest drift" assert_source_freeze_gate "${manifest}" "${approval}" "${digest}"
}

write_release_stage_approval() {
  local path="$1" source_sha="$2" artifact_sha="$3" runtime_sha="$4"
  local release_id="$5" run_id="$6"
  printf '{"schemaVersion":1,"status":"green","reviewedBy":"root","scope":"release-stage","sourceManifestSha256":"%s","artifactSha256":"%s","runtimeManifestSha256":"%s","releaseId":"%s","runId":"%s"}\n' \
    "${source_sha}" "${artifact_sha}" "${runtime_sha}" "${release_id}" "${run_id}" >"${path}"
}

test_release_stage_approval_binding() {
  local approval="${TMP_ROOT}/release-stage-approval.json"
  local source_sha artifact_sha runtime_sha
  source_sha="$(printf 'a%.0s' {1..64})"
  artifact_sha="$(printf 'b%.0s' {1..64})"
  runtime_sha="$(printf 'c%.0s' {1..64})"
  write_release_stage_approval "${approval}" "${source_sha}" "${artifact_sha}" "${runtime_sha}" \
    fixture-release fixture-run
  assert_release_stage_gate "${approval}" "${source_sha}" "${artifact_sha}" "${runtime_sha}" \
    fixture-release fixture-run
  assert_fails "release approval artifact mismatch" assert_release_stage_gate "${approval}" \
    "${source_sha}" "$(printf 'd%.0s' {1..64})" "${runtime_sha}" fixture-release fixture-run
  assert_fails "release approval run mismatch" assert_release_stage_gate "${approval}" \
    "${source_sha}" "${artifact_sha}" "${runtime_sha}" fixture-release another-run
}

write_runtime_manifest() {
  local path="$1"
  local artifact_sha="$2"
  local production_lock_sha="$3"
  printf '%s\n' "{\"schemaVersion\":1,\"createdAt\":\"2026-08-24T03:45:59.000Z\",\"host\":{\"architecture\":\"amd64\",\"bootId\":\"fixture\",\"hostname\":\"fixture.example\",\"osRelease\":\"Debian GNU/Linux 13 (trixie)\"},\"release\":{\"artifactSha256\":\"${artifact_sha}\",\"gitCommit\":\"aaaaaaaa\",\"lockfileSha256\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"productionLockSha256\":\"${production_lock_sha}\"},\"paths\":{\"backupsRoot\":\"/var/lib/dsh/backups\",\"currentLink\":\"/opt/dsh/current\",\"environmentFile\":\"/etc/dsh/dsh.env\",\"releasesRoot\":\"/opt/dsh/releases\",\"sessionsRoot\":\"/var/lib/dsh/sessions\",\"stateRoot\":\"/var/lib/dsh\",\"uploadsRoot\":\"/var/lib/dsh/uploads\",\"workspacesRoot\":\"/var/lib/dsh/workspaces\"},\"ports\":{\"admin\":18791,\"authEdge\":13080,\"browser\":13083,\"preview\":13082,\"postgres\":15432,\"workerRun\":18788,\"workerWeb\":13081},\"database\":{\"bindHost\":\"127.0.0.1\",\"cluster\":\"dsh\",\"vectorVersion\":\"0.8.0-1\",\"version\":\"17.9-0+deb13u1\"},\"sandbox\":{\"imageDigest\":\"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"network\":\"none\",\"rootless\":true},\"units\":[{\"configSha256\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"entrypoint\":\"/opt/dsh/current/apps/auth/dist/main.js\",\"name\":\"dsh-auth.service\"}],\"environment\":{\"bytes\":1,\"group\":\"dsh\",\"mode\":\"0600\",\"owner\":\"dsh\",\"path\":\"/etc/dsh/dsh.env\",\"sha256\":\"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\"}}" >"${path}"
}

test_stage_no_clobber() {
  local source_dir="${TMP_ROOT}/release-source"
  local archive="${TMP_ROOT}/release.tar"
  local releases_root="${TMP_ROOT}/releases"
  local runtime_manifest="${TMP_ROOT}/runtime-manifest.json"
  local source_manifest="${TMP_ROOT}/stage-source-manifest.json"
  local approval="${TMP_ROOT}/stage-approval.json"
  mkdir -p -- "${source_dir}" "${releases_root}"
  printf 'fixture release\n' >"${source_dir}/README.txt"
  tar -cf "${archive}" -C "${source_dir}" .
  local artifact_sha production_lock_sha freeze_sha runtime_sha
  artifact_sha="$(sha256_file "${archive}")"
  production_lock_sha="$(sha256_file "${REPO_ROOT}/infra/linux/production.lock.json")"
  freeze_sha="$(write_freeze_fixtures "${source_manifest}" "${approval}")"
  write_runtime_manifest "${runtime_manifest}" "${artifact_sha}" "${production_lock_sha}"
  runtime_sha="$(sha256_file "${runtime_manifest}")"
  write_release_stage_approval "${approval}" "${freeze_sha}" "${artifact_sha}" "${runtime_sha}" \
    fixture-release fixture-release
  DSH_DEPLOY_TESTING=1 stage_release "${archive}" "${artifact_sha}" "${runtime_manifest}" \
    "fixture-release" "${releases_root}" "${source_manifest}" "${approval}" "${freeze_sha}"
  test -f "${releases_root}/fixture-release/README.txt"
  test -f "${releases_root}/fixture-release/.dsh-runtime-manifest.json"
  assert_fails "release no-clobber" env DSH_DEPLOY_TESTING=1 bash -c \
    'source "$1/lib/common.sh"; source "$1/lib/stage.sh"; stage_release "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9"' \
    _ "${DEPLOY_ROOT}" "${archive}" "${artifact_sha}" "${runtime_manifest}" "fixture-release" \
    "${releases_root}" "${source_manifest}" "${approval}" "${freeze_sha}"
  local mismatch_manifest="${TMP_ROOT}/runtime-manifest-mismatch.json"
  write_runtime_manifest "${mismatch_manifest}" "${artifact_sha}" "${production_lock_sha}"
  sed -i 's/17\.9-0+deb13u1/17.10-0+deb13u1/' "${mismatch_manifest}"
  runtime_sha="$(sha256_file "${mismatch_manifest}")"
  write_release_stage_approval "${approval}" "${freeze_sha}" "${artifact_sha}" "${runtime_sha}" \
    mismatch-release mismatch-release
  if DSH_DEPLOY_TESTING=1 stage_release "${archive}" "${artifact_sha}" "${mismatch_manifest}" \
    "mismatch-release" "${releases_root}" "${source_manifest}" "${approval}" "${freeze_sha}"; then
    printf 'not ok - database version mismatch unexpectedly staged\n' >&2
    return 1
  fi
  test ! -e "${releases_root}/mismatch-release"
}

test_stage_restores_linked_executable_modes() {
  local stage_dir="${TMP_ROOT}/linked-executable-stage"
  mkdir -p -- "${stage_dir}/node_modules/.bin" "${stage_dir}/node_modules/vitest"
  printf '#!/usr/bin/env node\n' >"${stage_dir}/node_modules/vitest/vitest.mjs"
  chmod 0640 -- "${stage_dir}/node_modules/vitest/vitest.mjs"
  ln -s ../vitest/vitest.mjs "${stage_dir}/node_modules/.bin/vitest"
  restore_release_executable_modes "${stage_dir}"
  test -x "${stage_dir}/node_modules/vitest/vitest.mjs"
}

test_stage_uses_immutable_input_snapshots() {
  local source_dir="${TMP_ROOT}/snapshot-source"
  local archive="${TMP_ROOT}/snapshot-release.tar"
  local releases_root="${TMP_ROOT}/snapshot-releases"
  local runtime_manifest="${TMP_ROOT}/snapshot-runtime-manifest.json"
  local source_manifest="${TMP_ROOT}/snapshot-source-manifest.json"
  local approval="${TMP_ROOT}/snapshot-source-approval.json"
  mkdir -p -- "${source_dir}" "${releases_root}"
  printf 'immutable payload\n' >"${source_dir}/README.txt"
  tar -cf "${archive}" -C "${source_dir}" .
  local artifact_sha production_lock_sha freeze_sha runtime_sha
  artifact_sha="$(sha256_file "${archive}")"
  production_lock_sha="$(sha256_file "${REPO_ROOT}/infra/linux/production.lock.json")"
  freeze_sha="$(write_freeze_fixtures "${source_manifest}" "${approval}")"
  write_runtime_manifest "${runtime_manifest}" "${artifact_sha}" "${production_lock_sha}"
  runtime_sha="$(sha256_file "${runtime_manifest}")"
  write_release_stage_approval "${approval}" "${freeze_sha}" "${artifact_sha}" "${runtime_sha}" \
    snapshot-release snapshot-release
  (
    after_stage_input_snapshot() {
      printf 'mutated archive\n' >"$1"
      printf '{}\n' >"$2"
    }
    DSH_DEPLOY_TESTING=1 stage_release "${archive}" "${artifact_sha}" "${runtime_manifest}" \
      "snapshot-release" "${releases_root}" "${source_manifest}" "${approval}" "${freeze_sha}"
  )
  grep -Fqx 'mutated archive' "${archive}"
  grep -Fqx 'immutable payload' "${releases_root}/snapshot-release/README.txt"
  grep -Fq '"schemaVersion":1' "${releases_root}/snapshot-release/.dsh-runtime-manifest.json"
}

test_closure_record() {
  local payload="${TMP_ROOT}/payload.deb"
  printf 'deb fixture\n' >"${payload}"
  verify_file_record "${payload}" "$(file_size "${payload}")" "$(sha256_file "${payload}")"
  assert_fails "closure digest mismatch" verify_file_record "${payload}" "$(file_size "${payload}")" "$(printf 'f%.0s' {1..64})"
}

test_bootstrap_dry_run_without_closure() {
  local missing="${TMP_ROOT}/missing-closure"
  assert_bootstrap_closure_ready \
    "${REPO_ROOT}/infra/linux/production.lock.json" "${missing}" 1
  test ! -e "${missing}"
  assert_fails "real bootstrap requires prepared closure" assert_bootstrap_closure_ready \
    "${REPO_ROOT}/infra/linux/production.lock.json" "${missing}" 0
}

test_apt_transaction_argv() {
  local actual
  actual="$({
    apt-get() { printf '%s|%s\n' "${DEBIAN_FRONTEND:-}" "$*"; }
    apt_transaction -s install fixture-package=1
  })"
  [[ "${actual}" == \
    'noninteractive|-y --no-remove --no-install-recommends -s install fixture-package=1' ]]
}

write_closure_set_manifest() {
  local path="$1" extra="${2:-0}"
  local tail=""
  if [[ "${extra}" == "1" ]]; then
    tail=',{"package":"extra-package","version":"2","architecture":"amd64","action":"new-install","installedVersion":null,"size":1,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","filename":"extra-package_2_amd64.deb"}'
  fi
  printf '{"schemaVersion":1,"packages":[{"package":"fixture-package","version":"1","architecture":"amd64","action":"new-install","installedVersion":null,"size":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","filename":"fixture-package_1_amd64.deb"}%s]}\n' \
    "${tail}" >"${path}"
}

test_closure_matches_exact_simulation_set() {
  local simulation="${TMP_ROOT}/apt-simulation.txt"
  local manifest="${TMP_ROOT}/closure-set.json"
  printf 'Inst fixture-package (1 Debian:13/stable [amd64])\n' >"${simulation}"
  write_closure_set_manifest "${manifest}" 0
  assert_closure_manifest_matches_simulation "${simulation}" "${manifest}"
  write_closure_set_manifest "${manifest}" 1
  assert_fails "extra closure package" assert_closure_manifest_matches_simulation "${simulation}" "${manifest}"
}

test_createcluster_policy_rollback() {
  local config="${TMP_ROOT}/createcluster.conf"
  printf 'create_main_cluster = true\n' >"${config}"
  disable_default_cluster_creation "${config}"
  grep -Fqx 'create_main_cluster = false' "${config}"
  if (
    install_server_phase() { return 42; }
    install_server_phase_or_restore_policy "ignored-closure" "ignored-lock" "${config}"
  ); then
    printf 'not ok - package failure unexpectedly succeeded\n' >&2
    return 1
  fi
  grep -Fqx 'create_main_cluster = true' "${config}"
  test ! -e "${config}.dsh-before-bootstrap"
  disable_default_cluster_creation "${config}"
  if (
    create_service_account_and_roots() { return 41; }
    create_service_account_or_restore_policy "${config}"
  ); then
    printf 'not ok - account failure unexpectedly succeeded\n' >&2
    return 1
  fi
  grep -Fqx 'create_main_cluster = true' "${config}"
  test ! -e "${config}.dsh-before-bootstrap"
}

test_commented_createcluster_default() {
  local config="${TMP_ROOT}/createcluster-commented.conf"
  printf '#create_main_cluster = true\n' >"${config}"
  disable_default_cluster_creation "${config}"
  grep -Fqx 'create_main_cluster = false' "${config}"
  restore_default_cluster_creation "${config}"
  grep -Fqx '#create_main_cluster = true' "${config}"
}

assert_closure_failure_cleanup() {
  local phase="$1"
  local final_dir="${TMP_ROOT}/closure-${phase}"
  if (
    DSH_DEPLOY_TESTING=1
    locked_package_specs() { printf 'fixture-package=1\n'; }
    apt-get() { printf '%s\n' 'Inst fixture-package (1 fixture [amd64])'; }
    download_closure_packages() {
      [[ "${phase}" != "download" ]] || return 41
      printf 'fixture\n' >"$2/fixture.deb"
    }
    write_closure_manifest() {
      [[ "${phase}" != "manifest" ]] || return 42
      printf '{"schemaVersion":1,"packages":[]}\n' >"$1/apt-closure.manifest.json"
    }
    verify_apt_closure() {
      [[ "${phase}" != "verify" ]] || return 43
    }
    download_apt_closure "${REPO_ROOT}/infra/linux/production.lock.json" "${final_dir}" 0
  ); then
    printf 'not ok - closure %s failure unexpectedly succeeded\n' "${phase}" >&2
    return 1
  fi
  test ! -e "${final_dir}"
  if compgen -G "${TMP_ROOT}/.closure-${phase}.stage-*" >/dev/null; then
    printf 'not ok - closure %s left a stage directory\n' "${phase}" >&2
    return 1
  fi
}

test_closure_failure_cleanup() {
  assert_closure_failure_cleanup download
  assert_closure_failure_cleanup manifest
  assert_closure_failure_cleanup verify
}

test_preflight_fixtures
test_source_freeze_gate
test_release_stage_approval_binding
test_closure_record
test_closure_matches_exact_simulation_set
test_bootstrap_dry_run_without_closure
test_apt_transaction_argv
test_createcluster_policy_rollback
test_commented_createcluster_default
test_closure_failure_cleanup
test_stage_no_clobber
test_stage_restores_linked_executable_modes
test_stage_uses_immutable_input_snapshots
bash "${TEST_ROOT}/archive.sh"
bash "${TEST_ROOT}/installed-packages.sh"
printf 'ok - deploy fixture tests passed\n'
