/**
 * OCI profile 实机验收：管道 Bash、打包 ripgrep、断网和清理。
 * 镜像由 `pnpm sandbox:build` 生成；没有 Podman 或镜像时不伪造通过。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { Context } from '@deepseek-ai/cordis'
import { apply as applyFsSearch } from '@deepseek-ai/dsh-tool-fs-search'
import { describe, expect, it } from 'vitest'

import { apply } from '../../../bundle/web/agent-presets-oci/pipe-bash.mjs'
import { resolveSandboxConfig } from './config.ts'
import { containerName, OciContainerRuntime } from './container.ts'
import { OciSubprocessRuntime } from './runtime.ts'

const executeFile = promisify(execFile)
const PODMAN = process.platform === 'win32' ? 'C:\\Program Files\\RedHat\\Podman\\podman.exe' : 'podman'
const IMAGE = process.env.DSH_SANDBOX_E2E_IMAGE ?? 'localhost/dsh-lark-sandbox:1.0.0'

async function available() {
  try {
    await executeFile(PODMAN, ['info'], { timeout: 10000 })
    await executeFile(PODMAN, ['image', 'exists', IMAGE], { timeout: 10000 })
    return true
  } catch {
    return false
  }
}

async function collect(handle) {
  const outcome = await handle.done
  return {
    outcome,
    stdout: handle.collected.stdout?.readFrom(0).text ?? '',
    stderr: handle.collected.stderr?.readFrom(0).text ?? '',
  }
}

const runnable = await available()

describe.skipIf(!runnable)('OCI 管道 Bash 实机验收', () => {
  it('保持 Bash 状态并让 glob/grep 使用容器内 ripgrep', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-lark-oci-pipe-e2e-'))
    let core
    try {
      await chmod(workspace, 0o777)
      await mkdir(join(workspace, 'nested'))
      await writeFile(join(workspace, 'notes.md'), 'workspace note\n', 'utf8')
      await writeFile(join(workspace, 'nested', 'match.txt'), 'needle in container\n', 'utf8')

      const config = resolveSandboxConfig({ image: IMAGE, podmanPath: PODMAN, workspaceRoot: workspace })
      core = new OciContainerRuntime({ config })
      const subprocess = new OciSubprocessRuntime(new Context(), core, config)
      const definitions = []
      apply({
        subprocess,
        tools: {
          register(definition) {
            definitions.push(definition)
            return () => undefined
          },
        },
        on: () => () => undefined,
        effect: () => () => undefined,
      }, { timeoutMs: 30000, maxOutputChars: 16000 })

      const bash = definitions.find((definition) => definition.name === 'bash')
      expect(bash).toBeDefined()
      const exec = { agent: { id: 'oci-e2e-session', session: { header: { cwd: workspace } } } }

      await expect(bash.execute({ command: "printf 'state-ok\\n'" }, exec)).resolves.toContain('state-ok')
      await expect(bash.execute({ command: 'cd nested' }, exec)).resolves.toContain('(no output)')
      await expect(bash.execute({ command: 'pwd' }, exec)).resolves.toContain('/workspace/nested')

      const searchDefinitions = []
      const searchCtx = {
        subprocess,
        tools: {
          register(definition) {
            searchDefinitions.push(definition)
            return () => undefined
          },
        },
        systemPrompt: { section: () => undefined, getSectionOrder: () => 100 },
        on: () => () => undefined,
      }
      await applyFsSearch(searchCtx, {
        sampleOverCapGlobResults: false,
        globMaxResults: 100,
        grepMaxMatches: 250,
        grepMaxLineBytes: 2000,
        searchMetaMaxBytes: 16000,
        rawOutputMaxBytes: 65536,
        graceMs: 5000,
        stderrMaxBytes: 4096,
        timeoutMs: 30000,
      })
      const searchExec = { ...exec, signal: new AbortController().signal }
      const globTool = searchDefinitions.find((definition) => definition.name === 'glob')
      const grepTool = searchDefinitions.find((definition) => definition.name === 'grep')
      expect(globTool).toBeDefined()
      expect(grepTool).toBeDefined()
      const globResult = await globTool.execute({ pattern: '**/*.txt' }, searchExec)
      expect(globResult.paths).toContain('nested/match.txt')
      const grepResult = await grepTool.execute({ pattern: 'needle' }, searchExec)
      expect(grepResult.matches).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'nested/match.txt', line: 'needle in container' }),
      ]))

      const { rgPath } = await import('@vscode/ripgrep')
      const glob = await collect(subprocess.spawn({
        argv: [rgPath, '--no-config', '--files', '--hidden'],
        cwd: workspace,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 4096 } },
        graceMs: 5000,
      }))
      expect(glob.outcome.exitCode).toBe(0)
      expect(glob.stdout).toContain('nested/match.txt')
      expect(glob.stdout).not.toContain(rgPath)

      const grep = await collect(subprocess.spawn({
        argv: [rgPath, '--no-config', 'needle', '.'],
        cwd: workspace,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 4096 } },
        graceMs: 5000,
      }))
      expect(grep.outcome.exitCode).toBe(0)
      expect(grep.stdout).toContain('nested/match.txt')
      expect(grep.stdout).toContain('needle in container')

      const blocked = await collect(subprocess.spawn({
        argv: ['bash', '-c', 'exec 3<>/dev/tcp/198.51.100.1/80'],
        cwd: workspace,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
        graceMs: 5000,
      }))
      expect(blocked.outcome.exitCode).not.toBe(0)

      const expectedName = containerName(createHash('sha256').update(workspace).digest('hex'))
      await core.dispose()
      const ps = await executeFile(PODMAN, ['ps', '-a', '--format', '{{.Names}}'])
      expect(String(ps.stdout).split(/\r?\n/).filter(Boolean)).not.toContain(expectedName)
    } finally {
      await core?.dispose().catch(() => undefined)
      await rm(workspace, { recursive: true, force: true })
    }
  }, 600000)

  it('每个工作区只映射自己的 /workspace，且不会读取宿主同名绝对路径', async () => {
    const firstWorkspace = await mkdtemp(join(tmpdir(), 'dsh-lark-oci-first-'))
    const secondWorkspace = await mkdtemp(join(tmpdir(), 'dsh-lark-oci-second-'))
    let core
    try {
      await chmod(firstWorkspace, 0o777)
      await chmod(secondWorkspace, 0o777)
      await writeFile(join(firstWorkspace, 'owner.txt'), 'first-workspace\n', 'utf8')
      await writeFile(join(firstWorkspace, 'first-only.txt'), 'private\n', 'utf8')
      await writeFile(join(secondWorkspace, 'owner.txt'), 'second-workspace\n', 'utf8')
      await writeFile(join(secondWorkspace, 'second-only.txt'), 'private\n', 'utf8')

      const config = resolveSandboxConfig({ image: IMAGE, podmanPath: PODMAN, workspaceRoot: tmpdir() })
      core = new OciContainerRuntime({ config })
      const subprocess = new OciSubprocessRuntime(new Context(), core, config)

      const first = await collect(subprocess.spawn({
        argv: [
          'bash', '-c',
          'pwd; cat /workspace/owner.txt; test ! -e /workspace/second-only.txt; test ! -e "$1"',
          'bash', firstWorkspace,
        ],
        cwd: firstWorkspace,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 4096 } },
        graceMs: 5000,
      }))
      expect(first.outcome.exitCode).toBe(0)
      expect(first.stdout).toBe('/workspace\nfirst-workspace\n')

      const second = await collect(subprocess.spawn({
        argv: [
          'bash', '-c',
          'pwd; cat /workspace/owner.txt; test ! -e /workspace/first-only.txt; test ! -e "$1"',
          'bash', secondWorkspace,
        ],
        cwd: secondWorkspace,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 4096 } },
        graceMs: 5000,
      }))
      expect(second.outcome.exitCode).toBe(0)
      expect(second.stdout).toBe('/workspace\nsecond-workspace\n')
    } finally {
      await core?.dispose().catch(() => undefined)
      await rm(firstWorkspace, { recursive: true, force: true })
      await rm(secondWorkspace, { recursive: true, force: true })
    }
  }, 600000)
})
