import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { WindowsFiles } from "../src/windowsRuntime.js";

// 账 187：第一次探测失败（exec-server 还没起好）不能被缓存成永久失败
describe("WindowsFiles not-found probe", () => {
  it("retries the probe after a failure instead of caching it", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>(resolve => server.once("listening", () => resolve()));
    const port = (server.address() as { port: number }).port;
    let up = false;
    server.on("connection", ws => {
      if (!up) { ws.terminate(); return; }
      ws.on("message", raw => {
        const frame = JSON.parse(String(raw));
        if (frame.id === undefined) return;
        if (frame.method === "initialize") {
          ws.send(JSON.stringify({ id: frame.id, result: { environmentInfo: { executorVersion: "0.155.1" } } }));
        } else {
          ws.send(JSON.stringify({ id: frame.id, error: { code: -32004, message: "not found" } }));
        }
      });
    });
    const files = new WindowsFiles({
      url: () => `ws://127.0.0.1:${port}`,
      home: "/tmp",
      roots: [],
      mode: "elevated" as never,
      writable: false,
      helper: { node: process.execPath, script: "unused" },
    });
    const probe = () => (files as unknown as { getNotFound(): Promise<{ file: { code: number } }> }).getNotFound();
    try {
      await expect(probe()).rejects.toThrow();
      up = true;
      await expect(probe()).resolves.toMatchObject({ file: { code: -32004 } });
    } finally {
      server.close();
    }
  });
});
