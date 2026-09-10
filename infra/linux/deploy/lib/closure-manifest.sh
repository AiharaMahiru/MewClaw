#!/usr/bin/env bash
set -euo pipefail

assert_deb_metadata() {
  local path="$1"
  require_regular_file "${path}" "Debian package" || return 1
  local package version architecture
  package="$(dpkg-deb -f "${path}" Package)"
  version="$(dpkg-deb -f "${path}" Version)"
  architecture="$(dpkg-deb -f "${path}" Architecture)"
  [[ "${package}" =~ ^[a-z0-9][a-z0-9+.-]+$ ]] || { die "invalid package metadata: ${path}"; return 1; }
  [[ -n "${version}" && "${version}" != *$'\n'* ]] || { die "invalid package version: ${path}"; return 1; }
  [[ "${architecture}" =~ ^[a-z0-9][a-z0-9-]+$ ]] || { die "invalid package architecture: ${path}"; return 1; }
  printf '%s\t%s\t%s\n' "${package}" "${version}" "${architecture}"
}

installed_package_metadata() {
  local package="$1"
  require_command dpkg-query || return 1
  dpkg-query -W -f='${Status}\t${Version}\t${Architecture}' -- "${package}" 2>/dev/null
}

assert_installed_package_exact() {
  local package="$1" expected_version="$2" expected_architecture="$3" metadata
  metadata="$(installed_package_metadata "${package}")" || { die "installed package is missing: ${package}"; return 1; }
  local status version architecture
  IFS=$'\t' read -r status version architecture <<<"${metadata}"
  if [[ "${status}" != "install ok installed" || "${version}" != "${expected_version}" || \
        "${architecture}" != "${expected_architecture}" ]]; then
    die "installed package state mismatch: ${package}"
    return 1
  fi
}

locked_installed_package_rows() {
  local production_lock="$1" rows
  rows="$(locked_package_rows "${production_lock}")" || return 1
  local package version architecture size sha filename metadata status installed_version installed_architecture
  while IFS=$'\t' read -r package version architecture size sha filename; do
    metadata="$(installed_package_metadata "${package}")" || continue
    IFS=$'\t' read -r status installed_version installed_architecture <<<"${metadata}"
    [[ "${status}" == "install ok installed" ]] || continue
    if [[ "${installed_version}" != "${version}" || "${installed_architecture}" != "${architecture}" ]]; then
      die "installed direct package differs from production lock: ${package}"
      return 1
    fi
    printf '%s\t%s\t%s\n' "${package}" "${version}" "${architecture}"
  done <<<"${rows}"
}

append_downloaded_package_records() {
  local closure_dir="$1" records="$2"
  mapfile -d '' -t debs < <(find "${closure_dir}" -maxdepth 1 -type f -name '*.deb' -print0 | sort -z)
  [[ "${#debs[@]}" -gt 0 ]] || { die "APT closure contains no Debian packages"; return 1; }
  local deb package version architecture key metadata
  declare -A seen=()
  for deb in "${debs[@]}"; do
    metadata="$(assert_deb_metadata "${deb}")" || return 1
    IFS=$'\t' read -r package version architecture <<<"${metadata}"
    key="${package}:${version}:${architecture}"
    [[ -z "${seen[${key}]:-}" ]] || { die "duplicate package in closure: ${key}"; return 1; }
    seen[${key}]=1
    printf '%s\t%s\t%s\tnew-install\t\t%s\t%s\t%s\n' \
      "${package}" "${version}" "${architecture}" "$(file_size "${deb}")" \
      "$(sha256_file "${deb}")" "$(basename -- "${deb}")" >>"${records}"
  done
}

append_installed_package_records() {
  local production_lock="$1" records="$2" rows
  rows="$(locked_installed_package_rows "${production_lock}")" || return 1
  [[ -n "${rows}" ]] || return 0
  local package version architecture
  while IFS=$'\t' read -r package version architecture; do
    printf '%s\t%s\t%s\talready-installed\t%s\t\t\t\n' \
      "${package}" "${version}" "${architecture}" "${version}" >>"${records}"
  done <<<"${rows}"
}

write_closure_manifest_json() {
  local records="$1" manifest="$2"
  LC_ALL=C sort -o "${records}" "${records}"
  node --input-type=module - "${records}" "${manifest}" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const [, , recordsPath, manifestPath] = process.argv;
const packages = readFileSync(recordsPath, "utf8").trim().split("\n").map((line) => {
  const [packageName, version, architecture, action, installedVersion, size, sha256, filename] = line.split("\t");
  return { package: packageName, version, architecture, action, installedVersion: installedVersion || null,
    size: size ? Number(size) : null, sha256: sha256 || null, filename: filename || null };
});
writeFileSync(manifestPath, `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
NODE
}

write_closure_manifest() {
  local closure_dir="$1" production_lock="$2"
  local manifest="${closure_dir}/apt-closure.manifest.json"
  local records="${closure_dir}/.apt-closure.records.tmp"
  assert_new_path "${manifest}" "closure manifest" || return 1
  assert_new_path "${records}" "closure records" || return 1
  append_downloaded_package_records "${closure_dir}" "${records}" || return 1
  append_installed_package_records "${production_lock}" "${records}" || return 1
  write_closure_manifest_json "${records}" "${manifest}" || return 1
  rm -f -- "${records}"
}

manifest_all_package_rows() {
  local manifest="$1"
  require_regular_file "${manifest}" "closure manifest" || return 1
  node --input-type=module - "${manifest}" <<'NODE'
import { readFileSync } from "node:fs";

const value = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (Object.keys(value).sort().join(",") !== "packages,schemaVersion" || value.schemaVersion !== 1 ||
    !Array.isArray(value.packages) || value.packages.length === 0) process.exit(1);
const expected = "action,architecture,filename,installedVersion,package,sha256,size,version";
const keys = new Set();
for (const row of value.packages) {
  const common = Object.keys(row).sort().join(",") === expected &&
    /^[a-z0-9][a-z0-9+.-]+$/.test(row.package) && /^\S+$/.test(row.version) &&
    /^[a-z0-9][a-z0-9-]+$/.test(row.architecture);
  const downloaded = row.action === "new-install" && row.installedVersion === null &&
    Number.isSafeInteger(row.size) && row.size > 0 && /^[a-f0-9]{64}$/.test(row.sha256) &&
    /^[A-Za-z0-9][A-Za-z0-9+%_.:-]*\.deb$/.test(row.filename);
  const installed = row.action === "already-installed" && row.installedVersion === row.version &&
    row.size === null && row.sha256 === null && row.filename === null;
  if (!common || (!downloaded && !installed)) process.exit(1);
  const key = `${row.package}:${row.version}:${row.architecture}`;
  if (keys.has(key)) process.exit(1);
  keys.add(key);
  console.log([row.package, row.version, row.architecture, row.action, row.installedVersion ?? "",
    row.size ?? "", row.sha256 ?? "", row.filename ?? ""].join("\t"));
}
NODE
}

manifest_package_rows() {
  manifest_all_package_rows "$1" | awk -F '\t' \
    '$4 == "new-install" { print $1 "\t" $2 "\t" $3 "\t" $6 "\t" $7 "\t" $8 }'
}

manifest_installed_package_rows() {
  manifest_all_package_rows "$1" | awk -F '\t' \
    '$4 == "already-installed" { print $1 "\t" $2 "\t" $3 }'
}

verify_manifest_installed_packages() {
  local manifest="$1" package version architecture
  while IFS=$'\t' read -r package version architecture; do
    [[ -n "${package}" ]] || continue
    assert_installed_package_exact "${package}" "${version}" "${architecture}" || return 1
  done < <(manifest_installed_package_rows "${manifest}")
}

assert_direct_lock_records() {
  local production_lock="$1" manifest="$2"
  local package version architecture size sha filename key locked_count=0
  declare -A downloaded=() installed=() direct=()
  while IFS=$'\t' read -r package version architecture size sha filename; do
    downloaded["${package}:${version}:${architecture}"]="${size}:${sha}"
  done < <(manifest_package_rows "${manifest}")
  while IFS=$'\t' read -r package version architecture; do
    key="${package}:${version}:${architecture}"
    installed["${key}"]=1
    assert_installed_package_exact "${package}" "${version}" "${architecture}" || return 1
  done < <(manifest_installed_package_rows "${manifest}")
  while IFS=$'\t' read -r package version architecture size sha filename; do
    key="${package}:${version}:${architecture}"
    direct["${key}"]=1
    if [[ "${downloaded[${key}]:-}" != "${size}:${sha}" && -z "${installed[${key}]:-}" ]]; then
      die "direct package lock mismatch: ${package}"
      return 1
    fi
    locked_count=$((locked_count + 1))
  done < <(locked_package_rows "${production_lock}")
  [[ "${locked_count}" -gt 0 ]] || { die "production lock package set is empty"; return 1; }
  for key in "${!installed[@]}"; do
    [[ -n "${direct[${key}]:-}" ]] || { die "installed manifest record is not directly locked"; return 1; }
  done
}

assert_locked_packages_installed() {
  local production_lock="$1" package version architecture size sha filename count=0
  while IFS=$'\t' read -r package version architecture size sha filename; do
    assert_installed_package_exact "${package}" "${version}" "${architecture}" || return 1
    count=$((count + 1))
  done < <(locked_package_rows "${production_lock}")
  [[ "${count}" -gt 0 ]] || { die "production lock package set is empty"; return 1; }
}
