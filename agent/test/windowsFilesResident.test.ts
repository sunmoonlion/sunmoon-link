import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { WindowsFiles, type ResidentFallback, type WindowsFilesTiming } from "../src/windowsRuntime.js";

// opus-qwen 第 19 条：每个文件操作新起一个沙箱辅助进程，提权模式每次约 1 秒（luna 11-08 实测）。
// 改成常驻：一个辅助进程连续收请求；它在输入开着时不回 ping（11-01 那台机器的症状）就整个进程退回每次新起。
const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fakeWindowsHelper.mjs");
const servers: WebSocketServer[] = [];
const instances: WindowsFiles[] = [];

async function executor(): Promise<string> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await new Promise<void>(resolve => server.once("listening", () => resolve()));
  server.on("connection", ws => ws.on("message", raw => {
    const frame = JSON.parse(String(raw));
    if (frame.id === undefined) return;
    ws.send(JSON.stringify(frame.method === "initialize"
      ? { id: frame.id, result: { environmentInfo: { executorVersion: "0.155.1" } } }
      : { id: frame.id, error: { code: -32004, message: "not found" } }));
  }));
  return `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function files(modes: string[], timing: Partial<WindowsFilesTiming> = {}, fallback: ResidentFallback = { residentUnavailable: false }) {
  const url = await executor();
  const spawned: ChildProcess[] = [];
  const f = new WindowsFiles({
    url: () => url, home: "/tmp", roots: [], mode: "elevated", writable: false,
    helper: { node: process.execPath, script: "unused" },
    spawnHelper: () => {
      const child = spawn(process.execPath, [fake, modes[Math.min(spawned.length, modes.length - 1)]], { stdio: ["pipe", "pipe", "pipe"] });
      spawned.push(child);
      return child;
    },
    killTree: async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGKILL");
      await new Promise(resolve => child.once("exit", resolve));
    },
    fallback, timing,
  });
  instances.push(f);
  return { f, spawned, fallback };
}

const alive = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;
const exited = (c: ChildProcess) => new Promise(resolve => alive(c) ? c.once("exit", resolve) : resolve(null));

afterEach(async () => {
  for (const f of instances.splice(0)) await f.close();
  for (const s of servers.splice(0)) s.close();
});

describe("WindowsFiles resident helper", () => {
  it("serves consecutive calls from one helper, answers matched by id", async () => {
    const { f, spawned } = await files(["echo"]);
    const a = await f.call("fs/getMetadata", { path: "file:///C:/a" });
    const b = await f.call("fs/readFile", { path: "file:///C:/b" });
    const [c, d] = await Promise.all([f.call("fs/getMetadata", { path: "file:///C:/c" }), f.call("fs/getMetadata", { path: "file:///C:/d" })]);
    expect(spawned).toHaveLength(1);
    expect([a, b, c, d].map(v => v.result.params.path)).toEqual(["file:///C:/a", "file:///C:/b", "file:///C:/c", "file:///C:/d"]);
    expect(new Set([a, b, c, d].map(v => v.result.pid)).size).toBe(1);
    expect(alive(spawned[0])).toBe(true);
  });

  it("falls back to one helper per call when the ping only comes back after EOF", async () => {
    const { f, spawned, fallback } = await files(["eof-only"], { readyMs: 200 });
    const first = await f.call("fs/getMetadata", { path: "file:///C:/a" });
    expect(first.result.params.path).toBe("file:///C:/a");
    expect(fallback.residentUnavailable).toBe(true);
    const second = await f.call("fs/getMetadata", { path: "file:///C:/b" });
    expect(second.result.params.path).toBe("file:///C:/b");
    // resident attempt + one helper per call; the request was sent once, after the ping failed
    expect(spawned).toHaveLength(3);
    for (const c of spawned) await exited(c);
  });

  it("uses one helper per call straight away once the process has fallen back", async () => {
    const { f, spawned } = await files(["eof-only"], {}, { residentUnavailable: true });
    await f.call("fs/getMetadata", { path: "file:///C:/a" });
    await f.call("fs/getMetadata", { path: "file:///C:/b" });
    expect(spawned).toHaveLength(2);
  });

  it("rejects a timed-out request without replaying it; the next call starts a new helper", async () => {
    const { f, spawned, fallback } = await files(["stall", "echo"], { callMs: 200 });
    await expect(f.call("fs/writeFile", { path: "file:///C:/a", dataBase64: "" })).rejects.toThrow("filesystem worker timeout: fs/writeFile");
    await exited(spawned[0]);
    expect(fallback.residentUnavailable).toBe(false);
    const next = await f.call("fs/getMetadata", { path: "file:///C:/b" });
    expect(next.result.params.path).toBe("file:///C:/b");
    expect(spawned).toHaveLength(2);
  });

  it("reports a helper crash and restarts on the next call", async () => {
    const { f, spawned, fallback } = await files(["crash", "echo"]);
    await expect(f.call("fs/getMetadata", { path: "file:///C:/a" })).rejects.toThrow("filesystem worker exited prematurely");
    expect(fallback.residentUnavailable).toBe(false);
    const next = await f.call("fs/getMetadata", { path: "file:///C:/b" });
    expect(next.result.params.path).toBe("file:///C:/b");
    expect(spawned).toHaveLength(2);
  });

  it("retires an idle helper by ending its stdin, and starts again when needed", async () => {
    const { f, spawned } = await files(["echo"], { idleMs: 100 });
    await f.call("fs/getMetadata", { path: "file:///C:/a" });
    await exited(spawned[0]);
    expect(spawned[0].exitCode).toBe(0);
    await f.call("fs/getMetadata", { path: "file:///C:/b" });
    expect(spawned).toHaveLength(2);
  });

  it("keeps an idle helper longer while a file handle is open", async () => {
    const { f, spawned } = await files(["echo"], { idleMs: 50, idleWithHandlesMs: 60000 });
    await f.call("fs/open", { path: "file:///C:/a", handleId: "h1" });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(alive(spawned[0])).toBe(true);
    await f.call("fs/close", { handleId: "h1" });
    await exited(spawned[0]);
    expect(spawned).toHaveLength(1);
  });

  it("close stops the resident helper and refuses later calls", async () => {
    const { f, spawned } = await files(["echo"]);
    await f.call("fs/getMetadata", { path: "file:///C:/a" });
    await f.close();
    expect(alive(spawned[0])).toBe(false);
    await expect(f.call("fs/getMetadata", { path: "file:///C:/b" })).rejects.toThrow("filesystem worker closed");
  });
});
