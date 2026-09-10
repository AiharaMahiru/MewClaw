#!/usr/bin/env bash
set -euo pipefail

readonly TEST_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly DEPLOY_ROOT="$(cd -- "${TEST_ROOT}/.." && pwd -P)"
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

test_archive_prefetch_avoids_mirror_404() {
  local stage="${TMP_ROOT}/archive-cache" curl_argv="${TMP_ROOT}/archive-curl.argv"
  mkdir -p -- "${stage}/partial"
  (
    locked_archive_package_rows() {
      printf 'postgresql-17\t17.9-0+deb13u1\tamd64\t8\t%s\t%s\t%s\t%s\n' \
        "$(printf 'a%.0s' {1..64})" "pool/postgresql-17_17.9_amd64.deb" \
        "8e78f206f6767f2a958c36696872c56ce2af5264" \
        "https://snapshot.debian.org/file/8e78f206f6767f2a958c36696872c56ce2af5264"
    }
    locked_package_specs() { printf 'postgresql-17=17.9-0+deb13u1\n'; }
    curl() {
      printf '%s\n' "$*" >"${curl_argv}"
      printf 'fixture\n' >"${stage}/partial/postgresql-17_17.9_amd64.deb.snapshot"
    }
    verify_file_record() {
      [[ "$2" == "8" && "$3" == "$(printf 'a%.0s' {1..64})" ]]
      printf 'verified\n' >"${TMP_ROOT}/archive-record.checked"
    }
    assert_deb_metadata() {
      printf 'metadata\n' >"${TMP_ROOT}/archive-metadata.checked"
      printf 'postgresql-17\t17.9-0+deb13u1\tamd64\n'
    }
    apt_transaction() {
      if [[ "$1" == "-s" ]]; then printf 'Inst postgresql-17 (17.9-0+deb13u1 fixture [amd64])\n'; return; fi
      test -f "${stage}/postgresql-17_17.9_amd64.deb" || return 22
    }
    download_closure_packages ignored-lock "${stage}"
  )
  grep -Fq 'https://snapshot.debian.org/file/8e78f206f6767f2a958c36696872c56ce2af5264' "${curl_argv}"
  test -f "${stage}/postgresql-17_17.9_amd64.deb"
  test -f "${TMP_ROOT}/archive-record.checked"
  test -f "${TMP_ROOT}/archive-metadata.checked"
}

test_archive_prefetch_avoids_mirror_404
printf 'ok - Debian archive closure tests passed\n'
