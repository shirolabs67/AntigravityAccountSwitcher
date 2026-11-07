# 账号进程

在目标 Linux 主机上为每个 Google 账号使用一个独立的普通系统用户，例如 `aas-account-a` 和 `aas-account-b`。为各用户保留独立且持久的 home、工作目录、CLI 状态和证书私钥。服务配置中的 `runAsUser` 与实际启动 worker 的 Linux 用户一致。由 systemd 启动时，使用该服务用户和它自己的 home，并在实际服务环境中验收。Sylvie 共享目录是源码检出位置，运行环境在目标服务器上配置。参见 [systemd 的 User= 和登录环境](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#User=)。

## Linux 安装和登录

在目标服务器用 Google 官方 Linux 安装方式安装 agy。官方安装脚本根据 CPU 架构与 libc 选择发布包，核对 SHA-512，默认安装到调用用户的 `$HOME/.local/bin/agy`。在服务配置 `agyPath` 中填写该二进制的实际绝对路径。使用由管理员维护的公共安装时，各 worker 可以指向同一个二进制，且各自仍使用自己的 home。2026-11-08 核对的官方 Linux AMD64、ARM64 和对应 musl 发布清单版本均为 `1.5.3`，部署记录以目标机的 `agy --version` 为准。

```sh
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy --version
agy acp --help
```

- [Google Antigravity 官方下载与 Linux 安装命令](https://antigravity.google/download)
- [Google Linux 安装脚本](https://antigravity.google/cli/install.sh)
- [Linux AMD64 发布清单](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json)
- [Linux ARM64 发布清单](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_arm64.json)

在管理员的交互式 SSH 终端中，以每个 worker 的服务用户分别执行 `agy acp --login`，在本地浏览器打开 CLI 给出的授权 URL，登录对应 Google 账号，再把一次性代码交给该 CLI。登录和运行 worker 应使用同一用户、同一实际 home 和同一 CLI 配置。一次性代码只在终端交给 CLI。缓存凭据和证书私钥保存在服务用户或系统提供的凭据存储中，仓库配置只引用必要的本机路径。

Linux 上 CLI 会尝试使用该用户的 Secret Service/D-Bus 安全存储。systemd 系统单元的 `User=` 会切换运行身份，但不会自动接入用户登录时解锁的密钥环。先在各自登录会话中前台启动 worker。若交互式命令可用，后台却提示需要登录或密钥环已锁定，检查实际服务环境的用户、HOME 和该用户的 D-Bus/Secret Service 会话。需要密钥环时，在该账号的用户服务和已解锁会话中运行，并验证服务重启后仍可读取凭据。两个账号均通过无 TTY 验收后，再启用代理模式。

- [Google SSH OAuth 登录流程](https://antigravity.google/docs/install?tab=cli#remote-ssh-oauth-flow)
- [Google ACP 登录命令](https://antigravity.google/docs/ide/extensions/acp/#flags)
- [Google CLI 无终端环境的认证行为](https://antigravity.google/docs/cli/headless/#run-a-single-prompt)
- [Google 密钥环访问排查](https://antigravity.google/docs/cli/troubleshooting#authorize-keyring-permissions)

## 每账号配置

为每个账号复制一份 [worker 配置示例](../examples/worker.example.json)，配置 `runAsUser`、`agyPath`、`cwd` 和该 worker 的证书。`cwd` 使用该用户拥有的专用工作目录。相对路径由启动器按配置文件所在目录解析。登录、查额度和 ACP 都使用服务用户自己的默认 HOME。CLI 设置文件为 `$HOME/.gemini/antigravity-cli/settings.json`，全局自定义目录为 `$HOME/.gemini/config/`。agy 1.5.3 的 ACP 接受 `--gemini-dir`，但非交互 `/usage` 拒绝该选项。若早期 worker 配置包含 `geminiDir`，删除该字段，并以实际服务用户在默认 HOME 下完成登录和代理配置。

工作目录及其父目录应保持干净，避免从仓库加载其他钩子或工具。以 worker 用户身份将下方配置写入 `$HOME/.gemini/config/agents/dsh-bridge.md`。从先前的工作目录配置升级时，把同一份文件移到上述位置。官方 agy 会略过未信任工作目录中的 `.agents/agents/`。启动器检查 CLI 配置目录里的文件，实际加载的工具由下文验收确认。

```markdown
---
name: dsh-bridge
description: DSH conversation and tools bridge
tools: []
excludeDefaultComponents: true
mainAgent: true
subagent: false
inheritCustomizations: false
inheritMcp: false
commandExecutionPolicy: "off"
---

Follow the system instructions provided by DSH. Use only the tools DSH attaches to the session.
```

`tools` 和 `inheritCustomizations` 来自官方 Markdown 代理配置，`excludeDefaultComponents` 沿用 DSH 上游生成的代理定义。ACP 以 `--agent dsh-bridge --process-per-session` 启动，后者允许通过会话配置接入 HTTP MCP。

- [Google CLI 配置文件位置](https://antigravity.google/docs/settings?tab=cli#configuration-file-location)
- [Google 自定义代理的发现路径](https://antigravity.google/docs/subagents?tab=cli)
- [Google Markdown 代理字段](https://antigravity.google/docs/build-plugins)
- [Google 对未信任工作目录的说明](https://github.com/google-antigravity/antigravity-cli/issues/1270#issuecomment-6279349418)
- [DSH 上游代理生成逻辑](https://github.com/lili-luo/dsh-plugin-bundle/blob/6aac22493754c5aefb4642b2627c88b136c72b6d/dsh-llm-antigravity-acp/src/preflight.ts#L213-L243)

## 账号验收

在各 worker 的实际服务身份和工作目录下执行以下命令。使用 `agyPath` 指向的二进制。命令使用各自的默认 HOME。输出只在服务器上核对。

```sh
agy --version
agy acp --help
agy agents
agy -p /config --output-format json
agy -p /usage --output-format json </dev/null
```

1. 确认 `agy agents` 能发现 `dsh-bridge`。核对生效权限使用默认 Agent 模式和 `request-review`，且没有批准本机终端、文件或浏览器工具的规则。
2. 在相同用户、配置和工作目录下执行 `agy --agent dsh-bridge -p "Reply only OK." --output-format stream-json`。核对 `init.tools` 中没有终端、文件和浏览器等内置工具。此步骤会发送一次短模型请求。
3. 用实际 ACP 启动参数创建两个会话，分别挂载空 MCP 列表和测试 DSH 桥。验收纯文本回复和测试工具回调，核对 ACP 的 `tool_call` 与权限事件只涉及预期的 DSH 桥。
4. 两个账号应分别返回预期模型组和额度。映射使用 `command.data.groups[].name` 的确切组名，例如 `Gemini Models` 和 `Claude and GPT models`。每组必须各有一个 `weekly` 与 `5h` 窗口，两者的 `remaining_fraction` 均须为 0 至 1 的数。验证记录可保留版本、组名和字段形状。

- [Google CLI 额度说明](https://antigravity.google/docs/cli/commands/usage/)
- [Google ACP 参数与权限回调](https://antigravity.google/docs/ide/extensions/acp/#flags)
- [Google CLI 权限设置](https://antigravity.google/docs/permissions/?tab=cli)
- [Google CLI 的流式 JSON 与 init 事件](https://antigravity.google/docs/cli/headless/)

## Windows 对照

如果将来部署到 Windows，同样给每个账号分配独立的系统用户，使用对应的 `agy.exe`。Windows Credential Manager 的访问还取决于进程的登录会话，部署为计划任务时应在该任务实际采用的登录类型下重复上述验收。[Google 维护者对 Windows 凭据的说明](https://github.com/google-antigravity/antigravity-cli/issues/1261#issuecomment-4974500117) · [Microsoft Credential Manager 的登录会话规则](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw)
