# Link 0.5.7 Windows 常驻实机验收

2026-11-08，Luna，本地 qwen 工位。运行源码 `686a74c463360b33a56accd41ae0904647323a8a`，Link 0.5.7、Codex 0.155.1、Windows Node 24.19.0。此目录只有验证证据，不改运行代码、不发布。

- windows-unelevated.json / windows-elevated.json：真实 WindowsFiles（未注入 spawnHelper/killTree/timing/fallback），各 3 轮四种计时；常驻 PID、生产 fallback 状态、40 秒空闲退出、句柄保持、崩溃恢复、清理结果。
- packages.json：两种候选包、源码版本、摘要、组包自检；Linux 为 edge-public，Windows 为 dev-kind，均未上传发布。
- installation.json：真实本机 0.5.6→0.5.7，升级前业务/文件桥接连接均为 0，配置文件摘要前后相同，原配对和自启保留，托盘恢复，relay connected。
- environment.json：Windows 11 中文家庭版 build 26300、AMD RYZEN AI MAX+ 395、KIOXIA SSD；Defender 实时防护原为 false，未修改。
- comparison.json：与上一卡 0.5.6 同一 WindowsFiles API 的逐批计时比较。0.5.7 首启另列，暖态数据不能替代完整模型任务耗时。本轮两模式并行，各用独立自建 fixture；上轮环境负载未严格控制，不能作为保证性能的固定倍数。
- web-confirmation.json：所有者在聊天中亲自确认网页浏览目录、建项目正常；不是助手浏览器自动化结果。
- probe-checksums.json：仓外测试脚本 SHA256。脚本保留于 `C:\Users\zymun\sunmoon-probe-runs\link-057-20261108`，未进仓。

35 个测试文件通过、4 个跳过；366 项通过、33 项跳过；pnpm typecheck 通过。两模式真实测试均通过：计时期间单一常驻进程，未退回；40 秒后 Codex/helper 整棵树退出，目录可改名；持有句柄 40 秒仍可读取，close 后 40 秒内退出；仅杀本轮自建 helper，下一调用报错，再下一调用以新 PID 成功；清理后无探针子进程残留。

没有在实机复现 11-01 的 EOF 阻塞，所以未触发生产 fallback；其模拟路径由 windowsFilesResident.test.ts 的单元测试覆盖，不能算实机验证通过。未修改代码强造 fallback，未调用模型、未触发 UAC、未读取或导出凭据。

探针先直接从 WSL 执行安装目录 node.exe，被 Linux 权限检查拒绝；改为经 Windows PowerShell 调用同一原程序后成功，未改 ACL。一次 environment.ps1 用 Linux 路径传给 Windows -File 被拒绝，随后用 Windows 原生命令取得环境。升级进程结束后，WSL interop 包装仍等待继承句柄；核实 supervisor 已结束后只终止 Linux 包装 PID 2651899，Link PID 27100 始终 connected。以上不算产品验收失败，也不隐瞒初次命令错误。
