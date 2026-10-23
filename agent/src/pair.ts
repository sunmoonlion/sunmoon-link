// Browser-confirmed pairing. The device secret and agent token stay out of logs and stdout.
import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { CONFIG_PATH, defaultConfig, ensureDeviceId, loadConfig, saveConfig, type AgentConfig } from "./config.js";
import { registerSecret } from "./log.js";
import { installedSite } from "./siteTrust.js";

const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;
const SECRET = /^[A-Za-z0-9_-]{32,128}$/;

export const PAIR_EXIT = { ok: 0, failed: 1, expired: 4, denied: 5, cancelled: 6 } as const;

export function newDeviceSecret(): string {
  const secret = randomBytes(32).toString("base64url");
  if (!SECRET.test(secret)) throw new Error("无法生成连接秘密");
  return secret;
}

export function deviceSecretSha256(secret: string): string {
  if (!SECRET.test(secret)) throw new Error("连接秘密无效");
  return createHash("sha256").update(secret, "ascii").digest("hex");
}

export function menuTarget(hasToken: boolean): "tray" | "pair-page" {
  return hasToken ? "tray" : "pair-page";
}

/** A signed-in machine whose background agent is down is started before the tray opens. */
export function menuPlan(hasToken: boolean, running: boolean): { start: boolean; action: "tray" | "pair-page" } {
  const action = menuTarget(hasToken);
  return { start: action === "tray" && !running, action };
}

export function configHasToken(file = CONFIG_PATH): boolean {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof cfg.token === "string" && cfg.token.length > 0;
  } catch { return false; }
}

export interface PairResponse { status: number; body: unknown }

export interface PairProgress {
  event: string;
  user_code?: string;
  expires_at?: string;
  verify_url?: string;
  status?: string;
  message?: string;
  account?: string;
}

export interface PairRunOptions {
  webOrigin: string;
  relayUrl: string;
  machineName: string;
  osName: string;
  agentVersion: string;
  codexVersion: string;
  configPath: string;
  post: (url: string, body: Record<string, string>) => Promise<PairResponse>;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  secret?: string;
  cancelled?: () => boolean;
  stdout?: (line: string) => void;
  stopIfRunning?: () => Promise<void>;
  progress?: (state: PairProgress) => void;
}

function printable(value: string, max: number, label: string): string {
  const text = value.trim();
  if (!text || text.length > max || /[\x00-\x1f\x7f]/.test(text)) throw new Error(`${label}无法提交`);
  return text;
}

function endpoint(origin: string, suffix: string): string {
  let base: URL;
  try { base = new URL(origin); } catch { throw new Error("站点地址不正确"); }
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("站点地址不正确");
  return new URL(suffix, origin.endsWith("/") ? origin : `${origin}/`).href;
}

function say(stdout: ((line: string) => void) | undefined, value: unknown): void {
  stdout?.(JSON.stringify(value));
}

/** Presentation is memory-only; never emits pairing credentials. */
export function emitStatus(opts: { progress?: (state: PairProgress) => void }, value: PairProgress): void {
  opts.progress?.(value);
}

async function cancelRequest(opts: PairRunOptions, requestId: string, secret: string): Promise<void> {
  await opts.post(endpoint(opts.webOrigin, `/api/agent-pairing/requests/${requestId}/cancel`), { device_secret: secret });
}

export async function runPair(opts: PairRunOptions): Promise<number> {
  const secret = opts.secret ?? newDeviceSecret();
  registerSecret(secret);
  const machineName = printable(opts.machineName, 128, "电脑名称");
  const osName = printable(opts.osName, 64, "系统");
  const agentVersion = printable(opts.agentVersion, 64, "本地 link 版本");
  const codexVersion = printable(opts.codexVersion, 64, "Codex 版本");
  const created = await opts.post(endpoint(opts.webOrigin, "/api/agent-pairing/requests"), {
    machine_name: machineName,
    os: osName,
    agent_version: agentVersion,
    codex_version: codexVersion,
    device_secret_sha256: deviceSecretSha256(secret),
  });
  if (created.status === 503) return fail(opts, "unavailable: 连接服务暂不可用，请稍后再试。");
  if (created.status === 422) return fail(opts, "invalid: 这台电脑的连接信息无法提交，请重新从网页下载安装包。");
  if (created.status !== 200 && created.status !== 201) return fail(opts, "not-found: 连接没有完成，请重新获取。");
  const start = created.body as Record<string, unknown>;
  const requestId = typeof start.request_id === "string" ? start.request_id : "";
  const userCode = typeof start.user_code === "string" ? start.user_code : "";
  const expiresIn = start.expires_in;
  const interval = start.interval;
  const verifyUrl = typeof start.verify_url === "string" ? start.verify_url : "";
  if (!/^[A-Za-z0-9-]{1,80}$/.test(requestId) || !CODE.test(userCode) || expiresIn !== 300 || interval !== 3 || !/^https?:\/\//.test(verifyUrl)) {
    return fail(opts, "invalid: 连接服务返回的内容无法使用，请重新获取。");
  }
  const clock = opts.now ?? (() => Date.now());
  const deadline = clock() + expiresIn * 1000;
  const openable = openableVerifyUrl(verifyUrl, opts.webOrigin) ?? "";
  say(opts.stdout, { event: "code", user_code: userCode, expires_in: expiresIn, verify_url: openable, request_id: requestId });
  // 本机页根据绝对时刻计算倒计时；此投影不包含配对秘密或令牌。
  emitStatus(opts, { event: "code", user_code: userCode, expires_at: new Date(deadline).toISOString(), verify_url: openable });
  const pause = interval * 1000;
  let extra = 0;
  while (clock() < deadline) {
    if (opts.cancelled?.()) { await cancelRequest(opts, requestId, secret); return done(opts, PAIR_EXIT.cancelled, "cancelled: 已取消连接。"); }
    await opts.sleep(pause + extra);
    extra = 0;
    if (opts.cancelled?.()) { await cancelRequest(opts, requestId, secret); return done(opts, PAIR_EXIT.cancelled, "cancelled: 已取消连接。"); }
    const polled = await opts.post(endpoint(opts.webOrigin, `/api/agent-pairing/requests/${requestId}/poll`), { device_secret: secret });
    if (polled.status === 429) { extra = pause; continue; }
    if (polled.status === 404) return fail(opts, "not-found: 连接没有完成，请重新获取。");
    if (polled.status === 503) return fail(opts, "unavailable: 连接服务暂不可用，请稍后再试。");
    if (polled.status !== 200) return fail(opts, "not-found: 连接没有完成，请重新获取。");
    const body = polled.body as Record<string, unknown>;
    if (body.status === "pending") continue;
    if (body.status === "expired") return done(opts, PAIR_EXIT.expired, "expired: 确认码已过期，请重新获取。");
    if (body.status === "denied") return done(opts, PAIR_EXIT.denied, "denied: 确认码已被拒绝，请重新获取。");
    if (body.status === "cancelled") return done(opts, PAIR_EXIT.cancelled, "cancelled: 已取消连接。");
    if (body.status === "delivered") return fail(opts, "delivered: 确认码已经用过，请重新获取。");
    if (body.status === "approved") return await accept(opts, body);
    return fail(opts, "not-found: 连接没有完成，请重新获取。");
  }
  return done(opts, PAIR_EXIT.expired, "expired: 确认码已过期，请重新获取。");
}

async function accept(opts: PairRunOptions, body: Record<string, unknown>): Promise<number> {
  const token = body.agent_token;
  const relayUrl = body.relay_url;
  const relayUser = body.relay_user;
  if (typeof token !== "string" || !token || typeof relayUrl !== "string" || typeof relayUser !== "string" || !relayUser.trim()) {
    return fail(opts, "invalid: 连接服务返回的内容无法使用，请重新获取。");
  }
  if (relayUrl !== opts.relayUrl) return fail(opts, "invalid: 会合点与安装包不一致，没有保存连接。");
  registerSecret(token);
  if (opts.stopIfRunning) await opts.stopIfRunning();
  let cfg: AgentConfig;
  if (fs.existsSync(opts.configPath)) cfg = loadConfig(opts.configPath);
  else cfg = defaultConfig();
  cfg.relayUrl = relayUrl;
  cfg.userId = relayUser;
  cfg.token = token;
  ensureDeviceId(cfg);
  saveConfig(cfg, opts.configPath);
  say(opts.stdout, { event: "result", status: "approved", account: relayUser });
  // account 是用户可读标识，token 只进 config.json，不进呈现状态。
  emitStatus(opts, { event: "result", status: "approved", account: relayUser });
  return PAIR_EXIT.ok;
}

function done(opts: PairRunOptions, code: number, message: string): number {
  const status = message.split(":")[0];
  say(opts.stdout, { event: "result", status, message });
  // message 是我们自己写的人话（expired / denied / cancelled / failed），不含秘密。
  emitStatus(opts, { event: "result", status, message });
  return code;
}

function fail(opts: PairRunOptions, message: string): number {
  return done(opts, PAIR_EXIT.failed, message);
}

export function siteDocument(moduleUrl: string): { webOrigin: string; relayUrl: string } {
  const site = installedSite(moduleUrl);
  if (!site) throw new Error("没有站点文件。请从网页的安装命令安装。");
  const doc = JSON.parse(fs.readFileSync(path.join(site.root, "site", "site.json"), "utf8"));
  if (typeof doc.web_origin !== "string" || !doc.web_origin || typeof doc.relay_url !== "string" || !doc.relay_url) throw new Error("站点地址不正确");
  return { webOrigin: doc.web_origin, relayUrl: doc.relay_url };
}

export function siteOrigin(moduleUrl: string): string {
  return siteDocument(moduleUrl).webOrigin;
}

/** A browser may open only a URL that is the packaged site, or a path under it. */
export function openableVerifyUrl(verifyUrl: string, webOrigin: string): string | null {
  if (!webOrigin || !verifyUrl.startsWith(webOrigin)) return null;
  const rest = verifyUrl.slice(webOrigin.length);
  if (rest && !/^[/?#]/.test(rest)) return null;
  if (!/^https?:\/\/[^ \r\n]+$/.test(verifyUrl)) return null;
  return verifyUrl;
}

export function osLabel(platform = process.platform): string {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  return printable(platform, 64, "系统");
}
