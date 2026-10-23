// 出站桥：一条控制 WS 到会合点；每收到 open 就开一条数据流到会合点、一条本地 WS 到 exec-server，两头对接。
// 沙箱→执行端方向的每个 JSON-RPC 请求过一遍协议过滤；越界的回错误、不转发。断线指数退避重连（握手超时、心跳没回也算断线）；exec-server 不动。
import WebSocket from "ws";
import { WindowsBridge } from "./windowsBridge.js";
import type { WindowsMode, WindowsHelper, WindowsTemporary } from "./windowsRuntime.js";
import { decide, denialResponse, type Ceiling } from "./filter.js";
import { log, registerSecret } from "./log.js";
import { humanizeClose, humanizeReject, humanizeTransport } from "./connectionMessages.js";
import { relayHost } from "./siteTrust.js";
import type { LocalPermissions } from "./permissions.js";
import { hello, PERMISSION_CAPABILITY, validPermissionReport, type PermissionReport, type ControlMessage } from "./relayProtocol.js";
import { CONFIG_DIR } from "./config.js";
import { WindowsFiles } from "./windowsRuntime.js";
import { ServiceHandler, SERVICE_CAPABILITY, SERVICE_MAX_FRAME, SERVICE_RUNS_CAPABILITY } from "./service.js";

export interface RelayClientOptions {
  windows?: { home: string; helper: WindowsHelper; mode: WindowsMode; temporary: WindowsTemporary; executorEnvironment: () => NodeJS.ProcessEnv; confirmedHttpUrls?: readonly string[] };
  relayUrl: string;
  userId: string;
  token: string;
  codexVersion: string;
  softwareVersion: string;
  localUrl: () => string; // exec-server 的当前地址（重启后端口可能变）
  ceiling: () => Ceiling;
  roots: () => readonly string[];
  /** 这台机器的名字（网页「我的机器」里显示）；不给就不上报机器信息 */
  machineName?: () => string;
  /** 设备编号、主机名、系统，随机器信息一起报（账 143）；不给就不报 */
  identity?: () => { deviceId: string; host: string; os: string };
  /** 被会合点拒绝（令牌无效、被吊销、令牌已颁发给另一份本地 link）时调用一次；之后不会再重连。 */
  onRejected?: (reason: string) => void;
  onNotice?: (code: "codex_version_mismatch") => void;
  confirmPermission?: LocalPermissions["confirm"];
  codexHome?: string;
  /** 测试电脑才开（账 129）：服务流可在白名单根下的 runs/ 里建、删目录。普通用户的本地 link 不开。 */
  serviceRunsWritable?: boolean;
  /** 控制通道的两个时限（毫秒）；测试才改。见 CONTROL_TIMING */
  timing?: { handshakeMs: number; heartbeatMs: number };
}

/** 控制通道的两个时限。握手：从发起连接到收到 welcome，超了就断开重连——边缘卡死再重启时，
 * 半开的连接既不报错也不关闭，不设时限就永远等下去（2026-10-19 测试电脑静默 17 分钟）。
 * 心跳：连上后每隔这么久发一个 ping；上一次以来会合点什么都没回（消息、ping、pong 都算），就断开重连。 */
export const CONTROL_TIMING = { handshakeMs: 15000, heartbeatMs: 30000 };

/** 给本机探测接口看的连接状态（会合点备忘第五节）：网页据此分清令牌失效、被顶替、版本不配和连不上。 */
export type LinkState = "connected" | "connecting" | "unreachable" | "token_invalid" | "replaced" | "version_mismatch" | "rejected";

export interface BridgeStats {
  connections: number;
  active: number;
  forwardedUp: number;
  forwardedDown: number;
  denied: number;
  lastDenial?: { method: string; reason: string; at: string };
  service: { connections: number; active: number; requests: number; denied: number };
}

export class RelayClient {
  private ctrl: WebSocket | null = null;
  private streams = new Set<() => void>();
  private serviceStreams = new Set<() => void>();
  private stopped = false;
  private backoff = 1000;
  readonly stats: BridgeStats = { connections: 0, active: 0, forwardedUp: 0, forwardedDown: 0, denied: 0, service: { connections: 0, active: 0, requests: 0, denied: 0 } };
  status: "disconnected" | "connecting" | "connected" | "rejected" = "disconnected";
  lastError = "";
  /** lastError 的代码部分（connectionMessages 的 code）：401/4003 令牌、4000 被顶替、version-mismatch、网络错误码 */
  lastErrorCode = "";
  lastNotice = "";
  private permissionReportsAvailable = false;
  private controlEpoch = 0;
  private pendingReports = new Map<string, { resolve: (recorded: boolean) => void; timer: NodeJS.Timeout }>();

  /** Only a committed workbench receipt returns true. Old relays, timeouts,
   * invalid reports and disconnects all return false; no optimistic grant. */
  reportPermission(report: PermissionReport, timeoutMs = 30000): Promise<boolean> {
    if (!validPermissionReport(report) || !this.permissionReportsAvailable || this.ctrl?.readyState !== WebSocket.OPEN
      || this.pendingReports.has(report.id) || this.pendingReports.size >= 32) return Promise.resolve(false);
    return new Promise(resolve => {
      const timer = setTimeout(() => this.finishReport(report.id, false), Math.min(30000, Math.max(1, timeoutMs)));
      this.pendingReports.set(report.id, { resolve, timer });
      try { this.ctrl!.send(JSON.stringify({ type: "permission_report", report })); }
      catch { this.finishReport(report.id, false); }
    });
  }

  private finishReport(id: string, recorded: boolean): void {
    const pending = this.pendingReports.get(id);
    if (!pending) return;
    this.pendingReports.delete(id); clearTimeout(pending.timer); pending.resolve(recorded);
  }

  private clearReports(): void {
    this.controlEpoch++;
    this.permissionReportsAvailable = false;
    for (const id of this.pendingReports.keys()) this.finishReport(id, false);
  }

  constructor(private readonly opts: RelayClientOptions) { registerSecret(opts.token); }

  start(): void {
    this.stopped = false;
    this.connectControl();
  }

  private rejectedNotified = false;

  private notifyRejected(): void {
    if (this.rejectedNotified) return;
    this.rejectedNotified = true;
    try { this.opts.onRejected?.(this.lastError); } catch { log("error", "onRejected handler failed"); }
  }

  stop(): void {
    this.stopped = true;
    this.clearReports();
    this.ctrl?.close();
    this.ctrl = null;
    for (const close of this.streams) close();
  }

  private fail(info: { code: string; message: string }): void {
    this.lastError = info.message; this.lastErrorCode = info.code;
  }

  get linkState(): LinkState {
    if (this.status === "connected") return "connected";
    const code = this.lastErrorCode;
    if (code === "401" || code === "4003") return "token_invalid";
    if (code === "4000") return "replaced";
    if (code === "version-mismatch") return "version_mismatch";
    if (this.status === "rejected") return "rejected";
    return code ? "unreachable" : "connecting";
  }

  private controlUrl(): string {
    return this.opts.relayUrl.replace(/\/$/, "") + "/agent";
  }

  private dataUrl(conn: string): string {
    return this.opts.relayUrl.replace(/\/$/, "") + `/agent-data?conn=${encodeURIComponent(conn)}`;
  }

  private connectControl(): void {
    if (this.stopped) return;
    this.status = "connecting";
    const ws = new WebSocket(this.controlUrl(), { maxPayload: 64 * 1024 });
    this.ctrl = ws;
    const { handshakeMs, heartbeatMs } = this.opts.timing ?? CONTROL_TIMING;
    let heard = true;
    let heartbeat: NodeJS.Timeout | undefined;
    const handshake = setTimeout(() => {
      if (this.ctrl !== ws) return;
      log("warn", "relay handshake timed out", { ms: handshakeMs });
      this.fail(humanizeTransport({ code: "ETIMEDOUT" }, relayHost(this.opts.relayUrl)));
      ws.terminate();
    }, handshakeMs);
    const clearTimers = () => { clearTimeout(handshake); clearInterval(heartbeat); };
    const beat = () => {
      if (this.ctrl !== ws) { clearTimers(); return; }
      if (!heard) {
        log("warn", "relay silent, reconnecting", { ms: heartbeatMs });
        ws.terminate();
        return;
      }
      heard = false;
      try { ws.ping(); } catch { /* 已在关，close 会接手 */ }
    };
    ws.on("ping", () => { heard = true; });
    ws.on("pong", () => { heard = true; });
    ws.on("open", () => {
      // 机器信息只在控制通道的 hello 里报一次：白名单和上限改了要重启 start，重启就会重报
      const id = this.opts.identity?.();
      const machine = this.opts.machineName
        ? { name: this.opts.machineName(), roots: [...this.opts.roots()], ceiling: { ...this.opts.ceiling() }, ...(id ? { device_id: id.deviceId, host: id.host, os: id.os } : {}) }
        : undefined;
      ws.send(hello({ role: "agent", user: this.opts.userId, token: this.opts.token, codex: this.opts.codexVersion, software: this.opts.softwareVersion, capabilities: [SERVICE_CAPABILITY, ...(this.opts.serviceRunsWritable ? [SERVICE_RUNS_CAPABILITY] : [])], ...(machine ? { machine } : {}) }));
    });
    ws.on("message", (data) => {
      if (this.ctrl !== ws || this.stopped) return;
      heard = true;
      let msg: ControlMessage;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "welcome") {
        this.permissionReportsAvailable = Array.isArray(msg.capabilities) && msg.capabilities.includes(PERMISSION_CAPABILITY);
        this.status = "connected"; this.backoff = 1000; this.lastError = ""; this.lastErrorCode = "";
        clearTimeout(handshake); clearInterval(heartbeat); heartbeat = setInterval(beat, heartbeatMs);
        log("info", "relay connected");
      } else if (msg.type === "reject") {
        const info = humanizeReject(msg.reason, relayHost(this.opts.relayUrl));
        this.status = "rejected"; this.fail(info);
        log("error", info.message);
        this.stopped = true; ws.close();
        this.notifyRejected();
      } else if (msg.type === "open") {
        if (msg.kind === undefined || msg.kind === "service") this.openStream(msg.conn, msg.kind);
      } else if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      } else if (msg.type === "permission_receipt") {
        if (Object.keys(msg).sort().join() === "id,status,type" && typeof msg.id === "string" && ["recorded", "rejected"].includes(msg.status)) {
          this.finishReport(msg.id, msg.status === "recorded");
        }
      } else if (msg.type === "notice" && msg.code === "codex_version_mismatch") {
        this.lastNotice = "codex_version_mismatch";
        log("warn", "沙箱与本地 link 的 Codex 版本不一致，已拒绝连接；请更新成配套版本后重试。本地 link 继续等待兼容的连接。");
        try { this.opts.onNotice?.(msg.code); } catch { log("warn", "notice handler failed"); }
      }
    });
    const onDown = (why: string) => {
      clearTimers();
      if (this.ctrl !== ws) return;
      this.clearReports();
      for (const close of this.serviceStreams) close();
      this.ctrl = null;
      if (this.status !== "rejected") this.status = "disconnected";
      if (this.stopped) return;
      log("warn", "relay control down, will retry", { why, inMs: this.backoff });
      setTimeout(() => this.connectControl(), this.backoff);
      this.backoff = Math.min(30000, this.backoff * 2);
    };
    ws.on("close", (code) => {
      // 4000 = 同一用户有更新的代理连上来，会合点把我们顶掉了；4003 = 令牌被吊销。
      // 这两种都不重连：重连只会把对方再顶掉，两个代理每秒互踢（KIND 09 实测）
      if ((code === 4000 || code === 4003) && this.ctrl === ws) {
        this.status = "rejected";
        this.fail(humanizeClose(code));
        this.stopped = true;
        log("error", this.lastError, { code });
        this.notifyRejected();
      }
      onDown(`close ${code}`);
    });
    ws.on("error", (error: { code?: unknown; message?: unknown }) => {
      this.fail(humanizeTransport(error, relayHost(this.opts.relayUrl)));
      onDown(this.lastError);
    });
  }

  private openServiceStream(conn: string): void {
    const up = new WebSocket(this.dataUrl(conn), { maxPayload: SERVICE_MAX_FRAME });
    if (this.stats.service.active >= 2) {
      log("warn", "service stream limit");
      up.on("error", () => {});
      up.on("open", () => {
        up.send(hello({ role: "agent", user: this.opts.userId, token: this.opts.token, codex: this.opts.codexVersion, software: this.opts.softwareVersion, conn }));
        up.close(1008, "service stream limit");
      });
      return;
    }
    this.stats.service.connections++; this.stats.service.active++;
    const w = this.opts.windows;
    const handler = new ServiceHandler({ version: this.opts.softwareVersion, roots: this.opts.roots, runsWritable: this.opts.serviceRunsWritable,
      configDir: CONFIG_DIR, codexHome: w?.home ?? this.opts.codexHome ?? CONFIG_DIR,
      files: w ? new WindowsFiles({ url: this.opts.localUrl, home: w.home, roots: this.opts.roots(), mode: w.mode,
        writable: false, helper: w.helper, temporary: w.temporary.directory }) : undefined,
      onRequest: (method, code) => {
        this.stats.service.requests++;
        if (code) this.stats.service.denied++;
        log(code ? "warn" : "debug", "service request", { method, ...(code ? { code } : {}) });
      },
    });
    let finished = false;
    const stop = () => finish();
    const finish = (code = 1000) => {
      if (finished) return; finished = true;
      this.streams.delete(stop); this.serviceStreams.delete(stop); this.stats.service.active--;
      void handler.close().catch(() => log("warn", "service helper close failed"));
      up.close(code);
    };
    this.streams.add(stop); this.serviceStreams.add(stop);
    up.on("open", () => {
      if (finished) return;
      up.send(hello({ role: "agent", user: this.opts.userId, token: this.opts.token, codex: this.opts.codexVersion, software: this.opts.softwareVersion, conn }));
    });
    up.on("message", (data, binary) => {
      if (finished) return;
      void handler.receive(String(data), binary).then(response => {
        if (!finished && response && up.readyState === WebSocket.OPEN) up.send(response);
      }).catch(() => finish(1009));
    });
    up.on("close", () => finish()); up.on("error", () => finish());
  }

  private openStream(conn: string, kind?: "service"): void {
    if (kind === "service") { this.openServiceStream(conn); return; }
    this.stats.connections += 1; this.stats.active += 1;
    const up = new WebSocket(this.dataUrl(conn), { maxPayload: this.opts.windows ? 12 * 1024 * 1024 : 0 });
    const windows = this.opts.windows ? new WindowsBridge({ ...this.opts.windows, roots: this.opts.roots(), ceiling: this.opts.ceiling(), url: this.opts.localUrl,
      localPermissions: this.opts.confirmPermission ? { confirm: this.opts.confirmPermission,
        report: report => this.reportPermission({ ...report, conn }),
        available: () => this.permissionReportsAvailable && this.status === "connected",
        epoch: () => this.controlEpoch,
      } : undefined,
    }) : null;
    let chain = Promise.resolve();
    let pendingFrames = 0, pendingBytes = 0;
    const forward = (data: WebSocket.RawData, binary: boolean) => {
      if (!windows) { this.forwardUp(data, binary, up, local); return; }
      chain = chain.then(async () => {
        if (finished) return;
        const result = await windows.receive(String(data), binary);
        if (result.reason) {
          this.stats.denied += 1; this.stats.lastDenial = { method: result.method, reason: result.reason, at: new Date().toISOString() };
          log("warn", "denied by local ceiling", { method: result.method, reason: result.reason });
        }
        if (result.response && up.readyState === WebSocket.OPEN) up.send(result.response);
        if (result.forward && local.readyState === WebSocket.OPEN) { this.stats.forwardedUp += 1; local.send(result.forward); }
      }).catch(() => finish("Windows stream failed")).finally(() => { pendingFrames--; pendingBytes -= Buffer.byteLength(String(data)); });
    };
    const local = new WebSocket(this.opts.localUrl(), { maxPayload: 0 });
    const queueUp: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];
    let localReady = false;
    let finished = false;
    const stopStream = () => finish("agent stopped");
    const finish = (why: string) => {
      if (finished) return; finished = true; this.streams.delete(stopStream);
      void windows?.close();
      if (this.stats.active > 0) this.stats.active -= 1;
      log("info", "stream closed", { conn, why });
      try { up.close(); } catch {}
      try { local.close(); } catch {}
    };
    this.streams.add(stopStream);
    up.on("open", () => {
      up.send(hello({ role: "agent", user: this.opts.userId, token: this.opts.token, codex: this.opts.codexVersion, software: this.opts.softwareVersion, conn }));
    });
    local.on("open", () => {
      localReady = true;
      for (const q of queueUp) forward(q.data, q.isBinary);
      queueUp.length = 0;
      log("info", "stream bridged", { conn, local: this.opts.localUrl() });
    });
    up.on("message", (data, isBinary) => {
      if (finished) return;
      if (windows) {
        pendingFrames++; pendingBytes += Buffer.byteLength(String(data));
        if (pendingFrames > 128 || pendingBytes > 24 * 1024 * 1024) { finish("Windows request queue limit"); return; }
      }
      if (!localReady) { queueUp.push({ data, isBinary }); return; }
      forward(data, isBinary);
    });
    local.on("message", (data, isBinary) => {
      if (!isBinary) windows?.observe(String(data));
      this.stats.forwardedDown += 1;
      if (up.readyState === WebSocket.OPEN) up.send(data, { binary: isBinary });
    });
    up.on("close", (c) => finish(`relay side close ${c}`));
    up.on("error", () => finish("relay data connection failed"));
    local.on("close", (c) => finish(`exec-server side close ${c}`));
    local.on("error", () => finish("exec-server connection failed"));
  }

  /** 沙箱 → 执行端：过滤后转发 */
  private forwardUp(data: WebSocket.RawData, isBinary: boolean, up: WebSocket, local: WebSocket): void {
    if (!isBinary) {
      const text = String(data);
      let frame: any = null;
      try { frame = JSON.parse(text); } catch { /* 不是 JSON 就原样转 */ }
      if (frame && typeof frame === "object") {
        const d = decide(frame, this.opts.ceiling(), this.opts.roots());
        if (!d.allow) {
          this.stats.denied += 1;
          this.stats.lastDenial = { method: frame.method, reason: d.reason ?? "", at: new Date().toISOString() };
          log("warn", "denied by local ceiling", { method: frame.method, reason: d.reason });
          if (up.readyState === WebSocket.OPEN) up.send(denialResponse(frame, d.reason ?? "denied"));
          return;
        }
      }
    }
    this.stats.forwardedUp += 1;
    if (local.readyState === WebSocket.OPEN) local.send(data, { binary: isBinary });
  }
}
