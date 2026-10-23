// 提权模式（elevated）下命令以 Codex 建的沙箱账户运行，只读得到授给 CodexSandboxUsers 组的地方。Codex 只给用户目录的
// 第一层授读（0.155.1 setup.rs `profile_read_roots`，0.164 未变）；%LOCALAPPDATA%\Programs 这类带保护 ACL、断了继承的
// 子目录就读不到，本地 link 自己的 node.exe 与用户装在那里的 Python 都起不来（2026-10-23 所有者 Windows 实测：
// CreateProcessAsUserW 5）。所以由本地 link 照 Codex 的做法补授：只授读与执行、子项继承，先查后授。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const SANDBOX_GROUP = "CodexSandboxUsers";
// 与 Codex USERPROFILE_ROOT_EXCLUSIONS 相同：这些目录即使在 PATH 里也不授。
const PROFILE_EXCLUSIONS = [".ssh", ".tsh", ".brev", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config", ".npm", ".pki", ".terraform.d"];

const key = (p: string) => path.win32.resolve(p).toLowerCase();
const inside = (child: string, parent: string) => key(child) === key(parent) || key(child).startsWith(key(parent).replace(/\\$/, "") + "\\");

export interface SandboxReadInput {
  profile: string;
  programs: readonly string[];
  pathEnv: string;
  privateDirs: readonly string[];
  isDirectory?: (p: string) => boolean;
}

/** 要补授读的目录：本地 link 自己的程序目录与 PATH 里的目录，只取用户目录之下的（别处 Codex 已授或本来可读）。 */
export function sandboxReadTargets(input: SandboxReadInput): string[] {
  const isDirectory = input.isDirectory ?? ((p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  const seen = new Set<string>(); const out: string[] = [];
  for (const raw of [...input.programs, ...input.pathEnv.split(";")]) {
    const entry = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!entry || !path.win32.isAbsolute(entry)) continue;
    const p = path.win32.resolve(entry);
    if (!inside(p, input.profile) || key(p) === key(input.profile)) continue;
    const first = path.win32.relative(input.profile, p).split("\\")[0].toLowerCase();
    if (PROFILE_EXCLUSIONS.includes(first)) continue;
    if (input.privateDirs.some(d => inside(p, d) || inside(d, p))) continue;
    if (seen.has(key(p)) || !isDirectory(p)) continue;
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

export function grantSandboxRead(targets: readonly string[], run: Icacls = icacls): SandboxReadResult {
  const result: SandboxReadResult = { granted: [], present: [], failed: [] };
  for (const target of targets) {
    const current = run([target]);
    if (current.status === 0 && sandboxGroupCanRead(current.stdout)) { result.present.push(target); continue; }
    const grant = run([target, "/grant", `${SANDBOX_GROUP}:(OI)(CI)(RX)`]);
    (grant.status === 0 ? result.granted : result.failed).push(target);
  }
  return result;
}
