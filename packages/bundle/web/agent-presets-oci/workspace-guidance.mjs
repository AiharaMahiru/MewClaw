/** OCI 执行面统一的工作区路径提示，不改变任何文件权限或路径解析。 */
export const name = 'oci-workspace-guidance'
export const inject = ['systemPrompt']

export function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'oci:workspace-paths',
    order: 110,
    text: [
      'OCI workspace path rule:',
      '/workspace is only the mount path shown inside Bash.',
      'For read, write, edit, read_image, glob, and grep, use paths relative to the session working directory and never pass /workspace.',
      'Do not request broader sandbox permissions to work around this path distinction.',
    ].join(' '),
  }))
}
