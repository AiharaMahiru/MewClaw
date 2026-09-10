#!/usr/bin/env bash
set -euo pipefail

locked_package_rows() {
  local production_lock="$1"
  require_regular_file "${production_lock}" "production lock" || return 1
  require_linux_build || return 1
  node --input-type=module - "${DSH_LINUX_DIST}" "${production_lock}" <<'NODE'
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [, , modulePath, lockPath] = process.argv;
const { parseProductionPackageLock } = await import(pathToFileURL(modulePath));
const lock = parseProductionPackageLock(JSON.parse(readFileSync(lockPath, "utf8")));
for (const item of lock.packages) {
  console.log([item.name, item.version, item.architecture, item.size, item.sha256, item.filename].join("\t"));
}
NODE
}

locked_package_specs() {
  local production_lock="$1"
  local name version architecture size sha filename
  while IFS=$'\t' read -r name version architecture size sha filename; do
    printf '%s=%s\n' "${name}" "${version}"
  done < <(locked_package_rows "${production_lock}")
}

simulation_package_rows() {
  local simulation="$1"
  require_absolute_path "${simulation}" "APT simulation" || return 1
  [[ -r "${simulation}" ]] || { die "APT simulation is not readable"; return 1; }
  awk '
    /^Inst[[:space:]]+/ {
      package_name = $2
      sub(/:.*/, "", package_name)
      version_field = ($3 ~ /^\[/) ? $4 : $3
      if (version_field !~ /^\([^[:space:]]+$/) {
        print "dsh-deploy: unsupported APT simulation row" > "/dev/stderr"
        failed = 1
        next
      }
      sub(/^\(/, "", version_field)
      print package_name "\t" version_field
      found = 1
    }
    END {
      if (failed || !found) {
        if (!found) print "dsh-deploy: APT simulation package set is empty" > "/dev/stderr"
        exit 1
      }
    }
  ' "${simulation}" | LC_ALL=C sort -u
}

assert_closure_manifest_matches_simulation() {
  local simulation="$1"
  local manifest="$2"
  local expected actual
  expected="$(simulation_package_rows "${simulation}")" || return 1
  actual="$(manifest_package_rows "${manifest}" | \
    awk -F '\t' '{ print $1 "\t" $2 }' | LC_ALL=C sort -u)" || return 1
  if [[ "${actual}" != "${expected}" ]]; then
    die "APT closure package set differs from the safe simulation"
    return 1
  fi
}

assert_closure_matches_current_apt_plan() {
  local production_lock="$1"
  local closure_dir="$2"
  mapfile -t package_specs < <(locked_package_specs "${production_lock}")
  [[ "${#package_specs[@]}" -gt 0 ]] || { die "production lock package set is empty"; return 1; }
  local simulation
  simulation="$(apt_transaction -s install "${package_specs[@]}")" || return 1
  assert_apt_transaction_safe <(printf '%s\n' "${simulation}") || return 1
  assert_closure_manifest_matches_simulation \
    <(printf '%s\n' "${simulation}") "${closure_dir}/apt-closure.manifest.json"
}

verify_apt_closure() {
  local production_lock="$1"
  local closure_dir="$2"
  local manifest="${closure_dir}/apt-closure.manifest.json"
  require_absolute_path "${closure_dir}" "closure directory" || return 1
  if [[ ! -d "${closure_dir}" || -L "${closure_dir}" ]]; then die "closure directory is invalid"; return 1; fi
  local package version architecture size sha filename key count=0
  declare -A records=()
  while IFS=$'\t' read -r package version architecture size sha filename; do
    [[ "${filename}" == "$(basename -- "${filename}")" && "${filename}" == *.deb ]] || { die "unsafe closure filename"; return 1; }
    key="${package}:${version}:${architecture}"
    [[ -z "${records[${key}]:-}" ]] || { die "duplicate package manifest entry: ${key}"; return 1; }
    verify_file_record "${closure_dir}/${filename}" "${size}" "${sha}" || return 1
    records[${key}]="${size}:${sha}"
    count=$((count + 1))
  done < <(manifest_package_rows "${manifest}")
  local file_count
  file_count="$(find "${closure_dir}" -maxdepth 1 -type f -name '*.deb' | wc -l | tr -d '[:space:]')"
  [[ "${count}" -eq "${file_count}" && "${count}" -gt 0 ]] || { die "closure contains unmanifested Debian packages"; return 1; }
  assert_direct_lock_records "${production_lock}" "${manifest}" || return 1
  assert_closure_matches_current_apt_plan "${production_lock}" "${closure_dir}"
}

download_closure_packages() {
  local production_lock="$1"
  local stage_dir="$2"
  mapfile -t package_specs < <(locked_package_specs "${production_lock}")
  [[ "${#package_specs[@]}" -gt 0 ]] || { die "production lock package set is empty"; return 1; }
  local simulation new_rows
  simulation="$(apt_transaction -s install "${package_specs[@]}")" || return 1
  assert_apt_transaction_safe <(printf '%s\n' "${simulation}") || return 1
  new_rows="$(simulation_package_rows <(printf '%s\n' "${simulation}"))" || return 1
  download_archive_packages "${production_lock}" "${stage_dir}" "${new_rows}" || return 1
  apt_transaction --download-only -o "Dir::Cache::archives=${stage_dir}" install "${package_specs[@]}"
}

commit_apt_closure() {
  local production_lock="$1"
  local closure_dir="$2"
  local parent base stage_dir
  parent="$(dirname -- "${closure_dir}")"
  base="$(basename -- "${closure_dir}")"
  [[ "${base}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { die "closure directory name is unsafe"; return 1; }
  [[ -d "${parent}" && ! -L "${parent}" ]] || { die "closure parent must already exist"; return 1; }
  stage_dir="${parent}/.${base}.stage.$$"
  assert_new_path "${stage_dir}" "closure stage directory" || return 1
  (
    local cleanup_target="${stage_dir}"
    cleanup_closure_stage() {
      [[ -n "${cleanup_target}" && "${cleanup_target}" == "${parent}/.${base}.stage."* ]] || return 0
      rm -rf -- "${cleanup_target}"
    }
    trap cleanup_closure_stage EXIT
    if [[ "${DSH_DEPLOY_TESTING:-0}" == "1" ]]; then
      mkdir -- "${stage_dir}"
      mkdir -- "${stage_dir}/partial"
    else
      install -d -m 0700 -- "${stage_dir}" "${stage_dir}/partial"
    fi
    download_closure_packages "${production_lock}" "${stage_dir}" || return 1
    write_closure_manifest "${stage_dir}" "${production_lock}" || return 1
    verify_apt_closure "${production_lock}" "${stage_dir}" || return 1
    mv -T -n -- "${stage_dir}" "${closure_dir}"
    [[ ! -e "${stage_dir}" ]] || { die "closure target appeared during commit"; return 1; }
    cleanup_target=""
  ) || return 1
  if [[ "${DSH_DEPLOY_TESTING:-0}" != "1" ]]; then
    sync -d "${parent}"
  fi
}

download_apt_closure() {
  local production_lock="$1"
  local closure_dir="$2"
  local dry_run="$3"
  assert_new_path "${closure_dir}" "closure directory" || return 1
  mapfile -t package_specs < <(locked_package_specs "${production_lock}")
  [[ "${#package_specs[@]}" -gt 0 ]] || { die "production lock package set is empty"; return 1; }
  local apt_snapshot
  apt_snapshot="$(apt_transaction -s install "${package_specs[@]}")"
  assert_apt_transaction_safe <(printf '%s\n' "${apt_snapshot}") || return 1
  if [[ "${dry_run}" == "1" ]]; then
    print_archive_download_commands "${production_lock}" "${closure_dir}" || return 1
    print_argv env DEBIAN_FRONTEND=noninteractive apt-get -y --no-remove --no-install-recommends \
      --download-only -o "Dir::Cache::archives=${closure_dir}" install "${package_specs[@]}"
    return 0
  fi
  commit_apt_closure "${production_lock}" "${closure_dir}"
}

closure_package_spec() {
  local closure_dir="$1"
  local requested="$2"
  local package version architecture size sha filename
  while IFS=$'\t' read -r package version architecture size sha filename; do
    [[ "${package}" == "${requested}" ]] || continue
    printf '%s=%s\n' "${package}" "${version}"
    return 0
  done < <(manifest_package_rows "${closure_dir}/apt-closure.manifest.json")
  die "package is missing from closure: ${requested}"
}

closure_package_specs() {
  local closure_dir="$1"
  local package version architecture size sha filename
  while IFS=$'\t' read -r package version architecture size sha filename; do
    printf '%s=%s\n' "${package}" "${version}"
  done < <(manifest_package_rows "${closure_dir}/apt-closure.manifest.json")
}

closure_specs_for_names() {
  local closure_dir="$1"
  shift
  local requested package version architecture size sha filename found
  for requested in "$@"; do
    found=0
    while IFS=$'\t' read -r package version architecture size sha filename; do
      [[ "${package}" == "${requested}" ]] || continue
      printf '%s=%s\n' "${package}" "${version}"
      found=1
      break
    done < <(manifest_package_rows "${closure_dir}/apt-closure.manifest.json")
    [[ "${found}" -eq 1 ]] || { die "simulated package is missing from closure: ${requested}"; return 1; }
  done
}
