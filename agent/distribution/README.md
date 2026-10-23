# Windows 安装与日常操作

单目录包包含官方 Node 24.19.0、Codex 0.155.1、JS 和系统 PowerShell/WinForms 界面。
不编译自有 exe，不要求用户安装 Node/Python，不增加 Electron/原生依赖，不关闭应用控制。
版本入口为 `windows-x64.json`。执行能力仍在 `agent/src/`，托盘只调用同一个 CLI。

## 安装和首次连接

由可信交付记录取得清单 SHA256，在运行包内程序之前核对摘要及来源。包内清单只能
检查完整性，不能作为发布者签名。若 Smart App Control、WDAC 或 PowerShell 策略阻止，
记录具体程序与策略后停止；不要修改执行策略或关闭应用控制来通过。

```powershell
Get-FileHash .\bundle-manifest.json -Algorithm SHA256
.\install.cmd --manifest-sha256 '<可信记录中的 SHA256>'
.\install.cmd --manifest-sha256 '<同一 SHA256>' --apply
```

固定每用户目录 `%LOCALAPPDATA%\Programs\sunmoon-link`。默认只安装，不启动、

**0.5.0 起改名**（0.5.0 之前叫 sunmoon-agent，2026-10-16 决定、0028 R5 发版）：网页安装脚本发现旧的 `%LOCALAPPDATA%\Programs\sunmoon-agent` 时，先用新包自带的 `uninstall.mjs --legacy` 卸下它（按旧安装自己的清单校验后才删；关掉它的登录自启 `SunMoonAgent-*`、停托盘与后台），旧配置 `%USERPROFILE%\.sunmoon-agent` 与旧日志保留不删；新版用新的配置目录 `.sunmoon-link`，要重新接入一次（改名后的工作台从空库起，不认旧的配对与凭据）。环境变量名 `SUNMOON_AGENT_HOME`、本机接口与握手里的 `agent` 字段属于内部命名与协议，不改。
不自启、不提权、不设置全局 PATH。已存在目标或安装中断标记均停止，不能覆盖未知文件。
之后从**安装目录**执行 `sunmoon-link.cmd menu`，或使用网页安装脚本创建的开始菜单入口。
无令牌时 Node 开出本机浏览器页（颁发令牌）：显示确认码和倒计时，自动打开站点核对页。
在站点页亲手输入本机显示的码、确认账号并允许；令牌只由代理 TLS 轮询取得并写入私有配置。
允许后默认开启当前用户登录任务、启动后台；本机页显示「已在线」后可点完成。
目录权限仍需在托盘「这台电脑上的设置」选择；首次未选目录时不允许访问项目文件。
已有令牌时入口启动后台并打开托盘，不再出现颁发令牌页。「重新颁发令牌」会换一对新令牌，旧的本地 link 会断开。

`install.cmd` 是离线交付的安装器，只负责安装；网页的 `install.ps1` 编排下载、升级和 `menu`。
不要把安装器的退出成功当作真实配对及在线验收通过。

`init --token-prompt` 保留为排障入口：真正的本机终端隐藏输入，不进命令参数或历史；
不能管道输入。日常使用上述浏览器配对，不需要复制令牌。

`init` 会真实探测沙箱能力。Codex 的 Windows 沙箱有两种模式（OpenAI 文档：提权模式是首选，普通模式是退路）：

| 模式 | 命令以谁运行 | 白名单外 |
| --- | --- | --- |
| 提权（elevated） | Codex 建的独立沙箱账户（`CodexSandboxUsers` 组） | 写不进、删不掉 |
| 普通（unelevated） | 用户自己的身份，只限写的令牌 | 写不进，**但能删**（Windows 不把删除算写；0.155.1 `token.rs` 的 `WRITE_RESTRICTED`） |

没做过提权设置时用普通模式，无管理员也能用。托盘第一次看到是普通模式会问一次要不要提高（只问一次，记在
控制目录的 `sandbox-offer.json`），以后在托盘「这台电脑上的设置」里点「提高安全」；网页顶上也会提示。
提高的过程是托盘调 `sandbox-upgrade`：停下本地 link → 提权设置 → 再起来。也可以手动：

```powershell
.\sunmoon-link.cmd sandbox-setup --elevated
```

这是**唯一的 UAC**：只调用官方 `codex sandbox setup --elevated --current-user`，
固定到代理自己的 codex-home。拒绝用另一管理员账号替代当前用户。成功后再次实际探测，
确认 elevated 可用才保存模式；取消、失败不自动降权。超时先检查现场，不重复发起 UAC。

提权模式下，Codex 只给用户目录的第一层授读；`%LOCALAPPDATA%\Programs` 这类带保护 ACL 的子目录断了继承，
沙箱账户读不到本地 link 自己的 `node.exe` 和装在那里的 Python。所以本地 link 在提权探测前、每次启动时，
给 `CodexSandboxUsers` 组补授读与执行（子项继承）：本地 link 自己的 `node`、`app` 目录，以及 PATH 里在用户目录
之下的目录（不含 `.ssh` 等 Codex 排除的目录、不含本地 link 的控制目录与 codex-home），先查后授
（`src/windowsSandboxRead.ts`）。2026-10-23 在所有者 Windows 上实测：提权模式下只读档删不掉白名单内外的文件，
可写档白名单内能写能删、白名单外写不进删不掉，补授后 node、python 都能起。

## 日常控制

均在安装目录使用；未指定 `SUNMOON_AGENT_HOME` 时使用 `%USERPROFILE%\.sunmoon-link`。

| 操作 | 命令/入口 | 行为 |
| --- | --- | --- |
| 启动 | `sunmoon-link.cmd start --background` | 单实例、隐藏后台；重复启动不会多开 |
| 看状态 | `sunmoon-link.cmd status` | running、relay 状态及原因；成功查询退出 0，是否运行看 running |
| 托盘 | `sunmoon-link.cmd tray` | 五项：状态、查看状态与原因、这台电脑上的设置、重新颁发令牌、退出 link |
| 退出 | 托盘「退出 link」 | 本地 link 与托盘一起退出；从开始菜单打开即重启（`tray stop` 只关托盘，供卸载器用） |
| 停止 | `sunmoon-link.cmd stop` | 匹配 PID 与本轮随机身份，正常清理执行进程，不杀未知进程 |
| 自启开关 | 托盘「这台电脑上的设置」里的「登录时自动运行」，或 `autostart enable / disable / status` | 当前用户登录任务，Limited、非管理员；颁发令牌完成后默认打开，可关闭；和网页设置里是同一个开关 |
| 配置 | 托盘「这台电脑上的设置」 | 电脑名、逐项勾选目录、只读/工作区写入、网络开关、本地知识库目录、登录时自动运行；保存后本地 link 自己重启生效 |
| 前台诊断 | `sunmoon-link.cmd start` | 终端交互和日志；前台/后台共用单实例锁 |

托盘与后台分离，登录任务用系统 wscript 隐藏启动二者，不弹控制台。
任务名 `SunMoonAgent-<配置目录摘要>`，只有名称、说明和执行路径均匹配才修改/删除。
令牌吊销/被替换的退出不会触发任务自动重试；重新取得令牌是人工动作。
自启任务的手动触发可以验证启动链，**不能代替整机重启验收**。

托盘菜单直接显示本地 link 连着、正在连接、没连着或没在运行（只看得到本地 link 这一端；沙箱与配对成功没有在网页设置里看）；
双击图标或「查看状态与原因」查看最近连接错误和状态时间。超过 15 秒未更新的状态不会继续显示连着。

目录列表中，添加新目录只加入待选项，勾选后保存才进入白名单。取消勾选保留位置，
下次可以重新选择；“移除选中行”删除待选项。可以全部取消，关闭所有项目目录访问。
配置中的 `roots` 是唯一实际授权列表；`rootChoices` 只是本机界面记住的候选目录，
不会作为执行器权限或上传配置。旧配置没有 `rootChoices` 时，以原 `roots` 初始化列表。
保存后本地 link 自己重启（0.5.2 起，和从网页改设置一样），运行中的连接不会悄悄改变权限。

## 本机授权与边界

后台收到允许申请的权限提升时，以系统 WinForms 展示程序、目录、权限范围和请求摘要。
人工输入本次短码并点击允许；窗口关闭、60 秒超时、断线均拒绝。答案只走私有子进程
stdin/stdout，不开 localhost 批准接口、不存批准文件。远端命令强制 Codex 私有桌面，
控制目录与安装代码禁止作为可写项目根。确认后仍须经过工作台持久化审计回执。
`danger-full-access` 和新增白名单根不能在这个弹窗中获批；临时权限断线失效。

HTTP 只转发启动时本机确认过的完整 MCP URL，逐字匹配且禁止跳转；网络开关关闭则拒绝。
没有确认列表时不能访问任何 HTTP 地址。域名按正常 DNS 解析，本轮不实现 IP 固定。

同一 Windows 用户的任意恶意本地进程不是普通用户安装器的隔离边界。
后台不会提供无交互的自动同意方式。GUI 正向真实授权须单独验收；CLI 真实授权已有结果。配对允许与命令权限允许是两个不同动作。

## 日志与故障

`%LOCALAPPDATA%\sunmoon-link\logs\agent.log`：每份 2 MiB，共 5 份。
不记录令牌、确认码、用户输入、命令正文和执行器原始输出。托盘状态显示 `lastError`/`lastNotice`。
配置保持私有，执行器家不含登录态。退出或禁用自启不会删除配置和项目文件。
脚本被策略拒绝时 GUI/任务会失败，仍保留前台诊断入口，不能自动 bypass 策略。

## 卸载和手动升级

使用保留的**外部交付目录**运行，不能让正在使用的 installed node.exe 删除自己。

```powershell
.\uninstall.cmd --manifest-sha256 '<交付摘要>'
.\uninstall.cmd --manifest-sha256 '<同一摘要>' --apply
# 明确不要配置与令牌时，额外加 --remove-config；默认不删除。
```

先全目录验真，再删除本实例的自启任务、关闭托盘、正常停代理。全部成功后才按清单
逐文件移除安装目录；未知文件、修改或链接导致停止，不使用递归强删。部分文件被占用时
保留现场并报告失败，不宣称卸载完成。默认配置和日志保留。

`--remove-config` 只允许删除默认专用 `.sunmoon-link`，另删五个自有日志文件；
自定义配置目录、未知顶层文件、链接均拒绝。用户 `.codex` 和项目目录不删除。
外部包与已装版本不同时，增加 `--installed-manifest-sha256 '<已装版本可信摘要>'`。

第一期手动升级：核对新包 → 卸载旧程序（保留配置）→ 安装新包 → 启动/检查 →
按需重新启用自启。失败保留配置并用旧可信包重装。自动下载、验签更新与自动回滚属第二期。

## 维护者组包与回归

**发 Windows 包只用这一条命令**（账 128，0.5.2 起；以前「复制上一次的冻结依赖目录再跑 build.mjs、手工打 zip」的做法作废）。
提交源码后，在 WSL 或 Windows 上从仓库根目录：

```sh
node agent/distribution/release-windows.mjs \
  --node-exe '/path/to/verified/node.exe' \
  --site agent/distribution/sites/dev-kind.json \
  --ca-pem agent/distribution/sites/dev-kind-ca.pem \
  --out '/path/to/new/release-directory'
```

它依次：用 `git archive` 把 HEAD 的 `agent/` 导出到新目录 → 在那里按锁文件冻结安装 Windows 依赖（pnpm 10.24.0，
`--frozen-lockfile --ignore-scripts --prod --os win32 --cpu x64`，Linux 上也装得出 Windows 平台包）→ 核 `@openai/codex` 与
`@openai/codex-win32-x64` 都在 → `build.mjs` 组包（源码、版本、锁文件、Node 摘要、清单的检查照旧）→ 编码探针（含中文的 `.ps1`
必须有 UTF-8 BOM、`.cmd`/`.vbs` 必须是 ASCII、每个 `.ps1` 在 Windows PowerShell 里解析 0 错误）→ 用包里的 `node.exe` 在 Windows 上
跑 `test/windows-candidate.mjs` 自检（WSL 上先复制到 Windows 临时目录，过了就删）→ 打确定性 zip（`zip.mjs`：按名排序、时间固定为
1980-01-01、无额外字段）→ 打印并写 `<名字>.receipt.json`（源码提交、清单与 zip 的 SHA256、大小、各项检查、打包机的 Node/zlib/pnpm 版本）。
任何一步出错就停，工作目录留着排查；全过才删工作目录。同一提交、同一套工具打两次，zip 摘要相同。

`build.mjs` 仍可单独跑（`--dependencies` 指向一份冻结安装的结果），只供排查；发版不用。回归：

```sh
pnpm --dir agent build
pnpm --dir agent test
node --test agent/distribution/test/bundle.test.mjs
```

`--site` 必填。`ca_sha256` 由组包时对证书 DER 计算，不从配置文件读入。开发站点用上面两个文件；`bundled-ca` 必须再给 `--ca-pem`，`system` 不能带证书。

组包仅复制白名单生产文件、完整 Codex Windows 资源、固定依赖、许可证与入口。
Node 版本/摘要来自已固定的官方物料；生成全文件 SHA256、固定源码提交和锁文件摘要。
Node/Codex LICENSE/NOTICE 存 `licenses/`，其余许可证随依赖。输出不能预先存在。

## 浏览器页与兜底排障

`pair --page` 的 HTTP 服务只绑 127.0.0.1，随机端口和 32 字节随机路径，最长 30 分钟。
浏览器打不开时，从托盘「查看状态与原因」复制本机页地址、查看确认码；控制台与本机日志也记录页地址。
配对进展只在 Node 内存；私有 `pair-page.json` 仅存 PID 和本机页地址，供托盘定位。它不含连接码或令牌。
`pair-page-status` 输出该内存状态的安全投影，不能批准配对或权限申请。
退出页面服务关闭端口并清理自己的定位文件。重复入口重用同一个页，不重复申请确认码。

旧 `onboard-window`、PowerShell 配对向导和 `pair-status.json` 生产路径已经撤除。
卸载器为旧版升级保留 `onboard-ready.json`、`pair-status.json` 的精确允许清单一版。
浏览器关联或应用控制阻止启动时，记录证据，不绕过系统策略。真实清空浏览器关联的验收与故障注入区分记录。

## 第三阶段任务表

| 项目 | 实现状态 | 验收边界 |
| --- | --- | --- |
| 发行目录、校验、首次安装 | 已实现 | 原生真实包验证记录见最新 windows-agent-3 报告 |
| 单实例后台、启停、状态、托盘 | 已实现 | 普通用户原生启停及关托盘后保活已验证 |
| 设置窗口、确认窗口 | 已实现 | 实际 WinForms 三轮保存/重开、全不选、目录读写拒绝通过；GUI 人工正向确认待补 |
| 登录任务 | 已实现 | 当前用户 Limited 注册/触发/清理已验证；真实重启待补 |
| 可选 UAC setup | 已实现 | 静态解析通过，实际 UAC 未执行 |
| 卸载、保留或删除配置 | 已实现 | 21f864b 新完整包安装到卸载、重装闭环通过；实际安装实例真实 relay 在线后亦已清理 |
| 干净 Windows 10/11 | 待所有者 | 不能用开发机清空 PATH 宣布通过 |
| 真实 MCP | 已实际调用通过 | 见 `scripts/results/windows-agent-2-mcp.20261009.md`；固定回显服务，不代表认证型 MCP 均通过 |
| 旧两次投影追踪 | 待定位 | 最新调用投影成功，不能据此解释旧拒绝 |

## Linux 包（分身测试的测试电脑）

分身测试（SDD 0027 §3.4）的测试电脑是集群里的一个 Linux 容器，跑同一份代理。在 Linux x64 上、从已提交的源码打包：

```bash
node agent/distribution/build-linux.mjs --dependencies agent --site agent/distribution/sites/edge-public.json --output <新目录>
```

产出目录与同名 `.tar.gz`（按名排序、时间与属主固定，同一提交打出同一个摘要）。包里不带 Node（用镜像里的），没有 Windows 界面与安装器；`site/edge-public.json` 走公网边缘、用系统信任。测试电脑初始化时用 `installer/verify-linux.mjs <目录> <清单 SHA256>` 核对。清单默认只认 Windows 包，Linux 包要显式 `platform: 'linux'`，Windows 安装器不会接受它。

