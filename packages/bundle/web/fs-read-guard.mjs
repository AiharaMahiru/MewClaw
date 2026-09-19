/**
 * 多租户 Web 部署的模型侧宿主文件读边界。
 *
 * 上游 dsh-tool-fs 只对 write/edit 调用 sandboxPolicy.resolvePolicy，read 不设防
 * 是单人底座语义；本会话 cwd 才是租户边界。经官方 ctx.tools.guard() 扩展点在
 * tools/pre-execute 之后做单调拒绝，不改上游源码：
 *
 * - read / read_image 的 file_path、str_replace_editor 的 view 命令（目录列举
 *   同样收口）必须 realpath 后落在会话 header.cwd 或配置 readableRoots 之下；
 * - write/edit/str_replace 不叠加：checkedTarget 已执行 workspace-write 与
 *   danger-full-access 升级通道；glob/grep/bash 在 OCI 下只见 /workspace；
 * - 无会话 cwd 的内部调用不收口；拒绝理由作为工具错误回给模型。
 */
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

export const name = 'fs-read-guard'
export const inject = ['tools']

const FENCED_PATH_ARGS = {
  read: (args) => args?.file_path,
  read_image: (args) => args?.file_path,
  str_replace_editor: (args) => (args?.command === 'view' ? args?.path : undefined),
}

/** realpath 跟随最深现存祖先，未落地尾部保持词法拼接（对齐上游 resolve 语义）。 */
function canonicalize(pathname) {
  const tail = []
  let candidate = pathname
  while (true) {
    try {
      return tail.reduce((acc, seg) => join(acc, seg), realpathSync(candidate))
    } catch {
      const parent = dirname(candidate)
      if (parent === candidate) return pathname
      tail.unshift(basename(candidate))
      candidate = parent
    }
  }
}

function isUnder(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function validateRoots(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((root) => typeof root !== 'string' || !isAbsolute(root))) {
    throw new Error('fs-read-guard: readableRoots must be an array of absolute paths')
  }
  return value
}

export function apply(ctx, config = {}) {
  const extraRoots = validateRoots(config.readableRoots).map(canonicalize)
  ctx.tools.guard((exec) => {
    const pick = FENCED_PATH_ARGS[exec.name]
    if (pick === undefined) return
    const requested = pick(exec.arguments)
    if (typeof requested !== 'string' || requested.length === 0) return
    const cwd = exec.agent?.session?.header?.cwd
    if (cwd === undefined) return
    const root = canonicalize(cwd)
    const target = canonicalize(resolve(cwd, requested))
    if (isUnder(root, target)) return
    for (const allowed of extraRoots) if (isUnder(allowed, target)) return
    return `${exec.name} of "${requested}" denied: the path resolves outside the session working directory. File reads are confined to the session workspace and uploaded attachments.`
  })
}
