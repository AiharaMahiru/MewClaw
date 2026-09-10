import { PassThrough, Writable } from 'node:stream'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { apply } from './pipe-bash.mjs'

function makeEnvironment() {
  let finish
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const terminate = vi.fn(() => {
    finish?.({ exitCode: 0, signal: null })
    stdout.end()
    stderr.end()
  })
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      const script = String(chunk)
      const marker = script.match(/printf '\\n(__DSH_PIPE_END_[^:]+):%s\\n'/)?.[1]
      if (marker) {
        const output = script.includes('printf ok') ? 'ok\n' : ''
        stdout.write(`${output}\n${marker}:0\n`)
      }
      callback()
    },
  })
  const done = new Promise((resolve) => {
    finish = resolve
  })
  const spawn = vi.fn(() => ({
    pid: 42,
    stdin,
    stdout,
    stderr,
    collected: {},
    done,
    terminate,
    waitForExit: vi.fn(async () => true),
  }))
  const registered = []
  const listeners = new Map()
  const effects = []
  const ctx = {
    subprocess: { spawn },
    tools: { register: vi.fn((definition) => { registered.push(definition); return () => undefined }) },
    on: vi.fn((event, listener) => { listeners.set(event, listener); return () => undefined }),
    effect: vi.fn((register) => { effects.push(register); return () => undefined }),
  }
  apply(ctx, {})
  return { ctx, effects, listeners, registered, spawn, terminate }
}

describe('OCI 管道 Bash Consumer', () => {
  let env

  beforeEach(() => {
    env = makeEnvironment()
  })

  it('同一 Agent 复用 Bash 进程并返回退出状态', async () => {
    const tool = env.registered[0]
    expect(tool.description).toContain('never pass /workspace')
    const agent = { id: 'session-1', session: { header: { cwd: '/workspace/user-a' } } }

    await expect(tool.execute({ command: 'printf ok' }, { agent })).resolves.toContain('ok')
    await expect(tool.execute({ command: 'pwd' }, { agent })).resolves.toContain('(no output)')
    expect(env.spawn).toHaveBeenCalledTimes(1)
    expect(env.spawn).toHaveBeenCalledWith(expect.objectContaining({
      argv: ['bash', '--noprofile', '--norc'],
      cwd: '/workspace/user-a',
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    }))
  })

  it('Agent dispose 会终止其管道进程', async () => {
    const tool = env.registered[0]
    const agent = { id: 'session-1', session: { header: { cwd: '/workspace/user-a' } } }
    await tool.execute({ command: ':' }, { agent })

    env.listeners.get('agent/disposed')({ agent })
    await vi.waitFor(() => expect(env.terminate).toHaveBeenCalledTimes(1))
  })
})
