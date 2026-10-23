#!/usr/bin/env node
// sunmoon-link：本地代理的命令行（0.5.0 前叫 sunmoon-agent）。
//   init --relay URL --user ID --token-prompt [--root DIR ...] [--name 电脑名]   隐藏输入令牌并写配置
//   roots add|remove|list DIR                                白名单（改完要重启 start，外沙箱的 bind 在启动时定）
//   ceiling show|set --sandbox MODE --network on|off         本地上限（本机改，仅本机生效）
//   start                                                    前台运行：起 exec-server + 出站桥；状态写 status.json
//   status                                                   读 status.json
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { CONFIG_DIR, CONFIG_PATH, defaultConfig, ensureDeviceId, loadConfig, saveConfig, type AgentConfig } from "./config.js";
import { ExecServer } from "./execServer.js";
import { log, registerSecret, configureWindowsLogs, safeData } from "./log.js";
import { locateCodex } from "./paths.js";
import { RelayClient } from "./relayClient.js";
import { detectWindowsSandbox, ensureWindowsSandbox, prepareElevatedReads } from "./windowsBootstrap.js";
import { type WindowsHelper, WindowsTemporary, assertWindowsHome, locateWindowsHelper, pinWindowsDirectories, runSandboxProbe } from "./windowsRuntime.js";
import { canonicalPath } from "./pathuri.js";
import { importCandidates, loadMcp, saveMcp, confirmedMcpUrls } from "./mcp.js";
import { localConfirm } from "./localConfirm.js";
import { readHiddenToken } from "./hiddenToken.js";
import { windowsConfirm } from "./windowsDesktop.js";
import { acquireResident, autostart, preferences, readResidentStatus, residentAlive, runTray, closeTray, startResident, stopResident, setupElevated, upgradeSandbox, openDesktop, checkControlDirectory, scheduleResidentRestart } from "./resident.js";
import { installedLaunchError } from "./siteTrust.js";
import { configHasToken, menuPlan, osLabel, runPair, siteDocument, PAIR_EXIT } from "./pair.js";
import {runPairPage,openDefaultBrowser,PairPageError} from "./pairPage.js";
import {humanizeTransport} from "./connectionMessages.js";
import {openPairPage,readPageDiscovery,publishPageDiscovery,pairingPageStatus,acquirePairPage} from "./pairPageControl.js";
import { startLocalApi } from "./localApi.js";
import { LocalSettings } from "./localSettings.js";
import { LocalFiles } from "./localFiles.js";
import { killWindowsTree, WindowsFiles } from "./windowsRuntime.js";
import { LocalProjects } from "./localProjects.js";

const VERSION = "0.5.2";
const STATUS_PATH = path.join(CONFIG_DIR, "status.json");

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
function args(flag: string, argv: string[]): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => { if (a === flag && argv[i + 1]) out.push(argv[i + 1]); });
  return out;
}

/** 被会合点拒绝（令牌无效、被吊销、令牌已颁发给另一份本地 link）后退出用的码；换令牌后重新 init 再 start。 */
const EXIT_REJECTED = 3;

async function postPair(url: string, body: Record<string, string>): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), redirect:"error",signal:AbortSignal.timeout(10000) });
  } catch(error) {
    const outer=error as {cause?:{code?:string;message?:string};code?:string;message?:string;name?:string};
    const cause=outer.cause??(outer.name==="TimeoutError"?{code:"ETIMEDOUT"}:outer);
    throw new PairPageError(humanizeTransport(cause,new URL(url).hostname).message);
  }
  const text = await response.text();
  if (!text) return { status: response.status, body: null };
  try { return { status: response.status, body: JSON.parse(text) }; }
  catch { return { status: response.status, body: null }; }
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  // 任何子命令带 --help / -h 都只打印用法：以前 `start --help` 会忽略参数、真的起一个代理（KIND 09 实测）
  if (!cmd || cmd === "help" || argv.includes("--help") || argv.includes("-h")) { usage(); return 0; }
  if (cmd === "--version") { console.log(VERSION); return 0; }
  const launchError = installedLaunchError(import.meta.url);
  if (launchError) { console.error(launchError); return 1; }
  if (cmd === "restart-resident") {
    if (argv.length !== 1) throw new Error("Invalid lifecycle arguments");
    await stopResident(); await startResident(); return 0;
  }

  if (cmd === "init") {
    if (process.platform === "win32" && await residentAlive()) throw new Error("Stop the running agent before replacing its configuration");
    const cfg: AgentConfig = { ...defaultConfig() };
    cfg.relayUrl = arg("--relay", argv) ?? cfg.relayUrl;
    cfg.userId = arg("--user", argv) ?? cfg.userId;
    if (argv.includes("--token-prompt") && argv.includes("--token")) throw new Error("--token-prompt 不能与 --token 同用");
    cfg.token = argv.includes("--token-prompt") ? await readHiddenToken() : arg("--token", argv) ?? cfg.token;
    registerSecret(cfg.token);
    cfg.roots = args("--root", argv).map((r) => path.resolve(r));
    const name = arg("--name", argv); if (name) cfg.machineName = name;
    const port = arg("--port", argv); if (port) cfg.execPort = Number(port);
    if (argv.includes("--no-outer-sandbox") && process.platform !== "win32") cfg.outerSandbox = false;
    if (process.platform === "win32") { cfg.windowsSandbox = await detectWindowsSandbox(cfg.codexHome, cfg.roots); console.log(`Windows sandbox: ${cfg.windowsSandbox.mode} (real process/start verified)`); }
    ensureDeviceId(cfg);
    saveConfig(cfg);
    console.log(`已写 ${CONFIG_PATH}`);
    return 0;
  }

  if (cmd === "pair") {
    if (argv.length > 2 || (argv[1] && argv[1]!=="--page")) throw new Error("pair 只接受 --page");
    const pageMode=argv[1]==="--page";
    if(pageMode){checkControlDirectory();const old=readPageDiscovery();if(old){console.log(old.url);await openDefaultBrowser(old.url);return 0;}}
    const releasePage=pageMode?await acquirePairPage():undefined;
    if(pageMode&&!releasePage){
      for(let n=0;n<100;n++){const existing=readPageDiscovery();if(existing){console.log(existing.url);await openDefaultBrowser(existing.url);return 0;}await new Promise(resolve=>setTimeout(resolve,100));}
      throw new Error("本机接入页正在启动，请稍后再试。");
    }
    let cancel = false;
    if(!pageMode)process.stdin.on("data", (chunk: Buffer | string) => { if (String(chunk).includes("cancel")) cancel = true; });
    try {
      const machineName = fs.existsSync(CONFIG_PATH) ? loadConfig().machineName : defaultConfig().machineName;
      const site = siteDocument(import.meta.url);
      const options={
        webOrigin: site.webOrigin,
        relayUrl: site.relayUrl,
        machineName,
        osName: osLabel(),
        agentVersion: VERSION,
        codexVersion: locateCodex().version,
        configPath: CONFIG_PATH,
        post: postPair,
        sleep: (ms:number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
        stopIfRunning: async () => {
          if (process.platform === "win32" && await residentAlive() && !await stopResident()) throw new Error("请先退出正在运行的本地 link，再颁发令牌。");
        },
      };
      if(!pageMode)return await runPair({...options,cancelled:()=>cancel,stdout:line=>fs.writeSync(1,line+"\n")});
      let cleanup:(()=>void)|undefined;
      const controller=new AbortController(),abort=()=>controller.abort();
      process.once("SIGINT",abort);process.once("SIGTERM",abort);
      try{
        await runPairPage({signal:controller.signal,run:(cancelled,progress)=>runPair({...options,cancelled,progress}),
          ready:async page=>{cleanup=publishPageDiscovery(page);await openDesktop("tray");},
          output:url=>{console.log(url);configureWindowsLogs(path.join(process.env.LOCALAPPDATA!,"sunmoon-link","logs"),"");log("info","本机接入页",{url});},
          complete:async()=>{
            const deadline=Date.now()+30000;
            await autostart("enable");await startResident();
            while(Date.now()<deadline){const status=readResidentStatus();if(status?.relay?.status==="connected"&&await residentAlive())return;if(status?.relay?.status==="rejected")throw new PairPageError(status.relay.lastError??"令牌已失效，请重新颁发令牌。");await new Promise(resolve=>setTimeout(resolve,500));}
            const status=readResidentStatus();throw new PairPageError(status?.relay?.lastError??"ETIMEDOUT: 本地 link 还没有连上，请检查网络或代理设置。");
          }});
      }finally{cleanup?.();process.removeListener("SIGINT",abort);process.removeListener("SIGTERM",abort);}
      return 0;
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      log("error", "pair fatal", { error: message });
      return PAIR_EXIT.failed;
    }finally{await releasePage?.();}
  }
  if (cmd === "menu") {
    const hasToken = configHasToken();
    const running = process.platform === "win32" && hasToken ? await residentAlive() : false;
    const plan = menuPlan(hasToken, running);
    if (plan.start) await startResident();
    console.log(JSON.stringify({ action: plan.action, started: plan.start }));
    if (process.platform === "win32") {if(plan.action==="pair-page")await openPairPage();else await openDesktop("tray");}
    return 0;
  }
  if(cmd==="pair-page-status"){console.log(JSON.stringify(await pairingPageStatus()));return 0;}
  if(cmd==="tray"){
    if(process.platform!=="win32")throw new Error("Windows lifecycle command");
    if(argv[1]==="stop")console.log(JSON.stringify({closed:await closeTray()}));
    else if(!argv[1])await runTray();else throw new Error("tray [stop]");
    return 0;
  }
  if(cmd==="status"&&!fs.existsSync(CONFIG_PATH)){
    console.log(JSON.stringify({running:false,relay:{status:"disconnected"}}));
    return 0;
  }
  if (cmd === "autostart") {
    if (process.platform !== "win32") throw new Error("Windows lifecycle command");
    console.log(JSON.stringify(await autostart(argv[1] ?? "status")));
    return 0;
  }

  const cfg = loadConfig();
  registerSecret(cfg.token);
  if (["stop", "settings", "sandbox-setup", "sandbox-upgrade"].includes(cmd)) {
    if (process.platform !== "win32") throw new Error("Windows lifecycle command");
    if (cmd === "stop") console.log(JSON.stringify({ stopped: await stopResident() }));
    if (cmd === "settings") console.log(JSON.stringify(preferences(argv.slice(1))));
    if (cmd === "sandbox-setup") { if(argv.length!==2||argv[1]!=="--elevated")throw new Error("Optional UAC: sandbox-setup --elevated"); console.log(JSON.stringify(await setupElevated())); }
    if (cmd === "sandbox-upgrade") { if(argv.length!==1)throw new Error("sandbox-upgrade takes no arguments"); console.log(JSON.stringify(await upgradeSandbox())); }
    return 0;
  }
  if (cmd === "mcp") {
    const file = path.join(CONFIG_DIR, "mcp.json");
    if (argv[1] === "list") { console.log(JSON.stringify(loadMcp(file), null, 2)); return 0; }
    if (argv[1] !== "import" || argv.length !== 2) { usage(); return 2; }
    if (process.platform !== "win32") { console.error("本轮 MCP 导入入口仅用于 Windows 上的本地 link。"); return 2; }
    const source = path.join(os.homedir(), ".codex", "config.toml");
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error("Unsupported user Codex config file");
    const { servers, skipped } = importCandidates(fs.readFileSync(source, "utf8"));
    const selected = { ...loadMcp(file) };
    let imported = 0;
    console.log(`可导入 ${Object.keys(servers).length} 个 HTTP MCP；跳过 ${skipped} 个不支持/含认证字段的条目。`);
    for (const [name, server] of Object.entries(servers)) {
      const approved = await localConfirm(`导入 MCP ${JSON.stringify(name)}：${JSON.stringify(server)}\n它的 URL/公开配置会供云端读取；请确认 URL 路径本身也不含口令。固定版 Codex 将 HTTP 请求交给本机执行；localhost 指本机。还须本机网络上限开启，导入不会自动开启网络。`);
      if (approved) { selected[name] = server; imported++; }
    }
    if (!imported) { console.log("没有条目获得本机确认，配置未变更。"); return 1; }
    saveMcp(file, selected);
    console.log("已保存确认过的条目；重启本地 link 后生效。未复制用户其它配置或认证状态。"); return 0;
  }
  if (cmd === "roots") {
    const sub = argv[1]; const dir = argv[2] ? path.resolve(argv[2]) : "";
    if (sub === "list") { cfg.roots.forEach((r) => console.log(r)); return 0; }
    if (sub === "add") { if (!argv[2] || canonicalPath(dir) === null || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { console.error(`不是支持的本地目录：${dir}`); return 2; } if (!cfg.roots.some(r => canonicalPath(r) === canonicalPath(dir))) cfg.roots.push(dir); if (cfg.rootChoices && !cfg.rootChoices.some(r => canonicalPath(r) === canonicalPath(dir))) cfg.rootChoices.push(dir); saveConfig(cfg); console.log(`已加入白名单：${dir}（重启 start 生效）`); return 0; }
    if (sub === "remove") { if (!argv[2]) { usage(); return 2; } cfg.roots = cfg.roots.filter((r) => canonicalPath(r) !== canonicalPath(dir)); saveConfig(cfg); console.log(`已移出白名单：${dir}（重启 start 生效）`); return 0; }
    usage(); return 2;
  }
  if (cmd === "ceiling") {
    if (argv[1] === "show" || !argv[1]) { console.log(JSON.stringify(cfg.ceiling)); return 0; }
    if (argv[1] === "set") {
      const sb = arg("--sandbox", argv); if (sb) cfg.ceiling.sandbox = sb as AgentConfig["ceiling"]["sandbox"];
      const net = arg("--network", argv); if (net) cfg.ceiling.network = net === "on";
      saveConfig(cfg); console.log(JSON.stringify(cfg.ceiling)); return 0;
    }
    usage(); return 2;
  }
  if (cmd === "status") {
    if (process.platform === "win32") { console.log(JSON.stringify({ ...(readResidentStatus() ?? {}), running: await residentAlive() })); return 0; }
    if (!fs.existsSync(STATUS_PATH)) { console.log("没在跑（没有 status.json）"); return 1; }
    console.log(fs.readFileSync(STATUS_PATH, "utf8")); return 0;
  }
  if (cmd === "start") {
    if (argv.slice(1).some(v => !["--background", "--background-worker"].includes(v)) || argv.length > 2) throw new Error("start [--background]");
    if (argv[1] === "--background") { await startResident(); console.log(JSON.stringify({ started: true })); return 0; }
    return start(cfg, argv[1] === "--background-worker");
  }
  usage(); return 2;
}

async function start(cfg: AgentConfig, windowed = false): Promise<number> {
  if (windowed && process.platform !== "win32") throw new Error("Background worker is Windows-only");
  let requestedStop = false;
  const resident = process.platform === "win32" ? await acquireResident(() => { requestedStop = true; process.emit("SIGINT"); }) : undefined;
  if (process.platform === "win32") {
    if (!process.env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is required for agent logs");
    configureWindowsLogs(path.join(process.env.LOCALAPPDATA, "sunmoon-link", "logs"), cfg.token);
  }
  if (ensureDeviceId(cfg)) { saveConfig(cfg); log("info", "device id created", { code: "device_id_created" }); }
  const identity = () => ({ deviceId: cfg.deviceId!, host: os.hostname().slice(0, 128), os: osLabel() });
  if (cfg.roots.length === 0) log("warn", "白名单为空：任何 process/start 都会被拒；用 sunmoon-link roots add <目录>");
  const codex = locateCodex();
  log("info", "sunmoon-link starting", { version: VERSION, machine: cfg.machineName, codex: codex.version, codexBin: codex.codexBin, bwrap: codex.bwrap, platform: process.platform });
  let releaseRoots: (() => void) | undefined;
  let windows: { home: string; helper: WindowsHelper; mode: "elevated" | "unelevated"; temporary: WindowsTemporary } | undefined;
  const mcpServers = process.platform === "win32" ? loadMcp(path.join(CONFIG_DIR, "mcp.json")) : undefined;
  if (process.platform === "win32") {
    const capability = await ensureWindowsSandbox(cfg);
    if (cfg.libraryDir) { assertWindowsHome(CONFIG_DIR, [cfg.libraryDir]); assertWindowsHome(cfg.codexHome, [cfg.libraryDir]); }
    assertWindowsHome(cfg.codexHome, cfg.roots);
    const helper = locateWindowsHelper();
    // 每次启动都补一遍：用户后来装进用户目录的程序（如 Python）也要让沙箱账户读得到
    if (capability.mode === "elevated") prepareElevatedReads(cfg.codexHome, helper);
    windows = { home: cfg.codexHome, helper, mode: capability.mode, temporary: await WindowsTemporary.create(cfg.codexHome, cfg.roots, helper) };
    try { releaseRoots = await pinWindowsDirectories(windows.helper, [...cfg.roots, ...(cfg.libraryDir ? [cfg.libraryDir] : []), cfg.codexHome], cfg.codexHome); }
    catch (error) { await windows.temporary.close(); throw error; }
    log("info", "Windows inner sandbox and strict protocol filter; no OS outer sandbox", { mode: windows.mode });
  }
  const es = new ExecServer({ codexBin: codex.codexBin, bwrap: codex.bwrap, outerSandbox: cfg.outerSandbox, roots: cfg.roots, codexHome: cfg.codexHome, port: cfg.execPort, windowsMode: cfg.windowsSandbox?.mode, windowsTemporary: windows?.temporary, mcpServers });
  try {
    await es.start();
    if (windows && !await runSandboxProbe(es.url, cfg.codexHome, cfg.roots[0] ?? cfg.codexHome, windows.mode, windows.temporary.directory)) throw new Error("Configured Windows sandbox is no longer usable; run init");
  } catch (error) { await es.stop(); releaseRoots?.(); await windows?.temporary.close(); throw error; }
  // 测试电脑（集群里的 Linux 容器）由部署设 SUNMOON_AGENT_TEST_RUNS=1：服务流可在 runs/ 下建、删目录，每次测试一个干净目录（账 129）
  const serviceRunsWritable = process.platform !== "win32" && process.env.SUNMOON_AGENT_TEST_RUNS === "1";
  if (serviceRunsWritable) log("info", "test computer: service may create and remove folders under runs/");
  // 新建项目（0024）：装有本地 link 的电脑走回环口，远程登录 link 的电脑走服务流（账 165），两边共用这一份、同一套规矩：
  // 只在白名单根下，Windows 上经可写的内沙箱 helper（上限是只读时不可写）
  const projects = new LocalProjects({ roots: () => cfg.roots, denied: () => [CONFIG_DIR, cfg.codexHome, ...(cfg.libraryDir ? [cfg.libraryDir] : [])], ceiling: () => cfg.ceiling,
    files: windows ? new WindowsFiles({ url: () => es.url, home: windows.home, roots: cfg.roots, mode: windows.mode, writable: cfg.ceiling.sandbox !== "read-only", helper: windows.helper, temporary: windows.temporary.directory }) : undefined,
    kill: windows ? killWindowsTree : undefined });
  // 被会合点拒绝就退出（退出码 3），不挂着一个连不上的进程：开机自启、托盘、systemd 都能据此看出出错（KIND 12 实测）
  let onRejected: (reason: string) => void = () => {};
  const relay = new RelayClient({
    windows: windows ? { ...windows, executorEnvironment: () => es.windowsEnv, confirmedHttpUrls: confirmedMcpUrls(mcpServers!) } : undefined, relayUrl: cfg.relayUrl, userId: cfg.userId, token: cfg.token, codexVersion: codex.version, softwareVersion: VERSION,
    localUrl: () => es.url, ceiling: () => cfg.ceiling, roots: () => cfg.roots, machineName: () => cfg.machineName, identity,
    codexHome: cfg.codexHome, serviceRunsWritable, serviceProjects: projects, serviceLibraryDir: () => cfg.libraryDir,
    onRejected: (reason) => onRejected(reason),
    confirmPermission: windows ? (windowed ? windowsConfirm : localConfirm) : undefined,
  });
  relay.start();

  let presence: Awaited<ReturnType<typeof startLocalApi>> = null;
  if (resident) {
    try {
      const { webOrigin } = siteDocument(import.meta.url);
      const readRoots = () => [...cfg.roots, ...(cfg.libraryDir ? [cfg.libraryDir] : [])];
      const files = new LocalFiles({ roots: readRoots, configDir: CONFIG_DIR, codexHome: cfg.codexHome,
        files: windows ? new WindowsFiles({ url: () => es.url, home: windows.home, roots: readRoots(), mode: windows.mode, writable: false, helper: windows.helper, temporary: windows.temporary.directory }) : undefined });
      const settings = new LocalSettings({ file: CONFIG_PATH, config: () => cfg, confirm: windowed ? windowsConfirm : localConfirm,
        autostart: { get: async () => (await autostart("status")).enabled === true, set: async enabled => { await autostart(enabled ? "enable" : "disable"); } },
        restart: scheduleResidentRestart, onChange: () => log("info", "local settings applied", { code: "applied" }) });
      presence = await startLocalApi({ webOrigin, version: VERSION, machineName: cfg.machineName, config: () => cfg, files, settings, projects, connected: () => relay.status === "connected", identity, linkState: () => relay.linkState, windowsSandbox: () => cfg.windowsSandbox?.mode,
        onRequest: (category, code) => log(code ? "warn" : "debug", "local request", { category, ...(code ? { code } : {}) }),
        onEvent: (event, details) => log(event === "unavailable" ? "warn" : "info", `presence ${event}`, details) });
    } catch {
      log("warn", "presence unavailable", { code: "site_profile_unavailable" });
    }
  }

  const writeStatus = () => {
    const st = { version: VERSION, pid: process.pid, ...(resident ? { runId: resident.runId, background: windowed } : {}), codex: codex.version, execServer: { url: es.url, alive: es.alive, sandboxed: es.sandboxed, generation: es.generation, ...(windows ? { protection: "inner-sandbox+strict-protocol", windowsSandbox: cfg.windowsSandbox } : {}) }, relay: { url: cfg.relayUrl, status: relay.status, lastError: relay.lastError, lastNotice: relay.lastNotice }, ceiling: cfg.ceiling, roots: cfg.roots, bridge: relay.stats, at: new Date().toISOString() };
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const safe = safeData(st);
    fs.writeFileSync(STATUS_PATH, JSON.stringify(safe, null, 2), { mode: 0o600 });
    return safe;
  };
  const timer = setInterval(writeStatus, 5000);
  writeStatus();

  // 本机状态口（只绑回环）：给将来的弹窗/托盘与本地测试用
  const statusPort = Number(process.env.SUNMOON_AGENT_STATUS_PORT ?? 0);
  const srv = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(writeStatus())); });
  await new Promise<void>((r) => srv.listen(statusPort, "127.0.0.1", () => r()));
  const sp = srv.address(); log("info", "status endpoint", { url: `http://127.0.0.1:${typeof sp === "object" && sp ? sp.port : statusPort}/` });

  return new Promise<number>((resolve) => {
    let done = false;
    const shutdown = async (why: string, code: number) => {
      if (done) return;
      done = true;
      log(code === 0 ? "info" : "error", "shutting down", { why, exitCode: code });
      clearInterval(timer);
      if (code !== 0) writeStatus(); // 保留最后状态（含被拒原因），便于用户与托盘查看
      relay.stop(); srv.close(); if (presence) await presence.close(); else await projects.close(); await es.stop(); releaseRoots?.(); await windows?.temporary.close();
      if (code === 0) { try { fs.unlinkSync(STATUS_PATH); } catch {} }
      await resident?.close();
      resolve(code);
    };
    onRejected = (reason) => void shutdown(`relay rejected: ${reason}`, EXIT_REJECTED);
    process.once("SIGINT", () => void shutdown("SIGINT", 0));
    process.once("SIGTERM", () => void shutdown("SIGTERM", 0));
    if (requestedStop) void shutdown("stop requested during startup", 0);
  });
}

function usage(): void {
  console.log(`sunmoon-link ${VERSION}
  init --relay ws://HOST:PORT --user ID --token T [--root DIR]... [--name 电脑名] [--port N] [--no-outer-sandbox]
  init --relay wss://HOST --user ID --token-prompt [--root DIR]...  本机隐藏输入，不把令牌放进命令历史
  roots list | add DIR | remove DIR
  mcp import | list   本机逐项确认导入无凭据 HTTP MCP；拒绝管道输入确认
  ceiling show | set [--sandbox read-only|workspace-write|danger-full-access] [--network on|off]
  start      前台运行；被会合点拒绝（令牌无效、被吊销、令牌已颁发给另一份本地 link）时退出，退出码 3
  status
  start --background   Windows 后台运行，本机确认用独立窗口
  stop                 Windows 正常停止；不强杀未知进程
  tray [stop]          Windows 托盘（tray stop 只关托盘；托盘菜单「退出 link」连本地 link 一起退出）
  settings show|set    本机设置；set 从 stdin 读非秘密 JSON，重启后生效
  pair                       颁发令牌：显示确认码并轮询，令牌只写入本机配置
  pair --page                在默认浏览器打开本机接入页
  menu                       已连接则打开托盘，否则打开浏览器接入页
  pair-page-status           本机接入页状态（无令牌），供托盘排障
  autostart status|enable|disable   当前用户登录任务；安装时默认打开，可关闭
  sandbox-setup --elevated         提权模式设置（一次 UAC）；先退出本地 link，仅同一 Windows 用户
  sandbox-upgrade                  托盘用：停下本地 link、做提权模式设置、再起来`);
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { log("error", "fatal", { error: String(e?.stack ?? e) }); process.exit(1); });
