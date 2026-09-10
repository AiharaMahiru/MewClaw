/**
 * OCI preset 的持久 Bash Consumer。
 *
 * OCI subprocess provider 明确不提供 PTY。这里用普通管道维护一个
 * Agent 所有的 bash 进程，以随机完成标记分隔命令结果；进程仍由
 * ctx.subprocess.spawn() 进入同一个 OCI 工作区容器，不获得宿主权限。
 */
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

export const name = 'oci-pipe-bash'
export const inject = ['subprocess', 'tools']

const DEFAULT_TIMEOUT_MS = 300000
const DEFAULT_MAX_OUTPUT_CHARS = 16000
const MAX_COMMAND_CHARS = 128000
const MAX_BUFFER_BYTES = 4 * 1024 * 1024
const DEFAULT_DESCRIPTION = [
  'Run commands in a persistent bash shell inside the OCI workspace.',
  '/workspace is only the Bash mount path. For read/write/edit/glob/grep, use paths relative to the session cwd and never pass /workspace.',
].join(' ')

function validatePositiveInteger(value, fallback, label) {
  const resolved = value === undefined ? fallback : value
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`oci-pipe-bash: ${label} must be a positive safe integer`)
  }
  return resolved
}

function appendDecoded(state, decoder, chunk) {
  const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
  state.buffer += decoder.write(bytes)
  if (Buffer.byteLength(state.buffer, 'utf8') > MAX_BUFFER_BYTES) {
    state.buffer = state.buffer.slice(-MAX_BUFFER_BYTES)
    state.dropped = true
  }
  for (const check of [...state.waiters]) check()
}

function finishDecoder(state, decoder) {
  state.buffer += decoder.end()
  for (const check of [...state.waiters]) check()
}

function createSession(ctx, cwd) {
  const handle = ctx.subprocess.spawn({
    argv: ['bash', '--noprofile', '--norc'],
    cwd,
    env: {
      TERM: 'dumb',
      PAGER: 'cat',
      GIT_PAGER: 'cat',
      DSH_SHELL: '1',
      BASH_SILENCE_DEPRECATION_WARNING: '1',
    },
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 3000,
  })
  if (!handle.stdin || !handle.stdout || !handle.stderr) {
    handle.terminate()
    throw new Error('oci-pipe-bash: subprocess provider did not return pipe streams')
  }

  const state = {
    handle,
    buffer: '',
    dropped: false,
    failure: undefined,
    exited: false,
    waiters: new Set(),
    stdoutDecoder: new StringDecoder('utf8'),
    stderrDecoder: new StringDecoder('utf8'),
  }
  handle.stdout.on('data', (chunk) => appendDecoded(state, state.stdoutDecoder, chunk))
  handle.stderr.on('data', (chunk) => appendDecoded(state, state.stderrDecoder, chunk))
  void handle.done.then(
    (outcome) => {
      state.exited = true
      state.outcome = outcome
      finishDecoder(state, state.stdoutDecoder)
      finishDecoder(state, state.stderrDecoder)
    },
    (error) => {
      state.exited = true
      state.failure = error instanceof Error ? error : new Error(String(error))
      for (const check of [...state.waiters]) check()
    },
  )
  return state
}

async function writeText(stream, text) {
  if (stream.destroyed) throw new Error('oci-pipe-bash: stdin 已关闭')
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      stream.off('error', onError)
      reject(error)
    }
    stream.once('error', onError)
    stream.write(text, 'utf8', (error) => {
      stream.off('error', onError)
      if (error) reject(error)
      else resolve()
    })
  })
}

function waitForMarker(state, marker, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer
    let settled = false
    const token = `${marker}:`
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      state.waiters.delete(check)
      signal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => finish(reject, signal.reason ?? new Error('oci-pipe-bash: 命令已中止'))
    const check = () => {
      if (state.failure) {
        finish(reject, state.failure)
        return
      }
      const markerOffset = state.buffer.indexOf(token)
      if (markerOffset >= 0) {
        const lineEnd = state.buffer.indexOf('\n', markerOffset + token.length)
        if (lineEnd >= 0) {
          const statusText = state.buffer.slice(markerOffset + token.length, lineEnd).trim()
          if (/^\d+$/.test(statusText)) {
            // 完成标记前的首个换行是包装器分隔符，不属于命令输出。
            const rawOutput = state.buffer.slice(0, markerOffset)
            const output = rawOutput.startsWith('\n') ? rawOutput.slice(1) : rawOutput
            state.buffer = state.buffer.slice(lineEnd + 1)
            const dropped = state.dropped
            state.dropped = false
            finish(resolve, { output, exitCode: Number(statusText), dropped })
            return
          }
        }
      }
      if (state.exited) finish(reject, new Error('oci-pipe-bash: shell 在完成标记前退出'))
    }
    state.waiters.add(check)
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => finish(reject, new Error(`oci-pipe-bash: 命令超时（${timeoutMs}ms）`)), timeoutMs)
    check()
  })
}

async function runCommand(state, command, signal, timeoutMs) {
  const marker = `__DSH_PIPE_END_${randomUUID()}__`
  const script = `\n{\n${command}\n}\n__dsh_status=$?\nprintf '\\n${marker}:%s\\n' "$__dsh_status"\n`
  await writeText(state.handle.stdin, script)
  return await waitForMarker(state, marker, signal, timeoutMs)
}

async function closeSession(state) {
  if (state.exited) return
  state.handle.terminate()
  await state.handle.done.catch(() => undefined)
}

function renderResult(result, maxOutputChars) {
  let output = result.output
  let truncated = result.dropped
  if (output.length > maxOutputChars) {
    output = output.slice(-maxOutputChars)
    truncated = true
  }
  if (truncated) output += `${output.length > 0 ? '\n' : ''}[output truncated]`
  if (output.length === 0) output = '(no output)'
  if (result.exitCode !== 0) output += `\n[exit code: ${result.exitCode}]`
  return output
}

function resolveWorkdir(exec) {
  return exec?.agent?.session?.header?.cwd ?? process.cwd()
}

function serialize(owner, queues, operation) {
  const previous = queues.get(owner) ?? Promise.resolve()
  const current = previous.then(operation, operation)
  queues.set(owner, current.then(() => undefined, () => undefined))
  return current
}

export function apply(ctx, config = {}) {
  const timeoutMs = validatePositiveInteger(config.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs')
  const maxOutputChars = validatePositiveInteger(config.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS, 'maxOutputChars')
  const description = typeof config.description === 'string' && config.description.trim().length > 0
    ? config.description
    : DEFAULT_DESCRIPTION
  const sessions = new WeakMap()
  const queues = new WeakMap()
  const liveSessions = new Set()

  const reset = async (owner, state) => {
    if (sessions.get(owner) === state) sessions.delete(owner)
    liveSessions.delete(state)
    await closeSession(state)
  }

  ctx.on?.('agent/disposed', ({ agent }) => {
    const state = sessions.get(agent)
    if (state) void reset(agent, state)
  })
  ctx.effect?.(() => async () => {
    await Promise.all([...liveSessions].map((state) => closeSession(state)))
    liveSessions.clear()
  })

  ctx.tools.register({
    name: 'bash',
    description,
    parameters: {
      command: { type: 'string', required: true, description: 'The bash command to run.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const command = args?.command
      if (typeof command !== 'string' || command.trim().length === 0) {
        throw new Error('command must be a non-empty string')
      }
      if (command.length > MAX_COMMAND_CHARS) {
        throw new Error(`command exceeds ${MAX_COMMAND_CHARS} characters`)
      }
      const owner = exec?.agent
      if (!owner) throw new Error('bash requires an owning agent session')

      return serialize(owner, queues, async () => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(new Error(`oci-pipe-bash: 命令超时（${timeoutMs}ms）`)), timeoutMs)
        const signal = exec.signal === undefined
          ? controller.signal
          : AbortSignal.any([exec.signal, controller.signal])
        let state = sessions.get(owner)
        try {
          if (!state || state.exited) {
            state = createSession(ctx, resolveWorkdir(exec))
            sessions.set(owner, state)
            liveSessions.add(state)
            await runCommand(state, ':', signal, timeoutMs)
            state.buffer = ''
            state.dropped = false
          }
          const result = await runCommand(state, command, signal, timeoutMs)
          return renderResult(result, maxOutputChars)
        } catch (error) {
          if (state) await reset(owner, state)
          throw error
        } finally {
          clearTimeout(timer)
        }
      })
    },
    presentCall: (args) => ({ card: 'terminal', title: args.command }),
  })
}
