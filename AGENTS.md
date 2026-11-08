# 仓库协作约定

本仓库只负责 DSH 与官方 Antigravity CLI 之间的账号路由、可选的 DSH 插件接入和相应部署。外层 SylvieBot 的 QQ 工作流、角色资源及现有配置不属于本仓库的改动范围。

项目内容与详细实现说明见 [README.md](README.md)。

服务端用 Rust 实现，统一入口为 `aas <serve|worker|ingress> <config.json>`，作为独立进程负责账号选择、轮次租约和 ACP 转发。

`dsh-plugin/` 是基于上游 `dsh-llm-antigravity-acp` 加入代理模式的客户端适配器。它按 DSH 的 Node.js 插件接口构建，由 DSH 主机单独安装和加载。代理模式通过 SSH 调用服务端的轮次租约接口，历史重建和工具调用由 DSH 侧处理。 [插件说明](dsh-plugin/README.md) · [上游插件](https://github.com/lili-luo/dsh-plugin-bundle/tree/main/dsh-llm-antigravity-acp)

两部分同仓维护，便于同步更新代理协议和运行联调测试。服务端和插件独立交付，服务端 Docker 镜像按第 8 条约定构建。

1. 按 [实施顺序](docs/IMPLEMENTATION.md) 交付。修改组件或协议时，同步维护 [C4 架构](docs/ARCHITECTURE.md)；修改安装、配置或回退时更新 [部署文档](docs/OPERATIONS.md)。
2. ACP 使用 v1 stdio；stdout 只写协议帧。每个 DSH 连接从 SSH 身份取得租户归属。自定义扩展、会话 ID、请求 ID、取消与工具回调都按已认证连接校验。
3. 聊天历史由 DSH 持有。账号租约覆盖整个 DSH 轮次，包括工具回填和续写。提交后断线时，不跨账号或自动重放本轮。
4. 登录隔离由 Linux 服务用户和各自的 HOME 提供；用实际 worker 运行身份验证凭据可见性。只用官方 CLI；禁止复制 OAuth 凭据、提交私有配置、SSH 密钥、聊天内容或把真实账号资料写入测试数据。
5. 第三方代码必须固定版本并保留许可。遇到 CLI、ACP、DSH 或 OpenSSH 版本差异，先对照官方资料及部署实测，再修改兼容逻辑。
6. 区分模拟验证和真实部署验证。交付时记录验证的版本、场景和结果；真实双账号、跨主机工具回调及适用时的 QQ 回复分别验收。
7. 用 [rust-toolchain.toml](rust-toolchain.toml) 固定 Rust 工具链，提交 `Cargo.lock`，使用 `cargo build --release --locked` 和 `cargo test --locked`。修改路由契约时运行 [DSH 插件联调](docs/IMPLEMENTATION.md#rust-迁移验证)。
8. 通过 Docker 多阶段构建交付运行镜像。最终镜像只包含发布二进制、角色所需的运行时依赖和许可。Linux 使用 Docker Engine，Windows 使用 Docker Desktop 的 Linux 容器模式。Compose 只发布 SSH 端口，mTLS 与 MCP 反向转发留在共享网络命名空间的回环接口。每个 worker 使用独立 HOME 卷。修改镜像时运行 `docker compose config --quiet`，并在可用的 Linux 引擎上运行 [Docker 冒烟测试](tests/docker-smoke.sh)。
