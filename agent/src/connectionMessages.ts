// One human sentence per known failure. The original code stays; tokens and remote prose do not.
const SAFE_CODE = /^[A-Za-z0-9_-]{1,64}$/;
const TLS = /^(?:UNABLE_TO_VERIFY_|SELF_SIGNED_|DEPTH_ZERO_SELF_SIGNED|UNABLE_TO_GET_ISSUER_CERT|CERT_|ERR_TLS_CERT_ALTNAME_INVALID$)/;
const NETWORK = new Set(["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);

export interface HumanError { code: string; message: string }

function shown(code: string, sentence: string): HumanError {
  return { code, message: `${code}: ${sentence}` };
}

function hostName(host: string | undefined): string {
  return host && /^[A-Za-z0-9.-]{1,253}$/.test(host) ? host : "会合点";
}

const CERT = "这台电脑不信任站点证书。请重新从网页下载安装包；若仍出现，联系管理员。";
const offline = (host?: string) => `连不上 ${hostName(host)}。检查网络或代理设置。`;
const EXPIRED = "令牌已失效，请在托盘点『重新颁发令牌』。";
const REPLACED = "这个账号的令牌已颁发给另一份本地 link，这台已断开。";

export function humanizeReject(reason: unknown, host?: string): HumanError {
  const r = typeof reason === "string" ? reason : "";
  if (r === "replaced by a newer agent for this user") return shown("4000", REPLACED);
  if (r === "token revoked") return shown("4003", EXPIRED);
  if (r === "bad token" || r.startsWith("jwt ") || r === "malformed jwt") return shown("401", EXPIRED);
  if (r === "pairing-expired") return shown("expired", "确认码已过期，请重新获取。");
  if (r === "pairing-denied") return shown("denied", "确认码已被拒绝，请重新获取。");
  if (r.startsWith("codex version mismatch") || r.startsWith("protocol ") || r === "missing codex version") {
    return shown("version-mismatch", "本地 link 与服务端版本不匹配，连接已拒绝。请安装与服务端配套的本地 link 后重试。");
  }
  return shown("relay-rejected", `连不上 ${hostName(host)}。请核对服务地址和本地 link 的版本后再试。`);
}

export function humanizeClose(code: number): HumanError {
  if (code === 4000) return shown("4000", REPLACED);
  if (code === 4003) return shown("4003", EXPIRED);
  throw new Error("humanizeClose only covers close codes 4000 and 4003");
}

export function humanizeTransport(error: { code?: unknown; message?: unknown }, host?: string): HumanError {
  const code = typeof error.code === "string" && SAFE_CODE.test(error.code) ? error.code : "";
  const message = typeof error.message === "string" ? error.message : "";
  if (TLS.test(code) || TLS.test(message)) return shown(code || "SELF_SIGNED_CERT_IN_CHAIN", CERT);
  if (code === "401" || message.includes("Unexpected server response: 401")) return shown("401", EXPIRED);
  if (NETWORK.has(code) || (!code && /timed out|ETIMEDOUT/i.test(message))) return shown(code || "ETIMEDOUT", offline(host));
  if (code) return shown(code, offline(host));
  return shown("connection-failed", offline(host));
}
