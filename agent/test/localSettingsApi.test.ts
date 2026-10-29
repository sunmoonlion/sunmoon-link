import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { defaultConfig, saveConfig, type AgentConfig } from "../src/config.js";
import { startLocalApi, type LocalApiHandle } from "../src/localApi.js";
import { LocalSettings } from "../src/localSettings.js";
import { TicketVerifier } from "../src/ticket.js";
import { ticketFixture } from "./localTicketFixture.js";

const origin = "https://knowbench.example";
let base: string, file: string, root: string, other: string, cfg: AgentConfig, endpoint: LocalApiHandle;
let fixture: Awaited<ReturnType<typeof ticketFixture>>, confirm: ReturnType<typeof vi.fn>, restart: ReturnType<typeof vi.fn>;
const headers = () => ({ Origin: origin, Authorization: "Bearer " + fixture.token(), "Content-Type": "application/json" });
function request(method = "GET", body?: string, requestHeaders: Record<string, string> = headers(), route = "/local/v1/settings") {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }>((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${endpoint.port}${route}`, { method, headers: requestHeaders }, res => {
      let data = ""; res.on("data", chunk => data += chunk); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: data ? JSON.parse(data) : null }));
    }); req.on("error", reject); req.end(body);
  });
}
beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "sunmoon-settings-http-"));
  root = path.join(base, "root"); other = path.join(base, "other"); file = path.join(base, "state", "config.json");
  for (const dir of [root, other, path.join(base, "state", "codex-home")]) fs.mkdirSync(dir, { recursive: true });
  cfg = { ...defaultConfig(), userId: "probe-user", roots: [root], rootChoices: [root, other], codexHome: path.join(base, "state", "codex-home"), ceiling: { sandbox: "read-only", network: false }, token: "private-test-only" };
  saveConfig(cfg, file); fixture = await ticketFixture(); confirm = vi.fn(async () => true); restart = vi.fn(async () => {});
  const settings = new LocalSettings({ file, config: () => cfg, confirm, restart, autostart: { get: async () => false, set: async () => {} } });
  endpoint = (await startLocalApi({ webOrigin: origin, version: "0.4.0", machineName: cfg.machineName, connected: () => true, config: () => cfg, settings, ports: [0], ticket: new TicketVerifier({ webOrigin: origin, userId: () => cfg.userId, fetch: fixture.fetch }) }))!;
});
afterEach(async () => { await endpoint.close(); await fixture.close(); fs.rmSync(base, { recursive: true, force: true }); });
describe("settings HTTP contract", () => {
  it("GET exposes the same public settings as tray and info", async () => {
    const res = await request(); expect(res.status).toBe(200);
    expect(res.body).toEqual({ machineName: cfg.machineName, roots: [root], rootChoices: [root, other], ceiling: cfg.ceiling, autostart: false, lastSettingsChange: null, version: "0.4.0" });
    expect(JSON.stringify(res.body)).not.toContain(cfg.token);
  });
  it("authenticates writes and provides matching-origin PUT preflight", async () => {
    const before = fs.readFileSync(file), body = JSON.stringify({ roots: [] });
    expect((await request("PUT", body, { Origin: origin, "Content-Type": "application/json" })).status).toBe(401);
    const wrong = await request("PUT", body, { ...headers(), Origin: "https://other.example" });
    expect(wrong.status).toBe(403); expect(wrong.headers["access-control-allow-origin"]).toBeUndefined();
    const preflight = await request("OPTIONS", undefined, { Origin: origin, "Access-Control-Request-Method": "PUT" });
    expect(preflight.status).toBe(204); expect(preflight.headers["access-control-allow-methods"]).toBe("GET, POST, PUT");
    expect(preflight.headers["access-control-allow-headers"]).toBe("Authorization, Content-Type"); expect(preflight.headers["access-control-allow-private-network"]).toBe("true");
    expect(preflight.headers["access-control-allow-credentials"]).toBeUndefined(); expect(fs.readFileSync(file).equals(before)).toBe(true); expect(confirm).not.toHaveBeenCalled();
  });
  it("returns acknowledgement before triggering restart and reports the saved timestamp", async () => {
    let received: any;
    restart.mockImplementation(async () => {
      // If the server has handed off bytes before restarting, a client can consume the acknowledgement even when restart closes it.
      await endpoint.close();
    });
    received = await request("PUT", JSON.stringify({ roots: [] }));
    expect(received).toMatchObject({ status: 200, body: { applied: true, restart: true } });
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
    expect(cfg.roots).toEqual([]); expect(cfg.lastSettingsChange).toMatch(/^\d{4}-/); expect(confirm).not.toHaveBeenCalled();
    endpoint = (await startLocalApi({ webOrigin: origin, version: "0.4.0", machineName: cfg.machineName, connected: () => true, config: () => cfg, ports: [0], ticket: new TicketVerifier({ webOrigin: origin, userId: () => cfg.userId, fetch: fixture.fetch }) }))!;
    expect((await request("GET", undefined, headers(), "/local/v1/info")).body.lastSettingsChange).toBe(cfg.lastSettingsChange);
  });
  it("rejects bad JSON/type/fields, oversized bodies and unsupported methods without a prompt", async () => {
    const before = fs.readFileSync(file);
    for (const body of ["{", "null", JSON.stringify({ token: "x" }), JSON.stringify({ libraryDir: "relative" }), JSON.stringify({ roots: [root, other], extra: "x" }), JSON.stringify({ libraryDir: "x".repeat(70000) })]) expect((await request("PUT", body)).status).toBe(400);
    expect((await request("PUT", "{}", { ...headers(), "Content-Type": "text/plain" })).status).toBe(400);
    expect((await request("POST", "{}" )).status).toBe(405);
    expect((await request("GET", undefined, headers(), "/local/v1/settings?extra=x")).status).toBe(400);
    expect(fs.readFileSync(file).equals(before)).toBe(true); expect(confirm).not.toHaveBeenCalled(); expect(restart).not.toHaveBeenCalled();
  });
  it("returns 409 busy during a prompt and 409 local_denied after rejection with identical config", async () => {
    let deny!: (value: boolean) => void; confirm.mockImplementation(() => new Promise(resolve => { deny = resolve; }));
    const before = fs.readFileSync(file), first = request("PUT", JSON.stringify({ roots: [root, other] }));
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(await request("PUT", JSON.stringify({ roots: [] }))).toMatchObject({ status: 409, body: { code: "busy" } });
    deny(false); expect(await first).toMatchObject({ status: 409, body: { code: "local_denied", message: "local_denied" } });
    expect(fs.readFileSync(file).equals(before)).toBe(true); expect(restart).not.toHaveBeenCalled();
  });
  it("cancels the prompt when the requesting browser disconnects", async () => {
    let promptSignal!: AbortSignal; confirm.mockImplementation(async (_message, signal) => { promptSignal = signal; return new Promise(() => {}); });
    const before = fs.readFileSync(file);
    const req = http.request(`http://127.0.0.1:${endpoint.port}/local/v1/settings`, { method: "PUT", headers: headers() }); req.on("error", () => {}); req.end(JSON.stringify({ roots: [root, other] }));
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1)); req.destroy();
    await vi.waitFor(() => expect(promptSignal.aborted).toBe(true));
    expect(fs.readFileSync(file).equals(before)).toBe(true); expect(restart).not.toHaveBeenCalled();
    expect((await request("PUT", JSON.stringify({ roots: [] }))).status).toBe(200);
  });
  it("shutdown aborts an outstanding confirmation without modifying config", async () => {
    let promptSignal!: AbortSignal; confirm.mockImplementation(async (_message, signal) => { promptSignal = signal; return new Promise(() => {}); });
    const before = fs.readFileSync(file), pending = request("PUT", JSON.stringify({ roots: [root, other] })).catch(() => null);
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1)); await endpoint.close(); await pending;
    expect(promptSignal.aborted).toBe(true); expect(fs.readFileSync(file).equals(before)).toBe(true); expect(restart).not.toHaveBeenCalled();
    endpoint = (await startLocalApi({ webOrigin: origin, version: "0.4.0", machineName: cfg.machineName, connected: () => true, config: () => cfg, ports: [0] }))!;
  });
});
