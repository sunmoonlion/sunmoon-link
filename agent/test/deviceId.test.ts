import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, ensureDeviceId, loadConfig, priorDeviceId, saveConfig } from "../src/config.js";

let dir = "";
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ""; });
const file = () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "sunmoon-device-")); return path.join(dir, "config.json"); };

describe("device id (ledger 143)", () => {
  it("is created once, saved in the config and kept across loads", () => {
    const f = file(); const cfg = defaultConfig();
    expect(cfg.deviceId).toBeUndefined();
    expect(ensureDeviceId(cfg)).toBe(true);
    expect(cfg.deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const first = cfg.deviceId; saveConfig(cfg, f);
    const again = loadConfig(f);
    expect(ensureDeviceId(again)).toBe(false);
    expect(again.deviceId).toBe(first);
  });
  it("is not invented while reading an old config that has none", () => {
    const f = file(); const { deviceId: _unused, ...old } = defaultConfig(); fs.writeFileSync(f, JSON.stringify(old));
    expect(loadConfig(f).deviceId).toBeUndefined();
    expect(loadConfig(f).deviceId).toBeUndefined();
  });
  it("survives a re-init: the id in the old config is kept (Fable review P2-15)", () => {
    const f = file(); const cfg = defaultConfig(); ensureDeviceId(cfg); saveConfig(cfg, f);
    expect(priorDeviceId(f)).toBe(cfg.deviceId);
    fs.writeFileSync(f, "{not json"); expect(priorDeviceId(f)).toBeUndefined();
    fs.writeFileSync(f, JSON.stringify({ deviceId: "my-pc" })); expect(priorDeviceId(f)).toBeUndefined();
    expect(priorDeviceId(path.join(dir, "missing.json"))).toBeUndefined();
  });
  it("rejects a malformed id", () => {
    const f = file(); fs.writeFileSync(f, JSON.stringify({ ...defaultConfig(), deviceId: "my-pc" }));
    expect(() => loadConfig(f)).toThrow(/deviceId/);
  });
});
