import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { LocalFiles } from "../src/localFiles.js";
import { TicketVerifier } from "../src/ticket.js";
import { startLocalApi, type LocalApiHandle } from "../src/localApi.js";
import { ticketFixture } from "./localTicketFixture.js";

const origin = "https://knowbench.sunmoonai.com:30443";
let base: string, root: string, endpoint: LocalApiHandle, fixture: Awaited<ReturnType<typeof ticketFixture>>, token: string;
const records: unknown[] = [];
async function request(route: string, headers: Record<string, string> = { Origin: origin, Authorization: "Bearer " + token }, method = "GET") {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${endpoint.port}${route}`, { method, headers }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    }); req.once("error", reject); req.end();
  });
}
const file = (target: string, suffix = "") => "/local/v1/fs/file?path=" + encodeURIComponent(target) + suffix;
beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "sunmoon-local-api-")); root = path.join(base, "root"); fs.mkdirSync(root);
  fixture = await ticketFixture(); token = fixture.token(); records.length = 0;
  const cfg = { ...defaultConfig(), userId: "probe-user", roots: [root], codexHome: path.join(base, "home") };
  endpoint = (await startLocalApi({ webOrigin: origin, version: "0.4.0", machineName: "test-pc", connected: () => true, config: () => cfg,
    files: new LocalFiles({ roots: () => cfg.roots, configDir: path.join(base, "config"), codexHome: cfg.codexHome }),
    ticket: new TicketVerifier({ webOrigin: origin, userId: () => cfg.userId, fetch: fixture.fetch }), ports: [0], onRequest: (...args) => records.push(args) }))!;
});
afterEach(async () => { vi.restoreAllMocks(); await endpoint.close(); await fixture.close(); fs.rmSync(base, { recursive: true, force: true }); });
describe("local file HTTP API", () => {
  it("keeps presence ticket-free while all local routes require a valid ticket", async () => {
    const publicState = await request("/presence", { Origin: origin });
    expect(JSON.parse(publicState.body.toString())).toEqual({ agent: "sunmoon-agent", version: "0.4.0", machine_name: "test-pc", connected: true });
    expect(fixture.requests()).toBe(0);
    for (const route of ["/local/v1/info", "/local/v1/fs/dir", "/local/v1/fs/meta", "/local/v1/fs/file", "/local/v1/unknown"]) {
      expect((await request(route, { Origin: origin })).status).toBe(401);
    }
    const info = await request("/local/v1/info");
    expect(JSON.parse(info.body.toString())).toEqual({ agent: "sunmoon-agent", version: "0.4.0", userId: "probe-user", roots: [root], lastSettingsChange: null, capabilities: ["local-fs-v1"] });
  });
  it("rejects wrong-sub/aud, expired and corrupt tickets as 401; key outage is 503", async () => {
    for (const claims of [{ sub: "other" }, { aud: "relay" }, { exp: 1 }]) expect((await request("/local/v1/info", { Origin: origin, Authorization: "Bearer " + fixture.token(claims) })).status).toBe(401);
    const parts = token.split("."); parts[2] = Buffer.alloc(64).toString("base64url");
    expect((await request("/local/v1/info", { Origin: origin, Authorization: "Bearer " + parts.join(".") })).status).toBe(401);
  });
  it("never returns CORS permission to wrong or absent Origin, including preflight", async () => {
    for (const headers of [{}, { Origin: "https://example.com", Authorization: "Bearer " + token }]) {
      const res = await request("/local/v1/info", headers); expect(res.status).toBe(403);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined(); expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    }
    expect(fixture.requests()).toBe(0);
  });
  it("provides GET/POST/PUT, auth/content-type and private-network preflight without credentials", async () => {
    const res = await request("/local/v1/fs/file", { Origin: origin, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "authorization, content-type" }, "OPTIONS");
    expect(res.status).toBe(204); expect(res.headers["access-control-allow-methods"]).toBe("GET, POST, PUT");
    expect(res.headers["access-control-allow-headers"]).toBe("Authorization, Content-Type"); expect(res.headers["access-control-allow-private-network"]).toBe("true");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined(); expect(fixture.requests()).toBe(0);
  });
  it("reads original bytes with exposed metadata headers and reconstructs 5 MiB in five reads", async () => {
    const target = path.join(root, "中文.md"), bytes = Buffer.alloc(5 * 1024 * 1024, 197); fs.writeFileSync(target, bytes);
    const chunks: Buffer[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(file(target, "&offset=" + i * 1024 * 1024));
      expect(res.status).toBe(200); expect(res.headers["content-type"]).toBe("application/octet-stream");
      expect(res.headers["x-file-size"]).toBe(String(bytes.length)); expect(res.headers["x-file-mtime"]).toMatch(/^\d+$/); expect(res.headers["x-file-eof"]).toBe(String(i === 4));
      expect(res.headers["access-control-expose-headers"]).toBe("X-File-Size, X-File-Mtime, X-File-Eof"); chunks.push(res.body);
    }
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    expect((await request(file(target, "&offset=" + bytes.length))).body.length).toBe(0);
    for (const suffix of ["&length=1048577", "&offset=-1", "&length=0", "&offset=1.5", "&path=duplicate", "&extra=x"]) expect((await request(file(target, suffix))).status).toBe(400);
  });
  it("rejects outside/parent escape/protected names, symlinks and hardlinks without revealing paths", async () => {
    fs.writeFileSync(path.join(base, "outside"), "private"); fs.symlinkSync(path.join(base, "outside"), path.join(root, "link")); fs.linkSync(path.join(base, "outside"), path.join(root, "hard"));
    for (const target of [base, path.join(root, "..", "outside"), path.join(root, "link"), path.join(root, "hard"), path.join(root, "auth.json"), path.join(root, ".sandbox-secrets", "x")]) {
      const res = await request(file(target)); expect(res.status).toBe(403); expect(JSON.parse(res.body.toString())).toEqual({ code: "outside_whitelist", message: "outside_whitelist" });
    }
    expect(JSON.stringify(records)).not.toContain(base);
  });
  it("returns 413 for a file above 64 MiB and 404 for absent files", async () => {
    const target = path.join(root, "huge"); fs.closeSync(fs.openSync(target, "w")); fs.truncateSync(target, 64 * 1024 * 1024 + 1);
    expect((await request(file(target))).status).toBe(413); expect((await request(file(path.join(root, "missing")))).status).toBe(404);
  });
  it("returns one-layer directory entries with path and truncation and metadata", async () => {
    for (let i = 0; i < 2001; i++) fs.writeFileSync(path.join(root, String(i)), "");
    const res = await request("/local/v1/fs/dir?path=" + encodeURIComponent(root)), data = JSON.parse(res.body.toString());
    expect(data.path).toBe(root); expect(data.entries).toHaveLength(2000); expect(data.truncated).toBe(true);
    const meta = JSON.parse((await request("/local/v1/fs/meta?path=" + encodeURIComponent(root))).body.toString());
    expect(meta).toMatchObject({ type: "dir", size: expect.any(Number), mtime: expect.any(Number) });
  });
  it("shares twenty-per-second rate limiting with presence and local calls", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    for (let i = 0; i < 10; i++) expect((await request("/presence", { Origin: origin })).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await request("/local/v1/info")).status).toBe(200);
    const limited = await request("/local/v1/info"); expect(limited.status).toBe(429); expect(JSON.parse(limited.body.toString()).code).toBe("rate_limited");
  });
  it("reports keys unavailable as 503 before attempting any file read", async () => {
    fixture.fail(); const res = await request(file(path.join(root, "missing")));
    expect(res.status).toBe(503); expect(JSON.parse(res.body.toString())).toEqual({ code: "keys_unavailable", message: "keys_unavailable" });
  });
});
