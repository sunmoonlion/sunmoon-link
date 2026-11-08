# Link 0.5.6 Windows 常驻调查证据

2026-11-08，Luna 在本地 qwen 工位执行；被测运行代码 sunmoon-link `795d5f831076e87d6b352b79601ac64e476ac2d2`，包内 Codex 0.155.1、Windows Node 24.19.0。本提交只有证据，不改运行代码。

## 文件与边界

- results.json：第一轮，持续stdin两请求（保持30秒）、EOF单请求、最小脚本的输入标记/输出、10/50条批量各3轮、socket+子助手转发探针。
- followup-results.json：持续stdio逐条往返3轮；同文件后半的socket实验因临时适配器转义错误而失败，明确记为探针错误，不作为产品结论。
- socket-results.json：修正临时适配器后，在同一受限进程内把未改的helper模块的stdin/stdout接到回环socket，再做请求、拒绝和3轮计时。命名管道仍用默认ACL，两模式均EPERM；未放宽ACL。
- postcheck.json：150个探针写入文件逐一比对4096字节内容；无目录外写入；模拟敏感文件不变。
- environment.json：本轮同机环境，沿用同日先前探测，未改变Defender设置。
- source-checksums.json：精确Codex标签对应源码摘要及仓外探针摘要。

所有操作只针对自建fixture。真实Codex home仅用于官方elevated启动，不读取或导出凭据；敏感路径拒绝实验使用自己创建的假auth.json和假.sandbox-secrets，内容为SYNTHETIC NOT A CREDENTIAL。拒绝实验分清：OS层的目录外写返回EPERM；敏感读取由实际helper路径策略拒绝，不能据此宣称任意沙箱代码都无法读取任意配置文件。

两模式本次均在EOF前返回小请求，未复现11-01卡住。2字节即收到标记及stdout，无需凑满8KiB；逐步送至336898字节也有流式回包。此结论不抹掉历史失败，不证明所有机器均正常。精确0.155.1源码stdio_bridge.rs使用分块read、逐块发送，stdout write_all后flush；未找到必须等EOF才转发的设计。

network={enabled=false}下，本机127.0.0.1连接实测能通；不据此宣称可访问外网。第一版多进程转发unelevated连接成功但RPC超时，elevated正常；后来同进程IO适配器两模式均正常，前者具体为何超时未查清，原始失败保留。

计时定义：批量从spawn到检测进程结束，检测每100ms一次，故带0–100ms观测偏差；常驻是同一进程已预热后的逐条往返，记录全部单次样本，不含首启。不能直接用预热中位数代替整条用户任务延迟。先前WindowsFiles单次还含真实封装/清理，本轮没有替换该实现。建议需要另审取消、回收、隔离、并发与重连，再由所有者决定实现。

探针在 `C:\Users\zymun\sunmoon-probe-runs\link-056-resident-20261108`，没有进Git。源码从官方openai/codex精确标签读取，本地现有仓checkout未动，未在远程下载或执行。未调用模型、未发Wind请求、未新配对、未触发UAC、未改已安装Link配置。
