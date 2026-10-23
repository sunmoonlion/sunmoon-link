import { describe, it, expect } from "vitest";
import { grantSandboxRead, sandboxGroupCanRead, sandboxReadTargets, type Icacls } from "../src/windowsSandboxRead.js";

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

describe("提权模式补授读的目录（windowsSandboxRead）", () => {
  it("取本地 link 的程序目录与用户目录下 PATH 里的目录；去重、不分大小写", () => {
    const targets = sandboxReadTargets({
      profile,
      programs: ["C:\\Users\\zymun\\AppData\\Local\\Programs\\sunmoon-link\\node", "C:\\Users\\zymun\\AppData\\Local\\Programs\\sunmoon-link\\app"],
      pathEnv: "C:\\Program Files\\Git\\cmd;\"C:\\Users\\zymun\\AppData\\Local\\Programs\\Python\\Python313\";c:\\users\\zymun\\appdata\\local\\programs\\python\\python313\\Scripts\\;;relative\\bin",
      privateDirs: ["C:\\Users\\zymun\\.sunmoon-link"],
      isDirectory,
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
      isDirectory,
    });
    expect(targets).toEqual([]);
  });
  it("私有目录在某个 PATH 目录之下时，那个 PATH 目录也不授（继承会带到私有目录）", () => {
    const targets = sandboxReadTargets({ profile, programs: [], pathEnv: "C:\\Users\\zymun\\AppData\\Local\\Programs", privateDirs: ["C:\\Users\\zymun\\AppData\\Local\\Programs\\sunmoon-link\\app"], isDirectory: () => true });
    expect(targets).toEqual([]);
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
      if (args.length === 1) return { status: 0, stdout: args[0] === "A" ? "A zymun\\CodexSandboxUsers:(OI)(CI)(RX)" : `${args[0]} NT AUTHORITY\\SYSTEM:(OI)(CI)(F)` };
      return { status: args[0] === "C" ? 5 : 0, stdout: "" };
    };
    expect(grantSandboxRead(["A", "B", "C"], run)).toEqual({ granted: ["B"], present: ["A"], failed: ["C"] });
    expect(calls).toEqual([["A"], ["B"], ["B", "/grant", "CodexSandboxUsers:(OI)(CI)(RX)"], ["C"], ["C", "/grant", "CodexSandboxUsers:(OI)(CI)(RX)"]]);
  });
});
