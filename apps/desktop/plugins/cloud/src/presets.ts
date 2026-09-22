/** 本机 preset Provider：保留官方发现/挂载/持久化，仅统一 Web 可见名单与名称。 */
import type { Context } from '@deepseek-ai/cordis';
import { AgentPresets, type AgentPresetRoster, type Config } from '@deepseek-ai/dsh-agent-presets';
import z from '@deepseek-ai/schemastery';

interface DesktopPresetConfig extends Config { displayNames?: Record<string, string> }

export default class DesktopAgentPresets extends AgentPresets {
  static override Config: z<DesktopPresetConfig> = z.intersect([AgentPresets.Config, z.object({ displayNames: z.dict(z.string()).required() })]);
  private readonly displayNames: Record<string, string>;
  constructor(ctx: Context, config: DesktopPresetConfig) {
    if (!config.displayNames) throw new Error('WEB_PRESET_POLICY_REQUIRED');
    super(ctx, config);
    this.displayNames = config.displayNames;
  }
  override async remoteExportList(): Promise<AgentPresetRoster> {
    const roster = await super.remoteExportList();
    return { ...roster, presets: roster.presets.filter(row => Object.hasOwn(this.displayNames, row.id))
      .map(row => ({ ...row, name: this.displayNames[row.id]! })) };
  }
}
