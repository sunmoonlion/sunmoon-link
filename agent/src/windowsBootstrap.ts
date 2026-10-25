// Capability discovery is a real process/start, not a config-file guess.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { CONFIG_DIR, CONFIG_PATH, saveConfig, type AgentConfig } from "./config.js";
import { log } from "./log.js";
import { locateCodex } from "./paths.js";
import { freeLoopbackPort, waitForPort } from "./execServer.js";
import { assertWindowsHome, locateWindowsHelper, killWindowsTree, runSandboxProbe, windowsEnvironment, WindowsTemporary, type WindowsHelper, type WindowsMode } from "./windowsRuntime.js";
import { denySandboxRead, grantSandboxRead, plainDirectory, sandboxReadTargets, type SandboxReadResult } from "./windowsSandboxRead.js";

export interface WindowsCapability {
  mode: WindowsMode;
  testedAt: string;
  probe: "process/start";
  elevatedSetupForHome: boolean;
  elevatedUsable: boolean;
}
/** Pairing replaces init; the first start on Windows still needs a real sandbox probe. */
export async function ensureWindowsSandbox(
  cfg: AgentConfig,
  detect: (home: string, roots: readonly string[]) => Promise<WindowsCapability> = detectWindowsSandbox,
  file = CONFIG_PATH,
): Promise<WindowsCapability> {
  if (cfg.windowsSandbox) return cfg.windowsSandbox;
  log("info", "首次探测 Windows 沙箱");
  cfg.windowsSandbox = await detect(cfg.codexHome, cfg.roots);
  saveConfig(cfg, file);
  return cfg.windowsSandbox;
}

/** 提权模式起命令前补授读：本地 link 自己的 node 与 app 目录、用户目录下 PATH 里的程序目录（见 windowsSandboxRead.ts）。 */
export function prepareElevatedReads(home: string, helper: WindowsHelper, env: NodeJS.ProcessEnv = process.env): SandboxReadResult {
  const profile = env.USERPROFILE ?? os.homedir();
  const targets = sandboxReadTargets({ profile, programs: [path.dirname(helper.node), path.dirname(path.dirname(helper.script))], pathEnv: env.PATH ?? "", privateDirs: [home, CONFIG_DIR] });
  const result = grantSandboxRead(targets, undefined, target => plainDirectory(target, profile));
  log(result.failed.length ? "warn" : "info", "elevated sandbox read grants", { granted: result.granted.length, present: result.present.length, failed: result.failed });
  // Tokens the sandbox must never read, even though Codex grants the first level of the profile (Fable review P2-12)
  const denied = denySandboxRead([CONFIG_PATH, path.join(CONFIG_DIR, "mcp.json"), path.join(home, "auth.json"), path.join(profile, ".codex", "auth.json")]);
  log(denied.failed.length ? "warn" : "info", "elevated sandbox read denials", { denied: denied.denied.length, present: denied.present.length, failed: denied.failed });
  return result;
}

export async function detectWindowsSandbox(home: string, roots: readonly string[]): Promise<WindowsCapability> {
  if (process.platform !== "win32") throw new Error("Windows capability probe must run natively");
  fs.mkdirSync(home, { recursive: true }); assertWindowsHome(home, roots);
  const helper = locateWindowsHelper();
  const codex = locateCodex();
  const version = spawnSync(codex.codexBin, ["--version"], { env: windowsEnvironment(home), encoding: "utf8", windowsHide: true, timeout: 10000 });
  if (version.status !== 0 || version.stdout.trim() !== "codex-cli 0.155.1" || codex.version !== "0.155.1") throw new Error("Agent requires bundled Codex 0.155.1");
  const elevatedSetupForHome = fs.existsSync(path.join(home, ".sandbox-secrets"));
  const config = path.join(home, "config.toml");
  if (!fs.existsSync(config)) fs.writeFileSync(config, 'sandbox_mode="read-only"\napproval_policy="never"\n[windows]\nsandbox="unelevated"\n');
  const port = await freeLoopbackPort(); const url = `ws://127.0.0.1:${port}`;
  const temporary = await WindowsTemporary.create(home, roots, helper);
  const child = spawn(codex.codexBin, ["exec-server", "--listen", url], { cwd: home, env: windowsEnvironment(home, {}, process.env, temporary.directory), stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  let spawnFailed = false; child.once("error", () => { spawnFailed = true; });
  try {
    if (!await waitForPort(port, 10000, () => !spawnFailed && child.exitCode === null)) throw new Error("Sandbox capability executor failed to start");
    const cwd = roots[0] ?? home;
    if (elevatedSetupForHome) prepareElevatedReads(home, helper);
    // No automatic setup or elevation. An existing setup is usable only if an
    // actual process can be launched under it from THIS isolated CODEX_HOME.
    const elevatedUsable = elevatedSetupForHome && await runSandboxProbe(url, home, cwd, "elevated", temporary.directory).catch(() => false);
    const mode: WindowsMode = elevatedUsable ? "elevated" : "unelevated";
    if (!elevatedUsable && !await runSandboxProbe(url, home, cwd, "unelevated", temporary.directory)) throw new Error("No usable Windows sandbox; init refused");
    fs.writeFileSync(config, `sandbox_mode="read-only"\napproval_policy="never"\n[windows]\nsandbox="${mode}"\n`, { mode: 0o600 });
    return { mode, testedAt: new Date().toISOString(), probe: "process/start", elevatedSetupForHome, elevatedUsable };
  } finally { await killWindowsTree(child); await temporary.close(); }
}
