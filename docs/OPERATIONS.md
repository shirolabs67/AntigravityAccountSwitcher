# 部署、验收与回退

## Docker 主机

Linux 使用 Docker Engine 与 Compose v2。Windows 使用 Docker Desktop 的 Linux 容器模式和 WSL 2 后端。先用 `docker info --format '{{.OSType}}/{{.Architecture}}'` 确认引擎是 Linux，使用 AMD64 或 ARM64。以下 `docker compose` 命令可直接在 PowerShell 或 Linux shell 中运行。两种主机都使用同一套 Linux 镜像。DSH 插件安装在各自的 DSH 主机上。[Docker Desktop Windows 安装](https://docs.docker.com/desktop/setup/install/windows-install/) · [Compose 网络模式](https://docs.docker.com/compose/how-tos/networking/#change-the-network-mode)

从 Git 检出本仓库后，在仓库根目录构建。

~~~sh
docker compose config --quiet
docker compose build
~~~

多阶段构建使用锁定的 Rust 依赖编译发布版 `aas`。三个运行时镜像分别用于路由器、OpenSSH 入口和账号 worker。worker 镜像包含通过 SHA-512 校验的官方 Linux agy 1.5.3。构建工具和源码留在构建阶段。基础镜像按摘要固定，Debian 软件包取自固定日期的签名快照。镜像内禁用 agy 的自更新，更新时按官方发布清单同步替换版本、下载地址与 SHA-512，再重新构建镜像。Node.js 仅用于 DSH 插件、离线证书工具和部分测试。

## 准备配置与证书

在宿主机创建管理员专用目录。使用部署 CA，或在已安装 Node.js 与 OpenSSL 的管理终端运行以下命令，生成项目专用的证书。用真实路径替换命令中的输出目录，该路径的父目录需要事先设为仅管理员可读写。

~~~sh
node tools/new-local-certificates.mjs --output <新的私有证书目录> --account account-a --account account-b --instance dsh-a --instance dsh-b
~~~

证书生成后，将对应角色的 `pki/` 布置到以下目录。默认配置根目录为仓库内已忽略的 `.local/docker`，也可以通过 `AAS_CONFIG_DIR` 指定其他目录。SSH 的两个 `ingress/` 角色目录取自工具生成的 `ingress-dsh-a` 和 `ingress-dsh-b`。

~~~text
.local/docker/
  router/router.json
  router/pki/
  worker-account-a/worker.json
  worker-account-a/pki/
  worker-account-b/worker.json
  worker-account-b/pki/
  ssh/dsh-a/ingress.json
  ssh/dsh-a/pki/
  ssh/dsh-a/authorized_keys
  ssh/dsh-b/ingress.json
  ssh/dsh-b/pki/
  ssh/dsh-b/authorized_keys
~~~

复制 [JSON 示例](../examples/) 到上述位置，使用 `fingerprints.json` 填好证书指纹和 `serverName`。保留示例的 `pki/` 相对路径和文件名。设置实际的 DSH 模型 ID 和精确的 `/usage` 组名。Compose 使用路由端口 `43000`，`dsh-a` 与 `dsh-b` 的 `mcpPort` 分别为 `43101` 和 `43102`。worker 的 `agyPath` 设为 `/usr/local/bin/agy`，`cwd` 设为 `/var/lib/aas/worker/workspace`，`runAsUser` 分别设为 `aas-worker-a` 和 `aas-worker-b`。

每个 `authorized_keys` 文件写入该 DSH 实例自己的 SSH **公钥**。配对的私钥由 DSH 主机持有。宿主机以只读方式分别挂载每个角色的配置，容器启动时将本角色的文件放入具有 Linux 权限控制的临时目录。`ca-admin/` 留在管理员专用目录，容器只读取对应的叶证书和 CA 公钥证书。证书轮换时同时更换相应指纹，然后重建全部服务容器。

默认只在宿主机 `127.0.0.1:2222` 发布 SSH。对于远端 DSH，在仓库根目录的私有 `.env` 中设置 `AAS_SSH_BIND` 为可供 DSH 访问的宿主机地址，按需用 `AAS_SSH_PORT` 更改宿主端口，并在宿主防火墙中允许相应来源。容器内端口仍是 `2222`。路由器、两个 worker 和 sshd 共享容器网络命名空间。mTLS 路由及 MCP 反向隧道监听在该命名空间的回环地址。每个角色的文件系统、进程空间和账号 HOME 由各自的容器隔离。

## 登录并启动

先启动 SSH，再在对应 worker 的持久 HOME 中交互登录。

~~~sh
docker compose up -d ssh
docker compose run --rm --no-deps worker-a agy acp --login
docker compose run --rm --no-deps worker-b agy acp --login
docker compose run --rm --no-deps -T --interactive=false worker-a agy -p /usage --output-format json
docker compose run --rm --no-deps -T --interactive=false worker-b agy -p /usage --output-format json
docker compose up -d
docker compose ps
~~~

先在终端打开 CLI 给出的 URL，登录与该 worker 对应的 Google 账号，再把一次性代码交给 CLI。Windows 与 Linux 主机上均使用容器自己的 HOME 和凭据存储。Compose 为两个 worker 建立不同的命名卷。登录后用新的非交互进程探测额度，并在重建 worker 后复核持久性。见 [账号 worker 验收](WORKER.md)。

SSH 主机密钥由第一次启动时生成并保存在独立卷。管理员可通过 `docker compose exec -T ssh cat /var/lib/aas/ssh/ssh_host_ed25519_key.pub` 从可信终端取出主机公钥，再向 DSH 管理员核对该值和端口。把核对后的 SSH 主机记录加入 DSH 所用的 `known_hosts`。保持命名卷可在容器重建时保留 SSH 身份和登录状态。

## DSH 插件与反向回调

在各 DSH 的测试配置中按 [插件说明](../dsh-plugin/README.md) 安装插件，将 [代理示例](../examples/dsh-proxy.example.json) 合并到该插件条目的 `config`。填写 Docker 主机地址、发布的 SSH 端口、入口账号，以及该 DSH 的私钥和 `known_hosts` 的绝对路径。插件先启动自己的回环 MCP 桥，再按以下方式启动 SSH。客户端省略远程命令。

~~~sh
ssh -T -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -p <SSH端口> -i <该实例私钥> -R 127.0.0.1:43101:127.0.0.1:<本地桥端口> dsh-a@<SSH主机>
~~~

[容器 SSH 配置](../deploy/docker/sshd_config) 为每个入口用户设置固定命令和允许监听的回环端口。验收时尝试绑定另一实例的端口或非回环地址，确认 SSH 拒绝请求。正常连接建立后，从工具调用验证反向转发，并检查 MCP 路径、鉴权和原生会话标识。[OpenSSH 客户端选项](https://man.openbsd.org/ssh_config.5#ExitOnForwardFailure) · [OpenSSH 服务端转发配置](https://man.openbsd.org/sshd_config.5#PermitListen) · [ACP stdio](https://agentclientprotocol.com/protocol/v1/transports)

## Linux 原生部署

需要沿用现有 OpenSSH 和 systemd 时，可在 Linux 上用 `cargo build --release --locked --bin aas` 构建二进制，安装到管理员控制的 `/opt/antigravity-account-switcher/bin/aas`。分配独立非 root worker 用户和 HOME，再准备路由器、入口用户和各自的 TLS 配置。参考 [systemd 示例](../examples/systemd/) 与 [原生 worker 安装](WORKER.md#linux-原生安装)。各服务以实际运行身份执行 `aas serve <router.json>` 或 `aas worker <worker.json>`。

在入口用户的 `authorized_keys` 为每把公钥配置固定命令。以 `dsh-a` 为例。

~~~text
restrict,port-forwarding,permitlisten="127.0.0.1:43101",command="/opt/antigravity-account-switcher/bin/aas ingress /etc/antigravity-account-switcher/dsh-a/ingress.json" ssh-ed25519 <该实例的公钥>
~~~

对入口用户要求公钥认证，设置 `AllowTcpForwarding remote`、`GatewayPorts no`、`AllowStreamLocalForwarding no`，并禁用 PTY、X11、代理转发和隧道。核对现有 `ForceCommand` 与固定命令的优先级。修改前备份配置，用目标主机上的 `sshd -t` 校验后重载。

## 两账号、两台 DSH 的实机验收

1. 记录 Docker、OpenSSH、agy、DSH 和插件的实际版本。在两个真实 worker 中检查各自的 `/usage` 与 ACP 回复。分别从两台 DSH 发消息并调用测试 MCP 工具，核对流式回复、权限事件和回调的归属。
2. 让聊天甲在账号 A 上等待工具结果，再让聊天乙触发 A 低于阈值且 B 达标的场景。乙应由 B 回复，甲的工具回填和续写应在 A 上完成。甲的下一轮应在 B 上只重建甲自己的聊天历史。旧代次的 agy 子进程在所有相关轮次与回调结束后退出。
3. 提交 prompt 后断开测试连接。确认该轮报告结果未知，工具只执行一次，重连只承接新请求。若 DSH 接入 QQ，从原聊天发送测试消息并确认同一聊天收到回复。记录测试代号、版本、耗时和结果。

## 更新与回退

更新镜像或配置前先停止新请求，等待活跃轮次及回调结束。在仓库根目录运行 `docker compose build`，再用 `docker compose up -d --force-recreate` 同时重建角色，使各容器重新加入 SSH 的网络命名空间。

回退时在受影响的 DSH 删除 `config.proxy` 并重载，或恢复已备份的直连配置。用同一实际入口验证直连回复，再运行 `docker compose down`，保留命名卷供恢复时使用。原生部署则停止相关服务并撤销新增的 SSH 公钥或匹配规则。聊天历史由 DSH 持有。
