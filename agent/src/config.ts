import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WindowsCapability } from "./windowsBootstrap.js";
import type { Ceiling } from "./filter.js";
import { canonicalPath } from "./pathuri.js";

export interface AgentConfig {
  windowsSandbox?: WindowsCapability;
  /** 会合点地址，如 wss://edge.example.com/relay 或 ws://127.0.0.1:47100 */
  relayUrl: string;
  /** 用户标识（会合点按它配对） */
  userId: string;
  /** 会合点令牌（第一期：工作台签发的字符串；桥在 hello 里带上） */
  token: string;
  /** 根目录白名单（绝对路径） */
  roots: string[];
  /** Local settings choices, including unchecked directories; never grants access. */
  rootChoices?: string[];
  /** Local read-only library; never a writable workspace root. */
  libraryDir?: string | null;
  lastSettingsChange?: string | null;
  ceiling: Ceiling;
  /** exec-server 监听端口；0 = 自动选空闲回环端口 */
  execPort: number;
  /** 执行端 CODEX_HOME（会话与日志落这里；不放登录态） */
  codexHome: string;
  /** 是否启用 OS 外沙箱（Linux bwrap）；关掉只剩协议过滤，仅供调试 */
  outerSandbox: boolean;
  /** 这台机器在网页「我的机器」里显示的名字；默认用主机名。同一个用户的两台机器要不同名 */
  machineName: string;
  /** 设备编号：第一次运行时随机生成，存在这台电脑的配置里一直沿用，重新颁发令牌也不变。它代表「这台电脑上的这一份本地 link」，
   * 不含电脑或 link 的信息，不读硬件指纹；重装（配置删了）就是新编号（会合点备忘第三节，账 143）。 */
  deviceId?: string;
}

const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 没有设备编号就生成一个；生成了回 true（调用方负责存）。不放进 defaultConfig：那样每次读旧配置都会换一个新编号。 */
export function ensureDeviceId(cfg: AgentConfig): boolean {
  if (cfg.deviceId) return false;
  cfg.deviceId = randomUUID();
  return true;
}

// 0.5.0 起默认配置目录随命令改名为 .sunmoon-link（0028）：改名后的工作台从空库起，不认旧的配对与凭据，要重新接入；
// 旧的 .sunmoon-agent 原样留着不删。环境变量名是内部命名，不改。
export const CONFIG_DIR = process.env.SUNMOON_AGENT_HOME ?? path.join(os.homedir(), ".sunmoon-link");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export function defaultConfig(): AgentConfig {
  return {
    relayUrl: "ws://127.0.0.1:47100",
    userId: "local",
    token: "",
    roots: [],
    ceiling: { sandbox: "workspace-write", network: false },
    execPort: 0,
    codexHome: path.join(CONFIG_DIR, "codex-home"),
    outerSandbox: true,
    machineName: os.hostname().slice(0, 128) || "my-pc",
  };
}

export function loadConfig(file = CONFIG_PATH): AgentConfig {
  if (!fs.existsSync(file)) throw new Error(`没有配置：${file}（先跑 sunmoon-link init）`);
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error("本地 link 的配置无法读取或 JSON 无效；请在本机检查 config.json"); }
  const cfg: AgentConfig = { ...defaultConfig(), ...raw, ceiling: { ...defaultConfig().ceiling, ...(raw.ceiling ?? {}) } };
  validate(cfg);
  return cfg;
}

export function saveConfig(cfg: AgentConfig, file = CONFIG_PATH): void {
  validate(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

export function validate(cfg: AgentConfig): void {
  try { const u = new URL(cfg.relayUrl); if (!["ws:", "wss:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error(); }
  catch { throw new Error("relayUrl 必须是 ws:// 或 wss://，且不能包含口令、查询参数或片段"); }
  if (!cfg.userId) throw new Error("userId 不能为空");
  if (cfg.deviceId !== undefined && (typeof cfg.deviceId !== "string" || !DEVICE_ID.test(cfg.deviceId))) throw new Error("deviceId 非法");
  if (cfg.libraryDir != null) {
    let valid = false;
    try { valid = typeof cfg.libraryDir === "string" && canonicalPath(cfg.libraryDir) !== null && fs.statSync(cfg.libraryDir).isDirectory(); } catch { /* Fixed error below, without the private directory. */ }
    if (!valid) throw new Error("Invalid local library directory");
  }
  if (cfg.lastSettingsChange != null && (typeof cfg.lastSettingsChange !== "string" || !Number.isFinite(Date.parse(cfg.lastSettingsChange)))) throw new Error("Invalid settings timestamp");
  if (typeof cfg.machineName !== "string" || !cfg.machineName.trim() || cfg.machineName.length > 128 || /[\x00-\x1f\x7f]/.test(cfg.machineName)) throw new Error("machineName 要有，且不超过 128 个字符、不含控制字符");
  for (const r of cfg.roots) {
    if (canonicalPath(r) === null) throw new Error(`白名单根必须是受支持的本地绝对路径：${r}`);
  }
  if (cfg.rootChoices !== undefined) {
    if (!Array.isArray(cfg.rootChoices) || cfg.rootChoices.length > 32 || cfg.rootChoices.some(r => typeof r !== "string" || canonicalPath(r) === null)) throw new Error("Invalid local directory choices");
    const choices = cfg.rootChoices.map(r => canonicalPath(r));
    if (new Set(choices).size !== choices.length || cfg.roots.some(r => !choices.includes(canonicalPath(r)))) throw new Error("Selected roots must be unique directory choices");
  }
  if (cfg.windowsSandbox && !["unelevated", "elevated"].includes(cfg.windowsSandbox.mode)) throw new Error("Invalid Windows sandbox mode");
  if (typeof cfg.ceiling.network !== "boolean") throw new Error("ceiling.network must be boolean");
  if (!["read-only", "workspace-write", "danger-full-access"].includes(cfg.ceiling.sandbox)) throw new Error("ceiling.sandbox 非法");
  if (!Number.isInteger(cfg.execPort) || cfg.execPort < 0 || cfg.execPort > 65535) throw new Error("execPort 非法");
}
