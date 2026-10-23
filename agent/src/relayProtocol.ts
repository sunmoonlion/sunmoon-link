// 会合点协议 v1（0004-relay）。代理与沙箱都只出站；会合点按 user 配对，逐消息透传。
// 控制通道：代理 → 会合点 `/agent`；会合点用 {"type":"open","conn":ID} 通知代理开一条数据流。
// 数据流：代理 → 会合点 `/agent-data?conn=ID`；沙箱 → 会合点 `/sandbox`。两端第一帧都是 hello。
export const RELAY_PROTOCOL = 1;
export const PERMISSION_CAPABILITY = "local-permission-v1";

/** No argv, environment, paths, tokens or model keys on the audit channel. */
export interface PermissionReport {
  id: string;
  conn: string;
  threadId: string;
  requestDigest: string;
  permissionDigest: string;
  decision: "approved" | "denied";
  scope: { sandbox: "read-only" | "workspace-write" | "danger-full-access"; network: boolean };
  expiresAt: number;
}

export function validPermissionReport(value: unknown, now = Date.now() / 1000): value is PermissionReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, any>;
  const keys = ["id", "conn", "threadId", "requestDigest", "permissionDigest", "decision", "scope", "expiresAt"];
  if (Object.keys(v).length !== keys.length || !Object.keys(v).every(k => keys.includes(k))) return false;
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
  if (![v.id, v.threadId].every(x => typeof x === "string" && x.length === 36 && uuid.test(x))) return false;
  if (typeof v.conn !== "string" || v.conn.length !== 8 || !/^[0-9a-f]{8}$/.test(v.conn)) return false;
  if (![v.requestDigest, v.permissionDigest].every(x => typeof x === "string" && x.length === 64 && /^[0-9a-f]{64}$/.test(x))) return false;
  return ["approved", "denied"].includes(v.decision) && v.scope && typeof v.scope === "object"
    && Object.keys(v.scope).length === 2 && Object.hasOwn(v.scope, "sandbox") && Object.hasOwn(v.scope, "network")
    && ["read-only", "workspace-write", "danger-full-access"].includes(v.scope.sandbox) && typeof v.scope.network === "boolean"
    && (v.scope.sandbox !== "danger-full-access" || v.decision === "denied")
    && Number.isSafeInteger(v.expiresAt) && v.expiresAt > now && v.expiresAt <= now + 7200;
}

export interface Hello {
  type: "hello";
  role: "agent" | "sandbox" | "site";
  proto: number;
  user: string;
  token: string;
  /** 这一端的 Codex 版本（成对检查：不一致会合点拒绝配对） */
  codex: string;
  /** 软件版本（代理版 / 沙箱镜像版） */
  software: string;
  /** 数据流才有 */
  conn?: string;
  /**
   * 控制通道才有：这台机器叫什么、白名单里有哪些目录、它自己定的上限。
   * 会合点原样记下，工作台据此登记「我的机器」并知道它在不在线。只用来显示和登记，不是授权依据：
   * 能动哪些目录始终由本机的过滤和外沙箱拦。
   */
  machine?: MachineInfo;
  capabilities?: string[];
}

export interface MachineInfo {
  name: string;
  roots: string[];
  ceiling: { sandbox: string; network: boolean };
  /** 设备编号（账 143）：工作台按它认「这台电脑上的这一份本地 link」，不按电脑名 */
  device_id?: string;
  /** 操作系统的主机名与系统：配置目录被整个拷到别的电脑时，编号会跟过去，靠这两样发现 */
  host?: string;
  os?: string;
}

export type ControlMessage =
  | { type: "welcome"; relay: string; proto: number; capabilities?: string[] }
  | { type: "reject"; reason: string }
  | { type: "open"; conn: string; kind?: "service" }
  | { type: "notice"; code: "codex_version_mismatch" }
  | { type: "permission_receipt"; id: string; status: "recorded" | "rejected" }
  | { type: "ping" }
  | { type: "pong" };

export function hello(h: Omit<Hello, "type" | "proto">): string {
  return JSON.stringify({ type: "hello", proto: RELAY_PROTOCOL, ...h });
}
