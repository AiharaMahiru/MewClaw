/** Windows supervisor 支持的 worker 执行 profile。 */
export type IsolationProfile = "lightweight" | "full" | "oci";

type Environment = Record<string, string | undefined>;

export interface IsolationProfileConfig {
  profile: IsolationProfile;
  overlay: string;
  requiresPodman: boolean;
}

const PROFILES: Readonly<Record<IsolationProfile, IsolationProfileConfig>> = {
  lightweight: {
    profile: "lightweight",
    overlay: "apps/lark-worker/lightweight.overlay.yml",
    requiresPodman: false,
  },
  full: {
    profile: "full",
    overlay: "apps/lark-worker/full.overlay.yml",
    requiresPodman: false,
  },
  oci: {
    profile: "oci",
    overlay: "apps/lark-worker/oci.overlay.yml",
    requiresPodman: true,
  },
};

/** 缺省选择 full 宿主能力组合；未知值 fail loud。 */
export function resolveIsolationProfile(environment: Environment): IsolationProfileConfig {
  const value = environment.DSH_LARK_ISOLATION_PROFILE?.trim() || "full";
  if (value !== "lightweight" && value !== "full" && value !== "oci") {
    throw new Error("DSH_LARK_ISOLATION_PROFILE 只允许 lightweight、full 或 oci");
  }
  return PROFILES[value];
}
