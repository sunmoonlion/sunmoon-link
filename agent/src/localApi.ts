import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AgentConfig } from "./config.js";
import { TicketVerifier, TicketError } from "./ticket.js";
import { LocalFiles, LocalError, LOCAL_MAX_READ } from "./localFiles.js";
import type { LocalSettings } from "./localSettings.js";
import type { LocalProjects } from "./localProjects.js";

export interface LocalApiOptions {
  webOrigin: string;
  version: string;
  machineName: string;
  connected: () => boolean;
  /** 设备编号、主机名、系统（账 143）：网页拿它和「配给当前账号的那份本地 link」的编号比 */
  identity?: () => { deviceId: string; host: string; os: string };
  /** 连接状态（relayClient.linkState）：网页分清令牌失效和连不上 */
  linkState?: () => string;
  /** Windows 上 Codex 命令隔离的模式；普通模式（unelevated）拦写不拦删，网页据此提醒提高（0041 第四节）。 */
  windowsSandbox?: () => "elevated" | "unelevated" | undefined;
  config?: () => AgentConfig;
  files?: LocalFiles;
  ticket?: TicketVerifier;
  settings?: LocalSettings;
  projects?: LocalProjects;
  onEvent?: (event: "listening" | "rate_limited" | "unavailable", details: { count?: number; port?: number; code?: string }) => void;
  onRequest?: (category: "info" | "dir" | "meta" | "file" | "settings" | "project" | "other", code?: string) => void;
  /** Test seam. The shipped CLI tries the five fixed ports in order. */
  ports?: readonly number[];
}
export interface LocalApiHandle { port: number; close: () => Promise<void> }
function exactWebOrigin(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && url.origin === value && !url.username && !url.password; }
  catch { return false; }
}
export const LOCAL_PORTS = [47811, 47812, 47813, 47814, 47815] as const;
const routes = ["/local/v1/info", "/local/v1/fs/dir", "/local/v1/fs/meta", "/local/v1/fs/file", "/local/v1/settings", "/local/v1/projects/folder", "/local/v1/projects/clone"];
const headers = (origin: string) => ({ "Access-Control-Allow-Origin": origin, Vary: "Origin", "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });

function readSettingsBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const cleanup = () => { req.off("data", data); req.off("end", end); req.off("error", fail); req.off("aborted", fail); };
    const fail = () => { cleanup(); req.resume(); reject(new LocalError(400, "invalid")); };
    const data = (chunk: Buffer) => { size += chunk.length; if (size > 65536) fail(); else chunks.push(chunk); };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new LocalError(400, "invalid")); }
    };
    req.on("data", data); req.once("end", end); req.once("error", fail); req.once("aborted", fail);
  });
}

function createHandler(options: LocalApiOptions) {
  let second = -1, count = 0, rateLogWritten = false;
  const pending = new Set<AbortController>();
  const tickets = options.ticket ?? (options.config ? new TicketVerifier({ webOrigin: options.webOrigin, userId: () => options.config!().userId }) : undefined);
  const respond = (res: ServerResponse, status: number, responseHeaders: Record<string, string>, body: string | Buffer = "") => { res.writeHead(status, responseHeaders); res.end(body); };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    res.once("finish", () => req.resume()); // Drain ignored bodies only after routing/auth.
    const origin = req.headers.origin;
    if (typeof origin !== "string" || origin !== options.webOrigin) {
      respond(res, 403, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" }, JSON.stringify({ code: "origin_rejected", message: "origin_rejected" })); return;
    }
    const responseHeaders = headers(origin);
    const error = (status: number, code: string) => respond(res, status, responseHeaders, JSON.stringify({ code, message: code }));
    const now = Math.floor(Date.now() / 1000);
    if (now !== second) { second = now; count = 0; rateLogWritten = false; }
    if (++count > 20) {
      if (!rateLogWritten) { options.onEvent?.("rate_limited", { count }); rateLogWritten = true; }
      error(429, "rate_limited"); return;
    }
    let url: URL;
    try { url = new URL(req.url ?? "", "http://127.0.0.1"); } catch { error(400, "invalid_params"); return; }
    const presence = req.url === "/presence";
    const isLocal = url.pathname.startsWith("/local/v1/") && !!options.config;
    const category = url.pathname.startsWith("/local/v1/projects/") ? "project" : url.pathname === "/local/v1/settings" ? "settings" : url.pathname === "/local/v1/info" ? "info" : url.pathname.endsWith("/dir") ? "dir" : url.pathname.endsWith("/meta") ? "meta" : url.pathname.endsWith("/file") ? "file" : "other";
    if (!presence && !isLocal) { error(404, "not_found"); return; }
    if (req.method === "OPTIONS") {
      if (!presence && !routes.includes(url.pathname)) { error(404, "not_found"); return; }
      if (req.headers["access-control-request-method"] && !["GET", "POST", "PUT"].includes(String(req.headers["access-control-request-method"]))) { error(405, "method_not_allowed"); return; }
      respond(res, 204, { ...responseHeaders, "Access-Control-Allow-Methods": "GET, POST, PUT", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Private-Network": "true" }); return;
    }
    if (presence) {
      if (req.method !== "GET") { respond(res, 405, { ...responseHeaders, Allow: "GET, OPTIONS" }, JSON.stringify({ code: "method_not_allowed", message: "method_not_allowed" })); return; }
      const id = options.identity?.();
      respond(res, 200, responseHeaders, JSON.stringify({ agent: "sunmoon-agent", version: options.version, machine_name: options.machineName, connected: options.connected(),
        ...(id ? { device_id: id.deviceId, host: id.host, os: id.os } : {}), ...(options.linkState ? { link_state: options.linkState() } : {}), ...(options.windowsSandbox?.() ? { windows_sandbox: options.windowsSandbox() } : {}) })); return;
    }
    const controller = new AbortController(); pending.add(controller);
    const abort = () => controller.abort();
    const disconnected = () => { if (!res.writableFinished) abort(); };
    req.once("aborted", abort); res.once("close", disconnected);
    try {
      await tickets!.check(req.headers.authorization);
      if (res.destroyed) return;
      if (!routes.includes(url.pathname)) throw new LocalError(404, "not_found");
      if (category === "settings") {
        if (url.search) throw new LocalError(400, "invalid");
        if (!options.settings) throw new LocalError(503, "settings_unavailable");
        if (req.method === "GET") respond(res, 200, responseHeaders, JSON.stringify(await options.settings.read(options.version)));
        else if (req.method === "PUT") {
          if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "")) throw new LocalError(400, "invalid");
          const input = await readSettingsBody(req);
          const result = await options.settings.write(input, controller.signal);
          // finish means the acknowledgement has been handed to the socket.
          const restart = () => { setImmediate(() => { void options.settings!.restart().catch(() => options.onRequest?.("settings", "restart_failed")); }); };
          res.once("finish", restart);
          res.once("close", () => { if (!res.writableFinished) restart(); });
          respond(res, 200, responseHeaders, JSON.stringify(result));
        } else throw new LocalError(405, "method_not_allowed");
      } else if (category === "project") {
        if (req.method !== "POST") throw new LocalError(405, "method_not_allowed");
        if (url.search || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "")) throw new LocalError(400, "invalid");
        if (!options.projects) throw new LocalError(503, "projects_unavailable");
        const input = await readSettingsBody(req);
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new LocalError(400, "invalid_params");
        const body = input as Record<string, unknown>, folder = url.pathname.endsWith("/folder");
        if (Object.keys(body).some(k => !(folder ? ["path"] : ["url", "path", "auth"]).includes(k))) throw new LocalError(400, "invalid_params");
        const result = folder ? await options.projects.folder(body.path) : await options.projects.clone(body, controller.signal);
        if (!res.destroyed) respond(res, 200, responseHeaders, JSON.stringify(result));
      } else if (req.method !== "GET") throw new LocalError(405, "method_not_allowed");
      else if (category === "info") {
        if (url.search) throw new LocalError(400, "invalid_params");
        const cfg = options.config!();
        respond(res, 200, responseHeaders, JSON.stringify({ agent: "sunmoon-agent", version: options.version, userId: cfg.userId, roots: cfg.roots, libraryDir: cfg.libraryDir ?? null, lastSettingsChange: cfg.lastSettingsChange ?? null, capabilities: ["local-fs-v1", ...(options.projects ? ["local-project-v1"] : [])] }));
      } else {
        const keys = [...url.searchParams.keys()];
        if (keys.some(key => !(category === "file" ? ["path", "offset", "length"] : ["path"]).includes(key)) || new Set(keys).size !== keys.length || !url.searchParams.get("path")) throw new LocalError(400, "invalid_params");
        const target = url.searchParams.get("path")!;
        const number = (key: string, fallback: number) => { const raw = url.searchParams.get(key); if (raw === null) return fallback; if (!/^[0-9]+$/.test(raw)) throw new LocalError(400, "invalid_params"); return Number(raw); };
        if (!options.files) throw new LocalError(503, "files_unavailable");
        const result = await options.files.read(category as "dir" | "meta" | "file", target, number("offset", 0), number("length", LOCAL_MAX_READ));
        if (category === "file") respond(res, 200, { ...responseHeaders, "Content-Type": "application/octet-stream", "Access-Control-Expose-Headers": "X-File-Size, X-File-Mtime, X-File-Eof", "X-File-Size": String(result.size), "X-File-Mtime": String(result.mtime), "X-File-Eof": String(result.eof) }, result.content);
        else respond(res, 200, responseHeaders, JSON.stringify(result));
      }
      options.onRequest?.(category);
    } catch (cause) {
      const known = cause instanceof LocalError || cause instanceof TicketError;
      const code = known ? cause.code : "local_failed", status = known ? cause.status : 503;
      options.onRequest?.(category, code);
      if (!res.headersSent && !res.destroyed) error(status, code);
    } finally { pending.delete(controller); req.off("aborted", abort); res.off("close", disconnected); }
  };
  return { handle, abort: () => { for (const controller of pending) controller.abort(); } };
}
async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError); server.once("listening", onListening); server.listen(port, "127.0.0.1");
  });
}
export async function startLocalApi(options: LocalApiOptions): Promise<LocalApiHandle | null> {
  if (!exactWebOrigin(options.webOrigin)) { options.onEvent?.("unavailable", { code: "invalid_web_origin" }); return null; }
  const handler = createHandler(options); let lastCode = "listen_failed";
  for (const port of options.ports ?? LOCAL_PORTS) {
    const server = http.createServer((req, res) => { void handler.handle(req, res).catch(() => { if (res.destroyed || res.writableEnded) return; if (!res.headersSent) res.writeHead(503); res.end(); }); });
    server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
    try {
      await listen(server, port);
      const address = server.address(), actualPort = address && typeof address !== "string" ? address.port : port;
      options.onEvent?.("listening", { port: actualPort });
      return { port: actualPort, close: async () => { handler.abort(); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }); await options.files?.close(); await options.projects?.close(); } };
    } catch (cause) {
      lastCode = (cause as NodeJS.ErrnoException).code ?? "listen_failed";
      if (lastCode !== "EADDRINUSE") { options.onEvent?.("unavailable", { port, code: lastCode }); return null; }
    }
  }
  options.onEvent?.("unavailable", { code: lastCode }); return null;
}
