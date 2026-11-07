# Windows 账号进程

在 Sylvie 上给每个 Google 登录账号分配一个独立的 Windows 用户。以该用户登录并执行官方 agy 登录流程，再在同一 Windows 身份下启动 worker。先使用已登录的交互式用户会话验证。若要配置自动启动，在计划任务实际采用的登录类型下重新验证额度和 ACP，随后验证重启。Windows Credential Manager 的凭据可见性与进程登录会话有关，任务调度器的 S4U 登录也限制网络和加密文件访问。

- [Google CLI 登录与缓存凭据](https://antigravity.google/docs/install?tab=cli)
- [Google 维护者对 Windows 用户与配置目录的说明](https://github.com/google-antigravity/antigravity-cli/issues/1261#issuecomment-4974500117)
- [Microsoft Credential Manager 的登录会话规则](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw)
- [Windows 计划任务登录类型](https://learn.microsoft.com/en-us/windows/win32/taskschd/principal-logontype)

## 本机配置

为每个账号复制一份 [worker 配置示例](../examples/worker.example.json)，为各用户设置独立的配置、工作目录和证书私钥权限。`agyPath` 指向已验证的官方 `agy.exe`，`cwd` 指向由该用户控制的专用工作目录，`geminiDir` 可选，用于为两种 agy 调用选择同一个 CLI 配置目录。相对路径由启动器按配置文件所在目录解析。Windows 登录身份决定凭据归属，worker 会继承该身份的进程环境。工作目录及其父目录只放已核对的代理配置，避免从共享仓库加载其他钩子或工具。

在 `cwd/.agents/agents/dsh-bridge.md` 保存以下本机配置。启动器会检查该文件可读且非空。该代理接收 DSH 通过 ACP 挂载的 MCP 工具，实际工具集合要按下方步骤核对。

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

`tools`、`inheritCustomizations` 等字段来自官方 Markdown 代理配置。`excludeDefaultComponents` 沿用已安装 DSH 插件生成的定义。部署验收需要检查所装 agy 能识别该代理并在 ACP 中只挂载指定的 DSH MCP 工具。

- [Google 自定义代理的发现路径](https://antigravity.google/docs/subagents?tab=cli)
- [Google Markdown 代理字段](https://antigravity.google/docs/build-plugins)
- [DSH 上游代理生成逻辑](https://github.com/lili-luo/dsh-plugin-bundle/blob/6aac22493754c5aefb4642b2627c88b136c72b6d/dsh-llm-antigravity-acp/src/preflight.ts#L213-L243)

## 账号验收

在每个账号的实际 worker 身份下进入配置指定的工作目录，执行下列命令。配置 `geminiDir` 时，给每条命令附加同一个 `--gemini-dir <目录>`。命令输出只用于本机核对。

```powershell
agy --version
agy acp --help
agy agents
agy -p /config --output-format json
agy -p /usage --output-format json
```

确认 `agy agents` 能发现 `dsh-bridge`。核对 `/config` 显示的生效权限采用默认 Agent 模式和 `request-review`，且没有批准本机终端、文件或浏览器工具的规则。再做以下运行检查。

1. 在相同身份、工作目录和配置下执行 `agy --agent dsh-bridge -p "Reply only OK." --output-format stream-json`，检查首条 `init` 事件的 `init.tools` 是否缺少终端、文件、浏览器等内置工具。这是一次短模型调用，用于预检所选代理的工具配置。
2. 用实际 ACP 启动参数创建两个会话，分别挂载空 MCP 列表和一个测试 DSH 桥。前一个会话应能完成纯文本回复，后一个会话应能通过桥调用测试工具。检查 ACP 的 `tool_call` 和权限事件都只涉及配置中的测试桥；如果出现内置工具或别的 MCP 服务器，先修正代理配置和 CLI 权限再接入 DSH。
3. 确认两个账号各自返回预期模型组和额度，并记录版本、组名和字段形状。

额度映射使用 `command.data.groups[].name` 的确切组名，例如 `Gemini Models` 和 `Claude and GPT models`。每组必须各有一个 `weekly` 和 `5h` 窗口，两者的 `remaining_fraction` 均须为 0 至 1 的数。

截至本次检查，Sylvie 共享目录中的 Windows AMD64 `agy.exe` 与 Google 当前发布清单中的 `1.5.3` SHA-512 一致。真实双账号登录、worker 启动及现场额度响应仍需按上述步骤验收。

- [Google CLI 额度说明](https://antigravity.google/docs/cli/commands/usage/)
- [Google ACP 参数与权限回调](https://antigravity.google/docs/ide/extensions/acp/#flags)
- [Google CLI 权限设置](https://antigravity.google/docs/permissions/?tab=cli)
- [Google CLI 的流式 JSON 与 init 事件](https://antigravity.google/docs/cli/headless/)
- [Google Windows AMD64 发布清单](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json)
