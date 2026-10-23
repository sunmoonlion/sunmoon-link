// SDD 0022: a separate, read-only JSON-RPC service. Never forwards to exec-server.
// The one exception is the test computer (ledger 129): with runsWritable it may create and remove
// directories directly under <root>/runs/, so each knowlab test gets a clean folder. Users' links stay read-only.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalPath, isUnderAny } from "./pathuri.js";

export const SERVICE_CAPABILITY = "service-v1";
export const SERVICE_RUNS_CAPABILITY = "service-runs-v1";
export const RUNS_DIR = "runs";
const RUN_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const READS = ["fs/readDirectory", "fs/getMetadata", "fs/readFile"];
const WRITES = ["fs/createDirectory", "fs/remove"];
export const SERVICE_MAX_FRAME = 1024 * 1024;
export const SERVICE_MAX_READ = 512 * 1024;
const MAX_FILE = 64 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const errors: Record<number, string> = {
  [-32010]: "outside_whitelist", [-32011]: "too_large", [-32012]: "not_found", [-32013]: "rate_limited",
  [-32700]: "Parse error", [-32600]: "Invalid Request", [-32601]: "Method not found", [-32602]: "Invalid params",
};
class ServiceError extends Error { constructor(readonly code: number) { super(errors[code]); } }
export class ServiceFrameError extends Error {}
export interface ServiceFiles { call(method: string, params: object): Promise<any>; close(): Promise<void> }
export interface ServiceOptions {
  version: string;
  roots: () => readonly string[];
  configDir: string;
  codexHome: string;
  platform?: NodeJS.Platform;
  files?: ServiceFiles;
  now?: () => number;
  onRequest?: (method: string, code?: number) => void;
  /** Test computer only (Linux): allow fs/createDirectory and fs/remove for <root>/runs/<name>. */
  runsWritable?: boolean;
}
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const metadata = (s: fs.Stats) => ({ type: s.isSymbolicLink() ? "link" : s.isDirectory() ? "dir" : s.isFile() ? "file" : "other", size: s.size, mtime: Math.trunc(s.mtimeMs) });

export class ServiceHandler {
  private active = 0;
  private tokens = 50;
  private last: number;
  private closed = false;
  private readonly platform: NodeJS.Platform;
  private readonly runsWritable: boolean;
  constructor(private readonly opts: ServiceOptions) {
    this.platform = opts.platform ?? process.platform;
    this.last = (opts.now ?? Date.now)();
    this.runsWritable = opts.runsWritable === true && this.platform !== "win32";
  }
  async close(): Promise<void> { this.closed = true; await this.opts.files?.close(); }
  async receive(text: string, binary = false): Promise<string | null> {
    if (this.closed) return null;
    if (binary || Buffer.byteLength(text) > SERVICE_MAX_FRAME) throw new ServiceFrameError("invalid service frame");
    let frame: any;
    try { frame = JSON.parse(text); } catch { return this.error(null, -32700); }
    const validId = !Object.hasOwn(frame ?? {}, "id") || frame.id === null
      || (typeof frame.id === "string" && frame.id.length <= 128) || (typeof frame.id === "number" && Number.isSafeInteger(frame.id));
    if (!object(frame) || frame.jsonrpc !== "2.0" || typeof frame.method !== "string" || !validId
      || Object.keys(frame).some(k => !["jsonrpc", "id", "method", "params"].includes(k))) return this.error(null, -32600);
    const notification = !Object.hasOwn(frame, "id");
    const method = ["service/hello", ...READS, ...WRITES].includes(frame.method) ? frame.method : "unknown";
    const now = (this.opts.now ?? Date.now)();
    this.tokens = Math.min(50, this.tokens + Math.max(0, now - this.last) * .05); this.last = now;
    if (this.tokens < 1 || this.active >= 4) {
      this.opts.onRequest?.(method, -32013);
      return notification ? null : this.error(frame.id, -32013);
    }
    this.tokens--; this.active++;
    try {
      const result = await this.dispatch(frame.method, frame.params);
      if (this.closed) return null;
      this.opts.onRequest?.(method);
      const response = JSON.stringify({ jsonrpc: "2.0", id: frame.id, result });
      if (Buffer.byteLength(response) > SERVICE_MAX_FRAME) throw new ServiceFrameError("service response limit");
      return notification ? null : response;
    } catch (error) {
      if (error instanceof ServiceFrameError) throw error;
      const code = error instanceof ServiceError ? error.code : ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") ? -32012 : -32010;
      this.opts.onRequest?.(method, code);
      return this.closed || notification ? null : this.error(frame.id, code);
    } finally { this.active--; }
  }
  private error(id: unknown, code: number): string { return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: errors[code] } }); }
  private async dispatch(method: string, params: unknown): Promise<object> {
    if (method === "service/hello") {
      if (params !== undefined && (!object(params) || Object.keys(params).length)) throw new ServiceError(-32602);
      return { agent: "sunmoon-agent", version: this.opts.version, roots: [...this.opts.roots()], libraryDir: null, capabilities: [SERVICE_CAPABILITY, ...(this.runsWritable ? [SERVICE_RUNS_CAPABILITY] : [])] };
    }
    if (WRITES.includes(method)) {
      if (!this.runsWritable) throw new ServiceError(-32601);
      return this.writeRun(method, params);
    }
    if (!READS.includes(method)) throw new ServiceError(-32601);
    if (!object(params) || typeof params.path !== "string"
      || Object.keys(params).some(k => !(method === "fs/readFile" ? ["path", "offset", "length"] : ["path"]).includes(k))) throw new ServiceError(-32602);
    const target = params.path;
    const normalized = canonicalPath(target, this.platform);
    if (!normalized || !isUnderAny(target, this.opts.roots(), this.platform)
      || isUnderAny(target, [this.opts.configDir, this.opts.codexHome], this.platform)
      || normalized.split(this.platform === "win32" ? "\\" : "/").some(bit => ["auth.json", ".sandbox-secrets"].includes(bit))) throw new ServiceError(-32010);
    const offset = params.offset ?? 0, length = params.length ?? SERVICE_MAX_READ;
    if (method === "fs/readFile" && (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > SERVICE_MAX_READ)) throw new ServiceError(-32602);
    if (this.platform === "win32") {
      if (!this.opts.files) throw new ServiceError(-32010);
      // Only these locally selected read operations reach the existing sandboxed helper.
      const reply = await this.opts.files.call("service/" + method.slice(3), { path: pathToFileURL(target).href, ...(method === "fs/readFile" ? { offset, length } : {}) });
      if (reply.error) throw new ServiceError(reply.error.code === -32004 ? -32012 : [-32011, -32602].includes(reply.error.code) ? reply.error.code : -32010);
      return reply.result;
    }
    // Linux path is for tests. Check each ancestor, then the opened file identity.
    this.inspect(normalized);
    const stat = fs.lstatSync(normalized);
    if (method === "fs/getMetadata") return metadata(stat);
    if (method === "fs/readDirectory") {
      if (!stat.isDirectory()) throw new ServiceError(-32602);
      const entries: object[] = [];
      const dir = fs.opendirSync(normalized);
      let truncated = false, bytes = 512;
      try {
        let entry: fs.Dirent | null;
        while ((entry = dir.readSync())) {
          if (entries.length === MAX_ENTRIES) { truncated = true; break; }
          // lstat only: listing a link never resolves its destination.
          const s = fs.lstatSync(path.join(normalized, entry.name));
          const item = { name: entry.name, ...metadata(s) };
          bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
          if (bytes > SERVICE_MAX_FRAME - 2048) { truncated = true; break; }
          entries.push(item);
        }
      } finally { dir.closeSync(); }
      return { entries, truncated };
    }
    if (!stat.isFile()) throw new ServiceError(-32602);
    const fd = fs.openSync(normalized, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(fd);
      this.inspect(normalized);
      const named = fs.lstatSync(normalized);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== named.dev || opened.ino !== named.ino) throw new ServiceError(-32010);
      if (opened.size > MAX_FILE) throw new ServiceError(-32011);
      const bytes = Buffer.alloc(Math.min(length, Math.max(0, opened.size - offset)));
      const n = fs.readSync(fd, bytes, 0, bytes.length, offset);
      return { content: bytes.subarray(0, n).toString("base64"), size: opened.size, mtime: Math.trunc(opened.mtimeMs), eof: offset + n >= opened.size };
    } finally { fs.closeSync(fd); }
  }
  /** Only <root>/runs/<name>: create (making runs/ if missing) or remove recursively. Removing what is gone succeeds. */
  private writeRun(method: string, params: unknown): object {
    if (!object(params) || typeof params.path !== "string"
      || Object.keys(params).some(k => !["path", "recursive", "force"].includes(k))
      || (params.recursive !== undefined && typeof params.recursive !== "boolean")
      || (params.force !== undefined && typeof params.force !== "boolean")) throw new ServiceError(-32602);
    const target = canonicalPath(params.path, this.platform);
    if (!target || isUnderAny(params.path, [this.opts.configDir, this.opts.codexHome], this.platform)) throw new ServiceError(-32010);
    const runs = path.dirname(target), name = path.basename(target), root = path.dirname(runs);
    const roots = this.opts.roots().map(r => canonicalPath(r, this.platform));
    if (path.basename(runs) !== RUNS_DIR || !roots.includes(root) || !RUN_NAME.test(name) || name === "." || name === "..") throw new ServiceError(-32010);
    this.inspect(root);
    if (method === "fs/remove") {
      if (!fs.existsSync(runs)) return {};
      this.inspect(runs);
      // rm never follows links: a link Codex left in runs/ is removed itself, not its destination.
      fs.rmSync(target, { recursive: true, force: true });
      return {};
    }
    if (!fs.existsSync(runs)) fs.mkdirSync(runs);
    this.inspect(runs);
    if (!fs.existsSync(target)) fs.mkdirSync(target);
    this.inspect(target);
    if (!fs.lstatSync(target).isDirectory()) throw new ServiceError(-32010);
    return {};
  }
  private inspect(target: string): void {
    let p = target;
    for (;;) {
      const s = fs.lstatSync(p);
      if (s.isSymbolicLink() || (!s.isDirectory() && (!s.isFile() || s.nlink !== 1)) || fs.realpathSync.native(p) !== p) throw new ServiceError(-32010);
      const parent = path.dirname(p); if (parent === p) break; p = parent;
    }
  }
}
