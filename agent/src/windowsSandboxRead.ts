// 提权模式（elevated）下命令以 Codex 建的沙箱账户运行，只读得到授给 CodexSandboxUsers 组的地方。Codex 只给用户目录的
// 第一层授读（0.155.1 setup.rs `profile_read_roots`，0.164 未变）；%LOCALAPPDATA%\Programs 这类带保护 ACL、断了继承的
// 子目录就读不到，本地 link 自己的 node.exe 与用户装在那里的 Python 都起不来（2026-10-23 所有者 Windows 实测：
// CreateProcessAsUserW 5）。所以由本地 link 照 Codex 的做法补授：只授读与执行、子项继承，先查后授。
// 只认实打实的目录（Astra 评审 D01）：从用户目录到目标逐级 lstat，有一级是符号链接或目录联接（junction）就不授；
// 再用 realpath 核实际目标就是这个路径本身（大小写、8.3 短名、别名对不上的也不授）。icacls 带 /L，万一核过之后
// 被换成联接，改的也只是联接自己、不跟到目标；授之前再核一遍，把这段空档压到最短。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const SANDBOX_GROUP = "CodexSandboxUsers";
// 与 Codex USERPROFILE_ROOT_EXCLUSIONS 相同：这些目录即使在 PATH 里也不授。
const PROFILE_EXCLUSIONS = [".ssh", ".tsh", ".brev", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config", ".npm", ".pki", ".terraform.d"];

const key = (p: string) => path.win32.resolve(p).toLowerCase();
const inside = (child: string, parent: string) => key(child) === key(parent) || key(child).startsWith(key(parent).replace(/\\$/, "") + "\\");

export interface FileChecks {
  isDirectory: (p: string) => boolean;
  /** 这一级本身是符号链接或目录联接（lstat，不跟随）。 */
  isLink: (p: string) => boolean;
  /** 实际目标（跟随所有链接）；取不到回 null。 */
  realpath: (p: string) => string | null;
}

export const fileChecks: FileChecks = {
  isDirectory: p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
  isLink: p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return true; } },
  realpath: p => { try { return fs.realpathSync.native(p); } catch { return null; } },
};

/** 从 profile 到 p（都含）每一级都不是链接，且 p 的实际目标就是 p 本身。 */
export function plainDirectory(p: string, profile: string, checks: FileChecks = fileChecks): boolean {
  const steps = path.win32.relative(profile, p).split("\\").filter(Boolean);
  let at = path.win32.resolve(profile);
  for (const step of ["", ...steps]) {
    at = step ? path.win32.join(at, step) : at;
    if (checks.isLink(at)) return false;
  }
  const real = checks.realpath(p);
  return real !== null && key(real) === key(p) && checks.isDirectory(p);
}

export interface SandboxReadInput {
  profile: string;
  programs: readonly string[];
  pathEnv: string;
  privateDirs: readonly string[];
  checks?: FileChecks;
}

/** 要补授读的目录：本地 link 自己的程序目录与 PATH 里的目录，只取用户目录之下的（别处 Codex 已授或本来可读）。 */
export function sandboxReadTargets(input: SandboxReadInput): string[] {
  const checks = input.checks ?? fileChecks;
  const seen = new Set<string>(); const out: string[] = [];
  for (const raw of [...input.programs, ...input.pathEnv.split(";")]) {
    const entry = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!entry || !path.win32.isAbsolute(entry)) continue;
    const p = path.win32.resolve(entry);
    if (!inside(p, input.profile) || key(p) === key(input.profile)) continue;
    const first = path.win32.relative(input.profile, p).split("\\")[0].toLowerCase();
    if (PROFILE_EXCLUSIONS.includes(first)) continue;
    if (input.privateDirs.some(d => inside(p, d) || inside(d, p))) continue;
    if (seen.has(key(p)) || !plainDirectory(p, input.profile, checks)) continue;
    seen.add(key(p)); out.push(p);
  }
  return out;
}

/** icacls 列出的 ACL 里，沙箱组已有继承到子项的读（或更大）权限。 */
export function sandboxGroupCanRead(icaclsOutput: string): boolean {
  return icaclsOutput.split(/\r?\n/).some(line => {
    const at = line.indexOf(`${SANDBOX_GROUP}:`);
    if (at < 0) return false;
    const rights = line.slice(at + SANDBOX_GROUP.length + 1);
    return rights.includes("(OI)") && rights.includes("(CI)") && /\((RX|M|F)\)/.test(rights);
  });
}

export type Icacls = (args: string[]) => { status: number | null; stdout: string };
const icacls: Icacls = args => {
  const r = spawnSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), args, { encoding: "utf8", windowsHide: true, timeout: 120000 });
  return { status: r.status, stdout: r.stdout ?? "" };
};

export interface SandboxReadResult { granted: string[]; present: string[]; failed: string[] }

/** still：授之前再核一遍这个目录还是实打实的（见文件头）；变了的记进 failed。 */
export function grantSandboxRead(targets: readonly string[], run: Icacls = icacls, still: (target: string) => boolean = () => true): SandboxReadResult {
  const result: SandboxReadResult = { granted: [], present: [], failed: [] };
  for (const target of targets) {
    const current = run([target, "/L"]);
    if (current.status === 0 && sandboxGroupCanRead(current.stdout)) { result.present.push(target); continue; }
    if (!still(target)) { result.failed.push(target); continue; }
    const grant = run([target, "/grant", `${SANDBOX_GROUP}:(OI)(CI)(RX)`, "/L"]);
    (grant.status === 0 ? result.granted : result.failed).push(target);
  }
  return result;
}

/** icacls 列出的 ACL 里，沙箱组已被显式拒绝读。 */
export function sandboxGroupDenied(icaclsOutput: string): boolean {
  return icaclsOutput.split(/\r?\n/).some(line => {
    const at = line.indexOf(`${SANDBOX_GROUP}:`);
    return at >= 0 && line.slice(at).includes("(DENY)") && /\((R|RX|F|M)\)/.test(line.slice(at));
  });
}

export interface SandboxDenyResult { denied: string[]; present: string[]; failed: string[] }

/**
 * 控制文件对沙箱组显式拒绝读（Fable 评审 P2-12）：Codex 给用户目录第一层逐项授读，带到 .sunmoon-link（会合点令牌
 * 在 config.json）与 .codex（auth.json）。显式拒绝压过继承来的允许；只拒读这几个文件，目录照旧（沙箱可能要读
 * 目录里别的东西）。不在的文件跳过；查与改都带 /L，不跟链接。
 */
export function denySandboxRead(files: readonly string[], run: Icacls = icacls, exists: (p: string) => boolean = p => { try { return fs.lstatSync(p).isFile(); } catch { return false; } }): SandboxDenyResult {
  const result: SandboxDenyResult = { denied: [], present: [], failed: [] };
  for (const file of files) {
    if (!exists(file)) continue;
    const current = run([file, "/L"]);
    if (current.status === 0 && sandboxGroupDenied(current.stdout)) { result.present.push(file); continue; }
    const deny = run([file, "/deny", `${SANDBOX_GROUP}:(R)`, "/L"]);
    (deny.status === 0 ? result.denied : result.failed).push(file);
  }
  return result;
}
