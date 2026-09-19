import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { apply, inject, name } from './fs-read-guard.mjs'

const roots = []

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'fs-read-guard-'))
  roots.push(dir)
  return realpathSync(dir)
}

function setup(config) {
  let guard
  const ctx = { tools: { guard: vi.fn((candidate) => (guard = candidate)) } }
  apply(ctx, config)
  return guard
}

function exec(toolName, args, cwd) {
  return {
    name: toolName,
    arguments: args,
    agent: cwd === undefined ? undefined : { session: { header: { cwd } } },
  }
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true })
})

describe('fs-read-guard', () => {
  it('注册全局 tools guard 并声明 inject', () => {
    expect(name).toBe('fs-read-guard')
    expect(inject).toEqual(['tools'])
    const guard = setup()
    expect(typeof guard).toBe('function')
  })

  it('放行会话 cwd 内的相对与绝对路径', () => {
    const cwd = workspace()
    writeFileSync(join(cwd, 'a.txt'), 'x')
    const guard = setup()
    expect(exec && guard(exec('read', { file_path: 'a.txt' }, cwd))).toBeUndefined()
    expect(guard(exec('read', { file_path: join(cwd, 'a.txt') }, cwd))).toBeUndefined()
    expect(guard(exec('read', { file_path: 'missing/yet.txt' }, cwd))).toBeUndefined()
  })

  it('拒绝逃逸到工作区外的读取', () => {
    const cwd = workspace()
    const outside = workspace()
    writeFileSync(join(outside, 'secret.txt'), 'x')
    const guard = setup()
    expect(guard(exec('read', { file_path: join(outside, 'secret.txt') }, cwd))).toMatch(/denied/)
    expect(guard(exec('read', { file_path: '../escape' }, cwd))).toMatch(/denied/)
    expect(guard(exec('read_image', { file_path: join(outside, 'a.png') }, cwd))).toMatch(/denied/)
  })

  it('经符号链接逃逸同样拒绝', () => {
    const cwd = workspace()
    const outside = workspace()
    writeFileSync(join(outside, 'secret.txt'), 'x')
    symlinkSync(outside, join(cwd, 'link'))
    const guard = setup()
    expect(guard(exec('read', { file_path: 'link/secret.txt' }, cwd))).toMatch(/denied/)
  })

  it('str_replace_editor 仅 view 命令收口', () => {
    const cwd = workspace()
    const outside = workspace()
    const guard = setup()
    expect(guard(exec('str_replace_editor', { command: 'view', path: outside }, cwd))).toMatch(/denied/)
    expect(guard(exec('str_replace_editor', { command: 'view', path: '.' }, cwd))).toBeUndefined()
    expect(guard(exec('str_replace_editor', { command: 'create', path: join(outside, 'f') }, cwd))).toBeUndefined()
  })

  it('readableRoots 放行配置根', () => {
    const cwd = workspace()
    const attachments = workspace()
    writeFileSync(join(attachments, 'file.txt'), 'x')
    const guard = setup({ readableRoots: [attachments] })
    expect(guard(exec('read', { file_path: join(attachments, 'file.txt') }, cwd))).toBeUndefined()
  })

  it('无会话 cwd 与非目标工具不收口', () => {
    const guard = setup()
    expect(guard(exec('read', { file_path: '/etc/passwd' }))).toBeUndefined()
    expect(guard(exec('bash', { command: 'ls' }, workspace()))).toBeUndefined()
    expect(guard(exec('read', {}, workspace()))).toBeUndefined()
  })

  it('非法 readableRoots 装载期 fail loud', () => {
    expect(() => apply({ tools: { guard: vi.fn() } }, { readableRoots: ['relative/path'] })).toThrow(/readableRoots/)
    expect(() => apply({ tools: { guard: vi.fn() } }, { readableRoots: 'x' })).toThrow(/readableRoots/)
  })
})
