import { describe, it, expect } from "vitest";
import { grantSandboxRead, plainDirectory, sandboxGroupCanRead, sandboxReadTargets, type FileChecks, type Icacls } from "../src/windowsSandboxRead.js";

const profile = "C:\\Users\\zymun";
const dirs = new Set([
  "C:\\Users\\zymun\\AppData\\Local\\Programs\\sunmoon-link\\node",
  "C:\\Users\\zymun\\AppData\\Local\\Programs\\sunmoon-link\\app",
  "C:\\Users\\zymun\\AppData\\Local\\Programs\\Python\\Python313",
  "C:\\Users\\zymun\\AppData\\Local\\Programs\\Python\\Python313\\Scripts",
  "C:\\Users\\zymun\\.ssh\\bin",
  "C:\\Users\\zymun\\.sunmoon-link\\bin",
  "C:\\Users\\zymun",
  "C:\\Program Files\\Git\\cmd",
].map(d => d.toLowerCase()));
const isDirectory = (p: string) => dirs.has(p.toLowerCase());
// 模拟文件系统：links 里的是符号链接或目录联接，指向的实际目标在 real 里；没有链接的实际目标就是自己
const fake = (links: Record<string, string> = {}, extraDirs: string[] = []): FileChecks => {
  const lower = Object.fromEntries(Object.entries(links).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    isDirectory: p => isDirectory(p) || extraDirs.some(d => d.toLowerCase() === p.toLowerCase()) || Object.keys(lower).some(l => p.toLowerCase().startsWith(l)),
    isLink: p => p.toLowerCase() in lower,
    realpath: p => {
      for (const [link, target] of Object.entries(lower)) {
        if (p.toLowerCase() === link || p.toLowerCase().startsWith(link + "\\")) return target + p.slice(link.length);
      }
      return p;
    },
  };
};

describe("提权模式补授读的目录（windowsSandboxRead）", () => {
  it("取本地 link 的程序目录与用户目录下 PATH 里的目录；去重、不分大小写", () => {
    const targets = sandboxReadTargets({
      profile,
      programs: ["C:\\Users\\zymun\\AppData\\Local\\Programs\\sunmoon-link\\node", "C:\\Users\\zymun\\AppData\\Local\\Programs\\sunmoon-link\\app"],
      pathEnv: "C:\\Program Files\\Git\\cmd;\"C:\\Users\\zymun\\AppData\\Local\\Programs\\Python\\Python313\";c:\\users\\zymun\\appdata\\local\\programs\\python\\python313\\Scripts\\;;relative\\bin",
      privateDirs: ["C:\\Users\\zymun\\.sunmoon-link"],
      checks: fake(),
    });
    expect(targets).toEqual([
      "C:\\Users\\zymun\\AppData\\Local\\Programs\\sunmoon-link\\node",
      "C:\\Users\\zymun\\AppData\\Local\\Programs\\sunmoon-link\\app",
      "C:\\Users\\zymun\\AppData\\Local\\Programs\\Python\\Python313",
      "c:\\users\\zymun\\appdata\\local\\programs\\python\\python313\\Scripts",
    ]);
  });
  it("不授：用户目录之外、用户目录本身、Codex 排除的目录（.ssh 等）、本地 link 的私有目录、不存在的目录", () => {
    const targets = sandboxReadTargets({
      profile,
      programs: [],
      pathEnv: ["C:\\Program Files\\Git\\cmd", "C:\\Users\\zymun", "C:\\Users\\zymun\\.ssh\\bin", "C:\\Users\\zymun\\.sunmoon-link\\bin", "C:\\Users\\zymun\\missing", "C:\\Users\\zymunX\\tools"].join(";"),
      privateDirs: ["C:\\Users\\zymun\\.sunmoon-link"],
      checks: fake(),
    });
    expect(targets).toEqual([]);
  });
  it("私有目录在某个 PATH 目录之下时，那个 PATH 目录也不授（继承会带到私有目录）", () => {
    const targets = sandboxReadTargets({ profile, programs: [], pathEnv: "C:\\Users\\zymun\\AppData\\Local\\Programs", privateDirs: ["C:\\Users\\zymun\\AppData\\Local\\Programs\\sunmoon-link\\app"], checks: fake({}, ["C:\\Users\\zymun\\AppData\\Local\\Programs"]) });
    expect(targets).toEqual([]);
  });
});

describe("只授实打实的目录（Astra 评审 D01）", () => {
  const bin = "C:\\Users\\zymun\\bin";
  const tools = "C:\\Users\\zymun\\tools\\bin";
  it("目标本身是联接（指向 .ssh、用户目录外）不授", () => {
    for (const target of ["C:\\Users\\zymun\\.ssh", "D:\\secrets"]) {
      const checks = fake({ [bin]: target });
      expect(sandboxReadTargets({ profile, programs: [], pathEnv: bin, privateDirs: [], checks })).toEqual([]);
    }
  });
  it("祖先是联接也不授，哪怕最后一级是普通目录", () => {
    const checks = fake({ "C:\\Users\\zymun\\tools": "C:\\Users\\zymun\\.sunmoon-link" });
    expect(sandboxReadTargets({ profile, programs: [], pathEnv: tools, privateDirs: [], checks })).toEqual([]);
  });
  it("实际目标与路径对不上（8.3 短名、别名）不授；对得上（只差大小写）照授", () => {
    const short: FileChecks = { ...fake({}, [bin]), realpath: () => "C:\\Users\\zymun\\other" };
    expect(plainDirectory(bin, profile, short)).toBe(false);
    const cased: FileChecks = { ...fake({}, [bin]), realpath: () => "C:\\USERS\\ZYMUN\\BIN" };
    expect(plainDirectory(bin, profile, cased)).toBe(true);
    const gone: FileChecks = { ...fake({}, [bin]), realpath: () => null };
    expect(plainDirectory(bin, profile, gone)).toBe(false);
  });
  it("授之前再核一遍：核过之后被换成联接的不授，记进 failed；查与授都带 /L", () => {
    const calls: string[][] = [];
    const run: Icacls = args => { calls.push(args); return { status: 0, stdout: "" }; };
    expect(grantSandboxRead(["A", "B"], run, t => t === "A")).toEqual({ granted: ["A"], present: [], failed: ["B"] });
    expect(calls).toEqual([["A", "/L"], ["A", "/grant", "CodexSandboxUsers:(OI)(CI)(RX)", "/L"], ["B", "/L"]]);
  });
});

describe("沙箱组读权限的判断与授予", () => {
  it("认继承到子项的 RX / M / F，含继承来的（I）；只对文件的、只读一层的不算", () => {
    expect(sandboxGroupCanRead("C:\\x zymun\\CodexSandboxUsers:(OI)(CI)(RX)\r\n")).toBe(true);
    expect(sandboxGroupCanRead("C:\\x zymun\\CodexSandboxUsers:(I)(OI)(CI)(M)\n")).toBe(true);
    expect(sandboxGroupCanRead("C:\\x zymun\\CodexSandboxUsers:(RX)\n")).toBe(false);
    expect(sandboxGroupCanRead("C:\\x zymun\\CodexSandboxUsers:(OI)(CI)(W)\n")).toBe(false);
    expect(sandboxGroupCanRead("C:\\x NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\n")).toBe(false);
  });
  it("先查后授：已有的不再改，没有的授 (OI)(CI)(RX)，授失败的记下来", () => {
    const calls: string[][] = [];
    const run: Icacls = args => {
      calls.push(args);
      if (args.length === 2) return { status: 0, stdout: args[0] === "A" ? "A zymun\\CodexSandboxUsers:(OI)(CI)(RX)" : `${args[0]} NT AUTHORITY\\SYSTEM:(OI)(CI)(F)` };
      return { status: args[0] === "C" ? 5 : 0, stdout: "" };
    };
    expect(grantSandboxRead(["A", "B", "C"], run)).toEqual({ granted: ["B"], present: ["A"], failed: ["C"] });
    expect(calls).toEqual([["A", "/L"], ["B", "/L"], ["B", "/grant", "CodexSandboxUsers:(OI)(CI)(RX)", "/L"], ["C", "/L"], ["C", "/grant", "CodexSandboxUsers:(OI)(CI)(RX)", "/L"]]);
  });
});
