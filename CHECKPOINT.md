# CHECKPOINT（runtime 仓，分支 fable）

## 当前：0.5.3 提权模式三处修正——安装根目录授权、工作区本身建项目、「提高安全」重探（2026-10-25）

起因：所有者在 knowbench「专家 → 新建项目」报「本地 link 那头没做成」。在那台电脑上复现：提权模式下 `WindowsFiles` 起 `native/helper.mjs` 时，Node 逐级 realpath 到 `Programs\sunmoon-link` 这一层 `EPERM`（只授了 `node`、`app` 两个子目录，账 176）；补授后目录留空（= 工作区本身）又报 `outside_whitelist`：helper 查目录先进上级，白名单根的上级是用户目录，沙箱账户进不去（账 177）；另外「提高安全」弹窗报失败但重启后已是提权模式（账 174）。

改法：`helperProgramDirectories` 把安装根目录加进补授读；helper 对白名单根本身进它自己核身份；`setupElevated` 探测失败隔两秒再探，最多三次，探测异常记 `why`。版本 0.5.3，`b398c1d`；Windows zip `cf0e0b85…`、Linux tarball `d93bfc54…` 已上传，knowbench 发行配置已指过去。Linux 359 通过（新增 1）。Windows 实机：所有者电脑用 `icacls` 手工补授后新建子目录项目成功；0.5.3 装上后再验「留空」与「提高安全」。

## 当前：0.4.1 新建项目——回环口建文件夹、拉取 git 仓库（0024 段 1，远程实现，Windows 待验，2026-10-14）

起因：现网新建项目只在工作台登记路径，电脑上没有那个文件夹，工作对话写文件时代理反复报工作目录不存在、模型转去请求提权。设计 `k8s/.../SDD/modules/0024-new-project.md`。

回环口加 `POST /local/v1/projects/folder`、`POST /local/v1/projects/clone`（`src/localProjects.ts`），门与 0022 相同；`info.capabilities` 多 `local-project-v1`。只写工作区（`roots`），不写知识库、配置目录、codex-home、`.git` 里；本地上限只读时拒。Windows 建文件夹另起一个**可写**文件助手（工作区为写根），走它已审的 `fs/createDirectory`；建完 `service/getMetadata` 核。clone 由代理直接起 `git`（不经 shell、不在 Codex 沙箱：要用用户的凭据管理器与 ssh key），参数写死：只放行 https/ssh 传输、不拉子模块、`--` 之后才是地址；`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`；用户填的令牌只进 git 子进程环境，经一次性凭据助手交给 git，勾记住才 `git credential approve`。失败只按 stderr 固定片段分类，原文不回。超时 15 分钟 / 取消杀进程树，删掉本次新建的文件夹（用户选的空文件夹只清空）。Windows 上 `canonicalPath` 小写只用于比较，建的文件夹保留原名大小写。

Linux 323 通过 / 34 平台跳过，类型、构建通过（新增 `test/localProjects.test.ts`、`test/localProjectsApi.test.ts`，含真 git 验一次性凭据助手）。**Windows 未验**：`test/local-project-windows-probe.mjs <隔离源码> [公开仓库] [私有仓库]`（令牌只从环境变量 `SUNMOON_PROBE_TOKEN` 读）交所有者机器跑；版本三处 0.4.1。不 push、不发布。

## 当前：032 乙案段 2 已交审，本机真人允许/拒绝与正常重启通过（2026-10-12）

代码 `f002ab5346bb3e007c9de0339b960aeacb287a73`，基于已审回环段 1。五个候选口 47811–47815、未知 kid 距上次取钥超过 60 秒刷新、GET/PUT settings、共享 preferences 校验、合成本机随机码确认、原子配置替换、回包后 stop-request/startResident 重启、只读 libraryDir 与托盘字段已实现；版本仍 0.4.0，无新依赖。

Linux 308 通过 / 33 平台跳过，类型与构建通过；发行 Linux 46/2 跳过、Windows 48/48。Windows 隔离源码实际落 47813，自签票 + 本地 HTTPS JWKS，知识库可读/执行写拒、收窄重启/hello、新钥 61 秒重取通过；所有者亲手按随机码允许添加目录/知识库，并点拒绝提高写上限，409 后配置字节不变。真实设置窗字段检查通过。首轮 relay 配置、窗口观察编码、发行夹具缺文件与真人探针后置换钥断言错误都保留在回执，没有抹去失败。

最终 dist 68/native 5 文件与隔离源码相同，合成夹具已清理；现装 0.3.1 connected。未改同步脚本、其它仓、现装或站点，未 push/发布。现网发票/完整网页联调、elevated、干净机器安装和真实登录任务开关回滚仍待验；本轮不冒认。回执：[段 2 交审证据](scripts/results/windows-agent-0.4.0-local-stage2.20261012.md)。下一步所有者同步，远程审读，发布后补网页/现网票验收。

## 当前：032 乙案段 1 回环文件只读已实现，自签票/本地 JWKS + 隔离 Edge 通路通过（2026-10-12）

基线 9d96980（服务流段 1 已由远程过审保留），本段代码 35d7964。按重写的 032/0022 第三节增加 localApi、ticket、localFiles：presence 无票；local/v1 验精确 Origin 与 ES256 票，站点固定 JWKS 十分钟缓存；原始文件字节一次 1 MiB、三项元数据头跨源可读。已过审 service/relay 与 filter/windowsPolicy/windowsBridge/pair 字节不变，版本仍 0.4.0，无新依赖。

Linux 274 通过/33 平台跳过，类型构建通过，发行 46/2 跳过；Windows 原生 Codex 0.155.1 unelevated 与隔离 Edge 通过中文读取、五段原字节重组、边界/别名拒绝、CORS/预检。**使用自签票与本地 JWKS，不是生产票**，现网发票与真实文件树仍待发布。固定两个端口被已有进程占用，首次试验失败保留；测试改用随机回环端口，未停原进程、未改正式端口或现装代理。临时配置与夹具已清理，隔离源码保留。

证据、失败原文与复跑方式见 [032 乙案段 1 回执](scripts/results/windows-agent-0.4.0-local-stage1.20261012.md)。只本地提交，不 push、不发布、不改同步脚本。段 2 设置读写、libraryDir、放宽本机确认与重启未开始；下一步远程审读段 1，发布后补生产票/真实文件树，再按停点确认继续段 2。

## 当前：0.4.0 段 1 文件只读已实现并实测，交远程审读（2026-10-12）

任务 `inbox/astra/astra-032.md`，基线 ef6f33f；k8s e1540e0d 已将原始分段改为 512 KiB，解除上一节的合同阻塞。代码提交 3cf569a、652393f，三处版本为 0.4.0。独立服务流、白名单文件只读、四并发/50/s/两流、消息大小边界已实现；沙箱流主体和现有过滤/配对代码字节不变。Windows 文件助手使用连续 UTF-8 解码。

Linux 258 通过/33 平台跳过，类型/构建通过，发行 46 通过/2 平台跳过；Windows 原生 Codex 0.155.1 unelevated、固定真实本机 Relay 联调通过：中文读取、十段重组、目录 2000 项截断、联接/硬链接/路径别名拒绝、超大文件与越界拒绝、无令牌 WS 被拒。最大回包 699150 字节。候选 dist/native 与本机实测源码逐文件相同；测试夹具已清理，隔离源码保留，现装代理仍 0.3.1 connected。

完整证据和重跑方式见 [0.4.0 段 1 回执](scripts/results/windows-agent-0.4.0-stage1.20261012.md)。只本地提交，不 push、不发布、不改现装。段 2 未实施：settings/read|write、libraryDir、设置确认与重启；下一步所有者回传、远程审读段 1 后继续。elevated、现网服务流、干净机器安装未验，不得冒认完成。

## 当前：0.4.0 服务流合同限额冲突，段 1 未实现，交远程确认（2026-10-12）

任务为 `switch-test/inbox/astra/astra-032.md`；所有者指定基线 `ef6f33f1a34f47d798e5a768a8374fab6c544e66`（含 0.3.2 托盘修复），目标版本 0.4.0。k8s 输入固定 `46438b0fd273855f45ac4fb42c3636f25eef550e`。没有产品代码或版本改动。

现有 Relay 的真实回环 WebSocket 服务配对证实：1 MiB 原始文件分段生成 1,398,189 字节 JSON-RPC/base64 响应，超过双向 1 MiB 消息上限；代理数据侧关闭码 1009，工作台收不到内容。小回包对照通过。按任务“设计走不通先停下交远程”的要求停下，未进入段 2。

交回选项、原始计数及固定输入见 [0.4.0 合同阻塞回执](scripts/results/windows-agent-0.4.0-contract-blocker.20261012.md)。回环探针暂在 `/tmp/sunmoon-service-frame-check.py`，复跑步骤在回执中。下一步远程确认并修改合同/会合点的消息或原始分段限额，所有者同步后再实现段 1。当前 Full Access，Windows PowerShell 已实际可调用，Windows 验收未做；不得把权限当作本次阻塞原因。不 push、不发布、不改集群或现装代理。

## 当前：0.3.0 主路径实测通过，收尾交审（2026-10-12）

生产源码 `834e4e9`；权限确认窗补充 `1fdefe7`。Node浏览器页替代PowerShell配对向导，通用设置/连接状态/权限确认显式显示与看门狗保留。固定候选100文件，清单SHA `93a9f313afc160282b203ce2ee5cf0220f142e4fda77d4a449b342062846c047`；ZIP SHA `225f34ebf69ab03ae33bea8cf0ca1e540b9b78dab615515e4b91ca4551e18990`。源码/包位于windows-agent-030/candidate-834e4e9。

完整同步安装模板在临时目录首次安装成功；所有者亲手登录、输码允许，本机页面及后台真实connected；默认自启Limited。托盘重开、HTTP404/403拒绝、状态无凭据通过。Windows浏览器失败故障注入的连接状态窗可见、显示同一地址与测试码；实际清空默认关联未做，控制台闪出答「好像有，看不清」，不能写通过。最终Windows259/259、发行48/48；新增关闭页保活实际后台回归通过（合成配对、真实Windows后台与测试会合点），Linux226/33Windows跳过、发行46/2跳过。网页235/2既有跳过、类型/i18n/lint通过。

按所有者选择，临时0.3.0正式卸载、任务移除；随后原0.2.7也正式卸载。卸载当时配置/日志保留且摘要不变；所有者后续授权清理后，原始及临时配置/日志四个目录已逐项删除（18文件、79709字节）。候选包与验收回执保留，当前无在线机器；正式安装走全新配对并重新选白名单。静态证据不含私有配置。首轮关闭页后状态复核用了错误CA路径，false读数无效，已补独立回归，不冒认通过。

证据、失败原文、重跑、P1–P4状态与Fable/Cursor交接：[0.3.0合成回执](scripts/results/windows-agent-0.3.0-browser.20261012.md)。本轮只本地提交，不push、不发布、不改集群。用户同步后Fable一次审读；发布卡另行执行。此节优先于以下历史状态。

## 当前：0.2.8 桌面链交审；控制台闪出未观察（2026-10-12）

按 `~/switch-test/astra-028.md` 的 1–7 项顺序实施，每项本地提交（`0a3fea6` 至 `f723539`）；k8s 模板同步 `d451d67c`、`878c7cb2`。不 push、不发布、不碰集群。Windows Vitest 256/256、发行 47/47；Linux 224/32 Windows 跳过、发行45/2跳过；build/typecheck通过。隔离托盘实际开窗、连接按钮、Dispose/终止/标记丢失收尾、完整安装模板自动修复及配置摘要不变均通过。三份健康隔离安装已正常卸载、临时任务/进程无残留；只保留原装0.2.7托盘（PID14740，最后只读核对00:00:36）及静态证据/回退目录。正式脚本摘要未变。

所有者对控制台闪出答「没注意，无法确认」，该项待验；不能宣布任务全部通过。最终证据、失败原文、包摘要、重跑方法：[0.2.8 交审回执](scripts/results/windows-agent-0.2.8-acceptance.20261011.md)。候选源码固定 `f723539e5d6794839e7a4a0fd1bc9869b4fb1107`，位置 `C:\Users\zymun\sunmoon-probe-runs\windows-agent-028\candidate-f723539`；之后只改测试/报告。下一步所有者同步给远程审读；Cursor 发布另走发布卡。不得替换原装版本、自动批准配对或删除保留的损坏目录。

## 当前：0.2.4 已装上并自己连上；配对接口回 404，窗口没有出现连接码，停下交审（2026-10-10）

依据 k8s `0cb358f6`。源码 `a878d145553625e9283701822d455d0eb3d043c0`。包在 `C:\Users\zymun\sunmoon-probe-runs\windows-agent-c2-20261010\sunmoon-agent-a878d14`。ZIP SHA256 `d00c1392e73079d24063877656599b0600da3806e18d3943e194fde617479e6e`，清单 SHA256 `e133f26f006c5e1ae3635ed0e031213a2bedb4ab6e6c574a06d74c754eb3f543`，`ca_sha256` 仍是 `76f9012886262cf6974039de8baf16ecd5e79e780237349fdcb95a2ac1aa1b3c`。

本机从正在运行的 0.2.3 升到 0.2.4。安装脚本没有手动 `start`，`menu` 打印 `started:true`，随后 `status` 为 0.2.4 connected（pid 19540）。配置和令牌摘要未变。设置窗口走了托盘同一条 `onboard` 命令，点「连接我的账号」后，站点 `POST /api/agent-pairing/requests` 回 404，窗口显示「连接没有完成，请重新获取。」没有 8 位码，没有倒计时，没有打开浏览器。没有点「允许」。没有发布，没有改集群。详情见[卡 C2 回执](scripts/results/windows-agent-onboarding-card-c2.20261010.md)。

**停点：**交审。只本地提交，不推送。卡 D 等这次验收交回后再做。

## 先前：0.2.3 已装到本机，真实配对被 pair 自己拒绝，停下交审（2026-10-10）

依据 k8s `69fd572e`。包在 `C:\Users\zymun\sunmoon-probe-runs\windows-agent-c2-20261010`。ZIP SHA256 `77eda63720dab2e833541440ff16aaeba46cd6c13fb20e812e75b18a61102ea8`，清单 SHA256 `8c742cfc718ac9e9d5b160bbf26ca6352a09e8fb3a0dd5e627a15d8d90de136b`，`ca_sha256` 为 `76f9012886262cf6974039de8baf16ecd5e79e780237349fdcb95a2ac1aa1b3c`。

本机已从 0.2.2 升到 0.2.3，配置保留，自启开着，开始菜单有「SunMoon 代理」，`status` 为 0.2.3 connected（pid 26184）。同版本重跑只开窗，安装目录未换。0.2.1 形态在临时目录卸完，配置保留。`pair` 不带参数也退出 1，因为 `argv.length` 把子命令名自己算进去了。没有连接码，没有打开核对页，没有换令牌。没有发布，没有改集群。详情见[卡 C2 回执](scripts/results/windows-agent-onboarding-card-c2.20261010.md)。

**停点：**交审。只本地提交，不推送。卡 D 等这次验收交回后再做。

## 先前：卡 C2 审读三处已改，版本 0.2.3，停下交审（2026-10-10）

依据 k8s `dd62bbb0`。源码版本改为 **0.2.3**，这样装到所有者那台 0.2.2 上会走升级，而不是同版本只开窗。外部卸载器在调用旧 CLI 的 `tray stop` 之前，先清掉进程已退的 `tray-stop.json` / `tray.json`。配对失败时设置窗口读 stderr，没有 `result` 就显示最后一行或「连接没有完成，请重新获取。」，「重新获取连接码」可点。核对页只在地址以 `site.json` 的 `web_origin` 开头时打开；批准返回的 `relay_url` 必须等于安装包里的 `relay_url`。429 之后下一次多等一个间隔。

没有组 0.2.3 包，没有发布，没有改集群，没有动本机正在运行的 0.2.2。详情见[卡 C2 回执](scripts/results/windows-agent-onboarding-card-c2.20261010.md)。

**停点：**交审。只本地提交，不推送。审过再组 0.2.3 包。之后所有者在 Windows 上核对：同版本重跑只开窗；从现装的 0.2.2 升级（配置保留、自启开着、开始菜单有入口）；0.2.1 形态用临时目录模拟；最后一次真实配对（会换令牌，这台会断开后重连）。

## 先前：卡 C2 已本地提交，停下交审（2026-10-10）

依据 k8s `390aabf2`。版本当时仍是 0.2.2。`pair`、四步设置窗口、开始菜单「SunMoon 代理」、安装时默认打开自启，以及 `install.ps1.tmpl` 的升级都在源码里。已安装目录按自己的清单核验；残留且进程已退出的 `tray-stop.json` 会清掉并视为已停。升级不绕过「已安装不能覆盖」。

没有组包，没有发布，没有改集群，没有动本机正在运行的 0.2.2，没有真实配对。详情见[卡 C2 回执](scripts/results/windows-agent-onboarding-card-c2.20261010.md)。

以下记录为先前阶段；与本节冲突时以本节和 SDD 0012 为准。

## 先前：0.2.2 已换上登记库 CA，本机自启验收完成，停下交审（2026-10-10）

依据 k8s `099da205`。随包证书改为 `CN=SunMoon Registry Local CA`，DER SHA-256 `76f9012886262cf6974039de8baf16ecd5e79e780237349fdcb95a2ac1aa1b3c`。源码 `294aa1de9939a8635f4ed93014557591318e824c`。ZIP SHA256 `007c9882fbb50391b21813f3c222fff98085e58f19df176c3d9599f59cce2bc6`，清单 SHA256 `8e11fbbe294aaf29f4ffe6e8e8225b007920935e863dd76810e5f429063b3510`。

本机已保留配置换上这包。甲 `authorized=true`、签发者 `SunMoon Registry Local CA`；乙失败 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`。重启登录后没有手动启动，status 为 0.2.2、connected，后台命令行带 `--use-system-ca`，`NODE_EXTRA_CA_CERTS` 指向安装目录 `site\ca.pem`。托盘打开了查看状态和设置，状态窗口为「在线 / 无连接错误」。自启保持开着。没有发布，没有改集群。两个卸载缺陷和 C2 都没动。详情见[卡 C1 回执](scripts/results/windows-agent-onboarding-card-c1.20261010.md)。

**停点：**交审。只本地提交，不推送。

以下记录为先前阶段；与本节冲突时以本节和 SDD 0012 为准。

## 先前：卡 B 三项审读修正已提交；全量测试有环境挂起；DNS 只读核实完成（2026-10-10）

设计由 Fable 定稿，唯一实施依据为 k8s
[SDD 0012：Windows 本地代理安装与首次接入](../k8s/docs/dev-investment-agent/tree-build/SDD/modules/0012-agent-onboarding.md)。
上一版一页方案已标为历史，不可据其冲突内容实施。

卡 A 已用 Edge 原始 ZIP 完成：包 SHA 与发布记录一致、ZoneId=3；Explorer 解压后 90 个文件通过清单核验，关键文件保留 Zone.Identifier。Smart App Control 为 On、Device Guard enforcement 值为 2。`.cmd`、`.vbs`、指向签名包内 Node 的 `.lnk` 默认打开均被策略拒绝；Code Integrity 有 3033/3118 事件。详见[卡 A 回执](scripts/results/windows-agent-onboarding-card-a.20261009.md)。所有者决定不购买代码签名证书。

卡 A2 按所有者/Fable 判定通过：loopback 单次下载、SHA256、无 `Zone.Identifier`（原检查输出 `"zoneIdentifier":false`）、解压 90 文件及 manifest 摘要均通过；包内 Node 执行并触发安装器自身“已安装不能覆盖”保护，证明该 Node 执行路径没有被智能应用控制拦截。所有者确认等价路径此前已打开 `desktop.ps1` 托盘；网页登录确认换令牌后到期为 2026-11-08（30 天）。A2 与卡 A 的精确临时目录均已清理，单次服务已退出；未安装、卸载或改令牌。详见[卡 A2 回执](scripts/results/windows-agent-onboarding-card-a2.20261009.md)。

卡 B 初始提交 `9bcff86` 经 Fable 审读后，三项修正提交为后端 `304f8a3`：CTE 锁定并返回旧令牌密文后清空；迁移不变量纳入 0014；来源 IP 从右向左剥可信转发跳、支持多条 XFF，并补伪造链用例。投资父仓子模块指针待同步提交。ruff、import-linter、实现文件 pyright 通过；单测与迁移不变量 21 通过。全量 943 项在第 9 项后挂于既有下载 HTTP 合约测试，Ctrl+C 退出 130；两个测试数据库变量均未配置，3 个真实 PostgreSQL 用例跳过，故全量/数据库验收未通过。详情：[卡 B 实施回执](scripts/results/windows-agent-onboarding-card-b.20261009.md)。

随后按排队事项只读检查边缘集群 DNS：所有节点 Ready；CoreDNS 只固定 Harbor 到 `172.18.0.1`。投资 API Pod 的 `getent hosts` 显示 casdoor、relay、investment 均为 `127.0.0.1`，而 Harbor 为 `172.18.0.1`；Pod `/etc/hosts` 无对应项。**未改集群、未发版、未动公网 DNS**。完整原始输出见卡 B 回执；交 Fable/所有者复核后再决定下一步。

**停点：**交 Fable 复审三项修正与环境挂起证据。卡 B 全量/数据库验收未通过，不进入卡 C/D，不发布、不改集群。DNS 仅完成指定只读核实；三个域名当前得到 `127.0.0.1`，未擅自改 CoreDNS，等审读定下一步。只本地提交，不推送。

以下记录为先前阶段；与本节冲突时以本节和 SDD 0012 为准。

## 当前：托管候选已审读接受，Cursor 发布卡已准备（2026-10-09）

反馈基线 k8s `67e9fa97`；Fable 审读提交 `71048534`，已由同步合并提交 `723d637d` 带回。
**先读 [本轮交回与检查记录](scripts/results/agent-release-hosting.20261009.md)。**

| 单元 | 本地提交 / 结果 | 当前状态 |
| --- | --- | --- |
| 下载与四项页面 | backend `a01db6f`，web `2095c04`，parent `231f305` | Fable 接受；未发布 |
| 投资源码版本锁 | k8s `87f56ec2`，锁至上述 parent/backend/web | 已提交 |
| 分阶段 Cursor 发布卡 | k8s `70528a59`，inbox 35；已标注 Fable 审阅/所有者通知前不执行；旧 stage2 待办已移入 done | 等审阅后再由 Cursor 执行 A/B/C |
| 托管与上传代码 | k8s `2966f98b`：独立读写身份、原部署链、Make 校验/条件上传/读回回执 | 候选接受；未实机 |
| 检查 | backend 667/258 跳过；web 226/2 跳过；构建通过；上传单测 10 通过；实际 Make 验包通过 | 后端专用测试库未配置，跳过不算通过 |

包仍为 `6de6002` / Agent 0.2.1：174243923 字节，90 文件已核；未重组。
真实桶/身份、上传读回与三段发布未执行。浏览器真人下载→安装→领令牌→在线、GUI 真人允许、重启/UAC/干净机、
两次旧投影原始参数仍待验；MCP URL 留下次自然实测。细节与回退见报告和
k8s `gitops/components/app-platform/investment-app/investment-backend/agent-releases/README.md`。
只本地提交；所有者用 `human-remote.sh` 同步，助手不自行 fetch/pull/push。

以下为历史记录，以本节和本轮报告为准。

## 当前：网页接入入口已补齐，提交后等待所有者拉新反馈（2026-10-09）

本轮反馈基线 k8s `bf15ce3d`；网页 `2e62fcdf8db800801d9782ad485a3bf5266d96ac`，
投资父仓 `459e08252c0894c731c81ae15f837bd8107229fa`。后端 `ed77f73` 与代理包 `6de6002` 不变。

- 首页、工作、专家、新建项目与侧栏统一去「我的电脑」；按钮「接入电脑」，中英文同步。
- 显式聊天入口 `?mode=chat` 不显示接入提示；通用首页保留首次欢迎卡。
- 接入按下载→安装→令牌→目录→在线引导；前两步本人勾选，后三步只读状态，不能替代真实安装/授权验收。
- 网页 **220 通过 / 2 原有跳过**；类型、lint、i18n（687 键）、生产构建通过。
- 原始成功与失败输出、重跑命令、完成边界见
  [本轮交回](scripts/results/windows-agent-entrypoints.20261009.md)。
- **未发布**，真人/UAT 待验不变；k8s 本轮未改，未拉取所有者新提到的下一份反馈。
- 所有者最新指示：先完成本轮并本地提交、通知其同步，随后才读新反馈；不要在这里自行 fetch/pull/push。

以下为历史，以本节为准。

## 当前：下载与首次接入候选完成，停在发布前交审（2026-10-09）

依据 k8s `d1cc2d65`：只本地提交，不自行发布。后端 `ed77f73`（主功能 `8279c2c`）、
网页 `039fa96`、投资父仓 `1b05650`；CLI `43182c6`，固定包源码 `6de6002` / Agent **0.2.1**。

- 代理 JWT 30 天，首次只返回一次；并发、旧 revision 重放拒绝；no-store、Web 身份与 CSRF。
- 后端统一配置下载；未配置显示不可下载。接入 UI 与接口迁到「我的机器」，Settings 保留 key 与偏好。
- CLI `--token-prompt` 隐藏输入；网页命令不含令牌，不进浏览器持久存储或请求缓存。
- 后端 **881/5 跳过**，网页 **205/2 跳过**及生产构建通过；Windows **217/217**，Linux **185/32 专用跳过**。
- 新包 **90 文件 / 477.77 MiB**，ZIP **174243923 字节 / 166.17 MiB**；全文件回验、Windows 隔离安装与 .cmd 通过。
  Codex 0.155.1、Node 24.19.0；官方助手与许可证未删，没有自编译 exe。
- 原 21f864b 完整包保留参考；当前新包在同级 `sunmoon-agent-6de6002`，ZIP 名含 0.2.1 与源码短号。
- 已配置签名的 JWT 路径才有 30 天期限，旧不透明开发令牌不自动改；发布前必须核实签名配置。

详细包摘要、失败原文、重跑与 Fable 发布注意事项：
[接入实施记录](scripts/results/windows-agent-onboarding.20261009.md)。
**未发布/未上线验收**：托管 URL 由远程定；网页与后端需配套发布；下载/首次接入真人闭环待验。
GUI 正向、网页肉眼在线、重启/UAC/干净机，以及历史两次投影与 MCP 完整 URL 缺口保持待验。
本轮清理结果见实施记录最后一节。以下为历史，不覆盖本节。

## 最新审读：实现接受；下载接入先交方案（2026-10-09）

已读 k8s `e21dbe58` 带回的 Fable 最后一节：接受 `60b17d1` 以前的真实 MCP、
托盘目录/状态、新包安装闭环和已装实例 relay 在线；仍由 Luna 开发、Fable 审读。

本轮仅文档和只读调查：

- [下载与首次令牌一页方案](scripts/results/windows-agent-onboarding-plan.20261009.md)
  已写，**未实施**；所有者定案后再改网页、后端、CLI 或发布静态包。
  复用已有签发流程；提出隐藏输入令牌，以及现有 90 天期限与 C-I9 短期要求的待定差距。
- MCP 拒绝 GET 已补查归档和云端持久日志；原探针没保存完整 URL，日志未补回。
  **完整地址和是否认证元数据仍未查实**，没有猜测或宣布完成；本次回显成功证据不变。
  见 [原报告末尾补查](scripts/results/windows-agent-2-mcp.20261009.md#2026-10-09-审读补查拒绝请求的地址仍缺原始证据)。
- 本轮不运行产品测试，不启动/停止测试代理，不更改令牌或线上部署；未改变交付包。

待验保持：GUI 真人允许→审计→执行；已装实例网页肉眼在线；真实重启登录；可选 UAC；
干净 Windows；两次旧 `environmentConfig/read` 原始拒绝参数；上述 MCP 完整地址补证。
只本地提交，由所有者同步给 Fable。下面“最新”及执行表保留历史，以本节为准。

## 最新：自动化开发与新包验收完成，真人步骤后置（2026-10-09）

**先读 [本轮交付与 Fable 提醒](scripts/results/windows-agent-3.20261009.md)。**
所有者要求持续做不需要真人的工作，并改为较大阶段提交。

- `b5ba251`：托盘可读状态与目录勾选；`21f864b`：原生界面保存、审批时序、回归与文档。
- Windows **206/206**，Linux **174/32 专用跳过**，发行两端各 **27/27**；
  当前产品源码 Linux 真实模型最小对退出 0，六项 pass。
- 固定 `21f864b` 新完整包：实际安装→后台→关托盘保活→停止→卸载保留配置→重装→显式删除
  隔离配置通过；交付包内的设置窗口也实际三轮保存/重开通过。
- 已安装程序以普通用户/unelevated 真实连接 relay，云端查询确认在线；进程路径位于
  实际 `Local\Programs\sunmoon-agent`，应用控制值仍 1；未关闭系统策略。
- 实际 token 未出现在包、结果、运行 status/日志；原配置和网页项目三文件摘要不变。
- 只保留新交付包；三处失败合成夹具、重复 WSL 包、旧候选和归档日志副本已清理。
  私有临时配置与安装实例已正常停止卸载，测试任务/进程无残留。

当前交付：`C:\Users\zymun\sunmoon-probe-runs\windows-agent-3-20261009\sunmoon-agent-21f864b`。
清单 SHA256 `e04d0cd3b2b865a638ca1d2425423e5d7dcf5b2d16211a19439b044fc6cf705d`。
本报告提交不改变包内产品源码；`9f2b5c6` 目录已核对删除，旧文档路径仅作历史。

**仍待验：** GUI 真人允许→记账→执行；已装版本网页人工在线检查；真实重启登录自启；
可选 UAC setup；干净 Windows。旧两次投影缺原始参数仍待定位，不猜原因、不放宽策略。
下载与首次令牌的网页入口按所有者要求另定；不擅自扩展网页/后端。
本轮真实 MCP 已在 `73bb78c` 完成并清理，不再列为完全未做。

**同步与发布：** 本轮只本地提交、不 push；Fable 在 luna 审读，整体完成再合入。
在 luna 合入 fable 前不能从 fable 发投资后端/relay，当前现网仍是已验的 luna 发布版本。
下面执行表及停点是过程/历史，以本节和最新报告为准。

## 当前执行表：连续完成自动化，真人动作后置（2026-10-09）

所有者已统一授权本轮开发、安装、启停、联网和清理；随后说明去休息，要求持续做
不需要真人的工作。**不再逐项请求业务授权；不代填产品确认码、不自动点 UAC。**
Windows 机器的重启登录、网页人工查看、GUI 真人正向批准、干净机验收留明确待验记录。
所有者最新说明会陪同开发，改为**较大阶段提交**，不再每个小段提交。
源码组包前仍须固定本地提交；中途接手者从最近提交继续，未完成项和失败输出随记录保留。

| 顺序 | 工作 | 当前状态 |
| --- | --- | --- |
| 1 | 托盘状态可读：在线/离线/原因，避免直接展示 JSON | 原生解析、六种状态文案通过 |
| 2 | 目录逐项勾选、记住未勾选项、只有已选项授予权限 | 原生读写边界及三轮实际 WinForms 保存/重开通过 |
| 3 | 核对既有 GUI 允许→审计回执→执行链并补自动回归 | 新增等待/迟到回执桥检查通过；Windows 206/206；真人 GUI 正向后置 |
| 4 | 固定源码组新完整包，实际安装、后台连接、启停和卸载 | 待代码回归完成后执行，不把 API 在线当网页已人工看过 |
| 5 | 当前源码 Linux 最小对、安装/托盘回归、维护文档 | 按依赖顺序执行；失败保留输出并修复 |
| 6 | 清理临时现场，更新逐项证据、本地提交 | 本轮最后执行；不推送 |

下载入口/令牌发放涉及网页与后端，按所有者决定在代理端完成后另定，本轮不扩大实现范围。

### 功能段 1：托盘状态和目录勾选（00:43）

`rootChoices` 仅记录本机候选，实际权限仍只读 `roots`；向后兼容旧配置。
可以全部不选，CLI roots add/remove 与界面候选保持一致；安装/控制目录不能加入候选。
Windows **204/204**；Linux **172 通过、32 Windows 专用跳过**；TypeScript 编译通过。
原始输出：`scripts/results/windows-agent-3-ui-20261009/{windows,linux}-tests.log`。
本段无失败。原生回归还覆盖了真实沙箱写入、批准后无审计回执拒绝、私有桌面、目录联接防护、
20 秒断连恢复和临时任务清理；批准回归使用测试回调，**不是 GUI 真人“允许”验收**。
下一段：自动检查实际 WinForms 目录选择保存、状态文案，核对权限链，再固定源码组包。

### 功能段 2：原生界面保存与审批时序（00:53）

三轮真实设置窗口（生产函数 AST 原样执行）与真实 CLI 配置保存全部通过；
Windows **206/206**、Linux **174 通过/32 专用跳过**，发行检查两端各 **27/27**。测试器首次无法关闭保存通知，
失败输出保留，修正为精确测试 PID/窗口关闭；没有自动批准权限弹窗。
详见 [本轮界面报告](scripts/results/windows-agent-3-ui.20261009.md)。

当前源码 Linux 真实模型最小对退出 0：外沙箱启动、真实 L3 写入、L1 danger 请求在协议层拒绝，
六项判定均通过。上游模型列表刷新数次超时，但两次 turn 实际完成；错误保留在 `linux-it-turns.out`。
探针已退出并清理隔离进程，未发布任何服务。
下一段固定本提交组包，然后安装/启停/卸载与已装实例真实在线检查。

## 当前分工与继续顺序（2026-10-09，所有者纠正）

**仍由本地 Luna 开发，Fable 审读；构建/发布需要时委托 Cursor。** 所有者明确撤回
“明天交他人开发”的旧安排。下面的交接和反馈原文保留作历史，不能据此停止当前开发。

已读 k8s `86f51c9e` 带回的深夜反馈。该反馈的 runtime 审读基线为 `a95910f`；
其“尚未组完整包/验安装闭环”早于后续 `9f2b5c6` 修复、`3d5b48e` 报告和 `97d7490` 清理。
安装闭环已有真机证据；**不等于 Fable 已审过这三个后续提交**。

| 顺序 | 本轮安排 | 状态 |
| --- | --- | --- |
| 1 | 核对完整包安装闭环的既有证据及固定版本 | 已核；不重复宣布为新的运行结果 |
| 2 | 真实云端 app-server → Windows 执行器 → 本机 MCP 回显 | 本轮已获批准、真人导入，实际调用通过；退出与清理通过 |
| 3 | 整机重启后的自启、干净 Windows 安装 | 待约环境，不擅自重启或新建虚拟机 |
| 4 | 旧两次投影拒绝定位、GUI 正向和当前 Linux 最小对 | 仍待验，证据与结论分开记录 |

**发布限制：luna 整体并入 fable 前，不得从 fable 发布投资后端或会合点 relay。**
现网对应 luna 的 k8s `4b6746bc` 发布，不能因 fable 同名服务存在就以其旧声明覆盖现网。
这项是反馈明确指出的版本约束；本轮没有发布。

本轮操作范围与记录：[真实 MCP 续验](scripts/results/windows-agent-2-mcp.20261009.md)。

本轮 MCP：使用最终候选 `9f2b5c6`，真实 `mcpServer/tool/call` 返回固定 marker，
`isError=false`，云端探针退出 0。9 次 HTTP 帧全部是 stop；其中 1 次非精确地址请求被拒，
另有 8 次越界 fs/getMetadata 拒绝，未影响成功调用。没有放宽产品策略。
00:18（本地时间）代理正常 exit=0；随后回显与两个测试终端停止，relay agents={}，
临时网络关闭、整个本轮目录及令牌副本删除，原配置摘要保持。明细见上述报告。
两次配置投影本轮均成功，不足以解释旧的两次拒绝；旧问题仍待定位。

本轮只改探针的公开诊断字段与文档，没有修改最终包、重跑全套回归或发布镜像。
真实重启、干净 Windows、GUI 真人正向、可选 UAC setup、旧投影定位、当前 Linux 模型最小对
仍待验。旧交接文档的 7 项待验表为历史；其中真实 MCP 一项现已关闭。

## 交接停点：现场已清理，明天由其他人继续（2026-10-08）

所有者在最终报告后追加要求：清理现场、给 Fable 写接手提醒、再本地提交。
本次只执行这三项，没有继续功能开发、真实联网 MCP 或新部署。

**请 Fable 先读 [接手说明](scripts/results/windows-agent-handoff.20261008.md)，并在下一位开始前提醒。**
其中包括已验/待验、固定包与源码、保留环境、真实会话位置、安全限制和重跑方法。

- 唯一候选保留 `sunmoon-agent-9f2b5c6`；清理前后全目录摘要验证通过。
- 旧 Windows 候选、WSL 重复包、四轮已停止的临时代理目录已删除。
  共 28 个精确目标、822 个文件，逻辑大小约 **2.34 GiB**；不等同 C 盘实测释放量。
- 临时测试输出先按字节归档；失败证据保留。删除清单与复核见
  `scripts/results/windows-agent-cleanup-20261008/`。
- Windows 本轮测试进程、`SunMoonAgent-*` 任务、临时安装/原生测试家无残留。
  网页项目三个验收文件摘要不变；依赖副本、符号链接夹具、既有 elevated 家保留供接手。
- 测试机器离线是预期状态；没有重新启动原已停止的 Linux 代理，也没有更改真实用户配置。
- 第 2/3 段尚有 **7 项待验**，详见交接表。第三段最新全测 Windows 204/204、Linux 172/32；
  新增交接提交不改变 `9f2b5c6` 的发行源码。

只本地提交；提交后停止编辑，等待所有者同步。以下临时目录与“正在演练”等描述为历史记录，
**当前现场以本节和接手说明为准**。

## 最终停点：三项顺序完成，等待所有者同步与 Fable 审读（2026-10-08 23:40）

**本轮到此停手，不再启动新任务。** 所有者要求 23:50 前最后提交；以下报告提交仅记录结果。

1. `5f8d208` 已保存全部当时改动、实际结果、失败原文与 Windows 重跑方法。
2. `a95910f` 完成 HTTP 精确本机确认列表、禁止跳转、禁网拒绝和越界测试；所有者确认同步成功。
3. `9f2b5c6` 修复整包演练发现的卸载路径身份问题；新包从头实际完成：
   **安装 → 启动 → 关闭托盘后保活 → 停止 → 卸载**，保留配置摘要一致；再装后
   显式删除隔离配置也通过，项目仍在、测试任务不存在，失败夹具已恢复清理。

最终结果：Windows **204/204**；Linux **172 通过、32 专用跳过**；发行测试两边各 **27/27**。

最终包位置：`C:\Users\zymun\sunmoon-probe-runs\windows-agent-3-20261008\sunmoon-agent-9f2b5c6`。
89 文件，500955617 字节（不含清单），约 477.75 MiB；清单 SHA256：
`95d9219ee12ffeb9b5a992523f9f8a0a8348bfce3c1b2d5c2be79d52f6511946`。
固定源码 `9f2b5c60b738b51d9cb757fd574ccd479cc40874`，本报告提交不改变发行内容。
旧 a95910f 交付目录为失败中间候选，勿用于正式安装。

报告：[windows-agent-3.20261008-2340.md](scripts/results/windows-agent-3.20261008-2340.md)。
原始输出、失败恢复、真机策略与交付 JSON：`scripts/results/windows-agent-3-20261008/`。
日常入口：`agent/distribution/README.md`，包内 README.txt。

**仍待验，未写通过**：真实联网 MCP、整机重启自启、无 Node 干净 Windows 10/11、
GUI 真人正向批准、可选 UAC setup、旧两次投影拒绝完整定位；当前源码的 Linux 模型最小对
本轮未重跑（保留第二段已有结果）。真实 MCP 若请求跟随跳转，本机将拒绝，不临时放宽。
本轮没有改应用或 k8s，没有真实账号连接、没有部署或重启服务；只本地提交、不 push。

以下为过程记录；若状态有冲突，以本节及最终报告为准。


## 第 3 项演练中发现并修复卸载身份路径错误（23:32）

所有者已确认第 2 项提交后同步成功。第三项按固定 `a95910f` 组包，89 文件，
500955386 字节；清单 `0ae35dbc8c8538790de6ed2a6da81888ae1d7bee5dbe9ff6787a0fe61f48487a`。
隔离真实包已完成安装→启动→关闭托盘（后台保活）→停止。卸载失败，尚未标闭环通过：

```text
Uninstall stopped: Cannot complete autostart; installation and config kept
```

原因：外部卸载器以交付包 node.exe 调用已装 CLI，自启任务原记录的是已装 node.exe，
精确身份检查正确拒绝不匹配。修复为：卸载器仍在外部运行，但启停/删除任务的短命子进程
使用已装 node.exe，等待退出后再删程序文件。没有放宽任务归属检查。
失败输出 `scripts/results/windows-agent-3-20261008/package-first-failure.log`。
失败夹具 `C:\Users\zymun\sunmoon-package-test-HrewXN` 暂保留，任务已注册但代理停止；
使用修复包按原安装摘要完成精确卸载后，再从头重跑。最终结果将另记，不据代码宣称修复通过。


## 最新：第 1、2 项已完成，准备隔离安装闭环（2026-10-08 23:25）

- 第 1 项提交 `5f8d208`：全部现状、真实结果、失败原文和重跑方法已保存。
- 第 2 项：`http/request` 仅准启动时从本机已确认 `mcp.json` 取得的 enabled 地址，
  **完整 URL 字符串完全相等**。协议、主机、端口、大小写、路径、尾斜杠、查询和编码变体
  均不扩大匹配；未配置、disabled、未知目标一律拒绝。
- 必须显式 `redirectPolicy=stop`；follow、缺省、null 均拒绝；禁止 Host/代理身份头覆盖。
  网络开关 false 时，即使地址已确认仍拒绝。云端参数不能提供或扩展确认列表，临时权限
  提示不能放行不匹配的 HTTP。改 MCP 需本机重新确认并重启；运行中使用固定快照。
- 专项 Linux **59 通过、3 原生跳过**；Windows **62/62**（其中 HTTP 45 项）。
  真实固定版执行器收到 302 时返回 302，跳转目标命中数 **0**；普通和流式回包通过。
  输出 `scripts/results/windows-agent-3-20261008/http-exact-url-windows-62-pass.log`。
- 这只是隔离回环执行器验证；**真实联网 MCP、真实重启、干净机器仍未验**。
- 同步报错原因：所有者脚本在第 1 项提交后运行，第 2 项编辑恰好进行中，runtime 再次变脏。
  没有丢提交，不需要 reset。第 2 项提交后六个父仓工作区已逐一只读检查。
  等同步结束再写第 3 项报告；组包/演练先放临时目录，避免同步与编辑重叠。


## 当前停点：先提交现状，再收窄 HTTP，最后安装闭环（2026-10-08 23:20）

所有者最新顺序：①先提交全部改动与本节；②`http/request` 只准本机确认过的精确 MCP
地址/路径、禁止跳转、禁网拒绝，补越界测试并提交；③有时间再实跑安装→启动→关托盘→
停止→卸载并提交。**23:50 前停手做最后提交**。真实 MCP、整机重启自启、干净机器仍待验。

### 本次已在 Windows 真机验证

- 第二段真实本机 CLI 人工批准、后端事务提交、relay recorded 回执、随后 Windows 写入；
  网络仍关闭。报告 `scripts/results/windows-agent-2.20261008-2315.md`。
- 本机普通用户原生回归 **179/179**；Linux **148 通过、31 Windows 专用跳过**。
- 发行清单/隔离安装与卸载单元检查 Windows、Linux 各 **27/27**。
- 原生后台单实例、停止/再启动、关托盘后后台仍在、设置保存、拒绝配置根变为可写根、
  拒绝过期 stop 身份、GUI 取消不放行、登录任务 Limited 注册→手动触发→移除。
- 原生固定 Codex HTTP 的普通/流式回环响应；**只在合成配置、隔离端口测试**。
- 20 秒连接闪断后执行器保活、吊销退出和进程树清理仍通过。

### 只有代码，或不能当作已通过

- 新版完整发行包还未组包；`probe/windows-stage3-package.mjs` 已写但**尚未执行**。
  已测的是源码原生后台和发行器单元，不是本轮真实安装包的完整闭环。
- 可选 UAC setup：脚本解析已验，真实 UAC 与 elevated 安装未执行。
- GUI 真实人工“允许”后完整审计链未验；已验 CLI 真实批准和 GUI 取消拒绝。
- 真实联网 MCP、两次旧投影拒绝的完整 cwd 定位、真实重启自启、干净 Windows 10/11
  **待验**。开发机去掉 Node PATH 也不能代表干净机器。
- 当前 HTTP 代码仅检查协议字段及网络上限，**地址约束尚未达到所有者最新要求**，下一提交
  必须收窄之后才组交付候选；不把这一中间提交作为完成品。

### 本轮失败输出与处置（保留，不掩盖）

第一次 Linux 在工作区沙箱内运行，回环/子进程权限被阻止，并误收 node:test 文件：

```text
Error: listen EPERM: operation not permitted 127.0.0.1
Error: No test suite found in file .../distribution/test/bundle.test.mjs
Tests 21 failed | 126 passed | 28 skipped (175)
```

改为经批准的宿主测试；新增 `vitest.config.ts` 明确只收 `test/**/*.test.ts`，发行测试用
`node --test` 单独运行。最新 Linux 148/31、发行 27 通过。

Windows 第一次多出一个旧 status 退出码断言失败（此前无 status 文件退出 1，现在查询
成功返回 JSON `running:false`、退出 0）：

```text
FAIL test/cli.test.ts > Windows CLI capability admission
AssertionError: expected +0 to be 1
expect(run("status").status).toBe(1);
Tests 1 failed | 175 passed (176)
```

更新为检查退出 0 和 running:false。第二次新增桌面测试把已经被策略拒绝的 false 当作
应被转发，失败如下（完整输出见 `windows-failed-before-assertion-fix.log`）：

```text
FAIL test/windowsBridge.test.ts > Windows bridge follow-up contracts
> forces a private desktop even if a remote client requests the interactive desktop
SyntaxError: "undefined" is not valid JSON
Tests 1 failed | 178 passed (179)
```

保留拒绝策略，修正断言为“false 拒绝；省略时转发强制 true”。最新 Windows 179/179，
完整输出：`scripts/results/windows-agent-3-20261008/windows-179-pass.log`。
未解决的真实 MCP 拒绝/旧投影信息见第二段最新报告，不列为测试已通过。

### Windows 如何重跑（普通 PowerShell，无真实令牌）

当前隔离副本：`C:\Users\zymun\sunmoon-probe-runs\windows-agent-2-20261008\agent`。
先用当前提交更新 src、test、native、distribution、vitest.config.ts；副本依赖保持锁定。

```powershell
Set-Location 'C:\Users\zymun\sunmoon-probe-runs\windows-agent-2-20261008\agent'
$Node = 'C:\Program Files\nodejs\node.exe'
$env:SUNMOON_TEST_ELEVATED_HOME = 'C:\Users\zymun\.codex-probe-exec'
$env:SUNMOON_TEST_SYMLINK_FIXTURE = 'C:\Users\zymun\sunmoon-probe-runs\windows-agent-2-native-links-20261008'
& $Node node_modules/typescript/bin/tsc -p tsconfig.json
if ($LASTEXITCODE -ne 0) { throw 'compile failed' }
& $Node node_modules/vitest/vitest.mjs run
if ($LASTEXITCODE -ne 0) { throw 'native tests failed' }
& $Node --test distribution/test/bundle.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'distribution tests failed' }
```

既有 elevated 家必须无认证数据，不复制 `.sandbox-secrets`；符号链接夹具是此前单独准备的。
测试创建独立临时目录和本用户任务，使用合成令牌/本机回环，最后移除自己的任务。
GUI 取消测试会短暂打开明确标注的隔离窗口，不要批准它；不执行 UAC 或真实重启。

以下是此前记录，状态以本节及之后追加的停点为准。

## 并行准备：第 3 段组包与首次安装（2026-10-08）

所有者明确允许先做第三段独立工作，覆盖任务书原先“等第二段审完再开始”的顺序限制。
第二段仍按下面的 Cursor 待办验收，尚未宣布通过。第三段只新增
`agent/distribution/`；不改本次 Cursor 固定的代理运行源码和协议。

- 单目录包含官方 Node 24.19.0、Codex 0.155.1 及完整 Windows 资源、固定 JS 依赖；无自有 exe、无 Python。
- 提供固定源码组包、全目录校验、首次安装预览/执行；已有安装拒绝覆盖，保留私有配置。
- 默认不启动、不注册登录任务、不提权。后台/托盘/退出/自启/卸载待第二段验收后接入。
- 实现与任务表：`agent/distribution/README.md`。测试与真实候选包结果另记第 3 段准备报告，不能当完整第三段通过。

3a 代码 `c56f68c`；Linux/Windows 各 25 项通过，真实包内 Node/Codex/CLI/依赖定位、
无独立 Node PATH 的启动器及隔离首次安装通过。包共 82 文件、约 478 MiB。
报告：`scripts/results/windows-agent-3.20261008-2200.md`。没有启动真实代理、自启、UAC 或真实安装。

**第二段最新回执已核读**：k8s `ee9adbb8`，普通用户 Windows 150/150；
投资后端源码 `db96b401`、relay 源码 `4d0ff043` 已发布，候选 `f6e9aa0b`、晋级 `8d07a0c0`。
71 个 Kustomization Ready、schema 仍 `20261007_0013`。应用控制只读值仍 1。
下一步接回真实 MCP、本机 CLI 确认→工作台持久化→回执、旧投影参数定位；不能把这三项标通过。


## 当前工作：第 2 段，先补跨仓协议，再实现代理（2026-10-08）

Fable 在 k8s `434241be` 的反馈末节已接受 1b。所有者随后授权 Luna 直接修改
第 2 段必要的会合点/工作台接口，验证后向 Fable 报备。只本地提交；所有者同步，
Fable 只在 luna 审读，整体验收后再合 fable。构建镜像/发布交 Cursor 的 switch-test 待办。

| 顺序 | 工作与完成条件 | 状态 |
| --- | --- | --- |
| 1 | 会合点权限报告、工作台持久化回执、版本错配通知；跨仓契约与隔离/重放测试 | 源码完成；relay 39、后端/DB/契约 31 通过 |
| 2 | HTTP MCP 本机选择导入；隔离用户配置/凭据；固定 Codex 原生投影对照 | 代码和原生投影对照完成；真实 HTTP 调用待联调 |
| 3 | 本机 CLI 确认、请求摘要、当前会话权限；断线/过期/拒绝默认关闭 | 本地终端与真实 Windows 写边界已验；云端审计链待发布 |
| 4 | 可操作的拒绝提示；Windows 文件日志轮转与秘密排除 | 已实现并回归；第三方任意 URL 路径秘密仍需本人核对 |
| 5 | Windows/Linux 回归、Linux 最小对；Cursor 发布后真实链路验收 | Linux 124 通过/26 Windows 专用跳过；Cursor 已补齐 Windows 150/150、发布两镜像；最小对 pass；真实链路待验 |
| 6 | windows-agent-2 结果、限制、跨仓提交清单，交 Fable 审读 | 本地候选报告与 Cursor 同机待办；未宣布第 2 段通过 |

发现：旧会合点忽略 hello 后的控制消息；Codex 错配只通知沙箱，代理收不到。
实现通过控制通道扩展，不在 Codex 数据流塞自定义消息。权限仍由本机确认；工作台
回执仅证明报告已记账。Windows 必须保留已接受的内层沙箱，不由云端关闭。
不复用旧 source-before.yaml 回退锁；当前没有重连测试代理或发布服务。

原 Cursor 待办已执行，当前接回 Luna 的真实联调：
k8s `scripts/results/luna-stage2-cursor.20261008-2146.md` 已核读。
报告：scripts/results/windows-agent-2.20261008-2130.md。
Windows replica：C:\Users\zymun\sunmoon-probe-runs\windows-agent-2-20261008。
既有无认证 elevated 测试家只复用，不复制；Node + 官方 Codex，不编译自有 exe、不关应用控制。
之前两次投影拒绝没有原始参数，尚未解决；发布后捕获受限投影参数再定位，不能猜测放行。
Windows 临时授权仅提高白名单内的 managed 权限；danger-full-access 一律拒绝并上报。
仓库协议、部署版本与网页真实验收由 Fable 在本次整体完成后审读；本轮只本地提交。

以下为历史停点，不代表当前待办。

## 当前停点：临时授权修复已上线，真实验收完成，待 Fable 审读（2026-10-08 19:25）

最新完整报告：[windows-agent-1b.20261008-1900.md](scripts/results/windows-agent-1b.20261008-1900.md)。
只本地提交，由所有者同步，不 push；未进入第 2 段。Windows 代理产品保持 3bf4d3d，仍为 Node + Codex。

| 工作 | 已完成 |
| --- | --- |
| 后端恢复 | ab4da306；心跳排持久探测、公开协议确认 ready、账房原子恢复；63 项通过，静态/架构检查通过 |
| 网页修复 | 9c47e303；非终态停止、窄屏按钮、项目占用说明、首句失败复用会话；192 项通过/2 项原有跳过 |
| Redis 与发布 | k8s dfe30caa、1fd485d3；有界频道、真实回环/越界拒绝；原生发布与 application-check 通过 |
| 原专家 | 同一个 Task 只恢复一次，18:57:09 SUCCEEDED，保留失败 Attempt；所有者确认“专家交回了”及输入框 |
| 普通聊天/工作 | 空闲重启后同会话继续读写通过；运行中重启明确报告命令失败并结束，重连后原会话下一问实际读取通过 |
| 清理 | 第7轮19:22:42正常退出、临时凭据已删；原 Linux 代理初始停止状态与配置不变；隔离数据库/预览/端口转发均已退出 |

不能扩大结论：代理重启时原命令输出未恢复；没有测试仅网络闪断且执行端保活；线上点击取消
只做了测试与预览、没有操作真实任务取消；专家 Profile 与文件问题不匹配，本轮证明状态恢复而非业务答案正确。
两次非致命 environmentConfig/read 投影拒绝仍保留、待远程评估，不为验收放宽边界。

现场 Task=5e77067c-983d-4e0d-a88e-e4e77f68fa71，work session=6e0bc2cf-7c86-4784-9156-5b4d3c7a6e5e。
聊天 session=52511429-3a68-4bb3-a102-55db1e6b4c3f。Windows 测试机器现在按约定停止；
项目里的 browser-check.txt 和 reconnect-work-20261008.txt 保留，不把离线当新故障。
部署真实旧 Flux 锁在 k8s results/reconnect-fix.20261008/source-before.yaml。
后端 HEAD 0f0ae68 只比已部署源码 ab4da306 多测试输出，不需要为此重新构建。
下一步：所有者同步全部本地提交 → Fable 审此次跨仓修复/验收 → 经审读决定是否进第2段。

以下为历史停点，不代表当前状态。

## 当前停点：专家重连卡住已报告，聊天通过，工作补验受专家占用阻挡（2026-10-08 18:00）

runtime 产品代码仍为 `3bf4d3d`；本轮只追加证据/报告，不修改工作台仓、不改任务数据、不 push。
报告：[windows-agent-1b.20261008-1750.md](scripts/results/windows-agent-1b.20261008-1750.md)。

- 专家真实 Task `5e77067c-983d-4e0d-a88e-e4e77f68fa71` 进入 WAITING(ENVIRONMENT) 后，
  机器恢复 online，Task 仍未恢复。MachineSync 只更新机器状态；advisor 不处理 WAITING，
  runner 接管也不包含 WAITING。请远程补合法状态迁移与幂等重新调度。
- 第一轮断开是我设置的 10 分钟联调计时器到期，并非确认的网络故障；“请专家读文件”误入
  DATA_QUERY SQL 流程，测试指导不合适，已经说明。1b 仍未通过。
- 普通聊天/工作已核对原前端投影，五组合成事件诊断通过：只有断线/error 没有终结事件时均保持忙碌；
  有 turn/completed/command-failed 则可收尾。**这不是现网普通会话重连通过或失败的证据。**
- 所有者说“重新来”，已重新单项引导：先在 myproject 新聊天只读 browser-check.txt，收到成功回执后
  才安排受控重连，并在原聊天再读；再做工作。不要在用户尚未准备时停代理。
- 新聊天基线及重连后原聊天再次读取均成功，kind=chat；session=`52511429-3a68-4bb3-a102-55db1e6b4c3f`。
  第二轮 17:50:38 正常退出并删临时令牌，第三轮 17:50:58 重连，17:52:03 新 turn 完成；
  所有者实际网页回执与桥新命令相符，browser-check.txt 摘要未变。仅覆盖空闲时断线。
- 工作补验第一句被 API 409 project_held_by_expert 拒绝。专家仍占项目，前端只有泛化错误；
  多次点开始留下四个空 work 会话。已补报告，用户正在通过精确链接停止原专家；不绕过互斥。
  另发现 SSE Redis subscribe 权限不足，已留错误行交远程；不是此次发送 409 的原因。
  报告初版已本地提交 `6f7449c`，新增发现待补提交。
  第三轮监督 `/tmp/luna-1e-watch3.py`、停止标记 `/tmp/luna-1e-stop3`，执行会话 56661，
  Windows PID 9244（操作前复核），最晚 18:20:53 自动停；记录前缀 `live3-`。
  不要把测试私有 config.json 令牌副本提交；仍需归档第三轮、补工作验收和最终清理。

## 前一停点：网页读写已通过，专家步骤待完成（2026-10-08 17:29）

runtime/luna `3bf4d3d`；已只读确认待办 34 的 Windows 顶层 cwd 修复在现网 runner 生效。
本轮 Windows 代理真实上线后，所有者完成：

- 项目页新聊天列文件：`myproject` 中只有 README.md；真实只读 process/start 正常通过。
- 项目页工作建文件：所有者改为内容 `hello！`；实际 browser-check.txt 字节
  `efbbbf68656c6c6fefbc81` 已核对。首次补丁命令失败，随后 PowerShell 写入及字节核验成功；
  三条命令均通过桥，未放宽沙箱。实际 `file:///data/.codex` read/skip 出现并按反馈丢弃，
  Windows 的 .git/.agents/.codex 只读保护均保留。
- 第一轮完整 95 条请求、62 条拒绝（全部是越白名单 fs/getMetadata）已归档到
  `scripts/results/windows-agent-1e-20261008/round1/`；读写回执在同目录上一级。
- 17:25:29 第一轮因本机联调计时器到期正常退出（0）；原 Linux 代理在开始前已停止，
  保持原状态且配置摘要未变。专家步骤没完成，不能把 1b 记通过。
- 所有者反馈断开后，17:28:48 重连同一台 Windows 测试机器，工作台已确认 online；
  本轮给专家验收 30 分钟，最晚 17:58:45 自动停止，完成则提前停止。

当前临时控制器 `/tmp/luna-1e-watch2.py`，停止标记 `/tmp/luna-1e-stop2`；
Windows PID 16368（操作前再核对身份），当前状态与记录为 Windows 测试副本下的
`live2-status.json`、`live2-frame-projection.jsonl`，日志 `/tmp/luna-1e-live2.log`。
本轮控制器退出后删除临时 config.json 令牌副本。产品代码未变。
下一步等待所有者完成专家 → 留实际三项结果与完整拒绝/退出记录 → 清理本轮私有副本与
试验产物 → 本地提交交审。暂不进入第 2 段。

以下为历史停点。

## 当前停点：可忽略的 POSIX 只读项已处理；待待办 34 上线后补网页三项

基线 runtime `526401c`，反馈 k8s `f14dbc1e` 最后一节；本轮只改 runtime。
远程已接受 a–d，并在 investment-backend `7ac05d2a` 修正 Windows 顶层 cwd。

- 代理只丢弃纯 POSIX、read、skip 同时成立的命令权限项，转发前移除。
  Windows 保护项保留；混合路径、越界、写权限和无 skip 仍拒绝。
- Windows 130 passed / 1 skipped（仍是需预建符号链接夹具的旧用例）；
  Linux 107 passed / 24 Windows 专用 skipped；两端 build/typecheck 通过。
- 原生测试确认：带 POSIX 只读跳过项的项目/受管临时目录写入成功，
  项目外和用户全局 Temp 的写入仍被 OS 拒绝。
- 只读核查现网 runner 时，仍看到旧版顶层 cwd 写法，待办 34 尚未生效。
  因此本轮尚未重连 Windows；Linux 代理未替换，网页三项未验，不报 1b 通过。

结果：[windows-agent-1b.20261008-1710.md](scripts/results/windows-agent-1b.20261008-1710.md)。
下一步：确认待办 34 已上线 → 核对 Windows 项目目录存在 → 临时连接 Windows（限时恢复）
→ 所有者从项目页做新聊天列文件、新工作建文件、请专家 → 完整拒绝清单与恢复记录交审。

以下为历史停点，不代表当前工作要求。

## 当前停点：1b 代理补修完成；真实网页暴露跨系统目录问题，待远程处理

本轮基线 `0c5779d`，按 k8s `c8428efb` 反馈，只改 runtime。
结果：[windows-agent-1b.20261008-0015.md](scripts/results/windows-agent-1b.20261008-0015.md)。

- a–d：受管临时目录、缺失文件原生错误、终止宽限、固定配置读取已实现。
- Windows 原生 128 passed / 1 skipped；跳过的是需要预建 symlink 夹具的旧用例，
  本轮没重新申请管理员创建该夹具，不能说 Windows 全部用例通过。
- Linux 105 passed / 24 Windows 用例 skipped；build 通过。
- 原生 Windows app-server → WindowsBridge → exec-server 默认工作策略建文件成功，
  不排除临时目录；这不能代表 Linux 编排端到 Windows 的网页验收。
- e：所有者确认待办 33 已上线并重拉沙箱。00:02 临时连接 Windows；网页读和写仍失败。
  项目填的是 `workspace\\myproject`，该目录不存在；沙箱 turn_context 另有
  `/data/C:\\…\\myproject/.codex` 混合路径，桥拒绝工作命令。未做专家。
- 已补不存在工作目录的明确错误提示；混合路径不得通过删除保护条目或提权绕过。
- 59 条拒绝完整入仓，原 Linux 代理已恢复在线，原配置摘要未变；临时凭据清理见结果。

**现在不进第 2 段、不报 1b 通过。**远程核对项目目录存在性、thread/turn 的本地 cwd
与 environments 中的远端 cwd；修正后要补 Linux 编排端 → Windows 执行端的真实三项网页验收。

### 本轮执行顺序（留作交接）

只改 runtime，不进入第 2 段；本轮顺序与验收表：

| 顺序 | 工作 | 状态 |
| --- | --- | --- |
| 1 | 固定 0.155.1 真机探针：临时目录解析、缺失文件、已结束进程终止、配置读取 | 完成 |
| 2 | 代理管理临时目录及环境/目录替换攻击；不开放用户全局 Temp | 完成 |
| 3 | 缺失文件回包、结束进程宽限、只读固定配置文件；原生与 Linux 回归 | 完成，覆盖限制见上 |
| 4 | 待办 33 及重拉沙箱；网页三项；恢复 Linux 代理 | 前提确认；读写失败、专家未做；恢复完成 |
| 5 | 新报告、完整拒绝列表、临时凭据清理、本地提交交审 | 本轮收尾 |

反馈已撤回“优先改工作台排除临时目录”的建议：先由代理把 TEMP/TMP 固定到受管目录，
实测 slash_tmp 在 Windows 的行为，走不通才交远程采用退路。以下保留上轮历史，不当作当前指令。

## 当前停点：第 1 段补验 1b，待远程修工作台请求后复验

基线 `9d68ed90dca32193a263b544123122c916b8f088`；按 k8s `87e36b47` 最新反馈，
仅修改 runtime，不进入第 2 段。顺序与完成条件：

1. 用户环境/PATH 继承、保留变量过滤和远端合并；真实工具可发现性验证。
2. 固定 0.155.1 的所有 fs 真回包与 Node 助手逐字段核对，帧追加入 probe/frames.jsonl。
3. opendir 句柄优化先原生实验；失败保留已验过的目录固定方式。
4. 原生攻击回归通过后，临时连接 Windows 代理，由所有者在网页执行聊天/建文件/专家，记录全部拒绝；结束恢复原 Linux 代理。
5. 追加 windows-agent-1b 结果，清理临时凭据/副本，本地提交交审。

第 4 项未实际完成不能写整个第 1 段已交付。

1b 已完成：环境继承与保留项过滤；原生 FS 14 组真回包对齐，修复 walk 顺序、
readBlock 的 eof/零长度错误；opendir 不阻止重命名，保留 cwd guard。
首轮真实网页请求已到达，initialize 被拒 3 次（resumeSessionId:null 漏列）。
已恢复原 Linux 代理且核对配置摘要不变；又用固定版 app-server → WindowsBridge →
exec-server 的无模型探针发现 environment/knowfeed 的 params:null 漏列，两处已修复。
本地客户端现在可取得环境信息并建立线程，白名单外 metadata 与 MCP 配置读取仍拒绝。
第二轮真实网页进入工作模式，process/start 因真实客户端字段不全被拒 4 次，合计 denied=38。
现已补齐 metadata/envPolicy/沙箱启动选项、保留标记核值后丢弃、缺失只读目录保护。
Windows 113 passed；Linux 96 passed、17 skipped。固定客户端本机只读命令通过；
默认 workspaceWrite 额外申请系统临时目录写权限，违反项目白名单；排除两项后本机建文件通过。
这些用确定性本地模型响应驱动，不是网页验收。

**需要改工作台，按任务书停下交远程**：WORK/EXPERT 的 turn sandboxPolicy 显式加
excludeTmpdirEnvVar=true、excludeSlashTmp=true，并核对云端客户端 Windows sandbox 选择。
具体源文件、两组真帧和复验步骤见 scripts/results/windows-agent-1b.20261007-2220.md 第 7 节。
只读查库确认普通“＋新建”不带项目，项目“新聊天/新工作”才绑定机器；未改应用数据。
原 Linux 代理已恢复在线、配置摘要不变。网页聊天/建文件/专家仍未全部成功，禁止报交付或进第 2 段。

## 当前停点：Windows 代理第 1 段完成开发自检，交远程审读（2026-10-07）

本轮基线 `36ec68be9a47386b3a39f387a3a12cd5fe9785d7`；采用所有者确认的
“内层沙箱 + 严格协议过滤”，文件助手使用本机 Node，不依赖 Python、不编译自有 exe。
只修改 runtime/luna，无 fetch/pull/rebase/push，不进入第 2 段。

| 顺序 | 当前结果 |
| --- | --- |
| 1 边界实现 | 逐项核对 process 权限、方法允许清单、FS 读白名单；Node 文件助手由 Codex sandbox 承载 |
| 2 原生攻击 | 普通用户/elevated 对照、联接/符号/硬链接/别名/检查后替换通过；普通 Node 写入由 OS 沙箱阻止外部路径 |
| 3 CLI/生命周期 | init 实际探测并优先可用 elevated；真实启停、20 秒重连、4003 拒绝及子孙进程清理通过 |
| 4 回归/现网 | Windows 98 passed；Linux 82 passed、16 Windows 用例 skipped；原 Linux 模型链路 pass。所有者已确认网页在线，最终 Node 版本也重连现网并恢复原 Linux 代理 |
| 5 交付 | 报告、原始状态和测试结果入仓；清理本轮临时凭据及试验副本；本地提交后等待审读 |

本机 Smart App Control = On，代码完整性状态原值均为 2，自编译未签名 helper 曾被
应用控制拦截。没有改动系统保护。后续打包使用官方 Node + JS + 官方 Codex，禁止自编译 exe。

结果：[windows-agent-1.20261007-2150.md](scripts/results/windows-agent-1.20261007-2150.md)。
安装器/托盘/开机恢复、Windows 10/干净机、MCP、抬高权限交互、真实网页轮换令牌等未做；
明确方法/路径支持范围及其他限制见报告，不将本段说成整个产品已交付。

## 历史：上一提交的受阻停点

以下保留上一提交的事实作为背景，不能当成本轮完成状态。

任务：k8s `switch-test/luna-task-windows-agent.md`；反馈 `luna-feedback.md`（k8s `6ded692ea7a8d5175f5253e4b28a938bb342e3ea`）。本单元基线 `e9f194b3d4178021f035cc81aeb1ed265299970c`；本提交只含 runtime、分支 luna，未 fetch/pull/rebase/push。第 0 段报告和证据保留。

**停在第 1 段安全准入，不能标通过，也不能进入第 2 段。**
结果与复现：[windows-agent-1.20261007-2025.md](scripts/results/windows-agent-1.20261007-2025.md)。

| 顺序 | 已做与剩余 |
| --- | --- |
| 1 内层 + 嵌套探针 | 内层 unelevated 新家无 setup 三项通过；已有 elevated 家三项通过，whoami 确认 `codexsandboxoffline`。外层中的 unelevated 嵌套两次返回 `CreateRestrictedToken failed: 87`；elevated 嵌套超时。只保留外层的诊断对照通过，不能当产品替代方案 |
| 2 代理适配 | 已补 Windows 路径规范化、真实帧 fixture、大小写去重、失败时阻止 Windows start；**自动模式探测、完整启动/进程树生命周期尚未完成**，不可绕过门禁连接现网 |
| 3 回归 | Windows Node 24.19.0 / pnpm 10.24.0：build/typecheck，65 测试通过。Linux Node 24.18.0：build/typecheck，64 通过、1 Windows 专用用例跳过。旧 Linux 模型联调未重跑，不以单元测试替代 |
| 4 现网与网页 | 所有者已授权临时替换并恢复；本次因准入阻塞**未执行替换**。原 Linux agent 仍在线；未轮换令牌、未改现网。任务端口 30471 与私有配置 30443 不一致，后续联调前核实 |
| 5 交回 | 证据、源码、限制与清理记录一起本地提交，由所有者同步给远程审读。需要先解决/审定沙箱承载方案，不能顺手改设计或降级保护 |

关键事实：直接 exec-server 使用 `initialize {clientName}` + `initialized`，`environment/add` 属于 app-server；`unelevated` 配置对应协议 `restricted-token`；真实字段是 `dataBase64`。受限 PowerShell 不能用任意 .NET 方法写文件，探针改 `Set-Content` 后才形成有效证据。

`arg0/PATH os error 5` 在成功和失败组均出现；仅说明不是足以解释全部失败的条件，尚未证明所有 PATH 命令不受影响。没有请求模型服务，也没有绕过阶段 0 的认证地区限制。

遵守 C-C7/C-C8（公开协议、固定 0.155.1）、C-A7（能力不足不启用）、C-A11（本地上限）、F-AGENT-10（执行端无凭据）；依 IMP 规范，设计组合问题交回审读，不在实现中擅自去掉任一层。安装器/托盘/MCP/自动更新仍不在本段。

后续顺序：先审本报告及最小复现 → 在固定协议/版本约束下确认可行的双层承载方式 → 完成 init 实际探测和生命周期 → Windows 本地组合全通过 → 使用已有授权临时替换现网 agent、验网页并恢复 → 第 1 段正式交审。Windows 10 / 干净机器在第 3 段验证。

以下保留原实现背景；旧“Windows 已 pass”仅指 2026-09-24 内层探针，不能扩大为本段完整代理可用。

## 这个仓是什么

`0005-agent` 本地代理：装在用户机器上的唯一东西。包 `codex exec-server`（钉版，随包带），出站连会合点，守本地上限。
设计：`k8s/docs/dev-investment-agent/tree-build/SDD/modules/0005-agent.md`；安全模型：`.../SDD/architecture/security.md`「本地上限」。

## 现在做到哪（第二段：代理与沙箱最小对）

| 部分 | 状态 | 在哪 |
| --- | --- | --- |
| 探针（第一段五个 + 外沙箱） | 全部完成，报告在 `probe/REPORT-*.md` | `probe/` |
| 代理 `@sunmoon/agent` 0.1.0 | 骨架可用：exec-server 守护（Linux 外沙箱 = 随包 bwrap）、出站桥（会合点协议 v1）、协议过滤（process/start、fs 写、http）、CLI（init/roots/ceiling/start/status）；27 个单元测试 | `agent/` |
| 会合点 v1、沙箱侧桥、沙箱镜像 | 在 k8s 仓 `infrastructure/applications/component-images/relay/`、`infrastructure/applications/component-images/sandbox-platform/` | k8s `fable` |
| 一机联调 | `scripts/integration-minimal-pair.sh` **pass**（会合点 + 代理 + 桥 + 真 app-server；danger 被拒、workspace-write 写成） | `scripts/results/` |

## 还没做（第二段剩余）

1. 本地上限弹窗（`F-AGENT-04`）：现在抬高上限只能 `sunmoon-agent ceiling set` 改配置再重启；要做成本机确认的交互（先做 CLI 确认，再做托盘）；
2. 令牌：现在是配置里的静态字符串；工作台签发、公钥就地验是 `D10`；
3. 版本成对：会合点已核对两端 Codex 版本；代理侧收到 reject 后只停不提示更新（`F-AGENT-05` 半成）；
4. macOS：不套外沙箱（只有协议过滤）；`sandbox-exec` 外层待验；
5. Windows：2026-09-24 elevated 探针 pass；2026-10-07 unelevated 结论见当前停点。代理原生 exe、动态端口、可选提权初始化仍未实现；
6. 勾选上送知识服务（`F-AGENT-08`）未做；开机自启（`F-AGENT-09`）未做；
7. 网络硬禁（`--unshare-net` + unix socket）未做，网络上限只有协议过滤 + Codex 自身策略；
8. 两机公网延迟实测等所有者开 47100（switch-test inbox 02）；
9. `F-AGENT-10`：从用户 `~/.codex/config.toml` 合并 HTTP 型 `[mcp_servers]` 到 `codex-home/config.toml`（本机确认、列出条目）；其余不读。执行端家已与 `~/.codex` 隔离（`config.codexHome` 默认 `~/.sunmoon-agent/codex-home`），合并功能未做；
10. `sunmoon-data` skill 与知识服务 MCP 配置进沙箱镜像入口脚本（属 k8s `sandbox-platform`，随 `0006` 一起做）。

## 怎么跑

```bash
cd agent && pnpm install && pnpm build && pnpm test
# 一机联调（需 ~/.codex-probe 有登录态，k8s 仓在 ../k8s）
bash scripts/integration-minimal-pair.sh
# 手工
node agent/dist/cli.js init --relay ws://127.0.0.1:47100 --user local --token agent-secret --root ~/some/project
node agent/dist/cli.js start
```

## 坑

- 找进程按端口（`ss -ltnp`）或 `pgrep -f '[c]odex app-server'`；`pkill -f` 会杀到自己的 shell；
- exec-server 在 stdin 关闭时退出：代理用 pipe 保持 stdin；手工起要 `setsid … < /dev/null`；
- 外沙箱**不能**用系统 `/usr/bin/bwrap`（Ubuntu AppArmor），要用 `@openai/codex-linux-x64/vendor/*/codex-resources/bwrap`；不能用 Landlock（禁 mount）；
- 代理断线不重启 exec-server（会话在它内存里，25 秒窗内要接回同一个进程）。
