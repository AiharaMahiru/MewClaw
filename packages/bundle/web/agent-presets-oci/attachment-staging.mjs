/**
 * OCI profile 的 prompt 附件暂存。
 *
 * 上游把 file 附件投影成宿主逐字节副本路径，只对宿主侧 read 可见且仅限
 * UTF-8 文本；容器执行面（bash/grep/glob）够不到该路径，二进制附件因此
 * 不可消费。本插件把每个 file 引用按 `<attachmentId 前 8 位>-<文件名>`
 * 逐字节拷入会话工作区 `.attachments/`——宿主文件工具与容器 Bash 共享的
 * 唯一世界。挂载面不变：不把附件存储目录挂进容器。
 *
 * 两处触发同一幂等拷贝：user/message 落盘时先动手，agent/pre-step 准入
 * 瀑布里 await 补齐，保证首个模型调用前副本就位。暂存失败不阻断会话：
 * 宿主侧 read 对文本附件仍可用。
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

export const name = 'oci-attachment-staging'
export const inject = ['attachments', 'systemPrompt']

const DEFAULT_MAX_STAGE_BYTES = 256 * 1024 * 1024

function sanitizeName(value) {
  const leaf = basename(String(value ?? 'file')).replace(/[\0-\x1f\\/]/g, '_')
  return leaf.length === 0 || leaf === '.' || leaf === '..' ? 'file' : leaf
}

function validatePositiveInteger(value, fallback, label) {
  const resolved = value === undefined ? fallback : value
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`oci-attachment-staging: ${label} must be a positive safe integer`)
  }
  return resolved
}

function fileBlocksOf(messages) {
  const refs = []
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block?.type === 'file' && block.attachment?.attachmentId !== undefined) refs.push(block.attachment)
    }
  }
  return refs
}

export function apply(ctx, config = {}) {
  const maxStageBytes = validatePositiveInteger(config.maxStageBytes, DEFAULT_MAX_STAGE_BYTES, 'maxStageBytes')
  const staged = new WeakMap()

  async function stageOne(session, ref) {
    const cwd = session?.header?.cwd
    if (cwd === undefined) return
    let bySession = staged.get(session)
    if (bySession === undefined) staged.set(session, (bySession = new Map()))
    const key = String(ref.attachmentId)
    const pending = bySession.get(key)
    if (pending !== undefined) return pending
    const task = (async () => {
      const hostPath = ctx.attachments.fileHostPath(ref)
      if (hostPath === undefined) return
      const info = await stat(hostPath)
      if (!info.isFile() || info.size > maxStageBytes) return
      const fileName = `${key.slice(7, 15)}-${sanitizeName(ref.name)}`
      const dir = join(cwd, '.attachments')
      const target = join(dir, fileName)
      if (!existsSync(target)) {
        await mkdir(dir, { recursive: true, mode: 0o755 })
        await pipeline(createReadStream(hostPath), createWriteStream(target, { mode: 0o644 }))
        await chmod(target, 0o644)
      }
      return fileName
    })().catch((error) => {
      ctx.logger?.warn(`attachment-staging: 暂存附件 ${key.slice(7, 15)} 失败: ${error?.message ?? error}`)
      return undefined
    })
    bySession.set(key, task)
    return task
  }

  async function stageMessages(session, messages) {
    await Promise.all(fileBlocksOf(messages).map((ref) => stageOne(session, ref)))
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message') void stageMessages(session, [event.data])
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    await stageMessages(payload.agent?.session, payload.messages)
    return next()
  })

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'oci:attachment-staging',
    order: 111,
    text: [
      'Uploaded file attachments are staged under `.attachments/` relative to the session working directory,',
      'named `<id>-<filename>`. That relative path is readable by file tools and visible inside Bash as',
      '/workspace/.attachments/ — use it (not the printed host path) for bash, grep, glob, or any binary file.',
    ].join(' '),
  }))
}
