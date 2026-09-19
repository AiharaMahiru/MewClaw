import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { apply, inject, name } from './attachment-staging.mjs'

const dirs = []
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'att-staging-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true })
})

const REF = { attachmentId: 'sha256:01c8a27832ffcb698c0b55a943a18814cbdbbbb8acd88de473ce9f7fe5e4de06', name: '表格.xlsx', bytes: 5 }

function setup({ hostPath, config } = {}) {
  const listeners = {}
  const ctx = {
    attachments: { fileHostPath: vi.fn(() => hostPath) },
    systemPrompt: { section: vi.fn(() => vi.fn()) },
    effect: vi.fn((cb) => cb()),
    on: vi.fn((event, fn) => (listeners[event] = fn)),
    logger: { warn: vi.fn() },
  }
  apply(ctx, config)
  return { ctx, listeners }
}

const session = (cwd) => ({ header: { cwd } })
const fileMessage = (ref = REF) => ({ content: [{ type: 'file', attachment: ref }] })

describe('oci-attachment-staging', () => {
  it('注册 inject 与两个生命周期监听 + 系统段', async () => {
    const { ctx, listeners } = setup({})
    expect(name).toBe('oci-attachment-staging')
    expect(inject).toEqual(['attachments', 'systemPrompt'])
    expect(typeof listeners['session/event']).toBe('function')
    expect(typeof listeners['agent/pre-step']).toBe('function')
    expect(ctx.systemPrompt.section).toHaveBeenCalledWith(expect.objectContaining({
      name: 'oci:attachment-staging',
      text: expect.stringContaining('.attachments/'),
    }))
  })

  it('user/message 触发按 id 前缀拷入 .attachments/', async () => {
    const host = tmp()
    const src = join(host, 'src.bin')
    writeFileSync(src, Buffer.from([0, 1, 2, 3, 255]))
    const { listeners } = setup({ hostPath: src })
    const cwd = tmp()
    listeners['session/event'](session(cwd), { type: 'user/message', data: fileMessage() })
    await vi.waitFor(() => {
      const staged = join(cwd, '.attachments', '01c8a278-表格.xlsx')
      expect(readFileSync(staged)).toEqual(Buffer.from([0, 1, 2, 3, 255]))
    })
  })

  it('pre-step 瀑布 await 暂存后放行 next', async () => {
    const host = tmp()
    const src = join(host, 'src.txt')
    writeFileSync(src, 'hello')
    const { listeners } = setup({ hostPath: src })
    const cwd = tmp()
    const next = vi.fn(async () => ({ kind: 'continue' }))
    const result = await listeners['agent/pre-step'](
      { agent: { session: session(cwd) }, messages: [fileMessage()] }, next)
    expect(next).toHaveBeenCalled()
    expect(result).toEqual({ kind: 'continue' })
    expect(readFileSync(join(cwd, '.attachments', '01c8a278-表格.xlsx')).toString()).toBe('hello')
  })

  it('同附件幂等且非 file 块忽略', async () => {
    const host = tmp()
    const src = join(host, 's')
    writeFileSync(src, 'x')
    const { ctx, listeners } = setup({ hostPath: src })
    const cwd = tmp()
    const s = session(cwd)
    const next = vi.fn(async () => ({}))
    await listeners['agent/pre-step']({ agent: { session: s }, messages: [fileMessage()] }, next)
    await listeners['agent/pre-step']({ agent: { session: s }, messages: [fileMessage()] }, next)
    await listeners['agent/pre-step']({ agent: { session: s }, messages: [{ content: [{ type: 'text', text: 'hi' }] }] }, next)
    expect(ctx.attachments.fileHostPath).toHaveBeenCalledTimes(1)
  })

  it('超上限与无 cwd 跳过且不抛错', async () => {
    const host = tmp()
    const src = join(host, 'big')
    writeFileSync(src, 'x')
    const { listeners } = setup({ hostPath: src, config: { maxStageBytes: 1 } })
    const cwd = tmp()
    const next = vi.fn(async () => ({}))
    await listeners['agent/pre-step']({ agent: { session: session(cwd) }, messages: [fileMessage()] }, next)
    await listeners['agent/pre-step']({ agent: { session: session(undefined) }, messages: [fileMessage()] }, next)
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('fileHostPath 异常只告警不阻断 next', async () => {
    const { ctx, listeners } = setup({})
    ctx.attachments.fileHostPath.mockImplementation(() => { throw new Error('bad ref') })
    const next = vi.fn(async () => ({}))
    await listeners['agent/pre-step']({ agent: { session: session(tmp()) }, messages: [fileMessage()] }, next)
    expect(next).toHaveBeenCalled()
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('暂存附件'))
  })
})
