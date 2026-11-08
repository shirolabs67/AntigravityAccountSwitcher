# Antigravity Account Switcher

给多台 DeepSeek Harness（DSH）提供一个共享的 Antigravity CLI 账号入口。

**Rust 服务端**通过 `aas` 二进制分别启动共享路由器、SSH stdio 入口和账号 worker。路由器在每轮开始前检查模型组额度，分配本轮使用的账号，再将 ACP 请求转发给以独立 Linux 服务用户和 HOME 运行的官方 `agy acp`。

**DSH 客户端插件**位于 `dsh-plugin/`，是在上游 `dsh-llm-antigravity-acp` 基础上加入代理模式的适配器，由 DSH 在自己的主机上安装和加载。启用代理后，插件通过 SSH 连接 `aas`，在每个 DSH 轮次开始和结束时申请和释放账号租约。换号时，插件用 DSH 持有的聊天历史重建会话。工具调用也通过插件回到 DSH。默认直连模式下，插件调用 DSH 主机上的 `agy`。 [插件构建与配置](dsh-plugin/README.md)

两部分同仓维护，便于同步更新代理协议和运行联调测试。Docker 镜像交付 Rust 服务端，客户端插件单独构建。

## 部署

Linux 使用 Docker Engine 与 Compose v2，Windows 使用 Docker Desktop 的 Linux 容器模式。运行镜像包含编译好的 `aas` 和各角色所需的运行时依赖。worker 镜像包含固定版本的官方 Linux agy。

```sh
docker compose build
```

按[部署手册](docs/OPERATIONS.md)准备证书、SSH 公钥和角色配置，再分别登录两个账号并运行 `docker compose up -d`。Docker 验收与真实双账号、跨主机回调及适用时的 QQ 验收分别记录在[实施与验收](docs/IMPLEMENTATION.md)。

## 路由行为

| 场景 | 预期行为 |
| --- | --- |
| 当前账号剩余至少 5% | 继续用当前账号；默认取每周和五小时窗口中较低的比例 |
| 当前账号剩余低于 5% | 按配置顺序最多绕一圈，选择首个达标账号 |
| 已授权的测试客户端在新轮次请求换号 | 跳过当前账号，从其后按配置顺序选择首个达标账号。见[主动换号验收](docs/OPERATIONS.md#两账号两台-dsh-的实机验收) |
| 所有账号都确认低于阈值 | 通过正常回复返回可配置提示，默认「余额不足」 |
| 登录失效、探测超时、模型组或额度字段缺失 | 记录分类；没有可用账号时报告探测失败 |
| 已开始的轮次正在调用工具 | 继续用原账号完成这一轮；其他聊天的新轮可立即使用新账号 |
| 同一聊天在下一轮换号 | 由 DSH 用该聊天自己的历史重建 ACP 会话，恢复模型、思考档位与 MCP |
| 连接中断且消息已提交 | 报告本轮结果不确定；不自动重放可能已经执行的操作 |

- [架构：C4 与切号时序](docs/ARCHITECTURE.md)
- [实施顺序、上游基线和验收](docs/IMPLEMENTATION.md)
- [部署、双账号实测与回退](docs/OPERATIONS.md)
- [账号进程与工具策略](docs/WORKER.md)
- [DSH 插件构建与配置](dsh-plugin/README.md)
- [仓库协作约定](AGENTS.md)

账号、系统凭据、SSH 密钥、实际模型配置和聊天内容留在各自主机的受保护环境。

## 开发验证

```sh
cargo build --release --locked
cargo test --locked
```

Rust 工具链版本见 [rust-toolchain.toml](rust-toolchain.toml)。DSH 插件按其[构建说明](dsh-plugin/README.md)单独构建。
