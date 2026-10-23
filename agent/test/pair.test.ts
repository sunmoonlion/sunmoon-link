import { createHash } from "node:crypto";
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, saveConfig } from "../src/config.js";
import { deviceSecretSha256, menuPlan, openableVerifyUrl, runPair, type PairResponse } from "../src/pair.js";

const SECRET = "device-secret-0123456789ABCDEFGHijkl";
const TOKEN = "agent-token-should-stay-out-of-stdout";

function harness(replies: PairResponse[]) {
  const home = mkdtempSync(path.join(tmpdir(), "agent-pair-"));
  const configPath = path.join(home, "config.json");
  const statusFile = path.join(home, "pair-status.json");
  const calls: { url: string; body: Record<string, string> }[] = [];
  const lines: string[] = [];
  const sleeps: number[] = [];
  const snapshots: string[] = [];
  let progress: unknown;
  let stopped = 0;
  let cancelled = false;
  const post = async (url: string, body: Record<string, string>) => {
    calls.push({ url, body });
    const next = replies.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  };
  const run = (extra: { jump?: number } = {}) => runPair({
    webOrigin: "https://knowbench.example",
    relayUrl: "wss://relay.example/relay",
    machineName: "desk",
    osName: "Windows",
    agentVersion: "0.2.2",
    codexVersion: "0.155.1",
    configPath,
    secret: SECRET,
    post,
    // Capture memory progress before poll; no filesystem progress record.
    sleep: async ms => { sleeps.push(ms); clock += extra.jump ?? ms; snapshots.push(JSON.stringify(progress)); },
    now: () => clock,
    cancelled: () => cancelled,
    stdout: line => lines.push(line),
    progress: value => { progress=value; },
    stopIfRunning: async () => { stopped += 1; },
  });
  let clock = 0;
  return {
    home, configPath, statusFile, snapshots, final: () => progress, calls, lines, sleeps, run,
    stopCount: () => stopped,
    cancel: () => { cancelled = true; },
    output: () => lines.join("\n"),
  };
}

const created = {
  status: 200,
  body: { request_id: "req-1", user_code: "ABCD-2345", expires_in: 300, interval: 3, verify_url: "https://knowbench.example/settings#computer" },
};

describe("menu", () => {
  it("starts the background agent only when a token exists and it is not running", () => {
    expect(menuPlan(true, false)).toEqual({ start: true, action: "tray" });
    expect(menuPlan(true, true)).toEqual({ start: false, action: "tray" });
    expect(menuPlan(false, false)).toEqual({ start: false, action: "pair-page" });
  });
});

describe("pair", () => {
  it("writes the approved token only into config", async () => {
    const h = harness([created, { status: 429, body: { error: "slow_down" } }, {
      status: 200,
      body: { status: "approved", relay_url: "wss://relay.example/relay", relay_user: "owner", agent_token: TOKEN, agent_token_expires_at: "2026-11-09T00:00:00Z" },
    }]);
    try {
      expect(await h.run()).toBe(0);
      const body = h.calls[0].body;
      expect(Object.keys(body).sort()).toEqual(["agent_version", "codex_version", "device_secret_sha256", "machine_name", "os"]);
      expect(body.device_secret_sha256).toBe(deviceSecretSha256(SECRET));
      expect(body.device_secret_sha256).toBe(createHash("sha256").update(SECRET, "ascii").digest("hex"));
      expect(h.sleeps).toEqual([3000, 6000]);
      expect(h.calls[1].url).toContain("/requests/req-1/poll");
      expect(h.calls[1].body).toEqual({ device_secret: SECRET });
      expect(h.stopCount()).toBe(1);
      const saved = JSON.parse(readFileSync(h.configPath, "utf8"));
      expect(saved.deviceId).toMatch(/^[0-9a-f-]{36}$/); // 账 143：颁发令牌时没有就生成，以后沿用
      expect(saved.token).toBe(TOKEN);
      expect(saved.userId).toBe("owner");
      expect(saved.relayUrl).toBe("wss://relay.example/relay");
      expect(h.output()).toContain("ABCD-2345");
      expect(h.output()).not.toContain(TOKEN);
      expect(h.output()).not.toContain(SECRET);
    } finally { rmSync(h.home, { recursive: true, force: true }); }
  });

  it("keeps an existing config's other fields", async () => {
    const h = harness([created, { status: 200, body: { status: "approved", relay_url: "wss://relay.example/relay", relay_user: "owner", agent_token: TOKEN } }]);
    const prior = defaultConfig();
    prior.machineName = "kept-name";
    prior.ceiling = { sandbox: "read-only", network: false };
    saveConfig(prior, h.configPath);
    try {
      expect(await h.run()).toBe(0);
      const saved = JSON.parse(readFileSync(h.configPath, "utf8"));
      expect(saved.machineName).toBe("kept-name");
      expect(saved.ceiling).toEqual({ sandbox: "read-only", network: false });
      expect(saved.token).toBe(TOKEN);
    } finally { rmSync(h.home, { recursive: true, force: true }); }
  });

  it("does not offer a verify url outside the packaged site", async () => {
    const foreign = { status: 200, body: { ...created.body as Record<string, unknown>, verify_url: "https://evil.example/settings#computer" } };
    const h = harness([foreign, { status: 200, body: { status: "cancelled" } }]);
    h.cancel();
    try {
      expect(openableVerifyUrl("https://knowbench.example/settings#computer", "https://knowbench.example")).toBe("https://knowbench.example/settings#computer");
      expect(openableVerifyUrl("https://evil.example/settings#computer", "https://knowbench.example")).toBeNull();
      expect(openableVerifyUrl("https://knowbench.example.evil/settings", "https://knowbench.example")).toBeNull();
      expect(await h.run()).toBe(6);
      expect(h.output()).toContain('"verify_url":""');
      expect(h.output()).not.toContain("evil.example");
    } finally { rmSync(h.home, { recursive: true, force: true }); }
  });

  it("refuses an approved relay that is not the packaged relay", async () => {
    const h = harness([created, { status: 200, body: { status: "approved", relay_url: "wss://elsewhere.example/relay", relay_user: "owner", agent_token: TOKEN } }]);
    try {
      expect(await h.run()).toBe(1);
      expect(existsSync(h.configPath)).toBe(false);
      expect(h.output()).toContain("会合点与安装包不一致");
      expect(h.output()).not.toContain(TOKEN);
    } finally { rmSync(h.home, { recursive: true, force: true }); }
  });

  it("cancels without saving and reports expiry, denial and reuse", async () => {
    const cases: { replies: PairResponse[]; jump?: number; cancel?: boolean; code: number; text: string }[] = [
      { replies: [created, { status: 200, body: { status: "cancelled" } }], cancel: true, code: 6, text: "已取消连接" },
      { replies: [created, { status: 200, body: { status: "pending" } }], jump: 300_000, code: 4, text: "确认码已过期" },
      { replies: [created, { status: 200, body: { status: "denied" } }], code: 5, text: "确认码已被拒绝" },
      { replies: [created, { status: 200, body: { status: "delivered" } }], code: 1, text: "确认码已经用过" },
    ];
    for (const item of cases) {
      const h = harness(item.replies);
      if (item.cancel) h.cancel();
      try {
        expect(await h.run({ jump: item.jump })).toBe(item.code);
        expect(h.output()).toContain(item.text);
        expect(h.output()).not.toContain(SECRET);
        expect(existsSync(h.configPath)).toBe(false);
      } finally { rmSync(h.home, { recursive: true, force: true }); }
    }
  });

  it("emits memory-only progress without secrets or status files", async () => {
    const h = harness([created, { status: 429, body: { error: "slow_down" } }, {
      status: 200,
      body: { status: "approved", relay_url: "wss://relay.example/relay", relay_user: "owner", agent_token: TOKEN, agent_token_expires_at: "2026-11-09T00:00:00Z" },
    }]);
    try {
      expect(await h.run()).toBe(0);
      // The first callback captures the code in memory.
      const codeStep = JSON.parse(h.snapshots[0]);
      expect(existsSync(h.statusFile)).toBe(false);
      expect(codeStep.event).toBe("code");
      expect(codeStep.user_code).toBe("ABCD-2345");
      expect(typeof codeStep.expires_at).toBe("string");
      expect(Number.isNaN(Date.parse(codeStep.expires_at))).toBe(false);
      expect(h.snapshots[0]).not.toContain(SECRET);
      // Terminal callback replaces the previous in-memory code.
      const raw = JSON.stringify(h.final());
      const finalStep = JSON.parse(raw);
      expect(existsSync(h.statusFile)).toBe(false);
      expect(finalStep.event).toBe("result");
      expect(finalStep.status).toBe("approved");
      expect(finalStep.account).toBe("owner");
      // Progress never contains credentials or their fields.
      expect(raw).not.toContain(TOKEN);
      expect(raw).not.toContain(SECRET);
      expect(raw).not.toContain("agent_token");
      expect(raw).not.toContain("device_secret");
    } finally { rmSync(h.home, { recursive: true, force: true }); }
  });

});
