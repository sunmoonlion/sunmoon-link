import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Ceiling } from "../src/filter.js";
import { LocalProjects, ONE_SHOT_HELPER, cloneFailure, cloneUrl } from "../src/localProjects.js";

let base: string, root: string, guarded: string, fake: string, ceiling: Ceiling;
const FAKE = `#!/bin/sh
dir="$FAKE_GIT_DIR"
printf 'ARGS %s\\n' "$*" >> "$dir/log"
printf 'ENV prompt=%s gcm=%s user=%s token=%s ssh=%s\\n' "$GIT_TERMINAL_PROMPT" "$GCM_INTERACTIVE" "$SUNMOON_GIT_USER" "$SUNMOON_GIT_TOKEN" "$GIT_SSH_COMMAND" >> "$dir/log"
case "$*" in
  *"credential approve"*) cat >> "$dir/approved"; exit 0;;
  *"symbolic-ref"*) echo main; exit 0;;
  *"config --get core.sshCommand"*) exit 1;;
esac
case "$(cat "$dir/mode")" in
  ok) for last; do :; done; mkdir -p "$last/.git"; echo hi > "$last/README.md"; exit 0;;
  auth) echo "fatal: could not read Username for 'https://example.com': terminal prompts disabled" >&2; exit 128;;
  ssh) echo "git@example.com: Permission denied (publickey)." >&2; echo "fatal: Could not read from remote repository." >&2; exit 128;;
  notfound) echo "remote: Repository not found." >&2; exit 128;;
  partial) for last; do :; done; echo x > "$last/half"; echo "fatal: early EOF" >&2; exit 128;;
  slow) sleep 30;;
esac
`;
const mode = (value: string) => fs.writeFileSync(path.join(fake, "mode"), value);
const log = () => fs.readFileSync(path.join(fake, "log"), "utf8");
const projects = (extra: Partial<ConstructorParameters<typeof LocalProjects>[0]> = {}) =>
  new LocalProjects({ roots: () => [root], denied: () => [guarded], ceiling: () => ceiling, platform: "linux", git: path.join(fake, "git"), ...extra });
// Linux 路径与 #!/bin/sh 假 git 的夹具：Windows 上的同样场景由 test/local-project-windows-probe.mjs 真机覆盖（0024 段 2）
const onWindows = process.platform === "win32";
const code = (promise: Promise<unknown>) => promise.then(() => "ok", (error: { code?: string }) => error.code);

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sunmoon-projects-")));
  root = path.join(base, "root"); guarded = path.join(root, "guarded"); fake = path.join(base, "fake");
  fs.mkdirSync(guarded, { recursive: true }); fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, "git"), FAKE, { mode: 0o755 }); mode("ok");
  process.env.FAKE_GIT_DIR = fake; ceiling = { sandbox: "workspace-write", network: false };
});
afterEach(() => { delete process.env.FAKE_GIT_DIR; fs.rmSync(base, { recursive: true, force: true }); });

describe.skipIf(onWindows)("new project folder", () => {
  it("creates nested folders under a workspace root, then reports an existing one as not created", async () => {
    const target = path.join(root, "a", "财务预测");
    expect(await projects().folder(target)).toEqual({ path: target, created: true });
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(await projects().folder(target)).toEqual({ path: target, created: false });
    expect(await projects().folder(root)).toEqual({ path: root, created: false });
  });
  it("refuses outside the roots, a denied directory, a file in the way, a linked ancestor and a read-only ceiling", async () => {
    expect(await code(projects().folder(path.join(base, "elsewhere")))).toBe("outside_whitelist");
    expect(await code(projects().folder(path.join(guarded, "x")))).toBe("outside_whitelist");
    expect(await code(projects().folder(path.join(root, "a", ".git", "x")))).toBe("outside_whitelist");
    fs.writeFileSync(path.join(root, "file"), "x");
    expect(await code(projects().folder(path.join(root, "file")))).toBe("not_a_directory");
    fs.symlinkSync(base, path.join(root, "link"));
    expect(await code(projects().folder(path.join(root, "link", "x")))).toBe("outside_whitelist");
    expect(fs.existsSync(path.join(base, "x"))).toBe(false);
    ceiling = { sandbox: "read-only", network: true };
    expect(await code(projects().folder(path.join(root, "b")))).toBe("local_read_only");
    expect(fs.existsSync(path.join(root, "b"))).toBe(false);
  });
});

describe("new project folder on Windows", () => {
  it("goes through the sandboxed helper's createDirectory and keeps the name as typed", async () => {
    const calls: [string, any][] = []; let made = false;
    const files = { close: async () => {}, call: async (method: string, params: any) => {
      calls.push([method, params]);
      if (method === "service/getMetadata") return made ? { result: { type: "dir" } } : { error: { code: -32004 } };
      if (method === "fs/createDirectory") { made = true; return { result: {} }; }
      return { error: { code: -32000 } };
    } };
    const win = new LocalProjects({ roots: () => ["C:\\Users\\U\\Desktop"], denied: () => [], ceiling: () => ceiling, platform: "win32", files });
    expect(await win.folder("C:/Users/U/Desktop/MyProject")).toEqual({ path: "C:\\Users\\U\\Desktop\\MyProject", created: true });
    expect(calls.map(([method]) => method)).toEqual(["service/getMetadata", "fs/createDirectory", "service/getMetadata"]);
    expect(calls[1][1]).toEqual({ path: "file:///C:/Users/U/Desktop/MyProject", recursive: true });
    expect(await code(win.folder("C:\\Users\\U\\Documents\\x"))).toBe("outside_whitelist");
  });
});

describe("clone url", () => {
  it("takes https, ssh:// and user@host:path, nothing that can run a local command or carries a password", () => {
    expect(cloneUrl("https://github.com/o/r.git")).toEqual({ url: "https://github.com/o/r.git", kind: "https", host: "github.com" });
    expect(cloneUrl("ssh://git@example.com:2222/o/r.git").kind).toBe("ssh");
    expect(cloneUrl("git@github.com:o/r.git")).toEqual({ url: "git@github.com:o/r.git", kind: "ssh", host: "github.com" });
    for (const bad of ["file:///etc", "ext::sh -c id", "http://example.com/r", "https://u:p@example.com/r", "https://u@example.com/r", "-uhttps://x/r", "https://example.com/", "/home/u/repo", "C:\\repo", "https://example.com/r b"]) {
      expect(() => cloneUrl(bad), bad).toThrow("invalid_url");
    }
  });
  it("sorts failures by fixed fragments only", () => {
    expect(cloneFailure("https", "fatal: Authentication failed for 'https://x/'").code).toBe("auth_required");
    expect(cloneFailure("ssh", "Permission denied (publickey).").code).toBe("ssh_auth_failed");
    expect(cloneFailure("ssh", "Host key verification failed.").code).toBe("host_key_unknown");
    expect(cloneFailure("https", "remote: Repository not found.").code).toBe("repo_not_found");
    expect(cloneFailure("https", "fatal: early EOF").code).toBe("clone_failed");
  });
});

describe.skipIf(onWindows)("clone", () => {
  const url = "https://example.com/team/repo.git";
  it("runs git with fixed argv, no prompts, only https/ssh transports and no submodules", async () => {
    const target = path.join(root, "repo");
    expect(await projects().clone({ url, path: target })).toEqual({ path: target, branch: "main" });
    expect(fs.readFileSync(path.join(target, "README.md"), "utf8")).toBe("hi\n");
    const first = log().split("\n")[0];
    expect(first).toBe(`ARGS -c protocol.allow=never -c protocol.https.allow=always -c protocol.ssh.allow=always clone --no-recurse-submodules -- ${url} ${target}`);
    expect(log()).toContain("ENV prompt=0 gcm=never user= token=");
  });
  it("hands a typed token to git through its env only, and remembers it only when asked", async () => {
    await projects().clone({ url, path: path.join(root, "a"), auth: { token: "tok-123" } });
    expect(log().split("\n").filter(line => line.startsWith("ARGS")).join("\n")).not.toContain("tok-123");
    expect(log()).toContain("-c credential.helper= -c credential.helper=!f()");
    expect(log()).toContain("user=oauth2 token=tok-123");
    expect(fs.existsSync(path.join(fake, "approved"))).toBe(false);
    await projects().clone({ url: "https://github.com/o/r.git", path: path.join(root, "b"), auth: { token: "tok-456", remember: true } });
    expect(log()).toContain("user=x-access-token token=tok-456");
    expect(fs.readFileSync(path.join(fake, "approved"), "utf8")).toBe("protocol=https\nhost=github.com\nusername=x-access-token\npassword=tok-456\n\n");
  });
  it("asks for a token when git cannot log in, and removes the folder it made", async () => {
    mode("auth"); const target = path.join(root, "private");
    expect(await code(projects().clone({ url, path: target }))).toBe("auth_required");
    expect(fs.existsSync(target)).toBe(false);
  });
  it("keeps an empty folder the user picked, but empties what a failed clone left in it", async () => {
    mode("partial"); const target = path.join(root, "picked"); fs.mkdirSync(target);
    expect(await code(projects().clone({ url, path: target }))).toBe("clone_failed");
    expect(fs.readdirSync(target)).toEqual([]);
  });
  it("refuses a non-empty target and a token for an ssh address; ssh login failure says so", async () => {
    const target = path.join(root, "busy"); fs.mkdirSync(target); fs.writeFileSync(path.join(target, "x"), "1");
    expect(await code(projects().clone({ url, path: target }))).toBe("target_not_empty");
    expect(fs.readdirSync(target)).toEqual(["x"]);
    expect(await code(projects().clone({ url: "git@example.com:o/r.git", path: path.join(root, "s"), auth: { token: "t" } }))).toBe("invalid_params");
    mode("ssh");
    expect(await code(projects().clone({ url: "git@example.com:o/r.git", path: path.join(root, "s") }))).toBe("ssh_auth_failed");
    expect(log()).toContain("ssh=ssh -o BatchMode=yes");
    expect(await code(projects().clone({ url, path: root }))).toBe("outside_whitelist");
  });
  it("stops git on timeout or cancel and removes the folder", async () => {
    mode("slow"); const target = path.join(root, "slow");
    expect(await code(projects({ timeoutMs: 300 }).clone({ url, path: target }))).toBe("clone_timeout");
    expect(fs.existsSync(target)).toBe(false);
    const controller = new AbortController(); setTimeout(() => controller.abort(), 200);
    expect(await code(projects().clone({ url, path: target }, controller.signal))).toBe("cancelled");
    expect(fs.existsSync(target)).toBe(false);
  });
  it("says git is missing", async () => {
    expect(await code(projects({ git: path.join(fake, "no-such-git") }).clone({ url, path: path.join(root, "m") }))).toBe("git_missing");
    expect(fs.existsSync(path.join(root, "m"))).toBe(false);
  });
});

describe("one-shot credential helper with real git", () => {
  const git = spawnSync("git", ["--version"]).status === 0;
  it.skipIf(!git)("answers exactly the typed pair and ignores helpers configured before it", () => {
    const run = spawnSync("git", ["-c", "credential.helper=store --file=/nonexistent", "-c", "credential.helper=", "-c", "credential.helper=" + ONE_SHOT_HELPER, "credential", "fill"], {
      input: "protocol=https\nhost=example.com\n\n", encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", SUNMOON_GIT_USER: "me", SUNMOON_GIT_TOKEN: "t0k" },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("protocol=https\nhost=example.com\nusername=me\npassword=t0k\n");
  });
});
