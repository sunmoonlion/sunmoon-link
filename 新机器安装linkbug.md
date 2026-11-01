# 新机器安装 Link：两个 Windows Bug，交 Opus 修复

日期：2026-10-30。本文记录用户实机结果及本地源码排查，供 Opus 接手修复。

本轮只做诊断及本文档整理，没有修改产品代码、安装文件或用户配置。文中的修复方向是建议，不代表已经实施或验收。

## 环境与结论

- 故障电脑：`DESKTOP-24MMCKL`，用户目录 `C:\Users\zouyaming`，Windows PowerShell，提示符有 Conda `(base)`。
- 用户此前在另一台电脑登录成功。页面同时列出 `zymun（本地 link 没连着）`，但本次创建项目选的是 **DESKTOP-24MMCKL**。
- 已安装版本：SunMoon Link **0.5.3**，随包 Codex **0.155.1**，随包 Node **v24.19.0**。
- 安装位置：`C:\Users\zouyaming\AppData\Local\Programs\sunmoon-link`。
- 本地检查的 Link 仓库 HEAD：`ab5679d`。修复前应核对实际发布包与源码版本，不要只凭相同版本号认定文件完全一致。
- 两个问题先后出现：**安装临时目录的 Windows 8.3 短路径被拒绝**；绕过后安装成功，但**创建项目所用文件助手在保持 stdin 打开时无响应，发送 EOF 后相同查询成功**。

## Bug 1：正常 TEMP 短路径导致安装失败

### 用户操作与现象

在新电脑 PowerShell 执行网页提供的 `irm '<安装脚本地址>' | iex`，报错：

```text
Installation stopped: Install/build paths must be ordinary local drive paths
警告: 可能有旧窗口的进程还开着，先在托盘退出、关掉所有 SunMoon 窗口再试
新版本没有装上，原来的配置还在。
所在位置 行:114
```

安装脚本 URL 含一次性凭据，本文不保存原始 URL。

实机环境变量：

```text
TEMP          C:\Users\ZOUYAM~1\AppData\Local\Temp
TMP           C:\Users\ZOUYAM~1\AppData\Local\Temp
LOCALAPPDATA  C:\Users\zouyaming\AppData\Local
USERPROFILE   C:\Users\zouyaming
```

仅在当前 PowerShell 会话设置长路径后重新执行安装命令，安装成功：

```powershell
$env:TEMP = Join-Path $env:LOCALAPPDATA 'Temp'
$env:TMP = $env:TEMP
```

成功输出摘要：`action: installed`，`files: 110`，`bytes: 501134996`，随后提示已准备 Link 0.5.3 / Codex 0.155.1。这是已验证的临时绕过，不是产品修复，也没有永久修改系统环境变量。

### 已确认原因及代码位置

1. [agent/distribution/install.ps1.tmpl](agent/distribution/install.ps1.tmpl) 第 12–14 行直接用 `$env:TEMP` 构造下载、解压目录，短路径进入安装源目录。
2. [agent/distribution/bundle.mjs](agent/distribution/bundle.mjs) 的 `plainDirectory()`，第 49–52 行通过 `/~[0-9]/` 拒绝短路径形式；`path.resolve()` 不会把 8.3 路径展开成长路径。
3. 同文件 `firstInstall()` 第 169–170 行先校验 `source` 和 `localAppData`；本例 `LOCALAPPDATA` 是长路径，安装源目录携带的短路径触发拒绝。
4. `install.ps1.tmpl` 第 122–124 行对所有异常都提示“可能有旧窗口的进程还开着”。本例没有证据表明失败由进程占用导致，这个通用提示误导排查。

### 修复方向与验收

- 让正常的 Windows TEMP/TMP 短路径环境可安装。可评估在安装脚本选择可靠的长路径暂存目录，或在安装器内安全解析真实路径；由 Opus 决定具体方案。
- 保留对 junction、符号链接、非本地路径、源目录与目标目录重叠等风险的校验，不要只删除短路径拒绝正则。
- 区分路径校验失败、下载校验失败与真正的文件占用，保留有用的原始错误。
- 在真实 Windows 上验证：原始短路径 TEMP/TMP、普通长路径、含空格或中文的用户路径；失败时已有配置仍保留。
- 发布范围取决于最终改动：若只改服务端返回的安装脚本，需要更新脚本生成/部署链路；若改随包安装器，需要重新打包并更新校验值。不要假定本地改完仓库就影响已发布安装命令。

## Bug 2：创建项目卡在文件助手通信，页面只报 local_failed

### 用户操作与状态证据

安装成功后，在网页创建项目：

```text
机器：DESKTOP-24MMCKL
工作区：C:\Users\zouyaming\Desktop
子目录：test
项目目录：C:\Users\zouyaming\Desktop\test
```

页面报“本地 link 那头没做成，请再试一次。”，用户确认 `test` 文件夹没有出现。

Link 状态摘要：

```json
{
  "version": "0.5.3",
  "pid": 4576,
  "runId": "29a6ff3c-8e4c-49d9-aa09-f66440d8888e",
  "running": true,
  "execServer": {
    "url": "ws://127.0.0.1:52988/",
    "alive": true,
    "sandboxed": false,
    "protection": "inner-sandbox+strict-protocol",
    "windowsSandbox": {
      "mode": "elevated",
      "probe": "process/start",
      "elevatedSetupForHome": true,
      "elevatedUsable": true
    }
  },
  "relay": { "status": "connected", "lastError": "" },
  "ceiling": { "sandbox": "workspace-write", "network": false },
  "roots": ["C:\\Users\\zouyaming\\Desktop"]
}
```

`sandboxed: false` 表示没有 OS 外层沙箱，结合 `protection` 和 `windowsSandbox` 看，不能解释为所有沙箱都关闭。`elevatedUsable` 验证的是进程启动，不是文件助手交互协议。

日志时间均为 UTC（北京时间加 8 小时）：

- `02:00:24`：`local settings applied`，随后重启。
- `02:00:42`：exec-server 启动时 roots 已包含桌面；此前的空白名单警告是旧状态。
- `02:00:43`：exec-server ready、relay connected。
- `02:01:49`、`02:02:09`、`02:02:32`、`02:02:45`、`02:03:56`：均为 `local request` / `category: project` / `code: local_failed`。

这些记录证明创建请求已到这台电脑的本地 Link。状态中的 bridge/service 计数为零，不能用于否认浏览器直连本地 API 的请求。

### 实机诊断：连接及启动前检查正常

通过安装包内的 `LocalRpc` 连接当前 exec-server，然后分别查询随机不存在文件的元信息及其子路径，得到：

```text
executor connection: OK
{"method":"fs/getMetadata","reply":{"error":{"code":-32004,"message":"系统找不到指定的文件。 (os error 2)"},"id":2}}
{"method":"fs/readFile","reply":{"error":{"code":-32004,"message":"系统找不到指定的路径。 (os error 3)"},"id":3}}
```

这是预期结果，符合 `WindowsFiles.start()` 对本地化 not-found 错误的检查，排除了当次连接失败和该协议检查失败。

### 关键对照：相同元信息查询，只改变 stdin 是否结束

使用安装包自己的 `windowsHelperArgs()`、`windowsEnvironment()`、`locateCodex()`、`locateWindowsHelper()`，沿用配置中的 home、roots、elevated 模式和当前已有的 executor 临时目录，启动独立诊断助手。直接转发助手 stdout/stderr，发送 `service/getMetadata` 查询桌面根目录，不调用 mkdir 或写文件方法。

| 唯一关键差异 | 用户实测输出 |
| --- | --- |
| `child.stdin.write(request + "\n")`，保持输入打开 | 30 秒无回复、无错误文字，诊断脚本打印 `helper timeout` 并终止进程，随后 `exitCode: 1` |
| `child.stdin.end(request + "\n")`，发送后结束输入 | 立即返回下方目录元信息，`exitCode: 0` |

```text
{"id":1,"result":{"type":"dir","size":0,"mtime":1793322237961}}
{"exitCode":0,"signal":null}
```

第一组 `exitCode: 1` 来自超时后的主动终止，不能当作助手自行报告的根因。第二组只证明目录查询成功，尚未验证实际创建项目或所有写权限。

随后查询 `<codexHome>\.sandbox\sandbox*.log` 未显示输出；这不能证明沙箱没有问题，也不能据此判定具体日志缺失原因。

### 代码链路与已确认的附带问题

1. [agent/src/localProjects.ts](agent/src/localProjects.ts) 第 112–118 行：`folder()` 先 `kind(target)`，再 mkdir，再查询；Windows 的 `kind()` 经 `service/getMetadata` 调用文件助手（第 71–82 行）。首个查询无响应即可解释为什么目录未创建。
2. [agent/src/windowsRuntime.ts](agent/src/windowsRuntime.ts) 第 109–113、138 行：通过 `codex sandbox --permission-profile sunmoon_files ... -- node native/helper.mjs ...` 启动助手，stdio 使用管道。
3. 同文件第 155–164 行：生产代码用 `stdin.write()` 发送一行 JSON，保持输入打开等待响应，**15 秒**无响应就 reject 并关闭助手。诊断脚本的等待时间是 30 秒，两者不要混淆。
4. 同文件第 167–170 行：关闭会把 `stopped` 设为 true；后续请求直接失败，没有自动重建。`starting` 失败的 Promise 也会保留。因此首次异常会导致该助手实例的后续点击继续失败。
5. 同文件第 149–152 行：stderr 只 drain，不记录；进程退出也不保留原因。
6. [agent/src/localApi.ts](agent/src/localApi.ts) 第 136–140 行：非 `LocalError` / `TicketError` 的异常统一映射为 HTTP 503 / `local_failed`，日志仅保留 category/code，原始失败阶段不可见。

### 结论边界

**已复现并定位到文件助手与沙箱命令之间的持续管道交互问题：该实机保持 stdin 打开时拿不到响应，EOF 后相同请求成功。** 生产代码恰好依赖保持 stdin 打开的多请求通信方式。

尚未定位底层具体卡在输入读取、转发、缓冲、输出回传还是其他等待点；不要把“已经证明某一行 Rust 在等 EOF”写成既定事实。也没有证据证明它发生在所有 Windows 或所有 elevated 环境。

本地有 Codex 源码 `/home/zym/repo/codex`，存在精确标签 `rust-v0.155.1`。继续排查应使用该标签，当前 checkout 不是相同版本。已查看的入口：

- `codex-rs/cli/src/debug_sandbox.rs`：Windows sandbox session 的启动及 stdio 转发。
- `codex-rs/windows-sandbox-rs/src/stdio_bridge.rs`：`forward_sandbox_session_stdio()`。
- `codex-rs/windows-sandbox-rs/src/unified_exec/backends/elevated.rs`：elevated runner 通道。

### 修复方向与验收

- 调整文件助手通信/生命周期，使其不再依赖这条实机不能及时响应的交互方式。继续追查底层阻塞点，或选用经验证的调用方式，由 Opus 决定。
- **不要只把生产代码的 `write()` 改成 `end()`**：当前助手还要处理后续请求及部分方法的有状态句柄；EOF 后不能继续复用原进程。若采用单次进程，需要明确支持的方法、句柄状态以及并发行为。
- 超时、异常退出、启动失败后的生命周期应明确：后续调用能恢复或明确要求恢复操作，不能无提示地永久复用失效实例；写操作不要盲目自动重放。
- 增加可诊断但不泄露凭据的错误阶段、退出码、超时信息。原始 stderr 可能含路径等信息，不宜直接全量暴露给网页。
- 在故障实机验证完整 `metadata → mkdir → metadata` 流程，页面成功且 `Desktop\test` 确实存在；重复使用已有空目录也成功。
- 验证连续请求、需要保留句柄的方法、并发调用、超时/进程退出后的下一次调用，确保不是“第一条成功，第二条失败”。
- 分别验证 elevated、unelevated；保留目录白名单、只读限制、禁止链接逃逸等安全约束。
- 修复 Link 客户端后重新打包发版，再由用户安装验证。只改服务端页面不能修复已安装助手的管道通信。

## Opus 可复用的诊断脚本

在故障 Windows 电脑 PowerShell 执行。用字符串数组避免 here-string 结束标记缩进及长命令换行导致的粘贴错误。只查询目录元信息；会启动独立沙箱进程，可能产生正常运行日志，但不改产品代码/配置，不创建项目目录。

此探针要求已有且仅有一个 `executor-*` 临时目录；不符合时主动停止，不创建、不删除、不猜选目录。`notFound` 参数未传入，因为本对照只查询存在的工作区根目录；它不是生产全流程的替代测试。

```powershell
$linkDir = Join-Path $env:LOCALAPPDATA 'Programs\sunmoon-link'
$probe2 = @(
'import fs from "node:fs";'
'import path from "node:path";'
'import { spawn } from "node:child_process";'
'import { pathToFileURL } from "node:url";'
'const install = process.argv[2];'
'const load = name => import(pathToFileURL('
'  path.join(install, "app", "dist", name + ".js")).href);'
'const { loadConfig } = await load("config");'
'const { locateCodex } = await load("paths");'
'const rt = await load("windowsRuntime");'
'const cfg = loadConfig();'
'const parent = path.join(process.env.LOCALAPPDATA, "sunmoon-link", "tmp");'
'const dirs = fs.readdirSync(parent, { withFileTypes: true })'
'  .filter(d => d.isDirectory() && d.name.startsWith("executor-"));'
'if (dirs.length !== 1) {'
'  throw new Error("Expected one active temp directory; found " + dirs.length);'
'}'
'const temporary = path.join(parent, dirs[0].name);'
'const helper = rt.locateWindowsHelper();'
'const args = rt.windowsHelperArgs(cfg.codexHome, cfg.roots,'
'  cfg.windowsSandbox.mode, cfg.ceiling.sandbox !== "read-only", helper);'
'const child = spawn(locateCodex().codexBin, args, {'
'  cwd: cfg.roots[0], windowsHide: true,'
'  env: rt.windowsEnvironment(cfg.codexHome, {}, process.env, temporary),'
'  stdio: ["pipe", "pipe", "pipe"]'
'});'
'child.stdout.pipe(process.stdout);'
'child.stderr.pipe(process.stderr);'
'child.stdin.on("error", e => console.log("stdin: " + e.message));'
'const timer = setTimeout(() => {'
'  console.log("helper timeout");'
'  rt.killWindowsTree(child).catch(e => console.log(e.message));'
'}, 30000);'
'child.on("error", e => { clearTimeout(timer); console.log(e.message); });'
'child.on("exit", (code, signal) => {'
'  clearTimeout(timer);'
'  console.log(JSON.stringify({ exitCode: code, signal }));'
'});'
'child.stdout.once("data", () => child.stdin.end());'
'child.stdin.write(JSON.stringify({ id: 1, method: "service/getMetadata",'
'  params: { path: pathToFileURL(cfg.roots[0]).href } }) + "\n");'
)
$nodeArgs = @('--input-type=module', '-', $linkDir)

# A：保持输入打开，实机复现超时。
($probe2 -join "`n") | & "$linkDir\node\node.exe" @nodeArgs

# B：仅改为发送后结束输入，实机返回目录信息并正常退出。
$probeEof = $probe2 -replace 'child\.stdin\.write\(', 'child.stdin.end('
($probeEof -join "`n") | & "$linkDir\node\node.exe" @nodeArgs
```
