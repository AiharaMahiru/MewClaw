#!/usr/bin/env bash
set -euo pipefail

readonly DSH_CREATECLUSTER_CONFIG="/etc/postgresql-common/createcluster.conf"
readonly DSH_SERVICE_UID=995

capture_cluster_snapshot() {
  if command -v pg_lsclusters >/dev/null 2>&1; then
    pg_lsclusters --no-header
  fi
}

guard_default_cluster() {
  local snapshot
  snapshot="$(capture_cluster_snapshot)"
  assert_no_default_postgres_cluster <(printf '%s\n' "${snapshot}")
}

disable_default_cluster_creation() {
  local config="${1:-${DSH_CREATECLUSTER_CONFIG}}"
  require_regular_file "${config}" "postgresql-common createcluster config" || return 1
  local active_count
  active_count="$(grep -Ec '^[[:space:]]*create_main_cluster[[:space:]]*=' "${config}" || true)"
  if [[ "${active_count}" -gt 1 ]]; then
    die "unexpected create_main_cluster configuration"
    return 1
  fi
  if grep -Eq '^[[:space:]]*create_main_cluster[[:space:]]*=[[:space:]]*false[[:space:]]*$' "${config}"; then
    return 0
  fi
  if ! grep -Eq '^[[:space:]#]*create_main_cluster[[:space:]]*=[[:space:]]*true[[:space:]]*$' "${config}"; then
    die "create_main_cluster has an unexpected value"
    return 1
  fi
  local backup="${config}.dsh-before-bootstrap"
  local stage="${config}.dsh-stage.$$"
  local original_sha
  original_sha="$(sha256_file "${config}")"
  assert_new_path "${backup}" "createcluster backup" || return 1
  assert_new_path "${stage}" "createcluster stage" || return 1
  (
    local committed=0
    cleanup_createcluster_stage() {
      rm -f -- "${stage}"
      [[ "${committed}" -eq 1 ]] || rm -f -- "${backup}"
    }
    trap cleanup_createcluster_stage EXIT
    cp --no-clobber --preserve=mode,ownership,timestamps -- "${config}" "${backup}"
    awk '
      /^[[:space:]]*create_main_cluster[[:space:]]*=/ { print "create_main_cluster = false"; next }
      /^[[:space:]]*#[[:space:]]*create_main_cluster[[:space:]]*=/ { print "create_main_cluster = false"; next }
      { print }
    ' "${config}" >"${stage}"
    chmod --reference="${config}" "${stage}"
    chown --reference="${config}" "${stage}"
    [[ "$(sha256_file "${config}")" == "${original_sha}" ]] || { die "createcluster config drifted"; return 1; }
    mv -T -- "${stage}" "${config}"
    committed=1
  )
}

restore_default_cluster_creation() {
  local config="${1:-${DSH_CREATECLUSTER_CONFIG}}"
  local backup="${config}.dsh-before-bootstrap"
  if [[ ! -e "${backup}" && ! -L "${backup}" ]]; then return 0; fi
  require_regular_file "${config}" "createcluster config to restore" || return 1
  require_regular_file "${backup}" "createcluster backup" || return 1
  grep -Eq '^[[:space:]]*create_main_cluster[[:space:]]*=[[:space:]]*false[[:space:]]*$' "${config}" || {
    die "createcluster config drifted before rollback"; return 1;
  }
  grep -Eq '^[[:space:]#]*create_main_cluster[[:space:]]*=[[:space:]]*true[[:space:]]*$' "${backup}" || {
    die "createcluster backup is not restorable"; return 1;
  }
  mv -T -- "${backup}" "${config}"
}

install_common_phase() {
  local closure_dir="$1"
  local metadata status version architecture
  if metadata="$(installed_package_metadata postgresql-common)"; then
    IFS=$'\t' read -r status version architecture <<<"${metadata}"
    if [[ "${status}" == "install ok installed" && "${architecture}" == "all" ]]; then
      log "postgresql-common is already installed; resuming bootstrap"
      return 0
    fi
  fi
  local common_spec simulation
  common_spec="$(closure_package_spec "${closure_dir}" postgresql-common)"
  simulation="$(apt_transaction -s install "${common_spec}")"
  assert_apt_transaction_safe <(printf '%s\n' "${simulation}") || return 1
  mapfile -t phase_names < <(awk '/^Inst[[:space:]]+/ { print $2 }' <(printf '%s\n' "${simulation}"))
  [[ "${#phase_names[@]}" -gt 0 ]] || { die "postgresql-common phase is empty"; return 1; }
  local name
  for name in "${phase_names[@]}"; do
    [[ "${name}" != "postgresql-17" && "${name}" != "postgresql-17-pgvector" ]] || {
      die "postgresql-common phase unexpectedly includes PostgreSQL server"
      return 1
    }
  done
  mapfile -t phase_specs < <(closure_specs_for_names "${closure_dir}" "${phase_names[@]}")
  [[ "${#phase_specs[@]}" -eq "${#phase_names[@]}" ]] || { die "common phase closure mapping is incomplete"; return 1; }
  apt_transaction --no-download -o "Dir::Cache::archives=${closure_dir}" install "${phase_specs[@]}"
}

install_server_phase() {
  local closure_dir="$1"
  mapfile -t closure_specs < <(closure_package_specs "${closure_dir}")
  [[ "${#closure_specs[@]}" -gt 0 ]] || { die "closure package set is empty"; return 1; }
  apt_transaction --no-download -o "Dir::Cache::archives=${closure_dir}" install "${closure_specs[@]}" || return 1
  guard_default_cluster
}

install_server_phase_or_restore_policy() {
  local closure_dir="$1"
  local production_lock="$2"
  local config="$3"
  local status=0
  install_server_phase "${closure_dir}" || status=$?
  if [[ "${status}" -eq 0 ]]; then
    assert_locked_packages_installed "${production_lock}" || status=$?
  fi
  [[ "${status}" -eq 0 ]] && return 0
  restore_default_cluster_creation "${config}" || return 1
  return "${status}"
}

install_locked_packages() {
  local production_lock="$1"
  local closure_dir="$2"
  local config="${3:-${DSH_CREATECLUSTER_CONFIG}}"
  verify_apt_closure "${production_lock}" "${closure_dir}" || return 1
  guard_default_cluster || return 1
  install_common_phase "${closure_dir}" || return 1
  guard_default_cluster || return 1
  disable_default_cluster_creation "${config}" || return 1
  install_server_phase_or_restore_policy "${closure_dir}" "${production_lock}" "${config}"
}

assert_bootstrap_targets_new() {
  if getent passwd dsh >/dev/null 2>&1; then die "dsh user already exists"; return 1; fi
  if getent group dsh >/dev/null 2>&1; then die "dsh group already exists"; return 1; fi
  if getent passwd "${DSH_SERVICE_UID}" >/dev/null 2>&1; then die "reserved dsh service UID is occupied"; return 1; fi
  if getent group "${DSH_SERVICE_UID}" >/dev/null 2>&1; then die "reserved dsh service GID is occupied"; return 1; fi
  assert_new_path "/opt/dsh" "DSH install root" || return 1
  assert_new_path "/var/lib/dsh" "DSH state root" || return 1
  assert_new_path "/etc/dsh" "DSH configuration root" || return 1
}

create_service_account_and_roots() {
  useradd --system --uid "${DSH_SERVICE_UID}" --user-group --home-dir /var/lib/dsh --shell /usr/sbin/nologin dsh
  usermod --add-subuids 200000-265535 --add-subgids 200000-265535 dsh
  install -d -m 0750 -o root -g dsh -- /opt/dsh /opt/dsh/releases /etc/dsh
  install -d -m 0700 -o dsh -g dsh -- /var/lib/dsh /var/lib/dsh/backups \
    /var/lib/dsh/browser /var/lib/dsh/previews /var/lib/dsh/rootless-runtime /var/lib/dsh/sessions /var/lib/dsh/uploads \
    /var/lib/dsh/workspaces
}

create_service_account_or_restore_policy() {
  local config="$1"
  local status=0
  create_service_account_and_roots || status=$?
  [[ "${status}" -eq 0 ]] && return 0
  restore_default_cluster_creation "${config}" || return 1
  return "${status}"
}

prepare_bootstrap_closure() {
  local production_lock="$1"
  local closure_dir="$2"
  local freeze_manifest="$3"
  local freeze_approval="$4"
  local freeze_sha="$5"
  local dry_run="$6"
  require_root || return 1
  assert_source_freeze_gate "${freeze_manifest}" "${freeze_approval}" "${freeze_sha}" || return 1
  run_host_preflight "${production_lock}" || return 1
  assert_bootstrap_targets_new || return 1
  download_apt_closure "${production_lock}" "${closure_dir}" "${dry_run}" || return 1
  log "APT closure prepared without installing packages"
}

assert_bootstrap_closure_ready() {
  local production_lock="$1"
  local closure_dir="$2"
  local dry_run="$3"
  require_absolute_path "${closure_dir}" "closure directory" || return 1
  if [[ ! -e "${closure_dir}" && ! -L "${closure_dir}" ]]; then
    if [[ "${dry_run}" == "1" ]]; then
      log "dry-run: closure is not present and will not be downloaded"
      return 0
    fi
    die "bootstrap requires a prepared APT closure"
    return 1
  fi
  verify_apt_closure "${production_lock}" "${closure_dir}"
}

bootstrap_runtime() {
  local production_lock="$1"
  local closure_dir="$2"
  local freeze_manifest="$3"
  local freeze_approval="$4"
  local freeze_sha="$5"
  local dry_run="$6"
  require_root || return 1
  assert_source_freeze_gate "${freeze_manifest}" "${freeze_approval}" "${freeze_sha}" || return 1
  run_host_preflight "${production_lock}" || return 1
  assert_bootstrap_targets_new || return 1
  assert_bootstrap_closure_ready "${production_lock}" "${closure_dir}" "${dry_run}" || return 1
  if [[ "${dry_run}" == "1" ]]; then
    log "dry-run complete; verified closure and bootstrap targets without mutation"
    return 0
  fi
  install_locked_packages "${production_lock}" "${closure_dir}" "${DSH_CREATECLUSTER_CONFIG}" || return 1
  create_service_account_or_restore_policy "${DSH_CREATECLUSTER_CONFIG}" || return 1
  log "bootstrap complete: locked packages, dsh account, and absolute roots"
}
