// New-project actions for the loopback API (0024): make a folder, clone a git repository.
// Writes only under the workspace roots, never the config/codex-home. Windows folders go
// through the sandboxed helper's reviewed fs/createDirectory; git runs unsandboxed because it
// needs the user's own credential manager and ssh keys, with fixed argv and no shell.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalPath, isUnderAny } from "./pathuri.js";
import { LocalError } from "./localFiles.js";
import type { Ceiling } from "./filter.js";
import type { ServiceFiles } from "./service.js";

export const CLONE_TIMEOUT_MS = 15 * 60 * 1000;
export interface CloneAuth { username?: string; token: string; remember?: boolean }
export interface LocalProjectsOptions {
  roots: () => readonly string[];
  denied: () => readonly string[];
  ceiling: () => Ceiling;
  platform?: NodeJS.Platform;
  /** Windows: a helper started writable over the workspace roots only. */
  files?: ServiceFiles;
  git?: string;
  timeoutMs?: number;
  kill?: (child: ChildProcess) => Promise<void>;
}

// https://host/path, ssh://[user@]host[:port]/path, user@host:path. No credentials in the URL, no options.
const HTTPS = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/[^\s@]*[^\s/@]$/;
const SSH = /^ssh:\/\/(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/\S*[^\s/]$/;
const SCP = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)[^\s]*[^\s/]$/;
export function cloneUrl(value: unknown): { url: string; kind: "https" | "ssh"; host: string } {
  if (typeof value !== "string" || value.length > 2048 || value.startsWith("-") || /[\x00-\x20]/.test(value)) throw new LocalError(400, "invalid_url");
  if (HTTPS.test(value)) return { url: value, kind: "https", host: new URL(value).host };
  if (SSH.test(value)) return { url: value, kind: "ssh", host: new URL(value).hostname };
  if (SCP.test(value)) return { url: value, kind: "ssh", host: value.slice(value.indexOf("@") + 1, value.indexOf(":")) };
  throw new LocalError(400, "invalid_url");
}

/** Only fixed English fragments of git's stderr are read; the text itself never leaves this function. */
export function cloneFailure(kind: "https" | "ssh", stderr: string): LocalError {
  if (/Permission denied \(publickey|Could not read from remote repository/.test(stderr) && kind === "ssh") return new LocalError(401, "ssh_auth_failed");
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION/.test(stderr)) return new LocalError(409, "host_key_unknown");
  if (/Authentication failed|could not read Username|could not read Password|terminal prompts disabled|Invalid username or password|HTTP Basic: Access denied|returned error: 40[13]/.test(stderr)) return new LocalError(401, "auth_required");
  if (/Repository not found|not found|does not appear to be a git repository|returned error: 404/i.test(stderr)) return new LocalError(404, "repo_not_found");
  return new LocalError(502, "clone_failed");
}

// Empty value resets the configured helper list; this one-shot helper reads the pair from the git child's env only.
export const ONE_SHOT_HELPER = '!f() { echo "username=$SUNMOON_GIT_USER"; echo "password=$SUNMOON_GIT_TOKEN"; }; f';
const defaultUser = (host: string) => host === "github.com" ? "x-access-token" : "oauth2";

export class LocalProjects {
  private readonly platform: NodeJS.Platform;
  constructor(private readonly opts: LocalProjectsOptions) { this.platform = opts.platform ?? process.platform; }
  async close(): Promise<void> { await this.opts.files?.close(); }
  private uri(target: string): string { return pathToFileURL(target, { windows: this.platform === "win32" }).href; }

  /** A folder project may be a whole workspace root; a clone always gets its own folder. */
  private target(value: unknown, root = false): string {
    if (typeof value !== "string" || !value || value.length > 1024) throw new LocalError(400, "invalid_params");
    const normalized = canonicalPath(value, this.platform), roots = this.opts.roots();
    if (!normalized || !isUnderAny(value, roots, this.platform) || (!root && roots.some(each => canonicalPath(each, this.platform) === normalized))
      || isUnderAny(value, this.opts.denied(), this.platform)
      || normalized.split(this.platform === "win32" ? "\\" : "/").some(bit => bit === "auth.json" || bit === ".sandbox-secrets" || bit === ".git")) throw new LocalError(403, "outside_whitelist");
    if (this.opts.ceiling().sandbox === "read-only") throw new LocalError(403, "local_read_only");
    // canonicalPath lower-cases Windows paths for comparison only; the folder keeps the name the user typed.
    return this.platform === "win32" ? path.win32.normalize(value.replaceAll("/", "\\")) : path.posix.normalize(value);
  }

  private async helper(method: string, params: object): Promise<any> {
    if (!this.opts.files) throw new LocalError(403, "outside_whitelist");
    const reply = await this.opts.files.call(method, params);
    if (reply.error) throw reply.error.code === -32004 ? new LocalError(404, "not_found") : new LocalError(403, "outside_whitelist");
    return reply.result;
  }

  /** "dir" | "file" | "other" | null (absent). */
  private async kind(target: string): Promise<string | null> {
    if (this.platform === "win32") {
      try { return (await this.helper("service/getMetadata", { path: this.uri(target) })).type; }
      catch (error) { if (error instanceof LocalError && error.code === "not_found") return null; throw error; }
    }
    try { const s = fs.lstatSync(target); return s.isSymbolicLink() ? "other" : s.isDirectory() ? "dir" : s.isFile() ? "file" : "other"; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new LocalError(403, "outside_whitelist"); }
  }

  private async empty(target: string): Promise<boolean> {
    if (this.platform === "win32") return (await this.helper("service/readDirectory", { path: this.uri(target) })).entries.length === 0;
    return fs.readdirSync(target).length === 0;
  }

  private async mkdir(target: string): Promise<void> {
    if (this.platform === "win32") { await this.helper("fs/createDirectory", { path: this.uri(target), recursive: true }); return; }
    // Each existing ancestor must be a real directory under its own name (no links, no aliases).
    const missing: string[] = []; let current = target;
    while (!fs.existsSync(current)) { missing.unshift(current); const parent = path.dirname(current); if (parent === current) break; current = parent; }
    for (let at = current; ; at = path.dirname(at)) {
      const s = fs.lstatSync(at);
      if (s.isSymbolicLink() || !s.isDirectory() || fs.realpathSync.native(at) !== at) throw new LocalError(403, "outside_whitelist");
      if (path.dirname(at) === at) break;
    }
    for (const dir of missing) fs.mkdirSync(dir);
  }

  private async remove(target: string): Promise<void> {
    if (this.platform === "win32") { await this.helper("fs/remove", { path: this.uri(target), recursive: true, force: true }).catch(() => {}); return; }
    // rm never follows a link: a link inside the folder goes, its destination stays.
    if (fs.lstatSync(target, { throwIfNoEntry: false })) fs.rmSync(target, { recursive: true, force: true });
  }

  async folder(input: unknown): Promise<{ path: string; created: boolean }> {
    const target = this.target(input, true);
    const before = await this.kind(target);
    if (before === "dir") return { path: target, created: false };
    if (before !== null) throw new LocalError(409, "not_a_directory");
    await this.mkdir(target);
    if (await this.kind(target) !== "dir") throw new LocalError(503, "local_failed");
    return { path: target, created: true };
  }

  async clone(body: { url?: unknown; path?: unknown; auth?: unknown }, signal?: AbortSignal): Promise<{ path: string; branch: string | null }> {
    const { url, kind, host } = cloneUrl(body.url);
    const auth = this.auth(body.auth, kind);
    const target = this.target(body.path);
    const before = await this.kind(target);
    if (before !== null && (before !== "dir" || !(await this.empty(target)))) throw new LocalError(409, "target_not_empty");
    const made = before === null;
    if (made) await this.mkdir(target);
    try {
      await this.git(url, kind, target, auth, signal);
    } catch (error) {
      // Only the folder this request created; an empty folder the user picked stays.
      if (made) await this.remove(target); else await this.clear(target);
      throw error;
    }
    if (auth?.remember && kind === "https") await this.remember(host, auth).catch(() => {});
    return { path: target, branch: await this.branch(target) };
  }

  private auth(value: unknown, kind: "https" | "ssh"): CloneAuth | null {
    if (value === undefined || value === null) return null;
    const ok = typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(k => ["username", "token", "remember"].includes(k));
    const v = value as CloneAuth;
    if (!ok || typeof v.token !== "string" || !v.token || v.token.length > 4096 || /[\x00-\x1f]/.test(v.token)
      || (v.username !== undefined && (typeof v.username !== "string" || v.username.length > 256 || /[\x00-\x1f]/.test(v.username)))
      || (v.remember !== undefined && typeof v.remember !== "boolean")) throw new LocalError(400, "invalid_params");
    if (kind === "ssh") throw new LocalError(400, "invalid_params");
    return v;
  }

  private async clear(target: string): Promise<void> {
    if (this.platform === "win32") {
      const entries = await this.helper("service/readDirectory", { path: this.uri(target) }).catch(() => ({ entries: [] }));
      for (const entry of entries.entries) await this.remove(path.join(target, entry.name));
      return;
    }
    for (const name of fs.readdirSync(target)) await this.remove(path.join(target, name));
  }

  private env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "", ...extra };
  }

  private run(args: string[], options: { env?: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal; timeoutMs?: number; cwd?: string } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      // Own process group off Windows, so a stop also takes git's transport helpers (Windows uses the tree kill).
      try { child = spawn(this.opts.git ?? "git", args, { env: options.env ?? this.env(), cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: this.platform !== "win32" }); }
      catch { reject(new LocalError(503, "git_missing")); return; }
      let stdout = "", stderr = "", settled = false, why: LocalError | null = null;
      const stop = (reason: LocalError) => {
        if (why) return; why = reason;
        if (this.opts.kill) { void this.opts.kill(child); return; }
        try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      };
      const timer = setTimeout(() => stop(new LocalError(504, "clone_timeout")), options.timeoutMs ?? this.opts.timeoutMs ?? CLONE_TIMEOUT_MS);
      const abort = () => stop(new LocalError(499, "cancelled"));
      if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
      const done = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort); fn(); };
      child.stdout!.setEncoding("utf8").on("data", d => { if (stdout.length < 65536) stdout += d; });
      child.stderr!.setEncoding("utf8").on("data", d => { if (stderr.length < 65536) stderr += d; });
      child.stdin!.on("error", () => {}); child.stdin!.end(options.input ?? "");
      child.once("error", error => done(() => reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new LocalError(503, "git_missing") : new LocalError(502, "clone_failed"))));
      child.once("exit", () => { if (why) done(() => reject(why)); });
      child.once("close", code => done(() => why ? reject(why) : resolve({ code, stdout, stderr })));
    });
  }

  private async git(url: string, kind: "https" | "ssh", target: string, auth: CloneAuth | null, signal?: AbortSignal): Promise<void> {
    const extra: Record<string, string> = {};
    const config = ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always"];
    if (kind === "ssh" && !process.env.GIT_SSH_COMMAND) {
      const configured = await this.run(["config", "--get", "core.sshCommand"], { timeoutMs: 10000 }).catch(() => null);
      if (!configured?.stdout.trim()) extra.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
    }
    if (auth) {
      config.push("-c", "credential.helper=", "-c", "credential.helper=" + ONE_SHOT_HELPER);
      extra.SUNMOON_GIT_USER = auth.username || defaultUser(new URL(url).host);
      extra.SUNMOON_GIT_TOKEN = auth.token;
    }
    const result = await this.run([...config, "clone", "--no-recurse-submodules", "--", url, target], { env: this.env(extra), signal });
    if (result.code !== 0) throw cloneFailure(kind, result.stderr);
  }

  private async remember(host: string, auth: CloneAuth): Promise<void> {
    const input = `protocol=https\nhost=${host}\nusername=${auth.username || defaultUser(host)}\npassword=${auth.token}\n\n`;
    await this.run(["credential", "approve"], { input, timeoutMs: 30000 });
  }

  private async branch(target: string): Promise<string | null> {
    const result = await this.run(["-C", target, "symbolic-ref", "--short", "-q", "HEAD"], { timeoutMs: 10000 }).catch(() => null);
    return result?.code === 0 ? result.stdout.trim() || null : null;
  }
}
