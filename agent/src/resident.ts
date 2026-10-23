// Per-user Windows lifecycle behind the existing CLI. No approval RPC server.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR, CONFIG_PATH, loadConfig, saveConfig } from "./config.js";
import { assertWindowsHome } from "./windowsRuntime.js";
import { desktopRequest, nativeDirectory, powershell } from "./windowsDesktop.js";
import { locateCodex } from "./paths.js";
import { detectWindowsSandbox } from "./windowsBootstrap.js";
import { applyLaunchEnv, installedSite, nodeLaunch } from "./siteTrust.js";
import { preferenceView, validatePreferences } from "./preferences.js";

const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
const statusFile = path.join(CONFIG_DIR, "status.json"), stopFile = path.join(CONFIG_DIR, "stop-request.json");
export const instanceKey = (directory: string): string => createHash("sha256").update(path.win32.resolve(directory).toLowerCase()).digest("hex").slice(0, 24);
const pipeName = () => `\\\\.\\pipe\\sunmoon-agent-${instanceKey(CONFIG_DIR)}`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Fresh installs have no config yet; pairing writes it after the owner approves. */
export function prepareAgentHome(home = CONFIG_DIR, configPath = CONFIG_PATH): string[] {
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    return [];
  }
  return loadConfig(configPath).roots;
}

export function checkControlDirectory(): void {
  if (process.platform !== "win32") throw new Error("This lifecycle is Windows-only");
  // Control files, prompts and credentials must not be writable workspace data.
  assertWindowsHome(CONFIG_DIR, prepareAgentHome());
}
export async function residentAlive(): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect(pipeName());
    let done = false;
    const finish = (yes: boolean) => { if (done) return; done = true; socket.destroy(); resolve(yes); };
    socket.once("connect", () => finish(true)); socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}
export async function acquireResident(onStop: () => void): Promise<{ runId: string; close: () => Promise<void> }> {
  checkControlDirectory();
  const server = net.createServer(socket => socket.destroy()); // mutex, never a command/approval endpoint
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipeName(), resolve); });
  const runId = randomUUID();
  const timer = setInterval(() => {
    try {
      const st = fs.lstatSync(stopFile);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 512) return;
      const request = JSON.parse(fs.readFileSync(stopFile, "utf8"));
      if (request.pid === process.pid && request.runId === runId) { fs.unlinkSync(stopFile); onStop(); }
    } catch { /* no current stop request */ }
  }, 500);
  timer.unref();
  return { runId, close: () => { clearInterval(timer); return new Promise<void>(resolve => server.close(() => resolve())); } };
}
export function readResidentStatus(): any {
  try {
    const st = fs.lstatSync(statusFile);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 65536) return null;
    return JSON.parse(fs.readFileSync(statusFile, "utf8"));
  } catch { return null; }
}
export async function stopResident(): Promise<boolean> {
  checkControlDirectory();
  if (!await residentAlive()) return false;
  const status = readResidentStatus();
  if (!Number.isSafeInteger(status?.pid) || typeof status?.runId !== "string") throw new Error("Agent is starting or is an older version; no process was killed");
  try {
    const st = fs.lstatSync(stopFile);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error("Unsafe stop request file");
    fs.unlinkSync(stopFile);
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  fs.writeFileSync(stopFile, JSON.stringify({ pid: status.pid, runId: status.runId }), { flag: "wx", mode: 0o600 });
  for (let i = 0; i < 100; i++) { if (!await residentAlive()) return true; await sleep(200); }
  throw new Error("Graceful stop timed out; no unrelated process was killed");
}
export async function startResident(): Promise<void> {
  checkControlDirectory();
  if (await residentAlive()) return;
  const launch = nodeLaunch(installedSite(import.meta.url));
  const child = spawn(process.execPath, [...launch.execArgv, cli, "start", "--background-worker"], { env: { ...applyLaunchEnv(process.env, launch), SUNMOON_AGENT_HOME: CONFIG_DIR }, detached: true, windowsHide: true, stdio: "ignore" });
  let failed = false; child.once("error", () => { failed = true; }); child.unref();
  for (let i = 0; i < 150; i++) {
    if (failed || child.exitCode !== null) throw new Error("Background agent could not start; inspect rotating agent log");
    const status = readResidentStatus();
    if (status?.pid === child.pid && status?.runId && await residentAlive()) return;
    await sleep(200);
  }
  throw new Error("Background agent startup timed out; inspect status before retrying");
}
/** A separate local lifecycle process waits for this resident to stop, then starts its replacement. */
export async function scheduleResidentRestart(): Promise<void> {
  checkControlDirectory();
  const launch = nodeLaunch(installedSite(import.meta.url));
  const child = spawn(process.execPath, [...launch.execArgv, cli, "restart-resident"], { env: { ...applyLaunchEnv(process.env, launch), SUNMOON_AGENT_HOME: CONFIG_DIR }, detached: true, windowsHide: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", () => reject(new Error("Resident restart could not start"))); });
  child.unref();
}
function readTrayControl(file: string): { pid: number; runId: string } {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 1024) throw new Error("Unsafe tray status");
  const current = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  if (!Number.isInteger(current.pid) || current.pid <= 0 || !/^[a-f0-9-]{36}$/.test(current.runId)) throw new Error("Invalid tray status");
  return current;
}
function removePlainControl(file: string): void {
  if (!fs.existsSync(file)) return;
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error("Unsafe tray status");
  fs.unlinkSync(file);
}
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
/** A leftover stop file whose recorded tray process is gone is cleared and treated as stopped. */
export function discardDeadTrayStop(directory: string, alive: (pid: number) => boolean): "cleared" | "pending" | "continue" {
  const file = path.join(directory, "tray.json"), stop = path.join(directory, "tray-stop.json");
  if (fs.existsSync(stop)) {
    const current = readTrayControl(stop);
    if (!alive(current.pid)) { removePlainControl(stop); removePlainControl(file); return "cleared"; }
    return "pending";
  }
  if (fs.existsSync(file)) {
    const current = readTrayControl(file);
    if (!alive(current.pid)) { removePlainControl(file); return "cleared"; }
  }
  return "continue";
}
export async function closeTray(): Promise<boolean> {
  checkControlDirectory();
  const decision = discardDeadTrayStop(CONFIG_DIR, pidAlive);
  if (decision === "cleared") return true;
  if (decision === "pending") throw new Error("A tray stop request is already pending");
  const file = path.join(CONFIG_DIR, "tray.json"), stop = path.join(CONFIG_DIR, "tray-stop.json");
  if (!fs.existsSync(file)) return false;
  const current = readTrayControl(file);
  if (fs.existsSync(stop)) throw new Error("A tray stop request is already pending");
  fs.writeFileSync(stop, JSON.stringify(current), { flag: "wx" });
  for (let i = 0; i < 50; i++) { if (!fs.existsSync(file)) return true; await sleep(200); }
  throw new Error("Tray close timed out; no process was killed");
}
function runDesktopScript(): Promise<void> {
  checkControlDirectory();
  return new Promise((resolve,reject)=>{
    const child=spawn(powershell(),["-NoLogo","-NoProfile","-NonInteractive","-File",path.join(nativeDirectory,"desktop.ps1"),"-Action","tray"],{windowsHide:true,stdio:["pipe","ignore","ignore"]});
    child.stdin.on("error",()=>{}); // spawn/exit carries the authoritative failure
    child.once("error",reject);
    child.once("exit",code=>{
      try {
        const marker=path.join(CONFIG_DIR,"tray.json");
        if(fs.existsSync(marker)&&readTrayControl(marker).pid===child.pid)removePlainControl(marker);
        code===0?resolve():reject(new Error("Desktop window failed; check Windows script policy"));
      } catch(error){reject(error);}
    });
    child.stdin.end(JSON.stringify({node:process.execPath,cli,state:CONFIG_DIR,instance:instanceKey(CONFIG_DIR)}));
  });
}
export function runTray():Promise<void>{return runDesktopScript();}
type DesktopLauncher = (command: string, args: string[], options: { detached: true; windowsHide: true; stdio: "ignore" }) => { unref(): void };
/** Detach through wscript, then resolve only after the window publishes its ready file. */
export function launchOpenDesktop(
  launch: DesktopLauncher, wscript: string, script: string, nodePath: string, cliPath: string, state: string, action: "tray", ready: () => boolean,
): Promise<void> {
  launch(wscript, ["//B", "//Nologo", script, nodePath, cliPath, state, action], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (ready()) { resolve(); return; }
      if (Date.now() - started >= 15000) { reject(new Error("Desktop window was not ready")); return; }
      setTimeout(tick, 200);
    };
    tick();
  });
}
/** A tray status that is still being written is not ready; the poll must not throw out of its timer. */
export function desktopWindowReady(marker: string, action: "tray"): boolean {
  try { return fs.existsSync(marker) && (pidAlive(readTrayControl(marker).pid)); }
  catch { return false; }
}
export async function openDesktop(action: "tray"): Promise<void> {
  checkControlDirectory();
  const marker = path.join(CONFIG_DIR, "tray.json");
  if (action === "tray") {
    discardDeadTrayStop(CONFIG_DIR, pidAlive);
    if (desktopWindowReady(marker, "tray")) return;
    removePlainControl(marker);
  }
  if (!process.env.SystemRoot) throw new Error("Windows is required");
  await launchOpenDesktop(spawn, path.join(process.env.SystemRoot, "System32", "wscript.exe"), path.join(nativeDirectory, "open-desktop.vbs"), process.execPath, cli, CONFIG_DIR, action, () => desktopWindowReady(marker, action));
}
export async function autostart(action: string): Promise<any> {
  checkControlDirectory();
  if (!["enable", "disable", "status"].includes(action)) throw new Error("autostart enable|disable|status");
  return desktopRequest("autostart", { action, node: process.execPath, cli, state: CONFIG_DIR, instance: instanceKey(CONFIG_DIR), hiddenScript: path.join(nativeDirectory, "run-hidden.vbs") }, undefined, 30000);
}
export async function setupElevated(): Promise<object> {
  checkControlDirectory();
  if(await residentAlive()) throw new Error("Stop the agent before optional sandbox setup");
  const cfg=loadConfig(); assertWindowsHome(cfg.codexHome,cfg.roots);
  await desktopRequest("setup",{codex:locateCodex().codexBin,home:cfg.codexHome},undefined,300000);
  cfg.windowsSandbox=await detectWindowsSandbox(cfg.codexHome,cfg.roots);
  if(!cfg.windowsSandbox.elevatedUsable) throw new Error("Setup did not produce a usable elevated sandbox; previous configuration is retained");
  saveConfig(cfg);return {windowsSandbox:cfg.windowsSandbox};
}
/** 托盘「提高安全」：停下本地 link → 提权设置（一次管理员确认）→ 再起来。设置取消或失败也把本地 link 起回来，模式照旧。 */
export async function upgradeSandbox(): Promise<object> {
  checkControlDirectory();
  const wasRunning = await stopResident();
  try { return await setupElevated(); }
  finally { if (wasRunning) await startResident(); }
}
export function preferences(argv: string[]): object {
  checkControlDirectory(); const cfg = loadConfig();
  if (argv[0] === "set") {
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!input || !["ceiling", "machineName", "roots"].every(key => key in input) || Object.keys(input).some(key => !["ceiling", "machineName", "roots", "rootChoices", "libraryDir"].includes(key))) throw new Error("Invalid settings fields");
    const choices = input.rootChoices ?? input.roots;
    fs.mkdirSync(cfg.codexHome, { recursive: true, mode: 0o700 });
    const next = { ...cfg, ...input, rootChoices: choices };
    validatePreferences(next, CONFIG_DIR); saveConfig(next); Object.assign(cfg, next);
  } else if (argv[0] && argv[0] !== "show") throw new Error("settings show|set");
  const { lastSettingsChange: _timestamp, ...view } = preferenceView(cfg);
  return view;
}
