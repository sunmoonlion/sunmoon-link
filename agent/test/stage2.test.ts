import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importCandidates, mcpToml, ownedConfig, ownedMcp, saveMcp, loadMcp } from "../src/mcp.js";
import { RotatingLog, registerSecret, safeData, safeText } from "../src/log.js";
import { rejectionInfo } from "../src/rejections.js";
import { SessionPermissions, digest } from "../src/permissions.js";
import { localConfirm } from "../src/localConfirm.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); vi.useRealTimers(); });

describe("HTTP MCP import", () => {
  it("imports only safe HTTP tables, ignoring other preferences and rejecting auth/stdio/unknown fields", () => {
    const { servers, skipped } = importCandidates(`model="unrelated"\napproval_policy="unrelated"\n[mcp_servers.docs]\nurl="https://docs.invalid/mcp"\nenabled=true\n[mcp_servers.stdio]\ncommand="do-not-run"\n[mcp_servers.secret]\nurl="https://private.invalid/mcp"\nhttp_headers={Authorization="fixture-secret"}\n[mcp_servers.query]\nurl="https://private.invalid/mcp?key=fixture-secret"\n[mcp_servers.env]\nurl="https://private.invalid/mcp"\nbearer_token_env_var="TOKEN"\n`);
    expect(skipped).toBe(4); expect(Object.keys(servers)).toEqual(["docs"]);
    const text = ownedConfig("unelevated", servers);
    expect(text).not.toMatch(/unrelated|secret|stdio|TOKEN|http_headers/);
    expect(ownedMcp(text)).toEqual(servers);
  });
  it("parses real TOML syntax rather than interpreting a fake header in a multiline string", () => {
    const { servers } = importCandidates(`note = '''\n[mcp_servers.fake]\nurl="https://fake.invalid/mcp"\n'''\n[mcp_servers."actual"]\nurl='https://actual.invalid/mcp'\n`);
    expect(Object.keys(servers)).toEqual(["actual"]);
    expect(() => importCandidates('broken = "fixture-secret')).toThrow("not valid TOML");
    try { importCandidates('broken = "fixture-secret'); } catch (e) { expect(String(e)).not.toContain("fixture-secret"); }
  });
  it("never accepts a credential-bearing owned config or unsafe saved state", () => {
    expect(() => ownedMcp(ownedConfig("unelevated") + 'model="unexpected"\n')).toThrow();
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "sunmoon-mcp-")); dirs.push(d);
    const file = path.join(d, "mcp.json"), servers = { docs: { url: "https://docs.invalid/mcp" } };
    saveMcp(file, servers); expect(loadMcp(file)).toEqual(servers);
    expect(mcpToml(servers)).toContain('[mcp_servers.docs]');
    fs.writeFileSync(file, '{"docs":{"url":"https://user:pass@invalid/mcp"}}');
    expect(() => loadMcp(file)).toThrow("invalid");
    expect(() => ownedMcp(ownedConfig("unelevated") + '\n[mcp_servers.secret]\nurl="https://invalid/mcp"\nhttp_headers={Authorization="fixture-secret"}')).toThrow();
  });
  it("refuses noninteractive confirmation", async () => {
    if (!process.stdin.isTTY || !process.stderr.isTTY) expect(await localConfirm("fixture")).toBe(false);
    const abort = new AbortController(); abort.abort(); expect(await localConfirm("fixture", abort.signal)).toBe(false);
  });
});

describe("bounded logs and useful rejection", () => {
  it("rotates only owned files and bounds total size", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "sunmoon-logs-")); dirs.push(d);
    fs.writeFileSync(path.join(d, "keep.txt"), "owner");
    const log = new RotatingLog(d, 256, 3);
    for (let i = 0; i < 100; i++) log.write(JSON.stringify({ i, msg: "x".repeat(60) }) + "\n");
    const files = fs.readdirSync(d).filter(n => n.startsWith("agent.log"));
    expect(files).toHaveLength(3);
    expect(files.reduce((n, f) => n + fs.statSync(path.join(d, f)).size, 0)).toBeLessThanOrEqual(768);
    expect(fs.readFileSync(path.join(d, "keep.txt"), "utf8")).toBe("owner");
    log.write("x".repeat(1000)); expect(fs.statSync(path.join(d, "agent.log")).size).toBeLessThanOrEqual(256);
  });
  it("does not write through hardlinked logs", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "sunmoon-logs-")); dirs.push(d);
    fs.writeFileSync(path.join(d, "keep"), "owner"); fs.linkSync(path.join(d, "keep"), path.join(d, "agent.log"));
    expect(() => new RotatingLog(d)).toThrow("alias"); expect(fs.readFileSync(path.join(d, "keep"), "utf8")).toBe("owner");
  });
  it("excludes secret fields and child raw output; strips URL auth/query and registered credentials", () => {
    const secret = "fixture-only-registered-value"; registerSecret(secret);
    const out = JSON.stringify(safeData({ msg: secret, token: "some-token", env: { KEY: "abc" }, line: "raw-secret",
      error: "Bearer bearer-canary", url: "wss://user:pass@host/path?token=query-canary", nested: { api_key: "key-canary" } }));
    for (const value of [secret, "some-token", "raw-secret", "bearer-canary", "query-canary", "key-canary", "user:pass"]) expect(out).not.toContain(value);
    expect(safeText("escape\x1b\nmessage")).not.toContain("\x1b");
    expect(JSON.stringify(rejectionInfo("untrusted fixture-secret"))).not.toContain("fixture-secret");
    expect(rejectionInfo("token revoked").message).toContain("重新颁发令牌");
    expect(rejectionInfo("codex version mismatch").message).toContain("配套");
  });
});

const roots = ["C:\\Allowed"], home = "C:\\Agent\\home";
const ceiling = { sandbox: "read-only" as const, network: false };
function request(threadId = "11111111-1111-1111-1111-111111111111") {
  return { id: 1, method: "process/start", params: { processId: "one", metadata: { threadId, toolCallId: "call-1" },
    argv: ["node.exe", "fixture"], cwd: "file:///C:/Allowed", env: {}, tty: false,
    sandbox: { cwd: "file:///C:/Allowed", workspaceRoots: [], windowsSandboxLevel: "restricted-token", permissions: {
      type: "managed", network: "restricted", file_system: { type: "restricted", entries: [{ path: { type: "special", value: { kind: "project_roots" } }, access: "write" }] },
    } },
  } };
}

describe("local session permissions", () => {
  it("requires both local consent and a recorded receipt, reuses only the same thread/scope", async () => {
    const confirm = vi.fn(async () => true), report = vi.fn(async () => true);
    const session = new SessionPermissions({ confirm, report, available: () => true, epoch: () => 1 });
    const first = await session.allow(request(), ceiling, roots, home);
    expect(first?.ceiling).toEqual({ sandbox: "workspace-write", network: false }); expect(first?.valid()).toBe(true);
    await session.allow(request(), ceiling, roots, home); expect(confirm).toHaveBeenCalledTimes(1);
    await session.allow(request("22222222-2222-2222-2222-222222222222"), ceiling, roots, home); expect(confirm).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[0][0]).toMatchObject({ requestDigest: digest(request()), decision: "approved" });
    expect(JSON.stringify(report.mock.calls)).not.toContain("node.exe");
    session.close(); expect(first?.valid()).toBe(false);
  });
  it("never prompts for malformed/unsandboxed/outside-root/unscoped requests", async () => {
    const confirm = vi.fn(async () => true), report = vi.fn(async () => true);
    const session = new SessionPermissions({ confirm, report, available: () => true, epoch: () => 1 });
    const frames: any[] = [request(), request(), request(), request()];
    frames[0].params.sandbox = null; frames[1].params.cwd = "file:///C:/Outside";
    frames[2].params.metadata = null; frames[3].params.argv = [];
    for (const f of frames) expect(await session.allow(f, ceiling, roots, home)).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({ decision: "denied", scope: { sandbox: "danger-full-access" } });
    session.close();
  });
  it("refuses on local rejection, unavailable relay and missing durable receipt", async () => {
    for (const [yes, ready, recorded] of [[false, true, true], [true, false, true], [true, true, false]]) {
      const session = new SessionPermissions({ confirm: async () => yes, report: async () => recorded, available: () => ready, epoch: () => 1 });
      expect(await session.allow(request(), ceiling, roots, home)).toBeNull(); session.close();
    }
  });
  it("invalidates grants on control reconnect, expiry and close; stops late receipt after close", async () => {
    let epoch = 1;
    const confirm = vi.fn(async () => true), report = vi.fn(async () => true);
    const session = new SessionPermissions({ confirm, report, available: () => true, epoch: () => epoch });
    const first = await session.allow(request(), ceiling, roots, home); epoch++;
    expect(first?.valid()).toBe(false);
    const second = await session.allow(request(), ceiling, roots, home); expect(confirm).toHaveBeenCalledTimes(2);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 1801000); expect(second?.valid()).toBe(false); vi.useRealTimers(); session.close();
    let resolve!: (v: boolean) => void;
    const late = new SessionPermissions({ confirm: async () => true, available: () => true, epoch: () => 1, report: () => new Promise(r => { resolve = r; }) });
    const pending = late.allow(request(), ceiling, roots, home); await Promise.resolve(); late.close(); resolve(true); expect(await pending).toBeNull();
  });
});
