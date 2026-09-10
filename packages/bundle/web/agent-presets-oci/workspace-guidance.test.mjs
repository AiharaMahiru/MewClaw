import { describe, expect, it, vi } from 'vitest'

import { apply, inject, name } from './workspace-guidance.mjs'

describe('OCI 工作区路径提示', () => {
  it('以独立系统段注册且不触碰权限服务', () => {
    let register
    const dispose = vi.fn()
    const ctx = {
      effect: vi.fn((callback) => {
        register = callback
        return dispose
      }),
      systemPrompt: { section: vi.fn(() => dispose) },
    }

    apply(ctx)
    register()

    expect(name).toBe('oci-workspace-guidance')
    expect(inject).toEqual(['systemPrompt'])
    expect(ctx.systemPrompt.section).toHaveBeenCalledWith(expect.objectContaining({
      name: 'oci:workspace-paths',
      order: 110,
      text: expect.stringContaining('never pass /workspace'),
    }))
  })
})
