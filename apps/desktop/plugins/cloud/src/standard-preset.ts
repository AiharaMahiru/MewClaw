/** 历史模式 wrapper：按安装位置包含官方 standard，兼容 workspace 与物理发行。 */
import type { Context } from '@deepseek-ai/cordis';
import { Include } from '@deepseek-ai/cordis-plugin-include';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export default class DesktopStandardPreset extends Include {
  constructor(ctx: Context) {
    const manifest = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-agent-presets/package.json');
    super(ctx, { path: new URL('presets/standard/agent.cordis.yml', pathToFileURL(manifest)).href });
  }
}
