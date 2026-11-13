# Codex 0.5.2 验收记录

日期：2026-11-11。维护工程 E:\Edoc\Projects\pro-flash-orchestrator。交接补丁已集成；真实验收仍未全部通过，尚未宣布 Codex 完整可用，也未创建 v0.5.2 Release。

## 模拟与离线检查

READY.json 的 14 个文件已逐一校验源文件与暂存文件 SHA-256，并由 APPLY_CHANGESET.mjs 写入维护工程。原有改动均保留。维护工程再次通过 doctor 90 项、漏洞回归 25 项、安装/打包 7 项与 Codex 离线 32 项，共 154 项；并发压测通过，包括 8 进程共 160 次更新、身份认领与五次派发配额。

首轮真实验收发现扁平工具名称未识别后，新增回归覆盖模型/effort/契约/独立上下文、递归、配额、追加消息、补丁与命令守门、Windows 元数据替换的有限重试与持续失败拒绝、CLI/app-server 两种协作项目格式，以及根 agent_id 与 session_id 相同时的写入配额。最后一项先复现失败，再修复角色归一化；最终 Codex 离线检查为 40 项，全通过；合计 162 项离线断言。离线结果不等同于真实 CLI 验收。

## 已获得的真实证据

| 项目 | 结果与证据 |
| --- | --- |
| 本地平台 | codex-cli 0.167.0-alpha.3.2，Node E:\Nodejs\node.exe |
| 原生安装 | 官方 marketplace add/plugin add 已注册 0.5.2，本地源路径 plugins/pro-flash-orchestrator/ |
| Hook 加载 | 插件 bundled Hooks 未被本机加载；兼容接线改用 CODEX_HOME/hooks.json 六个用户级原生事件，保留其他 Hook |
| 用户审核 | 用户回复已在 Codex 审核；原生 hooks/list 实际返回六个 enabled=true、trustStatus=trusted |
| 桌面触发 | 本次聊天观察到 SessionStart、PreToolUse、PostModelRequest 等真实日志；该事实尚未证明全部守门场景 |
| 默认模型 | gpt-6-luna 在 agentrouter 返回 503，无可用渠道；未启用该候选 |
| 本地助手 | 用户选择 gpt-5.6-sol、low；真实最小 CLI 请求成功；turn_context 确认相同模型与 effort |
| 最小探测会话 | 01a1c9ae-34f3-7b11-b7ec-e622d813e5ad |
| 可获得用量 | input_tokens=9918、output_tokens=19、cache_write_input_tokens=9915、reasoning_output_tokens=0；不推断官方费用 |
| 真实卸载/重装/升级 | 三个阶段均保留 config.json、mode.json、worker-verification.json 和现有日志内容；重复升级 changed=0。记录在 `.maintenance/codex-0.5.2/install-retention.json` |
| 最终算法模型探测 | 2026-11-11T10:14:46.981Z，线程 01a1ca1a-5a57-7711-8d86-dff8ee551daf；实际 turn_context 为 gpt-5.6-sol/low，input_tokens=9918、output_tokens=19 |
| 修复后用户审核 | 用户再次审核六个更新后的 Hook，真实 preflight 在 2026-11-11T10:14:55.690Z 返回 ready，六个均 enabled/trusted，无原生 Hook 错误 |
| Antigravity 同步 | 15 个运行文件已同步到原安装区；78 个已有 .state 文件 SHA-256 全部不变 |
| 平台运行包 | 本地重建 Antigravity 15 文件、Codex 20 文件 ZIP，均通过精确独立白名单，不含维护目录与用户状态 |
| 最终角色补丁安装与审核 | 2026-11-11T10:42:56.501Z 完成真实卸载、重装、重复升级，四类配置/日志保留检查全部通过，重复升级 changed=0；用户审核后在 2026-11-11T10:50:07.136Z 确认六个 enabled/trusted、hookState=observed，无原生错误 |

运行配置/登录凭据指纹算法的加固使旧证明失效，已对最终算法重新执行真实 --verify-worker。脚本更新的启动命令哈希变化均要求用户重新审核；不能把先前审核结果当成新代码已获审核。实际工作者请求失败会使模型证明失效，最小探测成功不能证明完整原生助手闭环可用。

## 首轮真实验收及修复

首轮 opt-in CLI 验收在 2026-11-11T09:55:26.225Z 完成，3/5 通过。普通写入、批量 add/update/delete/move 原子拒绝和不可用模型显式失败有真实证据。大输出场景已记录真实 dump 拒绝，但验收脚本未识别 Bash 名称；派发场景真实收到 collaborationspawn_agent，旧 Hook 未识别该扁平名称，因此没有记录模型/契约改写，未判通过。

已修复点分隔与扁平 namespace 的工具名称归一化、追加消息契约、Windows 短暂元数据替换冲突，以及根 agent_id 等于 session_id 时被共享守门误判为子代理的问题。验收脚本识别 Bash/exec_command、原生 wait_agent 和 CLI collab_tool_call/app-server collabAgentToolCall，并分别记录关闭、中断和工作者错误。缺少调用、缺少真实工作者文件证据或仅有中断都不能当作完成关闭。

第二轮全量真实验收在 2026-11-11T10:19:54.711Z 完成，仍为 3/5。大输出场景在模型调用前超时；原生派发已记录真正的模型/契约改写，但助手没有交付文件。随后大输出定向验收为 1/1，通过真实 Bash 调用、dump 拒绝日志和有界 CLI 输出验证。原生助手定向验收为 0/1，记录了 gpt-5.6-sol 子代理连续六次 `response.failed`；原生最小 PING 子代理即使不调用工具也失败，未能定位到宿主或提供商中的具体原因。

用户选择试验 gpt-5.6-luna/low 后，单独最小真实探测在 2026-11-11T10:28:37.447Z 返回 HTTP 503，明确说明 AgentRouter default 分组对该模型无可用渠道；turn_context 确认请求确实为 gpt-5.6-luna/low，没有模型回退。插件配置仍为 gpt-5.6-sol/low，未启用失败候选。最小 CLI 请求成功不能替代原生子代理验收。

用户补充本机 API key 的模型可用性不稳定，并提出 gpt-6.1-luna 作为理想后续候选，但这把 key 不包含该模型。发行默认与本机模型保持分离：公开默认仍为 gpt-6-luna/low，本机为 gpt-5.6-sol/low，各用户必须在自己的账户和提供商下真实验证。[OpenAI 官方 Models 页面](https://developers.openai.com/codex/models/)本次列出 gpt-6-luna，未确认 gpt-6.1-luna 这一公开标识，不因本机 key 限制把 gpt-5.6-sol 改为发行默认。

用户明确选择「等稳定渠道完成原生闭环后发布」。0.5.2 保持待发布，不以实验性声明替代完整验收门槛；暂存的实验性发布稿只是未采用的备选。

本地证据分别保存在 `.maintenance/codex-0.5.2/first-live-report.json`、`codex-live-report.json`、`codex-live-large-output-denied-report.json`、`codex-live-native-collaboration-report.json`、`candidate-probe.json` 和 `install-retention.json`。已有四类场景的真实通过证据；最后角色补丁的全量 5/5 验收、助手契约/独立上下文/递归/wait/close 闭环，以及安装后新桌面会话重复验证仍未完成。

## 仍待完成

1. 恢复原生助手请求链路或由用户提供并配置已确认可用的助手模型，再完成修复后的 opt-in test-codex-live，尤其实际助手模型/effort/契约/独立上下文、递归拒绝、wait/collect/close。模型未调用指定工具或工作者断流均属于未完成验收。
2. 在安装后新的桌面会话重复核心场景，核对原生记录、插件日志及文件实际结果。
3. 全部必需验收通过后创建/推送 v0.5.2 标签、等待 Release Actions 并核对两个附件；保留 v0.5.1。用户已另行授权将现有补丁提交并同步到 main，代码同步不代表发布验收通过。

## 当前阻碍与覆盖边界

本次维护聊天已具备 E 盘工程写权限。自动审批服务曾再次返回 agentrouter content-blocked，相关动作没有执行；用户切换到用户审批后完成原生安装与真实模型调用。三个原生审查/修复工作者均反复返回 `stream disconnected before completion: response.failed event received`，没有交付修改；用户显式允许主代理补齐必要修复和测试，并输入 [ALLOW-WRITE] 供现有写入守门识别。主模型与凭据未更改，未使用昂贵模型回退。

2026-11-11 的发布前检查确认 v0.5.2 Release 不存在，远端没有 v0.5.2 标签；v0.5.1 标签保留。该检查时维护工程 HEAD 为 0684eec，0.5.2 修改尚未提交或推送。用户随后授权将已集成补丁提交并同步到 GitHub main；本记录随补丁提交。v0.5.2 标签及 Release 仍等待真实助手闭环与新桌面会话验收通过。

账号登录模式、Claude Code 均未做真实验收。宿主跳过 Hook、超时/错误、hosted tools，以及已批准交互 Shell 的后续输入可能不受拦截。该插件不是绝对安全边界。
