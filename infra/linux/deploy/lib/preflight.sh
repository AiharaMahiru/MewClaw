#!/usr/bin/env bash
set -euo pipefail

readonly DSH_CANDIDATE_PORTS=(13080 13081 15432 18788 18791)
readonly DSH_LEGACY_POSTGRES_PORT=5432
readonly DSH_LEGACY_POSTGRES_COMMAND="/www/server/pgsql/bin/postgres -D /www/server/pgsql/data"

os_release_value() {
  local path="$1"
  local key="$2"
  local line value
  while IFS= read -r line; do
    [[ "${line}" == "${key}="* ]] || continue
    value="${line#*=}"
    value="${value%\"}"
    value="${value#\"}"
    printf '%s\n' "${value}"
    return 0
  done <"${path}"
  return 1
}

assert_secure_system_path() {
  local path="$1"
  local enforce_root="$2"
  local uid mode
  read -r uid mode < <(stat -Lc '%u %a' -- "${path}")
  [[ "${uid}" =~ ^[0-9]+$ && "${mode}" =~ ^[0-7]{3,4}$ ]] || { die "invalid system path metadata"; return 1; }
  if [[ "${enforce_root}" == "1" && "${uid}" -ne 0 ]]; then
    die "trusted os-release path is not root-owned"
    return 1
  fi
  if (( (8#${mode} & 8#022) != 0 )); then
    die "trusted os-release path is group/world writable"
    return 1
  fi
}

assert_trusted_os_release_resolution() {
  local resolved="$1"
  local expected="$2"
  local uid="$3"
  local mode="$4"
  local enforce_root="$5"
  [[ "${resolved}" == "${expected}" ]] || { die "os-release symlink escapes trusted target"; return 1; }
  [[ "${uid}" =~ ^[0-9]+$ && "${mode}" =~ ^[0-7]{3,4}$ ]] || { die "invalid os-release metadata"; return 1; }
  if [[ "${enforce_root}" == "1" && "${uid}" -ne 0 ]]; then
    die "trusted os-release target is not root-owned"
    return 1
  fi
  if (( (8#${mode} & 8#022) != 0 )); then
    die "trusted os-release target is group/world writable"
    return 1
  fi
}

assert_os_release_source() {
  local path="$1"
  local trusted="${2:-$1}"
  local enforce_root="${3:-0}"
  if [[ "${path}" == "${trusted}" ]]; then
    require_regular_file "${path}" "os-release"
    return
  fi
  require_absolute_path "${path}" "os-release" || return 1
  require_regular_file "${trusted}" "trusted os-release" || return 1
  [[ -L "${path}" ]] || { die "os-release must be the trusted symlink"; return 1; }
  local resolved expected uid mode
  resolved="$(readlink -f -- "${path}")"
  expected="$(readlink -f -- "${trusted}")"
  read -r uid mode < <(stat -Lc '%u %a' -- "${trusted}")
  assert_trusted_os_release_resolution "${resolved}" "${expected}" "${uid}" "${mode}" "${enforce_root}" || return 1
  assert_secure_system_path "$(dirname -- "${path}")" "${enforce_root}" || return 1
  assert_secure_system_path "$(dirname -- "${trusted}")" "${enforce_root}"
}

assert_supported_host() {
  local os_release="$1"
  local architecture="$2"
  local trusted_os_release="${3:-$1}"
  local enforce_root="${4:-0}"
  assert_os_release_source "${os_release}" "${trusted_os_release}" "${enforce_root}" || return 1
  if [[ "$(os_release_value "${os_release}" ID)" != "debian" ]]; then
    die "HOST_UNSUPPORTED: expected Debian"
    return 1
  fi
  if [[ "$(os_release_value "${os_release}" VERSION_ID)" != "13" ]]; then
    die "HOST_UNSUPPORTED: expected Debian 13"
    return 1
  fi
  if [[ "${architecture}" != "amd64" ]]; then
    die "HOST_UNSUPPORTED: expected amd64"
    return 1
  fi
}

snapshot_has_port() {
  local sockets="$1"
  local port="$2"
  awk -v port="${port}" '
    { for (field = 1; field <= NF; field += 1) if ($field ~ (":" port "$")) found = 1 }
    END { exit(found ? 0 : 1) }
  ' "${sockets}"
}

assert_candidate_ports_free() {
  local sockets="$1"
  local port
  require_absolute_path "${sockets}" "socket snapshot" || return 1
  if [[ ! -r "${sockets}" ]]; then
    die "socket snapshot is not readable"
    return 1
  fi
  for port in "${DSH_CANDIDATE_PORTS[@]}"; do
    if snapshot_has_port "${sockets}" "${port}"; then
      die "PORT_CONFLICT: candidate port ${port} is already listening"
      return 1
    fi
  done
}

assert_protected_legacy_postgres() {
  local sockets="$1"
  local processes="$2"
  require_absolute_path "${sockets}" "socket snapshot" || return 1
  require_absolute_path "${processes}" "process snapshot" || return 1
  if ! snapshot_has_port "${sockets}" "${DSH_LEGACY_POSTGRES_PORT}"; then
    die "protected legacy PostgreSQL listener on 5432 is missing"
    return 1
  fi
  if ! grep -Fq -- "${DSH_LEGACY_POSTGRES_COMMAND}" "${processes}"; then
    die "protected legacy PostgreSQL ownership drifted"
    return 1
  fi
}

assert_apt_transaction_safe() {
  local simulation="$1"
  require_absolute_path "${simulation}" "APT simulation" || return 1
  if [[ ! -r "${simulation}" ]]; then
    die "APT simulation is not readable"
    return 1
  fi
  if ! grep -Eq '^Inst[[:space:]]+' "${simulation}"; then
    die "APT simulation has no install transaction"
    return 1
  fi
  if grep -Eq '^Inst[[:space:]]+[^[:space:]]+[[:space:]]+\[' "${simulation}"; then
    die "PACKAGE_LOCK_MISMATCH: transaction would upgrade or downgrade an installed package"
    return 1
  fi
  if grep -Eq '^(Remv|Purg)[[:space:]]+' "${simulation}"; then
    die "PACKAGE_LOCK_MISMATCH: transaction would remove an installed package"
    return 1
  fi
}

assert_no_default_postgres_cluster() {
  local clusters="$1"
  require_absolute_path "${clusters}" "PostgreSQL cluster snapshot" || return 1
  if [[ ! -r "${clusters}" ]]; then
    die "PostgreSQL cluster snapshot is not readable"
    return 1
  fi
  if awk '$1 == "17" && $2 == "main" { found = 1 } END { exit(found ? 0 : 1) }' "${clusters}"; then
    die "default PostgreSQL 17 main cluster is forbidden"
    return 1
  fi
}

run_host_preflight() {
  local production_lock="$1"
  local socket_snapshot process_snapshot apt_snapshot
  require_root || return 1
  require_regular_file "${production_lock}" "production lock" || return 1
  require_command dpkg || return 1
  require_command ss || return 1
  require_command ps || return 1
  require_command apt-get || return 1
  require_command readlink || return 1
  require_command stat || return 1
  assert_supported_host "/etc/os-release" "$(dpkg --print-architecture)" "/usr/lib/os-release" 1 || return 1
  socket_snapshot="$(ss -H -ltnp)"
  process_snapshot="$(ps -eo pid=,args=)"
  assert_candidate_ports_free <(printf '%s\n' "${socket_snapshot}") || return 1
  assert_protected_legacy_postgres \
    <(printf '%s\n' "${socket_snapshot}") <(printf '%s\n' "${process_snapshot}") || return 1
  mapfile -t package_specs < <(locked_package_specs "${production_lock}")
  [[ "${#package_specs[@]}" -gt 0 ]] || { die "production lock has no packages"; return 1; }
  apt_snapshot="$(apt_transaction -s install "${package_specs[@]}")"
  assert_apt_transaction_safe <(printf '%s\n' "${apt_snapshot}") || return 1
  log "preflight passed: host, protected 5432, candidate ports, and APT transaction"
}
