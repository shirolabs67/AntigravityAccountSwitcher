# Linux 部署、验收与回退

Sylvie 的共享目录是开发检出。服务部署时从 Git 拉取到目标 Linux 服务器，并使用服务器实际的 SSH 地址与端口。以下命令用于部署和验收；当前未连接该服务器，也未更改现有 DSH 的直连配置。

## 构建

在服务器或同平台构建环境安装 Node.js `>=22.19`、npm 和 OpenSSL。安装目标架构的 [官方 Antigravity CLI](https://antigravity.google/docs/install?tab=cli)。核对服务器上的 `agy --version`、`agy acp --help` 和 OpenSSH 版本，以及两个 DSH 主机的实际 DSH 与 SSH 客户端版本。当前插件兼容测试使用 DSH 0.2.1-rc.5；Windows 开发检出中的 agy 1.5.3 与 [Google 发布清单](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json) 校验一致，Linux 安装须重新核对。

~~~sh
git clone --branch codex/initialize-account-switcher --single-branch https://github.com/shirolabs67/AntigravityAccountSwitcher.git
cd AntigravityAccountSwitcher
npm ci
npm test
npm run build
cd dsh-plugin
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
cd ..
npm run test:integration
~~~

生产运行的路由器只依赖 Node.js 内置模块。把根目录的 `dist/` 放到管理员控制的只读执行目录，例如 `/opt/antigravity-account-switcher/dist`。插件分别在两个 DSH 的测试配置中安装；见 [插件说明](../dsh-plugin/README.md)。

## 账号和回环认证

1. 在**同一台 Linux 服务器**上为两个 Google 账号各准备一个独立的非 root 用户，例如 `aas-account-a`、`aas-account-b`。给两人独立的 HOME、专用工作目录和配置。分别切换到对应登录身份，使用官方 CLI 完成 Google 登录。不要复制 OAuth 缓存。按 [账号 worker 说明](WORKER.md) 用各自身份和实际工作目录验证额度、ACP 和专用工具策略。
2. 创建路由器身份 `aas-router`，再为各 DSH 的 SSH 固定入口配置独立的最小权限身份。将 [样例](../examples) 复制到各角色的本机配置目录，填入账号顺序、精确 DSH 模型 ID 与 `/usage` 组名的映射、阈值及回调端口。每个 worker 配置的 `runAsUser` 应与实际用户一致；相对路径以对应配置文件目录为准。
3. 使用部署 CA，或在管理员专用目录下生成仅供此项目使用的证书。以下命令中替换输出路径；父目录须事先只有管理员能读写。把各角色自己的 `pki/` 复制到对应配置目录。仅该角色可读自己的私钥，`ca-admin/` 留给管理员。将 `fingerprints.json` 的 SHA-256 指纹和服务名填入配置。路由器在 `127.0.0.1` 上验证双向 TLS，并按客户端证书绑定角色和代号。轮换证书时同时更新相应指纹并重启。

   ~~~sh
   node tools/new-local-certificates.mjs --output <管理员目录下的新目录> \
     --account account-a --account account-b --instance dsh-a --instance dsh-b
   ~~~

先以各自身份前台运行以下两个命令进行预检。两个 worker 各运行一份，使用自己的配置路径：

~~~sh
node dist/cli.js serve <router.json>
node dist/cli.js worker <worker.json>
~~~

服务器使用 systemd 时，可从 [路由器示例单元](../examples/systemd/aas-router.service) 和 [worker 模板](../examples/systemd/aas-worker@.service) 开始。确认 Node 可执行文件路径、配置路径、用户和所有权。以 worker 单元实际身份验证 HOME、额度和 ACP，再启用开机启动及失败重启。Worker 断线会令已提交轮次失败，不会自动重放。

## OpenSSH 和 MCP

每个 DSH 准备自己的 SSH 私钥、该实例的专用服务端回环端口和通过可信渠道核对过的 `known_hosts`。端口使用服务端实际监听端口，和反向转发的回环端口是两个不同的配置。

服务端在该入口身份的 `authorized_keys` 写入专用公钥，固定命令使用绝对路径指向对应实例的入口配置。下面以 dsh-a 为例；dsh-b 使用另一份凭据、配置和端口。固定命令不读客户端提供的 argv、环境变量或 ACP 自报身份。入口身份只应能读取自己的 TLS 材料，代码和授权文件由管理员控制写权限。

~~~text
restrict,port-forwarding,permitlisten="127.0.0.1:43101",command="/usr/bin/node /opt/antigravity-account-switcher/dist/cli.js ingress /etc/antigravity-account-switcher/dsh-a/ingress.json" ssh-ed25519 <该实例的公钥>
~~~

用仅匹配两个入口用户的规则要求公钥认证，设置 `AllowTcpForwarding remote`、`GatewayPorts no`、`AllowStreamLocalForwarding no`，禁用 PTY、X11、代理转发和隧道。检查已有 `ForceCommand` 不覆盖每把公钥的固定命令。OpenSSH 配置变更前先保留备份，用服务器实际使用的 `sshd -t` 检查后再重载。[OpenSSH 服务端配置](https://man.openbsd.org/sshd_config.5) · [每把密钥的监听约束](https://man.openbsd.org/sshd.8#permitlisten)

在两个测试 DSH 安装插件，将 [代理配置示例](../examples/dsh-proxy.example.json) 合并到各自插件条目的 `config`。填入实际 SSH 主机、端口和账户名，以及各自 SSH 私钥、可信主机密钥文件的绝对路径。插件先绑定自己的 MCP 回环端口，再用下面的模式启动 SSH；客户端不提交远程命令。

~~~sh
ssh -T -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o ExitOnForwardFailure=yes -p <SSH端口> -i <该实例私钥> \
  -R 127.0.0.1:43101:127.0.0.1:<本地桥端口> <入口身份>@<SSH主机>
~~~

ACP 通过标准输入输出，MCP 通过反向回环转发。验证实例无法绑定其他实例的端口、非回环监听或本地转发。SSH 端口绑定成功后，再实际调用 MCP：应保留路径和鉴权，错误令牌或另一会话的原生 ID 必须被拒绝。[ACP stdio](https://agentclientprotocol.com/protocol/v1/transports) · [OpenSSH 客户端选项](https://man.openbsd.org/ssh_config.5#ExitOnForwardFailure)

## 两账号、两 DSH 的实机验收

1. 确认两个 Linux worker 能各自运行真实 `/usage`、初始化 ACP 并回复，第二次 Google 登录不会改变第一个 worker 的身份。两台 DSH 各发一条含不同测试标记的消息并调用测试 MCP 工具，检查流式回复、权限和回调都归原实例。
2. 让聊天甲在账号 A 的工具调用上等待，再让第二台 DSH 的聊天乙触发 A 低于阈值且 B 达标的场景。必要时在隔离测试环境根据实测额度调阈值。乙应立即由 B 回复；甲的工具回填和续写仍由 A 完成。甲的下一条消息由 B 带着甲自己的历史生成；旧代次的 `agy acp` 子进程应在所有轮次与回调结束后退出。
3. 在提交 prompt 后断开测试连接。用户应看到结果未知，工具只执行一次，重连只承接新请求。若此 DSH 接入 QQ，从原聊天发一条测试消息并确认原聊天收到回复。日志只记录测试代号、版本和结果，避免写入凭据或聊天正文。

## 回退

停止代理的新请求，等待活跃轮次及回调结束，或按 DSH 的取消流程结束测试轮次。在受影响的 DSH 中删除 `config.proxy` 并重载，或恢复已备份的直连配置；聊天历史仍在 DSH。使用同一实际入口验证直连回复，再停止路由器和 worker，撤销新增的 SSH 公钥或匹配配置。
