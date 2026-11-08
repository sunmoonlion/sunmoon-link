# Link 0.5.6 Windows 实测证据

2026-11-08，本地 qwen 工位。被测源码 `795d5f831076e87d6b352b79601ac64e476ac2d2`，Codex 0.155.1、Windows包Node 24.19.0。这里只有证据，未改运行代码。

- `windows-elevated.json`：安装0.5.6后的实际elevated模式，3轮逐次耗时与服务未启动→启动后同实例恢复结果。
- `windows-unelevated.json`：独立无凭据测试家目录的普通模式，同样3轮。对照组是Node同步fs，不是旧常驻进程；不得据此直接量化恢复常驻后的收益。
- `environment.json`：Windows/CPU/SSD/Defender观测；Defender实时扫描原本关闭，本次没有修改。
- `installation.json`：真实用户安装路径升级、保留既有配对、恢复自启及上线观测。没有新发令牌，不代表全新配对流程验收。
- `packages.json`：Windows/Linux候选包摘要与组包自检；尚未上传发布。
- pnpm在agent目录执行：test为34套通过/4套跳过、358项通过/33项跳过；typecheck通过。跳过项不计通过。
- 首次临时计时脚本漏传waitForPort的alive回调，执行服务启动后报“alive is not a function”。修正的是仓外探针，保留初次失败记录在本地；两份正式结果均为修正后完整3轮。
- 从仓根尝试pnpm --dir agent typecheck时工具链选择到pnpm12而被版本检查拒绝；进入agent目录按锁定pnpm10.24.0重跑通过，未修改锁或跳过版本门禁。

完整临时探针和原始结果留在 `C:\Users\zymun\sunmoon-probe-runs\link-056-20261108`，脚本按请求不进仓。只在自建测试目录读写文件；elevated测试复用现有Codex沙箱配置供官方执行器启动，未读取/导出凭据、未覆盖现有配置。没有模型调用。

临时脚本SHA-256：

- `benchmark.mjs`：`489644c87b1cb97450f5f09fff0aa4c9078dd53aa8ebf8dc71264a8bf025e700`
- `benchmark-elevated.mjs`：`4b56223064d95f0cabed2dbbe41a8d14ed8840f7ec8a410df8d70605a8d90678`
- `environment.ps1`：`c6b134147068c8e6dc7910e027d8a14872396ba16eb3aade038d0411435a333c`
- `upgrade-test.ps1`：`b69377db62a6dbd7fdef41715ea6e8959e63572b9e91f20e0eea5aaf5cc15ee9`
