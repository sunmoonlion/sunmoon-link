import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { locateCodex } from "./paths.js";
import { isUnder, canonicalPath } from "./pathuri.js";
import { isReservedWindowsEnv } from "./windowsPolicy.js";

export type WindowsMode = "elevated" | "unelevated";
export function windowsEnvironment(home: string, overrides: Record<string, string> = {}, inherited: NodeJS.ProcessEnv = process.env, temporary?: string): Record<string, string> {
  // Windows keys are case-insensitive. Canonicalize before merging so PATH
  // really overrides Path; Node otherwise chooses one of the duplicate keys.
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) if (value !== undefined && !isReservedWindowsEnv(key)) result[key.toUpperCase()] = value;
  for (const [key, value] of Object.entries(overrides)) {
    if (isReservedWindowsEnv(key)) {
      if (key === "CODEX_HOME" && value === home) continue;
      throw new Error("reserved executor environment override");
    }
    result[key.toUpperCase()] = value;
  }
  return { ...result, CODEX_HOME: home, ...(temporary ? { TEMP: temporary, TMP: temporary, TMPDIR: temporary } : {}) };
}
export function assertWindowsHome(home: string, roots: readonly string[]): void {
  if (canonicalPath(home, "win32") === null) throw new Error("Windows executor home must be on a local drive");
  if (fs.existsSync(path.join(home, "auth.json"))) throw new Error("Executor home contains auth.json; use a credential-free agent home");
  const protectedPaths = [home, path.dirname(home), path.dirname(path.dirname(fileURLToPath(import.meta.url))), process.execPath];
  if (roots.some(root => protectedPaths.some(p => isUnder(p, root, "win32")))) throw new Error("Writable root overlaps agent configuration, executor home or installed code");
  for (const root of [...roots, home]) {
    if (canonicalPath(root, "win32") === null || !fs.statSync(root).isDirectory()) throw new Error("Windows root must be an existing local directory");
    let p = root;
    while (true) {
      if (fs.lstatSync(p).isSymbolicLink()) throw new Error("Reparse point in configured root");
      if (canonicalPath(fs.realpathSync.native(p), "win32") !== canonicalPath(p, "win32")) throw new Error("Root alias refused");
      const parent = path.dirname(p); if (parent === p) break; p = parent;
    }
  }
}
export function windowsProfile(cwd: string, roots: readonly string[], mode: WindowsMode, writable = true): any {
  return {
    permissions: { type: "managed", file_system: { type: "restricted", entries: [
      { path: { type: "special", value: { kind: "root" } }, access: "read" },
      ...(writable ? [{ path: { type: "special", value: { kind: "project_roots" } }, access: "write" }] : []),
    ] }, network: "restricted" },
    cwd: pathToFileURL(cwd).href, workspaceRoots: roots.map(r => pathToFileURL(r).href),
    windowsSandboxLevel: mode === "elevated" ? "elevated" : "restricted-token", useLegacyLandlock: false,
  };
}
export async function killWindowsTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const result = spawnSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, encoding: "utf8", timeout: 10000 });
  if (result.error) throw new Error("Windows process tree termination failed");
  await new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) return resolve(); const t = setTimeout(resolve, 2000); child.once("exit", () => { clearTimeout(t); resolve(); }); });
  if (child.exitCode === null && child.signalCode === null) throw new Error("Windows executor still alive after taskkill /T");
}

export class LocalRpc {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  readonly listeners = new Set<(frame: any) => void>();
  private constructor(readonly ws: WebSocket) {
    ws.on("message", raw => { const f = JSON.parse(String(raw)); const p = this.pending.get(f.id); if (p) { clearTimeout(p.timer); this.pending.delete(f.id); p.resolve(f); } else for (const listener of this.listeners) listener(f); });
    ws.on("close", () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("local executor disconnected")); } this.pending.clear(); });
    ws.on("error", () => {});
  }
  static async connect(url: string): Promise<LocalRpc> {
    const ws = new WebSocket(url, { maxPayload: 16 * 1024 * 1024 });
    const rpc = new LocalRpc(ws);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.terminate(); reject(new Error("executor connect timeout")); }, 5000);
      ws.once("open", () => { clearTimeout(timer); resolve(); }); ws.once("error", () => { clearTimeout(timer); reject(new Error("executor connection failed")); });
    });
    const init = await rpc.call("initialize", { clientName: "sunmoon-agent-local-helper" });
    if (init.error || init.result?.environmentInfo?.executorVersion !== "0.155.1") { rpc.close(); throw new Error("helper requires exec-server 0.155.1"); }
    ws.send(JSON.stringify({ method: "initialized", params: {} }));
    return rpc;
  }
  call(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => { const id = ++this.seq; const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`local RPC timeout: ${method}`)); }, 15000); this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  close(): void { this.ws.terminate(); }
}

export async function runSandboxProbe(url: string, home: string, cwd: string, mode: WindowsMode, temporary?: string): Promise<boolean> {
  const rpc = await LocalRpc.connect(url); const processId = `probe-${randomUUID()}`;
  let result: any;
  let timer: NodeJS.Timeout | undefined;
  try {
    const closed = new Promise<any>((resolve, reject) => { timer = setTimeout(() => reject(new Error("sandbox probe timeout")), 12000); rpc.listeners.add(f => { if (f.method === "process/exited" && f.params.processId === processId) { clearTimeout(timer); resolve(f.params); } }); });
    void closed.catch(() => {});
    // Probe real launch with the isolated home; no setup/UAC or model request.
    const response = await rpc.call("process/start", { processId, tty: false, env: windowsEnvironment(home, {}, process.env, temporary), argv: [process.execPath, "-e", "process.stdout.write('sunmoon-sandbox-probe')"], cwd: pathToFileURL(cwd).href, sandbox: windowsProfile(cwd, [cwd], mode, false), enforceManagedNetwork: false, managedNetwork: null });
    if (response.error) { closed.catch(() => {}); return false; }
    result = await closed;
    return response.result?.sandboxType === "windowsRestrictedToken" && result.exitCode === 0;
  } finally { clearTimeout(timer); if (!result) await rpc.call("process/terminate", { processId }).catch(() => {}); rpc.close(); }
}

export interface WindowsHelper { node: string; script: string }
export function locateWindowsHelper(): WindowsHelper {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../native/helper.mjs");
  if (!fs.existsSync(script)) throw new Error("Windows Node helper missing from agent package");
  return { node: process.execPath, script };
}

/** CLI configuration is generated locally; no shell, remote profile or executable. */
export function windowsHelperArgs(home: string, roots: readonly string[], mode: WindowsMode, writable: boolean, helper: WindowsHelper, notFound?: { file: any; directory: any }): string[] {
  const entries = ['":root"="read"', ...(writable ? roots.map(r => `${JSON.stringify(r)}="write"`) : [])];
  const profile = `permissions.sunmoon_files={filesystem={${entries.join(",")}},network={enabled=false}}`;
  const config = Buffer.from(JSON.stringify({ home, notFound, roots: writable ? roots : [], reads: [...roots, home], deniedReads: [path.join(home, ".sandbox-secrets"), path.join(home, "auth.json")] })).toString("base64");
  return ["-c", profile, "-c", `windows.sandbox="${mode}"`, "sandbox", "--permission-profile", "sunmoon_files", "-C", roots[0] ?? home, "--", helper.node, helper.script, config];
}

/** Shared by every WindowsFiles in this process. Set once a resident helper did
 * not answer its readiness ping while stdin stayed open (the 11-01 symptom:
 * replies only after EOF). From then on each call gets its own helper. */
export interface ResidentFallback { residentUnavailable: boolean }
const processFallback: ResidentFallback = { residentUnavailable: false };

export interface WindowsFilesTiming { readyMs: number; callMs: number; idleMs: number; idleWithHandlesMs: number }
const DEFAULT_TIMING: WindowsFilesTiming = { readyMs: 10000, callMs: 15000, idleMs: 30000, idleWithHandlesMs: 600000 };

interface Resident {
  child: ChildProcess;
  pending: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  ready: Promise<void>;
  dead: boolean;
  idle?: NodeJS.Timeout;
}

/** Filesystem RPC through the sandboxed Node helper. One resident helper per
 * instance serves calls in order over stdin/stdout (sandbox start-up costs
 * ~0.6–1 s, a warm call ~1 ms). The helper is retired when idle so it does not
 * keep holding its working directory. If the helper never answers its ping
 * while stdin is open, the process switches to one helper per call, ended with
 * EOF, which is how 0.5.5–0.5.6 always ran. Calls are never replayed after a
 * timeout or crash: the caller sees the error and a later call starts afresh. */
export class WindowsFiles {
  private seq = 0;
  private notFoundPromise?: Promise<{ file: any; directory: any }>;
  private closed = false;
  private resident?: Resident;
  private handles = new Set<string>();
  private timing: WindowsFilesTiming;

  constructor(private opts: {
    url: () => string; home: string; roots: readonly string[]; mode: WindowsMode; writable: boolean; helper: WindowsHelper; temporary?: string;
    /** Test seams; production uses the Codex sandbox, taskkill and the process-wide fallback. */
    spawnHelper?: (args: string[]) => ChildProcess; killTree?: (child: ChildProcess) => Promise<void>;
    fallback?: ResidentFallback; timing?: Partial<WindowsFilesTiming>;
  }) {
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
  }

  private async getNotFound(): Promise<{ file: any; directory: any }> {
    if (!this.notFoundPromise) {
      this.notFoundPromise = (async () => {
        const rpc = await LocalRpc.connect(this.opts.url());
        try {
          const absent = path.join(this.opts.home, `.sunmoon-not-found-${randomUUID()}`);
          const file = (await rpc.call("fs/getMetadata", { path: pathToFileURL(absent).href, sandbox: null })).error;
          const directory = (await rpc.call("fs/readFile", { path: pathToFileURL(path.join(absent, "child")).href, sandbox: null })).error;
          if ([file, directory].some(e => e?.code !== -32004 || typeof e.message !== "string")) {
            throw new Error("Unexpected executor not-found contract");
          }
          return { file: { code: file.code, message: file.message }, directory: { code: directory.code, message: directory.message } };
        } finally {
          rpc.close();
        }
      })();
      // A failed probe (exec-server not up yet, a dropped connection) must not stick:
      // clear it so the next file call probes again (ledger 187).
      this.notFoundPromise.catch(() => { this.notFoundPromise = undefined; });
    }
    return this.notFoundPromise;
  }

  private get fallback(): ResidentFallback { return this.opts.fallback ?? processFallback; }

  private spawnHelper(notFound: { file: any; directory: any }): ChildProcess {
    const o = this.opts;
    const args = windowsHelperArgs(o.home, o.roots, o.mode, o.writable, o.helper, notFound);
    const child = o.spawnHelper ? o.spawnHelper(args) : spawn(locateCodex().codexBin, args, {
      cwd: o.roots[0] ?? o.home,
      env: windowsEnvironment(o.home, {}, process.env, o.temporary),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    // Directory responses can span pipe chunks in the middle of a UTF-8 name.
    child.stdout!.setEncoding("utf8");
    // Drain without forwarding paths, command output or credentials into logs.
    child.stderr!.resume();
    child.stdin!.on("error", () => {});
    return child;
  }

  private kill(child: ChildProcess): Promise<void> {
    return (this.opts.killTree ?? killWindowsTree)(child).catch(() => {});
  }

  async call(method: string, params: any): Promise<any> {
    if (this.closed) throw new Error("filesystem worker closed");
    const notFound = await this.getNotFound();
    if (this.closed) throw new Error("filesystem worker closed");
    if (this.fallback.residentUnavailable) return this.callOnce(method, params, notFound);

    let r = this.resident;
    if (!r || r.dead) r = this.resident = this.startResident(notFound);
    try {
      await r.ready;
    } catch (error) {
      // The ping got no answer: this request was never written to the helper,
      // so sending it through a one-shot helper is not a replay.
      if (this.fallback.residentUnavailable && !this.closed) return this.callOnce(method, params, notFound);
      throw error;
    }
    if (this.closed) throw new Error("filesystem worker closed");
    if (r.dead) throw new Error("filesystem worker exited");

    if (r.idle) { clearTimeout(r.idle); r.idle = undefined; }
    try {
      const v = await this.send(r, method, params, this.timing.callMs);
      if (method === "fs/open" && v?.result && typeof params?.handleId === "string") this.handles.add(params.handleId);
      if (method === "fs/close" && v?.result && typeof params?.handleId === "string") this.handles.delete(params.handleId);
      return v;
    } finally {
      this.scheduleIdle(r);
    }
  }

  private startResident(notFound: { file: any; directory: any }): Resident {
    const child = this.spawnHelper(notFound);
    const r: Resident = { child, pending: new Map(), ready: Promise.resolve(), dead: false };
    let buffer = "";
    child.stdout!.on("data", d => {
      buffer += String(d);
      if (buffer.length > 16 * 1024 * 1024) { void this.fail(r, "filesystem worker buffer overflow"); return; }
      let n;
      while ((n = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, n);
        buffer = buffer.slice(n + 1);
        let v: any;
        try { v = JSON.parse(line); } catch { void this.fail(r, "filesystem worker protocol error"); return; }
        const p = r.pending.get(v?.id);
        if (p) { clearTimeout(p.timer); r.pending.delete(v.id); p.resolve(v); }
      }
    });
    child.once("error", err => { void this.fail(r, `filesystem worker process error: ${err.message}`); });
    child.once("exit", (code, signal) => { void this.fail(r, `filesystem worker exited prematurely: code=${code ?? signal}`); });
    r.ready = this.send(r, "sunmoon/ping", {}, this.timing.readyMs, () => { this.fallback.residentUnavailable = true; }).then(() => {});
    r.ready.catch(() => {});
    return r;
  }

  private send(r: Resident, method: string, params: any, timeoutMs: number, onTimeout?: () => void): Promise<any> {
    if (r.dead) return Promise.reject(new Error("filesystem worker exited"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        onTimeout?.();
        void this.fail(r, `filesystem worker timeout: ${method}`);
      }, timeoutMs);
      r.pending.set(id, { resolve, reject, timer });
      r.child.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  private fail(r: Resident, message: string): Promise<void> {
    if (r.dead) return Promise.resolve();
    r.dead = true;
    if (this.resident === r) { this.resident = undefined; this.handles.clear(); }
    if (r.idle) clearTimeout(r.idle);
    for (const p of r.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
    r.pending.clear();
    return this.kill(r.child);
  }

  private scheduleIdle(r: Resident): void {
    if (r.dead || this.resident !== r || r.pending.size > 0) return;
    if (r.idle) clearTimeout(r.idle);
    r.idle = setTimeout(() => { void this.retire(r); }, this.handles.size ? this.timing.idleWithHandlesMs : this.timing.idleMs);
    r.idle.unref?.();
  }

  /** Idle: end stdin so the helper closes its handles and exits by itself. */
  private async retire(r: Resident): Promise<void> {
    if (r.dead || r.pending.size > 0) return;
    r.dead = true;
    if (this.resident === r) { this.resident = undefined; this.handles.clear(); }
    r.child.stdin!.end();
    const exited = await new Promise<boolean>(resolve => {
      if (r.child.exitCode !== null || r.child.signalCode !== null) return resolve(true);
      const t = setTimeout(() => resolve(false), 2000);
      t.unref?.();
      r.child.once("exit", () => { clearTimeout(t); resolve(true); });
    });
    if (!exited) await this.kill(r.child);
  }

  /** One helper for one request, stdin ended right after the frame. */
  private callOnce(method: string, params: any, notFound: { file: any; directory: any }): Promise<any> {
    const id = ++this.seq;
    const child = this.spawnHelper(notFound);
    let buffer = "";
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error: Error | null, value?: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
        void this.kill(child);
      };
      const timer = setTimeout(() => settle(new Error(`filesystem worker timeout: ${method}`)), this.timing.callMs);
      child.stdout!.on("data", d => {
        buffer += String(d);
        if (buffer.length > 16 * 1024 * 1024) { settle(new Error("filesystem worker buffer overflow")); return; }
        let n;
        while ((n = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, n);
          buffer = buffer.slice(n + 1);
          try { const v = JSON.parse(line); if (v && v.id === id) { settle(null, v); return; } } catch {}
        }
      });
      child.once("error", err => settle(new Error(`filesystem worker process error: ${err.message}`)));
      child.once("exit", (code, signal) => settle(new Error(`filesystem worker exited prematurely: code=${code ?? signal}`)));
      child.stdin!.end(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const r = this.resident;
    if (r) await this.fail(r, "filesystem worker closed");
  }
}

/** A Windows current-directory handle prevents renaming it or its ancestors.
 * This local guard only pins a directory; all remote FS operations run sandboxed. */
export type WindowsDirectoryGuard = (() => void) & { assert: () => void; close: () => Promise<void> };
export async function pinWindowsDirectories(helper: WindowsHelper, dirs: readonly string[], home: string): Promise<WindowsDirectoryGuard> {
  const children: ChildProcess[] = [];
  const release = () => { for (const c of children) c.stdin?.end(); };
  try {
    for (const dir of new Set(dirs)) {
      const child = spawn(helper.node, [helper.script, "--pin-directory"], { cwd: dir, env: windowsEnvironment(home), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      children.push(child); child.stderr!.resume(); child.stdin!.on("error", () => {});
      await new Promise<void>((resolve, reject) => {
        let output = ""; const t = setTimeout(() => reject(new Error("Windows directory guard timeout")), 5000);
        child.once("error", () => { clearTimeout(t); reject(new Error("directory guard unavailable")); });
        child.once("exit", () => { clearTimeout(t); reject(new Error("directory guard refused path")); });
        child.stdout!.on("data", d => { output += String(d); if (output.includes('{"ready":true}')) { clearTimeout(t); resolve(); } });
      });
      if (canonicalPath(fs.realpathSync.native(dir), "win32") !== canonicalPath(dir, "win32")) throw new Error("directory guard path alias");
    }
  } catch (error) { release(); for (const c of children) await killWindowsTree(c); throw error; }
  return Object.assign(release, {
    assert: () => { if (children.some(c => c.exitCode !== null || c.signalCode !== null)) throw new Error("Windows directory guard stopped"); },
    close: async () => { release(); for (const c of children) await killWindowsTree(c); },
  });
}

/** One agent-owned temp directory for one executor lifetime. Never sweep the
 * parent: other running agents may own siblings. Stop executor before close. */
export class WindowsTemporary {
  private constructor(readonly directory: string, private guard: WindowsDirectoryGuard, private identity: { dev: bigint; ino: bigint }) {}
  static async create(home: string, roots: readonly string[], helper: WindowsHelper): Promise<WindowsTemporary> {
    const local = process.env.LOCALAPPDATA;
    if (process.platform !== "win32" || !local || canonicalPath(local, "win32") === null) throw new Error("Windows LOCALAPPDATA required");
    const parent = path.join(local, "sunmoon-link", "tmp");
    if (roots.some(root => isUnder(parent, root, "win32") || isUnder(root, parent, "win32"))) throw new Error("Temporary storage overlaps project roots");
    // Pin the existing ancestor before creating descendants. Reparse aliases
    // in the parent are checked again by the directory guard before use.
    const ancestor = await pinWindowsDirectories(helper, [local], home);
    let directory: string | undefined;
    try {
      for (const candidate of [path.dirname(parent), parent]) {
        try { const s = fs.lstatSync(candidate); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Temporary storage parent alias refused"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      fs.mkdirSync(parent, { recursive: true });
      const parentGuard = await pinWindowsDirectories(helper, [parent], home);
      try {
        directory = fs.mkdtempSync(path.join(parent, "executor-"));
        const guard = await pinWindowsDirectories(helper, [directory], home);
        return new WindowsTemporary(directory, guard, fs.statSync(directory, { bigint: true }));
      } finally { await parentGuard.close(); }
    } catch (error) { if (directory) fs.rmSync(directory, { recursive: true, force: true }); throw error; }
    finally { await ancestor.close(); }
  }
  assert(environment?: NodeJS.ProcessEnv): void {
    this.guard.assert();
    const s = fs.lstatSync(this.directory, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink() || s.dev !== this.identity.dev || s.ino !== this.identity.ino || canonicalPath(fs.realpathSync.native(this.directory), "win32") !== canonicalPath(this.directory, "win32")) throw new Error("Owned temporary directory changed");
    if (environment && ["TEMP", "TMP", "TMPDIR"].some(k => environment[k] !== this.directory || Object.keys(environment).some(other => other !== k && other.toUpperCase() === k))) throw new Error("Executor temporary environment changed");
  }
  async close(): Promise<void> {
    this.assert(); await this.guard.close();
    fs.rmSync(this.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
