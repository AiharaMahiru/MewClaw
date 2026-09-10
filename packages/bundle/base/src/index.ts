/**
 * dsh-lark-base bundle 包：只有声明（行集在 cordis.patch.yml）。
 * worker 部署组合的第一层（在 dsh-base 之上）；网关不挂 dsh-base，
 * 其强制层即 gateway bundle 自身（见 bundles SPEC §4）。
 */
export const BUNDLE_NAME = "dsh-lark-base";
