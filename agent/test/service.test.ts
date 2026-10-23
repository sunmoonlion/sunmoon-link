import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceHandler, ServiceFrameError, SERVICE_MAX_FRAME, SERVICE_MAX_READ } from "../src/service.js";

let base: string, root: string, handler: ServiceHandler;
const rpc = async (method: string, params?: object, h = handler, id = 1) => JSON.parse((await h.receive(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })))!);
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "sunmoon-service-"));
  root = path.join(base, "root"); fs.mkdirSync(root);
  handler = new ServiceHandler({ version: "0.4.0", roots: () => [root], configDir: path.join(base, "config"), codexHome: path.join(base, "home"), platform: "linux" });
});
afterEach(async () => { await handler.close(); fs.rmSync(base, { recursive: true, force: true }); });
describe("service-v1 read boundary", () => {
  it("returns only the contracted hello and metadata fields", async () => {
    expect((await rpc("service/hello")).result).toEqual({ agent: "sunmoon-agent", version: "0.4.0", roots: [root], libraryDir: null, capabilities: ["service-v1"] });
    fs.writeFileSync(path.join(root, "中文.txt"), "hello");
    expect((await rpc("fs/getMetadata", { path: path.join(root, "中文.txt") })).result).toEqual({ type: "file", size: 5, mtime: expect.any(Number) });
  });
  it("rejects outside, dot-dot escape, protected homes and reserved names without exposing paths", async () => {
    for (const target of [base, root + "-sibling", path.join(root, "..", "outside"), path.join(root, "auth.json"), path.join(root, ".sandbox-secrets", "x")]) {
      const reply = await rpc("fs/readFile", { path: target });
      expect(reply.error).toEqual({ code: -32010, message: "outside_whitelist" });
      expect(JSON.stringify(reply)).not.toContain(target);
    }
    const h = new ServiceHandler({ version: "0.4.0", roots: () => [base], configDir: path.join(base, "config"), codexHome: path.join(base, "home") });
    for (const target of [path.join(base, "config", "x"), path.join(base, "home", "x")]) expect((await rpc("fs/readFile", { path: target }, h)).error.code).toBe(-32010);
    await h.close();
  });
  it("blocks symlinks and hardlinks but lists links without traversing", async () => {
    const outside = path.join(base, "outside"); fs.writeFileSync(outside, "private");
    const link = path.join(root, "link"); fs.symlinkSync(outside, link);
    expect((await rpc("fs/readFile", { path: link })).error.code).toBe(-32010);
    expect((await rpc("fs/getMetadata", { path: link })).error.code).toBe(-32010);
    expect((await rpc("fs/readDirectory", { path: root })).result.entries[0]).toMatchObject({ name: "link", type: "link" });
    const hard = path.join(root, "hard"); fs.linkSync(outside, hard);
    expect((await rpc("fs/readFile", { path: hard })).error.code).toBe(-32010);
  });
  it("bounds and reconstructs a 5 MiB file in ten responses under the frame limit", async () => {
    const target = path.join(root, "large"); const original = Buffer.alloc(5 * 1024 * 1024, 173); fs.writeFileSync(target, original);
    const chunks: Buffer[] = [];
    for (let i = 0; i < 10; i++) {
      const reply = await rpc("fs/readFile", { path: target, offset: i * SERVICE_MAX_READ });
      expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(SERVICE_MAX_FRAME);
      expect(reply.result.eof).toBe(i === 9); expect(reply.result.size).toBe(original.length);
      chunks.push(Buffer.from(reply.result.content, "base64"));
    }
    expect(Buffer.concat(chunks).equals(original)).toBe(true);
    expect((await rpc("fs/readFile", { path: target, offset: original.length })).result).toMatchObject({ content: "", eof: true });
    for (const invalid of [{ length: SERVICE_MAX_READ + 1 }, { offset: -1 }, { length: 0 }, { length: 1.5 }]) expect((await rpc("fs/readFile", { path: target, ...invalid })).error.code).toBe(-32602);
  });
  it("rejects files above 64 MiB before reading and reports not-found", async () => {
    const target = path.join(root, "huge"); fs.closeSync(fs.openSync(target, "w")); fs.truncateSync(target, 64 * 1024 * 1024 + 1);
    expect((await rpc("fs/readFile", { path: target })).error).toEqual({ code: -32011, message: "too_large" });
    expect((await rpc("fs/readFile", { path: path.join(root, "absent") })).error).toEqual({ code: -32012, message: "not_found" });
  });
  it("truncates directories at 2000 entries", async () => {
    for (let i = 0; i < 2001; i++) fs.writeFileSync(path.join(root, String(i)), "");
    const result = (await rpc("fs/readDirectory", { path: root })).result;
    expect(result.entries).toHaveLength(2000); expect(result.truncated).toBe(true);
    expect(result.entries[0]).toEqual({ name: expect.any(String), type: "file", size: 0, mtime: expect.any(Number) });
  });
  it("validates JSON-RPC and never exposes process, writes or helper methods", async () => {
    for (const method of ["process/start", "fs/writeFile", "service/readFile", "environmentConfig/read", "fs/createDirectory", "fs/remove"]) expect((await rpc(method, { path: path.join(root, "runs", "x") })).error.code).toBe(-32601);
    expect((await rpc("fs/readFile", { path: "file:///tmp/x" })).error.code).toBe(-32010);
    expect((await rpc("fs/readFile", { path: root, sandbox: null })).error.code).toBe(-32602);
    expect(JSON.parse((await handler.receive("not json"))!).error.code).toBe(-32700);
    for (const text of ["null", "[]", '{"method":"service/hello"}']) expect(JSON.parse((await handler.receive(text))!).error.code).toBe(-32600);
    expect(await handler.receive('{"jsonrpc":"2.0","method":"service/hello"}')).toBeNull();
  });
  it("rejects request 51 in one instant, refills and rejects oversized/binary frames", async () => {
    let time = 0; const h = new ServiceHandler({ version: "test", roots: () => [], codexHome: base, configDir: base, now: () => time });
    for (let i = 0; i < 50; i++) expect((await rpc("service/hello", undefined, h)).result).toBeTruthy();
    expect((await rpc("service/hello", undefined, h)).error.code).toBe(-32013);
    time = 1000; expect((await rpc("service/hello", undefined, h)).result).toBeTruthy();
    await expect(h.receive("x".repeat(SERVICE_MAX_FRAME + 1))).rejects.toBeInstanceOf(ServiceFrameError);
    await expect(h.receive("{}", true)).rejects.toBeInstanceOf(ServiceFrameError); await h.close();
  });
  it("uses Windows helper only, checks case/aliases and caps four pending requests", async () => {
    let release!: (value: object) => void;
    const pending = new Promise<object>(resolve => { release = resolve; });
    const call = vi.fn(() => pending), close = vi.fn(async () => {});
    const h = new ServiceHandler({ version: "test", platform: "win32", roots: () => ["C:\\Allowed"], configDir: "C:\\Agent", codexHome: "C:\\Agent\\home", files: { call, close } });
    for (const target of ["C:\\ALLOWED~1\\x", "C:\\Allowed\\a:stream", "\\\\?\\C:\\Allowed\\x", "C:\\Allowed\\..\\outside"]) expect((await rpc("fs/readFile", { path: target }, h)).error.code).toBe(-32010);
    const reads = Array.from({ length: 4 }, (_, i) => rpc("fs/getMetadata", { path: "c:\\ALLOWED\\x" }, h, i));
    expect((await rpc("fs/getMetadata", { path: "C:\\Allowed\\x" }, h, 9)).error.code).toBe(-32013);
    expect(call).toHaveBeenCalledTimes(4); expect(call.mock.calls[0]).toEqual(["service/getMetadata", { path: expect.stringContaining("ALLOWED") }]);
    release({ result: { type: "file", size: 1, mtime: 0 } }); await Promise.all(reads);
    await h.close(); expect(close).toHaveBeenCalledOnce();
  });
  it("discards results after disconnect and keeps logs limited to method/code", async () => {
    const records: any[] = []; const h = new ServiceHandler({ version: "test", roots: () => [root], configDir: base, codexHome: base, onRequest: (...args) => records.push(args) });
    await rpc("fs/readFile", { path: path.join(root, "secret") }, h);
    expect(records).toEqual([["fs/readFile", -32010]]);
    await h.close(); expect(await h.receive('{"jsonrpc":"2.0","id":1,"method":"service/hello"}')).toBeNull();
  });
});

describe("service-runs-v1 on the test computer (ledger 129)", () => {
  let runsHandler: ServiceHandler;
  const runs = () => path.join(root, "runs");
  beforeEach(() => { runsHandler = new ServiceHandler({ version: "0.5.1", roots: () => [root], configDir: path.join(base, "config"), codexHome: path.join(base, "home"), platform: "linux", runsWritable: true }); });
  afterEach(async () => { await runsHandler.close(); });
  it("announces the capability only when switched on", async () => {
    expect((await rpc("service/hello", undefined, runsHandler)).result.capabilities).toEqual(["service-v1", "service-runs-v1"]);
    expect((await rpc("service/hello")).result.capabilities).toEqual(["service-v1"]);
  });
  it("creates runs/<name> (and runs/ itself), idempotently, and removes it recursively", async () => {
    const mine = path.join(runs(), "20261023-abc");
    expect((await rpc("fs/createDirectory", { path: mine, recursive: true }, runsHandler)).result).toEqual({});
    expect(fs.statSync(mine).isDirectory()).toBe(true);
    expect((await rpc("fs/createDirectory", { path: mine, recursive: true }, runsHandler)).result).toEqual({});
    fs.mkdirSync(path.join(mine, "deep", "er"), { recursive: true }); fs.writeFileSync(path.join(mine, "deep", "er", "f.txt"), "x");
    expect((await rpc("fs/remove", { path: mine }, runsHandler)).result).toEqual({});
    expect(fs.existsSync(mine)).toBe(false);
    expect((await rpc("fs/remove", { path: mine }, runsHandler)).result).toEqual({});
    fs.rmSync(runs(), { recursive: true });
    expect((await rpc("fs/remove", { path: mine }, runsHandler)).result).toEqual({});
  });
  it("refuses anything that is not exactly <root>/runs/<name>", async () => {
    fs.mkdirSync(runs());
    for (const target of [root, runs(), path.join(root, "other", "x"), path.join(runs(), "a", "b"), path.join(runs(), "bad name"), path.join(runs(), ".."), path.join(base, "runs", "x"), path.join(root + "-sibling", "runs", "x")]) {
      expect((await rpc("fs/remove", { path: target }, runsHandler)).error.code).toBe(-32010);
      expect((await rpc("fs/createDirectory", { path: target }, runsHandler)).error.code).toBe(-32010);
    }
    expect(fs.existsSync(root)).toBe(true);
    for (const params of [{ path: path.join(runs(), "x"), recursive: "yes" }, { path: path.join(runs(), "x"), mode: 7 }, { recursive: true }]) expect((await rpc("fs/createDirectory", params, runsHandler)).error.code).toBe(-32602);
  });
  it("never follows links: a linked runs/ is refused and a link inside runs/ is removed itself", async () => {
    const outside = path.join(base, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
    fs.symlinkSync(outside, runs());
    expect((await rpc("fs/createDirectory", { path: path.join(runs(), "x") }, runsHandler)).error.code).toBe(-32010);
    expect((await rpc("fs/remove", { path: path.join(runs(), "keep.txt") }, runsHandler)).error.code).toBe(-32010);
    fs.unlinkSync(runs()); fs.mkdirSync(runs());
    const link = path.join(runs(), "planted"); fs.symlinkSync(outside, link);
    expect((await rpc("fs/remove", { path: link }, runsHandler)).result).toEqual({});
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
  });
  it("stays off on Windows even when asked", async () => {
    const w = new ServiceHandler({ version: "0.5.1", roots: () => [root], configDir: path.join(base, "config"), codexHome: path.join(base, "home"), platform: "win32", runsWritable: true });
    expect((await rpc("service/hello", undefined, w)).result.capabilities).toEqual(["service-v1"]);
    expect((await rpc("fs/createDirectory", { path: path.join(runs(), "x") }, w)).error.code).toBe(-32601);
    await w.close();
  });
});
