import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startPresence } from "../src/presence.js";
import { LOCAL_PORTS } from "../src/localApi.js";

const origin = "https://knowbench.sunmoonai.com:30443";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function request(port: number, path = "/presence", method = "GET", headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${path}`, { method, headers }, res => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.once("error", reject);
    req.end();
  });
}
async function listen(port = 0) {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected test listener address");
  return { server, port: address.port };
}
afterEach(() => vi.restoreAllMocks());

describe("loopback presence endpoint", () => {
  it("returns only the public four-field projection and required response headers", async () => {
    let connected = false;
    const endpoint = await startPresence({ webOrigin: origin, version: "0.3.1", machineName: "my-pc", connected: () => connected, ports: [0] });
    expect(endpoint).not.toBeNull();
    try {
      const response = await request(endpoint!.port, "/presence", "GET", { Origin: origin });
      expect(response.status).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
      expect(response.headers.vary).toBe("Origin");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(JSON.parse(response.body)).toEqual({ agent: "sunmoon-agent", version: "0.3.1", machine_name: "my-pc", connected: false });
      connected = true;
      expect(JSON.parse((await request(endpoint!.port, "/presence", "GET", { Origin: origin })).body).connected).toBe(true);
    } finally { await endpoint!.close(); }
  });

  it("adds device id, host, os and link state when given, never the account (ledger 143)", async () => {
    let state = "token_invalid";
    const endpoint = await startPresence({ webOrigin: origin, version: "0.5.1", machineName: "my-pc", connected: () => false, ports: [0],
      identity: () => ({ deviceId: "0f8fad5b-d9cb-469f-a165-70867728950e", host: "DESKTOP-1", os: "Windows" }), linkState: () => state });
    try {
      const body = JSON.parse((await request(endpoint!.port, "/presence", "GET", { Origin: origin })).body);
      expect(body).toEqual({ agent: "sunmoon-agent", version: "0.5.1", machine_name: "my-pc", connected: false, device_id: "0f8fad5b-d9cb-469f-a165-70867728950e", host: "DESKTOP-1", os: "Windows", link_state: "token_invalid" });
      state = "connected";
      expect(JSON.parse((await request(endpoint!.port, "/presence", "GET", { Origin: origin })).body).link_state).toBe("connected");
    } finally { await endpoint!.close(); }
  });

  it("requires the exact Origin and emits no CORS headers for missing or wrong origins", async () => {
    const endpoint = await startPresence({ webOrigin: origin, version: "0.3.1", machineName: "my-pc", connected: () => false, ports: [0] });
    try {
      for (const headers of [{}, { Origin: "https://example.com" }, { Origin: `${origin}/` }]) {
        const response = await request(endpoint!.port, "/presence", "GET", headers);
        expect(response.status).toBe(403);
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
        expect(response.headers["access-control-allow-methods"]).toBeUndefined();
      }
    } finally { await endpoint!.close(); }
  });

  it("supports only the exact path, GET and the GET private-network preflight", async () => {
    const endpoint = await startPresence({ webOrigin: origin, version: "0.3.1", machineName: "my-pc", connected: () => false, ports: [0] });
    try {
      expect((await request(endpoint!.port, "/other", "GET", { Origin: origin })).status).toBe(404);
      expect((await request(endpoint!.port, "/presence?x=1", "GET", { Origin: origin })).status).toBe(404);
      const wrongMethod = await request(endpoint!.port, "/presence", "POST", { Origin: origin });
      expect(wrongMethod.status).toBe(405);
      const preflight = await request(endpoint!.port, "/presence", "OPTIONS", { Origin: origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Private-Network": "true" });
      expect(preflight.status).toBe(204);
      expect(preflight.headers["access-control-allow-methods"]).toBe("GET, POST, PUT");
      expect(preflight.headers["access-control-allow-headers"]).toBe("Authorization, Content-Type");
      expect(preflight.headers["access-control-allow-private-network"]).toBe("true");
      expect(preflight.headers["access-control-allow-credentials"]).toBeUndefined();
      expect((await request(endpoint!.port, "/presence", "OPTIONS", { Origin: origin, "Access-Control-Request-Method": "POST" })).status).toBe(204);
    } finally { await endpoint!.close(); }
  });

  it("tries five candidates in order and reports unavailable only when all five are occupied", async () => {
    expect(LOCAL_PORTS).toEqual([47811, 47812, 47813, 47814, 47815]);
    const occupied = await listen();
    const first = await startPresence({ webOrigin: origin, version: "0.3.1", machineName: "my-pc", connected: () => false, ports: [occupied.port, 0] });
    try { expect(first?.port).toBeGreaterThan(0); }
    finally { await first?.close(); await new Promise<void>(resolve => occupied.server.close(() => resolve())); }

    const occupiedFive = await Promise.all(Array.from({ length: 5 }, () => listen())), events: unknown[] = [];
    const fifth = await startPresence({ webOrigin: origin, version: "0.4.0", machineName: "my-pc", connected: () => false, ports: [...occupiedFive.slice(0, 4).map(value => value.port), 0] });
    expect(fifth?.port).toBeGreaterThan(0); await fifth?.close();
    const none = await startPresence({ webOrigin: origin, version: "0.3.1", machineName: "my-pc", connected: () => false, ports: occupiedFive.map(value => value.port), onEvent: (...args) => events.push(args) });
    try {
      expect(none).toBeNull();
      expect(events.at(-1)).toEqual(["unavailable", { code: "EADDRINUSE" }]);
    } finally { await Promise.all(occupiedFive.map(value => new Promise<void>(resolve => value.server.close(() => resolve())))); }
  });

  it("limits valid-origin requests to 20 per second and logs only the count", async () => {
    const events: unknown[] = [];
    const endpoint = await startPresence({ webOrigin: origin, version: "0.3.1", machineName: "my-pc", connected: () => false, ports: [0], onEvent: (...args) => events.push(args) });
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const responses = await Promise.all(Array.from({ length: 21 }, () => request(endpoint!.port, "/presence", "GET", { Origin: origin })));
      expect(responses.slice(0, 20).every(response => response.status === 200)).toBe(true);
      expect(responses[20].status).toBe(429);
      expect(events).toEqual([["listening", { port: endpoint!.port }], ["rate_limited", { count: 21 }]]);
      expect(JSON.stringify(events)).not.toMatch(/origin|header|127\.0\.0\.1/i);
    } finally { await endpoint!.close(); await pause(1); }
  });

  it("rejects a non-HTTPS or non-origin site profile", async () => {
    const events: unknown[] = [];
    const endpoint = await startPresence({ webOrigin: "http://example.com", version: "0.3.1", machineName: "my-pc", connected: () => false, onEvent: (...args) => events.push(args) });
    expect(endpoint).toBeNull();
    expect(events).toEqual([["unavailable", { code: "invalid_web_origin" }]]);
  });
});
