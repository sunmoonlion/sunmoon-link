// exec-server 守护：Linux 经外沙箱、Windows 原生拉起回环执行器；stdin 保持打开。
// 停止显式清理进程树，不假设关闭 stdin 就能收掉所有子进程。
// 进程死了才重启；桥断线不重启（会话 id 在它内存里，25 秒窗内要接回同一个进程，见 REPORT-2026-09-23-reconnect.md）。
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { killWindowsTree, windowsEnvironment, type WindowsMode, type WindowsTemporary } from "./windowsRuntime.js";
import { log } from "./log.js";
import { wrapCommand } from "./outerSandbox.js";
import { ownedConfig, type McpServers } from "./mcp.js";

export interface ExecServerOptions {
  codexBin: string;
  bwrap: string | null;
  outerSandbox: boolean;
  roots: readonly string[];
  codexHome: string;
  port: number; // 0 = 自动
  env?: Record<string, string>;
  windowsMode?: WindowsMode;
  windowsTemporary?: WindowsTemporary;
  mcpServers?: McpServers;
}

export async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export async function waitForPort(port: number, timeoutMs: number, alive: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive()) return false;
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect({ port, host: "127.0.0.1" });
      s.once("connect", () => { s.destroy(); resolve(true); });
      s.once("error", () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// 云端的 app-server 会成批同时发文件信息查询（找 AGENTS.md 等）；exec-server 默认一个个处理，一批请求在用户电脑上排队累加。
// 并发处理是上游可选开启的（Codex 0.155.1 起有 `--concurrent-requests`，见 exec-server README），官方测试用到 32，这里取 8。
export const EXEC_SERVER_CONCURRENT_REQUESTS = 8;

export function execServerCommand(codexBin: string, url: string): string[] {
  return [codexBin, "exec-server", "--concurrent-requests", String(EXEC_SERVER_CONCURRENT_REQUESTS), "--listen", url];
}

export class ExecServer {
  private child: ChildProcess | null = null;
  private stopping = false;
  private restarts = 0;
  port = 0;
  sandboxed = false;
  generation = 0;
  windowsEnv: NodeJS.ProcessEnv = {};
  private starting: Promise<void> | null = null;
  constructor(private readonly opts: ExecServerOptions) {}

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  get alive(): boolean {
    return this.child != null && this.child.exitCode == null && this.child.signalCode == null;
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.startOnce().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async startOnce(): Promise<void> {
    this.stopping = false;
    fs.mkdirSync(this.opts.codexHome, { recursive: true, mode: 0o700 });
    const cfg = `${this.opts.codexHome}/config.toml`;
    if (process.platform === "win32") {
      if (!this.opts.windowsMode || !this.opts.windowsTemporary) throw new Error("Windows sandbox capability and owned temporary directory required; run init");
      this.opts.windowsTemporary.assert();
      this.windowsEnv = windowsEnvironment(this.opts.codexHome, {}, process.env, this.opts.windowsTemporary.directory);
      fs.writeFileSync(cfg, ownedConfig(this.opts.windowsMode, this.opts.mcpServers), { mode: 0o600 });
    } else if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, 'sandbox_mode = "read-only"\napproval_policy = "never"\n', { mode: 0o600 });
    this.port = this.opts.port || (await freeLoopbackPort());
    const command = execServerCommand(this.opts.codexBin, this.url);
    const { argv, sandboxed } = wrapCommand(command, { enabled: this.opts.outerSandbox, bwrap: this.opts.bwrap, roots: this.opts.roots, codexHome: this.opts.codexHome });
    this.sandboxed = sandboxed;
    this.generation += 1;
    const gen = this.generation;
    log("info", "exec-server starting", { port: this.port, sandboxed, roots: this.opts.roots, generation: gen });
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      cwd: process.platform === "win32" ? this.opts.codexHome : undefined,
      env: process.platform === "win32" ? this.windowsEnv : { ...process.env, ...(this.opts.env ?? {}), CODEX_HOME: this.opts.codexHome },
    });
    this.child = child;
    // Child output can contain argv, env or MCP auth failures. Drain it without
    // persisting its content, even at debug level.
    child.stdout?.on("data", (d) => log("debug", "exec-server stdout", { bytes: d.length }));
    child.stderr?.on("data", (d) => log("debug", "exec-server stderr", { bytes: d.length }));
    let ready = false;
    child.on("error", () => { log("error", "exec-server spawn failed", { generation: gen }); });
    child.on("exit", (code, signal) => {
      log(this.stopping ? "info" : "warn", "exec-server exited", { code, signal, generation: gen });
      if (this.child === child) this.child = null;
      if (!this.stopping && ready) this.scheduleRestart();
    });
    const up = await waitForPort(this.port, 15000, () => this.alive);
    if (!up) { await this.stop(); throw new Error(`exec-server 没有在 ${this.url} 监听`); }
    ready = true;
    this.restarts = 0;
    log("info", "exec-server ready", { url: this.url, generation: gen });
  }

  private scheduleRestart(): void {
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.restarts, 5));
    this.restarts += 1;
    log("warn", "exec-server restart scheduled — 注意：原会话全部丢失，沙箱侧会看到 unknown session id", { delayMs: delay });
    setTimeout(() => { if (!this.stopping) this.start().catch((e) => log("error", "exec-server restart failed", { error: String(e) })); }, delay);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    if (process.platform === "win32") { await killWindowsTree(child); this.child = null; return; }
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000);
      child.once("exit", () => { clearTimeout(t); resolve(); });
    });
    this.child = null;
  }
}
