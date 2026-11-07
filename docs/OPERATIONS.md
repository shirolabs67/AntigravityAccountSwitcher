# 部署、验收与回滚

本页记录部署设计和验收步骤。Windows、OpenSSH 和 Antigravity CLI 的命令可用于实机预检。路由器、账号 worker、SSH 入口与 DSH 代理模式需实现后才能按此手册启用。克隆仓库不代表已安装服务。实际版本、账号登录和端到端结果以验收记录为准。

## Sylvie 上的预检

已从 Sylvie 的部署元数据核对 DSH 0.2.1-rc.5、随附 Node.js 24.16.0 和 ACP 插件 0.2.0。现有烟雾测试记录引用上游提交 `6aac22493754c5aefb4642b2627c88b136c72b6d`。已见到 Antigravity CLI 可执行文件，其实机版本、OpenSSH 服务端版本和 worker 登录令牌下的凭据可用性仍需现场预检。

1. 在 Sylvie 记录 Windows 版本、Node.js 版本、OpenSSH 服务端版本及配置位置。在各 DSH 主机记录 DSH 版本、插件版本和实际加载的提交，以及 SSH 客户端版本。核对插件声明的兼容范围与目标版本的 ACP 握手结果。针对 Windows OpenSSH，以服务实际使用的二进制与配置为准。 [Windows OpenSSH 配置](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration)
2. 为两个 Google 账号各准备一个独立的非管理员 Windows 用户。每个用户有自己的配置目录、工作目录、日志目录和 Google 登录会话。分别在两人的 Windows 登录会话中运行下列命令并完成登录。账号对应关系由操作者本地核对，验收记录仅使用 A、B 代号。 [Antigravity CLI ACP](https://antigravity.google/docs/cli/acp/) · [Windows 凭据隔离的维护者说明](https://github.com/google-antigravity/antigravity-cli/issues/1261#issuecomment-4974500117)

   ~~~powershell
   agy --version
   agy acp --help
   agy acp --login
   agy -p /usage --output-format json
   ~~~

3. 保持两账号都可用，从两个 worker **实际使用的 Windows 登录令牌**下分别运行额度探测，并用 ACP 客户端启动各自的 `agy acp` 完成初始化、新建会话和简短回复。额度返回须包含目标模型组的每周与五小时窗口。记录版本、模型组、窗口是否齐全和握手结果，避免保留包含账号标识的原始输出。两账号再各验证一次，排除第二次登录覆盖第一个账号的情况。 [额度窗口](https://antigravity.google/docs/cli/commands/usage/) · [无交互模式](https://antigravity.google/docs/cli/headless/)
4. 首轮可由两个已登录用户各自启动 worker。若后续改用计划任务或服务，在实际采用的登录类型下重跑上一步并验证重启恢复。Windows Credential Manager 按进程令牌的登录会话提供凭据。配置目录和用户名正确，仍需要核对实际运行时的凭据与网络可用性。 [Windows CredReadW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw) · [计划任务登录类型](https://learn.microsoft.com/en-us/windows/win32/taskschd/principal-logontype)

Google 凭据由官方 CLI 维护。两个账号的登录材料、MCP 会话令牌、SSH 私钥和部署配置都保留在各自权限限制的本地位置。路由器只持有账号代号与 worker 连接配置。worker 接口只开放额度查询和 ACP 转发所需的操作，CLI 路径、工作目录和工具策略由本机管理员配置。用于验收的工作目录和工具数据应使用测试内容。

## SSH 与 MCP 回调

每个 DSH 实例生成专用 SSH 密钥，独立登记实例代号、公钥与 Sylvie 回环端口。入口使用非管理员 Windows 身份。SSH 服务端通过公钥条目里的固定命令赋予实例身份。启动器忽略客户端传入的原始命令、环境变量或 ACP `_meta` 中的自报身份。入口脚本、实例配置和公钥授权文件由管理员控制写权限。按可信渠道核对 Sylvie SSH 主机密钥，并为客户端启用严格主机密钥校验。 [Windows OpenSSH 配置](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration) · [OpenSSH 公钥选项](https://man.openbsd.org/sshd.8#AUTHORIZED_KEYS_FILE_FORMAT)

以下以 `dsh-a` 和端口 `43101` 为示例，另一个实例使用另一把公钥、固定命令与端口。示例中的启动器是待实现的部署入口，需要按目标 Windows OpenSSH 默认 shell 核对路径和引号。匹配该入口账号的服务端配置应要求 `publickey`，只允许远程 TCP 转发（`AllowTcpForwarding remote`），监听保持回环（`GatewayPorts no`），并禁止 StreamLocal 转发与隧道。每个公钥上的 `restrict` 禁用 PTY、代理转发与 X11，随后只恢复指定用途的端口转发。核对现有 `ForceCommand` 是否会覆盖各公钥的固定命令。 [OpenSSH 服务端配置](https://man.openbsd.org/sshd_config.5) · [每把密钥的回环监听约束](https://man.openbsd.org/sshd.8#permitlisten)

~~~text
restrict,port-forwarding,permitlisten="127.0.0.1:43101",command="<受控启动器> --instance dsh-a" ssh-ed25519 <DSH_A_PUBLIC_KEY>
~~~

在 DSH 侧先启动本机 MCP 桥，取得实际监听端口后再启动下列 SSH 长连接。ACP 经标准输入输出传输，桥的 HTTP 回调经反向转发传输。每个实例同一时刻使用一条承载该回环端口的连接。重连需要重新建立转发、ACP 会话和 MCP 鉴权上下文。 [ACP stdio](https://agentclientprotocol.com/protocol/v1/transports) · [OpenSSH 客户端选项](https://man.openbsd.org/ssh_config.5#ExitOnForwardFailure)

~~~text
ssh -T -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -i <该实例私钥> -R 127.0.0.1:43101:127.0.0.1:<实际桥端口> <入口账号>@<Sylvie SSH 主机>
~~~

在修改服务配置前备份原文件。用服务所用的 `sshd -t` 检查语法，在测试身份上验证实际规则，再启用新入口。分别验证两个授权转发可用，尝试绑定另一实例的端口、非回环监听和本地转发时均被拒绝。尝试启动 shell 时应只进入固定 ACP 入口。SSH 端口绑定成功后，还要通过每条隧道执行实际 MCP 调用。验证代理只改写受信桥地址的主机与端口，保留路径和会话鉴权，错误令牌或其他会话的原生 ID 应被拒绝。 [OpenSSH 服务端手册](https://man.openbsd.org/sshd.8) · [转发绑定失败的行为](https://man.openbsd.org/ssh_config.5#ExitOnForwardFailure)

## 试运行与实机验收

1. 先通过模拟 ACP 验证额度边界、绕圈、整圈不足、未知值、协议 ID 隔离和断线语义。用独立测试配置部署 Sylvie 路由器、两个已通过凭据预检的 worker 和两个 SSH 入口。保留各 DSH 的原直连配置以便回滚。
2. 将两台 DSH 的测试配置切换到代理模式。两台各发一条消息并执行带不同测试标记的 MCP 工具，分别确认流式回复、回调和权限请求都回到原实例。记录实例代号、代理会话代号和账号代号。标记只使用测试数据。
3. 让第一台 DSH 的聊天甲在 A 账号的一次工具调用上停住。选取已验证 A 的目标模型组低于阈值、B 达标的测试时点，或在隔离测试部署中根据实测额度调整阈值。用第二台 DSH 的聊天乙触发下一轮，确认它立即由 B 回复。解除聊天甲的工具阻塞，确认回填和自动续写仍归 A。等甲的旧轮结束，再向甲发下一条，确认它由 B 接手且能答出甲自己的上一轮测试标记，乙的标记不会出现在甲的上下文中。旧 worker 的旧 ACP 进程应在其活动轮次和回调结束后退出。
4. 测试代理连接在提交 prompt 后中断。原轮次应明确失败，工具不重复执行，新连接只承接之后的用户请求。检查 DSH 实际加载的重试策略能区分发送前失败和提交后结果未知。
5. 若实际接入 QQ，从原私聊或群聊发一条约定的测试消息并确认收到真实回复。用测试轮次代号关联 DSH、路由器和 worker 状态。验收记录保留版本、测试项与结论，避免保存真实 QQ 号码、聊天内容或鉴权材料。

如果实测额度暂时无法构成切号条件，记录账号登录、SSH 和 MCP 的实际结果，并单列真实额度切号为待复测。固定文案、探测超时和缺失字段可由模拟测试覆盖。模拟结果应与真实账号结果分开记录。

## 回滚

暂停代理模式的新增流量，等待已提交的轮次及其工具回调结束，或按 DSH 的取消流程终止测试轮次。将受影响 DSH 恢复至已保存的直连配置并重载，保留 DSH 本机的聊天历史。在实际入口发送一条测试消息验证直连回复。确认没有代理使用者后，停止路由器和 worker，再撤销本次新增的 SSH 公钥或匹配配置。若变更了 OpenSSH 服务配置，恢复备份并通过 `sshd -t` 后再重载。
