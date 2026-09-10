#!/usr/bin/env bash
set -euo pipefail

readonly DSH_DEBIAN_SNAPSHOT_FILE_ROOT="https://snapshot.debian.org/file"

locked_archive_package_rows() {
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
  if (item.archiveContentSha1 === null) continue;
  console.log([item.name, item.version, item.architecture, item.size, item.sha256,
    item.filename, item.archiveContentSha1, item.archiveUrl].join("\t"));
}
NODE
}

download_archive_packages() {
  local production_lock="$1" stage_dir="$2" new_rows="$3" rows
  rows="$(locked_archive_package_rows "${production_lock}")" || return 1
  [[ -n "${rows}" ]] || return 0
  require_command curl || return 1
  local name version architecture size sha filename content_sha archive_url target partial metadata
  while IFS=$'\t' read -r name version architecture size sha filename content_sha archive_url; do
    if ! awk -F '\t' -v name="${name}" -v version="${version}" \
      '$1 == name && $2 == version { found = 1 } END { exit(found ? 0 : 1) }' <<<"${new_rows}"; then
      continue
    fi
    [[ "${archive_url}" == "${DSH_DEBIAN_SNAPSHOT_FILE_ROOT}/${content_sha}" ]] || \
      { die "archive URL does not match its content ID"; return 1; }
    target="${stage_dir}/$(basename -- "${filename}")"
    partial="${stage_dir}/partial/$(basename -- "${filename}").snapshot"
    assert_new_path "${target}" "snapshot package target" || return 1
    assert_new_path "${partial}" "snapshot package partial" || return 1
    curl --fail --location --proto '=https' --proto-redir '=https' --max-redirs 3 \
      --silent --show-error --output "${partial}" "${archive_url}" || return 1
    verify_file_record "${partial}" "${size}" "${sha}" || return 1
    metadata="$(assert_deb_metadata "${partial}")" || return 1
    [[ "${metadata}" == "${name}"$'\t'"${version}"$'\t'"${architecture}" ]] || \
      { die "snapshot package metadata mismatch: ${name}"; return 1; }
    mv -T -n -- "${partial}" "${target}"
    [[ ! -e "${partial}" ]] || { die "snapshot package target appeared during commit"; return 1; }
  done <<<"${rows}"
}

print_archive_download_commands() {
  local production_lock="$1" stage_dir="$2" rows
  rows="$(locked_archive_package_rows "${production_lock}")" || return 1
  local name version architecture size sha filename content_sha archive_url partial
  while IFS=$'\t' read -r name version architecture size sha filename content_sha archive_url; do
    [[ -n "${archive_url}" ]] || continue
    partial="${stage_dir}/partial/$(basename -- "${filename}").snapshot"
    print_argv curl --fail --location --proto '=https' --proto-redir '=https' --max-redirs 3 \
      --silent --show-error --output "${partial}" "${archive_url}"
  done <<<"${rows}"
}
