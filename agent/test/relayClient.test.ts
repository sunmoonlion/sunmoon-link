// 端到端（进程内）：假会合点 + 假 exec-server + 真 RelayClient。验配对、透传、过滤拒绝、重连。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { RelayClient } from "../src/relayClient.js";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { validPermissionReport, type PermissionReport } from "../src/relayProtocol.js";

type Waiter<T> = { promise: Promise<T>; resolve: (v: T) => void };
function waiter<T>(): Waiter<T> { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => (resolve = r)); return { promise, resolve }; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeRelay {
  wss: WebSocketServer; port = 0; agentCtrl: WebSocket | null = null; pending = new Map<string, Waiter<WebSocket>>();
  hellos: any[] = [];
  ready: Promise<void>;
  constructor(public rejectReason?: string) { this.wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }); this.ready = new Promise<void>((r) => this.wss.once("listening", r)); }
  async start() {
    await this.ready;
    this.port = (this.wss.address() as any).port;
    this.wss.on("connection", (ws, req) => {
      const url = new URL(req.url ?? "/", "http://x");
      ws.once("message", (data) => {
        const h = JSON.parse(String(data)); this.hellos.push({ path: url.pathname, ...h });
        if (url.pathname === "/agent") {
          if (this.rejectReason) { ws.send(JSON.stringify({ type: "reject", reason: this.rejectReason })); ws.close(); return; }
          this.agentCtrl = ws; ws.send(JSON.stringify({ type: "welcome", relay: "fake", proto: 1 }));
        } else if (url.pathname === "/agent-data") {
          this.pending.get(url.searchParams.get("conn")!)?.resolve(ws);
        }
      });
    });
  }
  /** 模拟一个沙箱连上来：返回一对（沙箱侧 ws，可以直接收发 JSON-RPC） */
  async connectSandbox(kind?: "service"): Promise<WebSocket> {
    const conn = Math.random().toString(16).slice(2, 10); const w = waiter<WebSocket>(); this.pending.set(conn, w);
    this.agentCtrl!.send(JSON.stringify({ type: "open", conn, ...(kind ? { kind } : {}) }));
    // 会合点是逐消息透传：测试里直接把代理的数据流 ws 当作“沙箱侧”对端使用，语义等价
    return await w.promise;
  }
  async close() { for (const c of this.wss.clients) c.terminate(); await new Promise<void>((r) => this.wss.close(() => r())); }
}

class FakeExecServer {
  wss: WebSocketServer; port = 0; received: any[] = []; connections = 0;
  ready: Promise<void>;
  constructor() { this.wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }); this.ready = new Promise<void>((r) => this.wss.once("listening", r)); }
  async start() {
    await this.ready;
    this.port = (this.wss.address() as any).port;
    this.wss.on("connection", (ws) => {
      this.connections++;
      ws.on("message", (data: RawData) => {
        const f = JSON.parse(String(data)); this.received.push(f);
        if ("id" in f) ws.send(JSON.stringify({ id: f.id, result: { echoed: f.method } }));
      });
    });
  }
  async close() { for (const c of this.wss.clients) c.terminate(); await new Promise<void>((r) => this.wss.close(() => r())); }
}

async function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => ws.once("message", (d) => resolve(JSON.parse(String(d)))));
}

describe("RelayClient", () => {
  let relay: FakeRelay; let es: FakeExecServer; let client: RelayClient;
  const ROOT = "/home/u/proj";
  beforeEach(async () => { relay = new FakeRelay(); es = new FakeExecServer(); await relay.start(); await es.start(); });
  afterEach(async () => { client?.stop(); await relay.close(); await es.close(); });

  function makeClient(over: Partial<ConstructorParameters<typeof RelayClient>[0]> = {}) {
    client = new RelayClient({ relayUrl: `ws://127.0.0.1:${relay.port}`, userId: "u1", token: "t1", codexVersion: "0.155.1", softwareVersion: "test", localUrl: () => `ws://127.0.0.1:${es.port}`, ceiling: () => ({ sandbox: "workspace-write", network: false }), roots: () => [ROOT], ...over });
    client.start();
    return client;
  }

  it("sends hello on the control channel and becomes connected", async () => {
    makeClient();
    for (let i = 0; i < 50 && client.status !== "connected"; i++) await sleep(20);
    expect(client.status).toBe("connected");
    expect(relay.hellos[0]).toMatchObject({ path: "/agent", type: "hello", role: "agent", user: "u1", token: "t1", codex: "0.155.1", proto: 1 });
    expect(relay.hellos[0].capabilities).toContain("service-v1");
  });

  it("services open.kind=service without ever connecting to exec-server", async () => {
    makeClient();
    await connected();
    const wb = await relay.connectSandbox("service");
    const response = nextMessage(wb); wb.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "service/hello" }));
    expect(await response).toEqual({ jsonrpc: "2.0", id: 1, result: { agent: "sunmoon-agent", version: "test", roots: [ROOT], libraryDir: null, capabilities: ["service-v1"] } });
    expect(es.connections).toBe(0); expect(client.stats.connections).toBe(0);
    expect(client.stats.service).toMatchObject({ active: 1, requests: 1 });
    const denied = nextMessage(wb); wb.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "process/start", params: {} }));
    expect((await denied).error.code).toBe(-32601); expect(es.received).toEqual([]);
  });

  async function connected() { for (let i = 0; i < 50 && client.status !== "connected"; i++) await sleep(20); expect(client.status).toBe("connected"); }

  it("closes the third service stream and keeps sandbox counters independent", async () => {
    makeClient(); await connected();
    await relay.connectSandbox("service"); await relay.connectSandbox("service");
    const third = await relay.connectSandbox("service");
    await new Promise(resolve => third.once("close", resolve));
    expect(client.stats.service.active).toBe(2); expect(es.connections).toBe(0);
    await relay.connectSandbox(); await sleep(50);
    expect(es.connections).toBe(1); expect(client.stats.active).toBe(1); expect(client.stats.service.active).toBe(2);
  });

  it("closes oversized or binary service messages without contacting exec-server", async () => {
    makeClient(); await connected();
    for (const binary of [false, true]) {
      const wb = await relay.connectSandbox("service");
      const closed = new Promise(resolve => wb.once("close", resolve));
      wb.send(binary ? Buffer.from("{}") : "x".repeat(1024 * 1024 + 1), { binary }); await closed;
    }
    expect(es.connections).toBe(0); expect(client.stats.service.active).toBe(0);
  });

  it("cancels service streams on control disconnect", async () => {
    makeClient(); await connected();
    const wb = await relay.connectSandbox("service"); const closed = new Promise(resolve => wb.once("close", resolve));
    relay.agentCtrl!.terminate(); await closed;
    expect(client.stats.service.active).toBe(0); expect(es.connections).toBe(0);
  });

  it("reports the machine (name, whitelisted roots, ceiling) in the control hello only", async () => {
    makeClient({ machineName: () => "laptop" });
    for (let i = 0; i < 50 && client.status !== "connected"; i++) await sleep(20);
    const ctrl = relay.hellos.find((h) => h.path === "/agent");
    expect(ctrl.machine.name).toBe("laptop");
    expect(ctrl.machine.roots).toEqual([ROOT]);
    expect(ctrl.machine.ceiling).toMatchObject({ sandbox: expect.any(String), network: expect.any(Boolean) });
    await relay.connectSandbox();
    expect(relay.hellos.find((h) => h.path === "/agent-data")?.machine).toBeUndefined();
  });

  it("stays compatible when no machine name is given: the hello carries no machine", async () => {
    makeClient();
    for (let i = 0; i < 50 && client.status !== "connected"; i++) await sleep(20);
    expect(relay.hellos[0].machine).toBeUndefined();
  });

  function permission(): PermissionReport {
    return { id: randomUUID(), conn: "01234567", threadId: randomUUID(), requestDigest: "a".repeat(64),
      permissionDigest: "b".repeat(64), decision: "approved", scope: { sandbox: "workspace-write", network: false }, expiresAt: Math.floor(Date.now() / 1000) + 300 };
  }

  async function connectedWithReports(enabled = true) {
    makeClient();
    for (let i = 0; i < 50 && client.status !== "connected"; i++) await sleep(20);
    if (enabled) { relay.agentCtrl!.send(JSON.stringify({ type: "welcome", relay: "fake", proto: 1, capabilities: ["local-permission-v1"] })); await sleep(20); }
  }

  it("waits for a matching committed receipt and rejects a stale or unknown receipt", async () => {
    await connectedWithReports();
    const p = permission();
    const sent = nextMessage(relay.agentCtrl!);
    let settled = false;
    const recorded = client.reportPermission(p).then(r => { settled = true; return r; });
    expect(await sent).toEqual({ type: "permission_report", report: p });
    relay.agentCtrl!.send(JSON.stringify({ type: "permission_receipt", id: randomUUID(), status: "recorded" }));
    await sleep(20); expect(settled).toBe(false);
    relay.agentCtrl!.send(JSON.stringify({ type: "permission_receipt", id: p.id, status: "recorded" }));
    expect(await recorded).toBe(true);
  });

  it("fails closed for old relay, invalid schema, timeout, refusal, stop and disconnect", async () => {
    await connectedWithReports(false);
    expect(await client.reportPermission(permission())).toBe(false);
    relay.agentCtrl!.send(JSON.stringify({ type: "welcome", relay: "fake", proto: 1, capabilities: ["local-permission-v1"] })); await sleep(20);
    expect(await client.reportPermission({ ...permission(), token: "fixture" } as any)).toBe(false);
    expect(await client.reportPermission(permission(), 10)).toBe(false);
    const p = permission(); const pending = client.reportPermission(p);
    relay.agentCtrl!.send(JSON.stringify({ type: "permission_receipt", id: p.id, status: "rejected" }));
    expect(await pending).toBe(false);
    const lost = client.reportPermission(permission()); relay.agentCtrl!.terminate();
    expect(await lost).toBe(false);
    expect(await client.reportPermission(permission())).toBe(false);
  });

  it("does not accept unsolicited receipt after stop", async () => {
    await connectedWithReports();
    const p = permission(); const pending = client.reportPermission(p);
    client.stop();
    expect(await pending).toBe(false);
    expect(await client.reportPermission(p)).toBe(false);
  });

  it("makes pairing mismatch visible without stopping the executor connection", async () => {
    await connectedWithReports();
    relay.agentCtrl!.send(JSON.stringify({ type: "notice", code: "codex_version_mismatch" })); await sleep(20);
    expect(client.lastNotice).toBe("codex_version_mismatch");
    expect(client.status).toBe("connected");
  });

  it("strict report wire validation keeps credentials and ambiguous types out", () => {
    const good = permission(); expect(validPermissionReport(good)).toBe(true);
    for (const bad of [{ ...good, env: {} }, { ...good, expiresAt: true }, { ...good, requestDigest: good.requestDigest + "\n" },
      { ...good, scope: { sandbox: "danger-full-access", network: false } }, { ...good, scope: { ...good.scope, network: "false" } }]) {
      expect(validPermissionReport(bad)).toBe(false);
    }
  });

  it("opens a data stream on 'open', forwards allowed requests to exec-server and responses back", async () => {
    makeClient();
    for (let i = 0; i < 50 && client.status !== "connected"; i++) await sleep(20);
    const sb = await relay.connectSandbox();
    const dataHello = relay.hellos.find((h) => h.path === "/agent-data");
    expect(dataHello?.conn).toBeTruthy();
    await sleep(50);
    const req = { id: 7, method: "fs/readFile", params: { path: `file://${ROOT}/a.txt`, sandbox: null } };
    const resp = nextMessage(sb); sb.send(JSON.stringify(req));
    expect(await resp).toEqual({ id: 7, result: { echoed: "fs/readFile" } });
    expect(es.received).toContainEqual(req);
    expect(client.stats.forwardedUp).toBe(1);
  });

  it("denies a danger-full-access process/start locally without forwarding", async () => {
    makeClient();
    for (let i = 0; i < 50 && client.status !== "connected"; i++) await sleep(20);
    const sb = await relay.connectSandbox(); await sleep(50);
    const req = { id: 9, method: "process/start", params: { processId: "1", argv: ["sh"], cwd: `file://${ROOT}`, sandbox: null } };
    const resp = nextMessage(sb); sb.send(JSON.stringify(req));
    const r = await resp;
    expect(r.id).toBe(9); expect(r.error.code).toBe(-32001); expect(r.error.message).toMatch(/exceeds local ceiling/);
    expect(es.received.find((f) => f.method === "process/start")).toBeUndefined();
    expect(client.stats.denied).toBe(1);
    expect(client.stats.lastDenial?.method).toBe("process/start");
  });

  it("stops retrying after a reject", async () => {
    await relay.close(); relay = new FakeRelay("bad token"); await relay.start();
    makeClient();
    for (let i = 0; i < 50 && client.status !== "rejected"; i++) await sleep(20);
    expect(client.status).toBe("rejected"); expect(client.lastError).toBe("401: 这台电脑的连接已失效，请点『重新连接账号』。");
  });

  it("calls onRejected once when the relay rejects the hello", async () => {
    await relay.close(); relay = new FakeRelay("bad token"); await relay.start();
    const seen: string[] = [];
    makeClient({ onRejected: (r) => seen.push(r) });
    for (let i = 0; i < 50 && seen.length === 0; i++) await sleep(20);
    await sleep(200);
    expect(seen).toEqual(["401: 这台电脑的连接已失效，请点『重新连接账号』。"]);
  });

  it("calls onRejected once when replaced by a newer agent (4000)", async () => {
    const seen: string[] = [];
    makeClient({ onRejected: (r) => seen.push(r) });
    for (let i = 0; i < 50 && client.status !== "connected"; i++) await sleep(20);
    relay.agentCtrl!.close(4000, "x");
    for (let i = 0; i < 50 && seen.length === 0; i++) await sleep(20);
    await sleep(200);
    expect(seen).toEqual(["4000: 你的账号已在另一台电脑上连接，这台已断开。"]);
  });

  it("does not call onRejected on an ordinary disconnect", async () => {
    const seen: string[] = [];
    makeClient({ onRejected: (r) => seen.push(r) });
    for (let i = 0; i < 50 && client.status !== "connected"; i++) await sleep(20);
    relay.agentCtrl!.terminate();
    await sleep(400);
    expect(seen).toEqual([]);
  });

  for (const [code, reason] of [[4000, "4000: 你的账号已在另一台电脑上连接，这台已断开。"], [4003, "4003: 这台电脑的连接已失效，请点『重新连接账号』。"]] as const) {
    it(`does not reconnect after close ${code}`, async () => {
      makeClient();
      for (let i = 0; i < 50 && client.status !== "connected"; i++) await sleep(20);
      relay.agentCtrl!.close(code, "x");
      for (let i = 0; i < 50 && client.status !== "rejected"; i++) await sleep(20);
      expect(client.status).toBe("rejected"); expect(client.lastError).toBe(reason);
      await sleep(1500);
      expect(relay.hellos.filter((h) => h.path === "/agent").length).toBe(1);
    });
  }

  it("reconnects the control channel after the relay drops it", async () => {
    makeClient();
    for (let i = 0; i < 50 && client.status !== "connected"; i++) await sleep(20);
    relay.agentCtrl!.terminate();
    for (let i = 0; i < 20 && client.status === "connected"; i++) await sleep(20);
    expect(client.status).not.toBe("connected");
    for (let i = 0; i < 150 && client.status !== "connected"; i++) await sleep(20);
    expect(client.status).toBe("connected");
    expect(relay.hellos.filter((h) => h.path === "/agent").length).toBe(2);
  });

  it("gives up a handshake that never completes and dials again", async () => {
    // 边缘卡死时的样子：TCP 连得上，升级请求永远没有回音，也不报错、不关闭
    const sockets: Socket[] = [];
    const dead = createServer((socket) => { sockets.push(socket); });
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as any).port;
    try {
      makeClient({ relayUrl: `ws://127.0.0.1:${port}`, timing: { handshakeMs: 200, heartbeatMs: 30000 } });
      for (let i = 0; i < 100 && sockets.length < 2; i++) await sleep(20);
      expect(sockets.length).toBe(2);
      expect(client.status).not.toBe("connected");
    } finally {
      client.stop();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => dead.close(() => r()));
    }
  });

  it("drops a control channel that has gone silent and reconnects", async () => {
    makeClient({ timing: { handshakeMs: 15000, heartbeatMs: 100 } });
    for (let i = 0; i < 50 && client.status !== "connected"; i++) await sleep(20);
    expect(client.status).toBe("connected");
    // 会合点那头不再读：收不到 ping，也就不回 pong，连接却没断
    (relay.agentCtrl as any)._socket.pause();
    for (let i = 0; i < 150 && relay.hellos.filter((h) => h.path === "/agent").length < 2; i++) await sleep(20);
    expect(relay.hellos.filter((h) => h.path === "/agent").length).toBe(2);
    for (let i = 0; i < 50 && client.status !== "connected"; i++) await sleep(20);
    expect(client.status).toBe("connected");
  });

  it("keeps a control channel that answers its heartbeats", async () => {
    makeClient({ timing: { handshakeMs: 15000, heartbeatMs: 50 } });
    for (let i = 0; i < 50 && client.status !== "connected"; i++) await sleep(20);
    await sleep(400);
    expect(client.status).toBe("connected");
    expect(relay.hellos.filter((h) => h.path === "/agent").length).toBe(1);
  });
});
