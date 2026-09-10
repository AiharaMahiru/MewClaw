import type { FeishuConfig } from "./config.js";

export function buildFeishuAuthorizeUrl(config: FeishuConfig, state: string): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("app_id", config.appId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeFeishuCode(config: FeishuConfig, code: string): Promise<{ openId: string; unionId?: string; email?: string; name?: string }> {
  const response = await fetch(config.tokenUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code, app_id: config.appId, app_secret: config.appSecret }) });
  if (!response.ok) throw new Error("FEISHU_OAUTH_TOKEN_FAILED");
  const tokenBody = await response.json() as Record<string, unknown>;
  const accessToken = pickString(tokenBody, "access_token") ?? pickNestedString(tokenBody, ["data", "access_token"]);
  if (!accessToken) throw new Error("FEISHU_OAUTH_TOKEN_INVALID");
  const profileResponse = await fetch(config.userInfoUrl, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!profileResponse.ok) throw new Error("FEISHU_OAUTH_USERINFO_FAILED");
  const body = await profileResponse.json() as Record<string, unknown>;
  const data = (body.data && typeof body.data === "object" ? body.data : body) as Record<string, unknown>;
  const openId = pickString(data, "open_id") ?? pickString(data, "openId");
  if (!openId) throw new Error("FEISHU_OAUTH_PROFILE_INVALID");
  const unionId = pickString(data, "union_id") ?? pickString(data, "unionId");
  const email = pickString(data, "email");
  const name = pickString(data, "name") ?? pickString(data, "en_name");
  return { openId, ...(unionId ? { unionId } : {}), ...(email ? { email } : {}), ...(name ? { name } : {}) };
}

function pickString(value: Record<string, unknown>, key: string): string | undefined { return typeof value[key] === "string" && value[key] ? value[key] as string : undefined; }
function pickNestedString(value: Record<string, unknown>, keys: string[]): string | undefined { let current: unknown = value; for (const key of keys) { if (!current || typeof current !== "object") return undefined; current = (current as Record<string, unknown>)[key]; } return typeof current === "string" && current ? current : undefined; }
