# 实施与验收

本文记录实施顺序与通过条件。P0 已完成。P1 与 P2 已完成实现与模拟测试；P3 将在从 Git 拉取到 Linux 服务器、配置实际 SSH 地址和端口后进行。

## P0 仓库初始化

1. 将 `shirolabs67/AntigravityAccountSwitcher` 克隆到 Sylvie 的项目共享目录，确认目标仓库的 `origin`、当前分支及现有文件。该仓库独立于外层 SylvieBot 仓库。
2. 建立 README、架构及实施文档，写明项目边界、协议、失败处理、部署前置条件和验收标准。之后再开始服务与插件实现。
3. 锁定插件基线为 `dsh-llm-antigravity-acp` 0.2.0，取自 `lili-luo/dsh-plugin-bundle` 提交 `6aac22493754c5aefb4642b2627c88b136c72b6d`。引入或分发上游插件改动时保留原作者版权和 MIT 许可文本。现场确认 Node.js `24.16.0`、DSH `0.2.1-rc.5` 及插件 `0.2.0`。固定提交来自现场冒烟记录，待对已安装插件文件独立比对。上游声明 Node.js `>=22.19`、DSH `>=0.2.0-rc.1 <0.3.0-0`，README 要求 agy `>=1.5.0`。[固定版本插件](https://github.com/lili-luo/dsh-plugin-bundle/tree/6aac22493754c5aefb4642b2627c88b136c72b6d/dsh-llm-antigravity-acp) · [插件许可](https://github.com/lili-luo/dsh-plugin-bundle/blob/6aac22493754c5aefb4642b2627c88b136c72b6d/dsh-llm-antigravity-acp/LICENSE)

## P1 共享路由器与账号进程

1. 在目标 Linux 服务器核对 Node.js、OpenSSH、`agy`，在两台 DSH 核对插件版本。为两个 Google 账号分别准备 Linux 服务用户、HOME 和专用 CLI 配置目录，在各自身份下运行额度探测与 `agy acp`。先验证两账号能同时保持登录、各自读取额度，并确认进程运行时能访问该用户的凭据与配置。[Linux 账号凭据预检](WORKER.md)
2. 用 TypeScript 和 Node.js 实现共享路由器、SSH stdio 接入与账号 worker。由一个共享进程拥有当前账号与租约状态，每个 SSH 入口向它转交已认证实例的连接。账号 worker 在相应 Linux 服务用户下运行，独立拥有 `agy` 进程、工作目录和诊断日志。账号顺序、阈值、固定提示、模型组映射和实例端口从本地配置读取。发布样例使用占位符，实际凭据和私有配置由部署环境管理。
3. 在每次新 DSH 回合取得租约时探测目标模型组。记录该账号五小时和每周剩余量，取两项的较低值。以当前账号为起点按配置顺序最多绕一圈，选择第一个达到阈值的账号。默认阈值为 5%，等于 5% 可用。仅整圈每个账号都明确低于阈值时返回额度不足结果。未登录、探测超时、命令失败、组或窗口缺失、比例无效都属于探测失败。如果整圈找不到可用账号且有探测失败，按诊断错误处理。用实际安装版本采集脱敏 `agy -p /usage --output-format json` 样本，验证分组、窗口字段和比例单位。上游插件把缺失比例转成零并可回落到第一个组，路由器需要独立进行严格校验。[Google 额度说明](https://antigravity.google/docs/cli/commands/usage/) · [上游额度解析](https://github.com/lili-luo/dsh-plugin-bundle/blob/6aac22493754c5aefb4642b2627c88b136c72b6d/dsh-llm-antigravity-acp/src/quota.ts#L35-L70)
4. 在路由器上以认证实例、连接和代理会话标识为边界管理请求、流、取消和权限回调。后端请求和反向请求各自分配关联标识，以连接与请求方向区分同名 JSON-RPC ID。工作目录由账号 worker 解析为 Linux 服务器上的受控目录。每个 DSH 实例使用独立 SSH 密钥和专属 Linux 服务器回环监听端口，通过反向转发连到该 DSH 的回环 MCP 桥。端口绑定错误时应阻止该连接进入代理模式。[ACP stdio](https://agentclientprotocol.com/protocol/v1/transports) · [OpenSSH 反向转发监听约束](https://man.openbsd.org/sshd.8#permitlisten)

## P2 插件接入与回合契约

在固定版本上加可选的代理配置，未配置时沿用本机 `agy acp`。代理模式走现有 `AcpProcess` 的 stdio 通道。先启动 MCP 桥并取得实际本地回环端口，再启动带反向转发的 SSH；初始化时协商路由扩展能力。代理模式由 Linux worker 执行版本与登录探测；DSH 保留本地工具与附件处理，远端用量先使用 ACP 回包，按步读取远端 SQLite 的能力待单独验证。[进程接口](https://github.com/lili-luo/dsh-plugin-bundle/blob/6aac22493754c5aefb4642b2627c88b136c72b6d/dsh-llm-antigravity-acp/src/acp-process.ts#L161-L186) · [MCP 回环监听](https://github.com/lili-luo/dsh-plugin-bundle/blob/6aac22493754c5aefb4642b2627c88b136c72b6d/dsh-llm-antigravity-acp/src/mcp-bridge.ts#L101-L121)

一个 **DSH 回合** 从一次新模型任务开始，到该任务的最终完成、取消或失败。它可以跨多个 DSH step，期间可能等待工具结果，也可以因为工具结果回填或输出长度上限而发出多次 ACP `session/prompt`。一个 **ACP prompt** 是单个协议请求，其响应只结束该次请求。只有 DSH 回合结束才释放账号租约。[ACP Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn) · [工具回填和续写源码](https://github.com/lili-luo/dsh-plugin-bundle/blob/6aac22493754c5aefb4642b2627c88b136c72b6d/dsh-llm-antigravity-acp/src/runtime.ts#L736-L827)

| 时机 | 计划行为 |
| --- | --- |
| 新回合 | 在 `stream()` 的既有工具回填分支后、`plan()` 与构建输入之前调用 `_antigravityAccountSwitcher/acquireTurn`。由已认证连接发出当前模型及会话关联，返回与此连接绑定的不透明租约和路由代际，或明确的额度不足结果。插件本地继续按 `sessionId` 与 `purpose` 区分聊天、标题及子代理；关联信息只作路由匹配与诊断。 |
| 建立或复用会话 | 按租约绑定的账号与 worker 代际建立或复用代理会话。路由器在接收后续请求时验证租约和会话归属。其他聊天改变全局当前账号时，已分配租约继续固定在原账号。路由变化、后端会话失效或之前收到额度不足时，使用 `resetSession()` 与 `replayPrompt()` 从同一 DSH 聊天的历史重建，再设置模型、思考档位和工具桥。 |
| 工具及权限 | 为每次开会话保留代理 ACP session ID 与原生 agy session ID。代理重写 ACP 请求和更新中的 session ID，MCP 请求中的原生 ID 供插件核验。MCP URL 只替换为配置允许的 Linux 服务器回环端口，保留租户路径及 bearer，校验该租户与原生会话的绑定。 |
| 工具回填及续写 | 成功回填继续原租约。无论是恢复仍挂起的 prompt、提交工具结果续写，还是处理 `max_tokens` 的自动续写，均沿用原账号。 |
| 整圈额度不足 | 路由器将配置文字作为正常 ACP 文本更新和 `end_turn` 返回，默认 `余额不足`，且该回复无需调用 agy 生成。插件在下次额度恢复时按 DSH 历史重建上下文。 |
| 结束与清理 | 终止该 DSH 回合后调用 `_antigravityAccountSwitcher/releaseTurn`。未正常释放的租约随连接清理，仍在执行的 prompt 与工具回调先取消并收尾。旧 worker 在所有已接纳回合与挂起回调结束后退出。 |
| 传输中断 | 已提交 prompt 的结果可能未知。插件结束该回合并向 DSH 报告失败，禁止自动重发该回合。DSH 默认会重试 `TRANSPORT`，所以代理模式须验证提交后失败类别及 provider 重试策略，使重试插件也能遵守回合边界。 |

重放的数据源始终是 DSH 持有的对话历史。账号切换后复用既有转录与附件处理规则，历史按上游重放预算截取并保留最新输入。插件与代理用 ACP `_meta` 传递扩展信息，并在初始化能力中声明扩展。代理专用元数据在转发给 agy 前剥离，保留 agy 使用的系统提示元数据。[ACP 扩展](https://agentclientprotocol.com/protocol/v1/extensibility) · [回合入口](https://github.com/lili-luo/dsh-plugin-bundle/blob/6aac22493754c5aefb4642b2627c88b136c72b6d/dsh-llm-antigravity-acp/src/runtime.ts#L290-L367) · [历史重建](https://github.com/lili-luo/dsh-plugin-bundle/blob/6aac22493754c5aefb4642b2627c88b136c72b6d/dsh-llm-antigravity-acp/src/runtime.ts#L648-L733) · [MCP 会话核验](https://github.com/lili-luo/dsh-plugin-bundle/blob/6aac22493754c5aefb4642b2627c88b136c72b6d/dsh-llm-antigravity-acp/src/runtime.ts#L889-L898) · [DSH 重试策略](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-retry/README.md#configuration)

## P3 验证、切换与回退

已通过根目录 TypeScript 构建和 11 项路由、worker、双向 TLS 测试；插件的构建、类型检查和 53 项测试通过。在分别构建根目录与插件后，使用 `npm run test:integration` 运行实际插件代码与路由器的联调，模拟两台 DSH 使用相同聊天 ID 切号、重建隔离和额度不足。上述结果未使用真实账号。

先使用模拟 ACP worker 验证路由器。插件改动通过上游 `npm run build`、`npm run typecheck`、`npm test`，并将代理回归场景接入现有假 agy 测试。构建需 TypeScript 和 DSH peer 声明，可通过 `DSH_CHECKOUT` 指向已构建的 DSH 源码检出。实际接入再使用两台 DSH 主机和两个真实账号验收。[上游构建脚本](https://github.com/lili-luo/dsh-plugin-bundle/blob/6aac22493754c5aefb4642b2627c88b136c72b6d/dsh-llm-antigravity-acp/scripts/build.mjs) · [上游运行时测试](https://github.com/lili-luo/dsh-plugin-bundle/blob/6aac22493754c5aefb4642b2627c88b136c72b6d/dsh-llm-antigravity-acp/tests/runtime.test.mjs)

| 验收项 | 环境 | 通过条件 |
| --- | --- | --- |
| 阈值与窗口 | 模拟 | 周额度 20%、五小时额度 4.99% 时跳过。较低窗口恰好 5% 时可用。两种窗口互换位置得到同一结果。 |
| 轮询与恢复 | 模拟 | 当前账号不达标时按顺序接续，最多探测一圈。先前跳过的账号在后续绕回且达标时可重新接手。并发准入后每个回合的租约仍固定在各自选定账号。 |
| 固定回复与未知 | 模拟 | 整圈确认不足时收到配置文字和正常终止，默认文字为 `余额不足`。没有可用账号且出现登录失败、超时或字段缺失时收到诊断错误。 |
| 多 DSH 会话隔离 | 模拟、两台 DSH | 两客户端用相同 RPC ID、同名会话关联，均只收到所属流、取消和权限回调。错用其他实例或会话的 MCP 凭据被拒绝。 |
| 工具等待期间换号 | 模拟、两账号两台 DSH | 让账号 A 上的聊天停在工具调用，令下一次探测判定 A 低于阈值。另一聊天立即由 B 生成。同一聊天等待 A 完成工具回填与续写后，下一条消息由 B 带着该聊天原上下文生成。A 的 worker 关闭时其已开始回合和工具回调全部结束。 |
| 重建与恢复 | 模拟、实机 | 重建只使用该聊天的 DSH 历史，保留模型、思考档位、MCP 与附件。账户恢复后能接在先前的固定回复后继续。 |
| 已提交后断链 | 模拟、实机 | 发送 prompt 后切断链路，用户可见该轮失败。在启用 DSH 重试插件的配置下，工具执行次数仍为一次。后续新消息可重新建立会话。 |
| 直连回归与回退 | 模拟、实机 | 可关闭代理模式恢复原配置，用相同 DSH 入口验证直连回复。 |
| QQ 验收 | 仅在 DSH 接入 QQ 时 | 从原 QQ 聊天发一条测试消息并在原聊天收到回复，记录测试结果与脱敏路由证据。 |

真实部署需要在两个独立 Linux 服务用户中完成 Google 登录，并为每台参与验收的 DSH 配置自己的 SSH 密钥及对应反向端口。先在测试配置启用代理并通过上表，再切换日常入口。需要回退时关闭代理并恢复原直连配置，在原入口确认回复。验收只记录版本、状态、账号代号、耗时和结果，凭据及聊天正文留在实际运行环境。
