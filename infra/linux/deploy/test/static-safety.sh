#!/usr/bin/env bash
set -euo pipefail

readonly TEST_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly DEPLOY_ROOT="$(cd -- "${TEST_ROOT}/.." && pwd -P)"

mapfile -t scripts < <(find "${DEPLOY_ROOT}" -type f -name '*.sh' -not -path '*/fixtures/*' | sort)
test "${#scripts[@]}" -gt 0

for script in "${scripts[@]}"; do
  grep -Fqx 'set -euo pipefail' "${script}"
  bash -n "${script}"
done

if grep -R -n -E '(^|[^[:alnum:]_])(eval|source[[:space:]]+[^"$])([[:space:]]|$)' \
  "${DEPLOY_ROOT}/deploy.sh" "${DEPLOY_ROOT}/lib"; then
  printf 'unsafe shell evaluation pattern found\n' >&2
  exit 1
fi

if grep -R -n -E '(cat|sed|awk|grep|source|\. )[[:space:]]+.*\.env' \
  "${DEPLOY_ROOT}/deploy.sh" "${DEPLOY_ROOT}/lib"; then
  printf 'environment file content access pattern found\n' >&2
  exit 1
fi

if grep -R -n -- '--reinstall' "${DEPLOY_ROOT}/deploy.sh" "${DEPLOY_ROOT}/lib"; then
  printf 'forced package reinstall is forbidden\n' >&2
  exit 1
fi

worker_unit="${DEPLOY_ROOT}/../systemd/dsh-worker.service"
grep -Fqx 'Environment=XDG_RUNTIME_DIR=/run/user/995' "${worker_unit}"
grep -Fqx 'Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/995/bus' "${worker_unit}"
if grep -Fqx 'BindPaths=/run/user/995:/var/lib/dsh/rootless-runtime' "${worker_unit}"; then
  printf 'worker unit must use the real user-manager runtime path for rootless cgroups\n' >&2
  exit 1
fi
grep -Fqx 'ProtectHome=read-only' "${worker_unit}"
grep -Fqx 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK' "${worker_unit}"
grep -Fqx 'ReadWritePaths=/var/lib/dsh /run/user/995' "${worker_unit}"
grep -Fqx 'CapabilityBoundingSet=' "${worker_unit}"
grep -Fqx 'Delegate=yes' "${worker_unit}"
if grep -n -E '(%U|user@%U)' "${worker_unit}"; then
  printf 'worker unit must not derive rootless runtime paths from system-unit UID specifiers\n' >&2
  exit 1
fi

for unit in auth worker gateway admin preview browser; do
  unit_file="${DEPLOY_ROOT}/../systemd/dsh-${unit}.service"
  grep -Fqx 'Environment=DSH_PROJECT_ENV_DIR=/var/lib/dsh' "${unit_file}"
  if [[ "${unit}" == auth ]]; then
    grep -Fqx 'EnvironmentFile=/etc/dsh/runtime.secrets.env' "${unit_file}"
  elif grep -Fqx 'EnvironmentFile=/etc/dsh/runtime.secrets.env' "${unit_file}"; then
    printf 'non-auth unit must not inherit the managed credential defaults\n' >&2
    exit 1
  fi
done

preview_unit="${DEPLOY_ROOT}/../systemd/dsh-preview.service"
auth_unit="${DEPLOY_ROOT}/../systemd/dsh-auth.service"
grep -Fqx 'Wants=network-online.target dsh-preview.service' "${auth_unit}"
grep -Fqx 'Requires=dsh-worker.service dsh-admin.service' "${auth_unit}"
if grep -Eq '^Requires=.*dsh-preview\.service' "${auth_unit}"; then
  printf 'auth must not require the optional preview runtime\n' >&2
  exit 1
fi
grep -Fqx 'Environment=DSH_PREVIEW_PORT=13082' "${preview_unit}"
grep -Fqx 'Environment=DSH_PREVIEW_WORKSPACE_ROOT=/var/lib/dsh/workspaces' "${preview_unit}"
grep -Fqx 'Environment=XDG_RUNTIME_DIR=/run/user/995' "${preview_unit}"
grep -Fqx 'Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/995/bus' "${preview_unit}"
if grep -Fqx 'BindPaths=/run/user/995:/var/lib/dsh/rootless-runtime' "${preview_unit}"; then
  printf 'preview unit must use the real user-manager runtime path for rootless cgroups\n' >&2
  exit 1
fi
grep -Fqx 'ProtectHome=read-only' "${preview_unit}"
grep -Fqx 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK' "${preview_unit}"
grep -Fqx 'ReadWritePaths=/var/lib/dsh /run/user/995' "${preview_unit}"
grep -Fqx 'CapabilityBoundingSet=' "${preview_unit}"

browser_unit="${DEPLOY_ROOT}/../systemd/dsh-browser.service"
grep -Fqx 'Environment=DSH_BROWSER_PORT=13083' "${browser_unit}"
grep -Fqx 'Environment=DSH_BROWSER_CHROMIUM_PATH=/usr/bin/chromium' "${browser_unit}"
grep -Fqx 'Environment=DSH_BROWSER_STATE_ROOT=/var/lib/dsh/browser' "${browser_unit}"
grep -Fqx 'Environment=DSH_BROWSER_WORKSPACE_ROOT=/var/lib/dsh/workspaces' "${browser_unit}"
grep -Fqx 'CapabilityBoundingSet=' "${browser_unit}"
grep -Fqx 'ReadWritePaths=/var/lib/dsh/browser /var/lib/dsh/workspaces' "${browser_unit}"
grep -Fq 'dsh-browser.service' "${DEPLOY_ROOT}/../systemd/dsh-worker.service"
grep -Fq -- '--no-open' "${DEPLOY_ROOT}/../systemd/dsh-worker.service"

bootstrap_lib="${DEPLOY_ROOT}/lib/bootstrap.sh"
grep -Fqx 'readonly DSH_SERVICE_UID=995' "${bootstrap_lib}"
grep -Fq '/var/lib/dsh/rootless-runtime' "${bootstrap_lib}"

stage_lib="${DEPLOY_ROOT}/lib/stage.sh"
grep -Fq 'restore_release_executable_modes' "${stage_lib}"
grep -Fq 'chmod a+rx -- "${path}"' "${stage_lib}"

printf 'ok - deploy static safety checks passed\n'
