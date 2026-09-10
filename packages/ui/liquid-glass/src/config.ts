/** Host 与浏览器共享的无密钥视觉配置。 */
export interface GlassConfig {
  enabled: boolean;
  defaultEnabled: boolean;
  refraction: boolean;
  displacementScale: number;
  blurAmount: number;
  saturation: number;
  aberrationIntensity: number;
  identityTimeoutMs: number;
}

/** 仅属于该插件的启动元素，不读取官方 DOM。 */
export const CONFIG_ID = "mewclaw-liquid-glass-config";
/** token 层与模块的稳定归属标识。 */
export const PLUGIN_ID = "dsh-lark-liquid-glass";

const DEFAULT_CONFIG: GlassConfig = {
  enabled: true, defaultEnabled: true, refraction: true, displacementScale: 32,
  blurAmount: 0.12, saturation: 130, aberrationIntensity: 1, identityTimeoutMs: 5000,
};

/**
 * 在配置输入边界显式填充默认值，拒绝未知字段和非有限数。
 * @param input - Cordis 配置或浏览器收到的 JSON。
 * @returns 完整且已校验的配置；非法输入抛出 TypeError。
 */
export function resolveConfig(input: unknown = {}): GlassConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError(`${PLUGIN_ID}: 配置必须是对象`);
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new TypeError(`${PLUGIN_ID}: 未知配置 ${key}`);
  }
  const resolved = { ...DEFAULT_CONFIG, ...record };
  for (const key of ["enabled", "defaultEnabled", "refraction"] as const) {
    if (typeof resolved[key] !== "boolean") throw new TypeError(`${PLUGIN_ID}: ${key} 必须是 boolean`);
  }
  for (const [key, min, max] of [
    ["displacementScale", 0, 80], ["blurAmount", 0, 1],
    ["saturation", 100, 180], ["aberrationIntensity", 0, 3],
    ["identityTimeoutMs", 1000, 30000],
  ] as const) {
    const value = resolved[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      throw new TypeError(`${PLUGIN_ID}: ${key} 必须在 ${min}–${max} 内`);
    }
  }
  return resolved;
}
