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
# shellcheck source=../lib/closure-manifest.sh
source "${DEPLOY_ROOT}/lib/closure-manifest.sh"
# shellcheck source=../lib/preflight.sh
source "${DEPLOY_ROOT}/lib/preflight.sh"
# shellcheck source=../lib/closure.sh
source "${DEPLOY_ROOT}/lib/closure.sh"
# shellcheck source=../lib/bootstrap.sh
source "${DEPLOY_ROOT}/lib/bootstrap.sh"

write_mixed_manifest() {
  local path="$1"
  printf '%s\n' '{"schemaVersion":1,"packages":[' \
    '{"package":"fixture-dependency","version":"1","architecture":"amd64","action":"new-install","installedVersion":null,"size":8,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","filename":"fixture-dependency_1_amd64.deb"},' \
    '{"package":"slirp4netns","version":"1.2.1-1.1","architecture":"amd64","action":"already-installed","installedVersion":"1.2.1-1.1","size":null,"sha256":null,"filename":null}' \
    ']}' | tr -d '\n' >"${path}"
  printf '\n' >>"${path}"
}

test_exact_installed_direct_package_needs_no_deb() {
  local closure="${TMP_ROOT}/mixed-closure" checked="${TMP_ROOT}/installed.checked"
  mkdir -- "${closure}"
  printf 'fixture\n' >"${closure}/fixture-dependency_1_amd64.deb"
  write_mixed_manifest "${closure}/apt-closure.manifest.json"
  (
    locked_package_rows() {
      printf 'slirp4netns\t1.2.1-1.1\tamd64\t39268\t%s\tpool/slirp4netns.deb\n' \
        "$(printf 'b%.0s' {1..64})"
    }
    apt_transaction() { printf 'Inst fixture-dependency (1 fixture [amd64])\n'; }
    verify_file_record() { [[ "$2" == "8" && "$3" == "$(printf 'a%.0s' {1..64})" ]]; }
    assert_installed_package_exact() {
      [[ "$1" == "slirp4netns" && "$2" == "1.2.1-1.1" && "$3" == "amd64" ]]
      printf 'checked\n' >"${checked}"
    }
    verify_apt_closure ignored-lock "${closure}"
  )
  test -f "${checked}"
  test ! -e "${closure}/slirp4netns_1.2.1-1.1_amd64.deb"
}

test_postinstall_lock_mismatch_restores_policy() {
  local config="${TMP_ROOT}/createcluster.conf"
  printf 'create_main_cluster = true\n' >"${config}"
  disable_default_cluster_creation "${config}"
  if (
    install_server_phase() { return 0; }
    assert_locked_packages_installed() { return 43; }
    install_server_phase_or_restore_policy "ignored-closure" "ignored-lock" "${config}"
  ); then
    printf 'not ok - package lock mismatch unexpectedly succeeded\n' >&2
    return 1
  fi
  grep -Fqx 'create_main_cluster = true' "${config}"
  test ! -e "${config}.dsh-before-bootstrap"
}

test_installed_postgresql_common_resumes_bootstrap() {
  (
    installed_package_metadata() {
      [[ "$1" == "postgresql-common" ]]
      printf 'install ok installed\t278\tall\n'
    }
    closure_package_spec() { return 41; }
    install_common_phase ignored-closure
  )
}

test_exact_installed_direct_package_needs_no_deb
test_postinstall_lock_mismatch_restores_policy
test_installed_postgresql_common_resumes_bootstrap
printf 'ok - installed package closure tests passed\n'
