# v0.6.1 全仓审查与离线验收

审查日期：2026-11-13。维护工程：`E:\Edoc\Projects\pro-flash-orchestrator`。

按用户后续要求取消子代理，由主控自行完成核心脚本、状态机、跨平台适配器、安装打包、测试、配置和文档的审查与修复。工作区已有的 v0.6 功能一起验收，当前版本统一为 0.6.1。此前失败的原生子代理没有交付实现，不作为验收证据。

## 问题与修复

| 范围 | 问题与完成的修改 |
| --- | --- |
| AGY 模型路由 | Hydrogen 能力不代表 Schema 接受 hydrogen。同时识别 modelName / model：Hydrogen 主会话默认 inherit，其他主会话默认 flash；保留任务与通用环境覆盖，PRO_HYDROGEN_ID 仅在明确有能力时生效 |
| 父子会话关联 | 支持转录 sender、契约 [PRO-PARENT:<id>]、旧版 spawn 状态和已认领记录。未认领记录只接受唯一候选父会话，多候选不按时间猜选。契约重复注入幂等，跨父会话复用时替换旧标识 |
| 同批文件互斥 | 父 Session 物理锁内原子检查 batchFileClaims；同批其他代理冲突则拒绝，多文件冲突不产生部分认领，新批清空、同批续派保留。无法恢复 AGY 父 ID、状态损坏或持久化失败时拒绝源码写入 |
| 状态持久化 | 明确传播写入失败并清理临时文件；拒绝更新无法读取或解析的现有 Session，避免清空已有认领记录 |
| 命令与派单守门 | 父子各保留最近 10 条脱敏放行记录；轮询、并发与递归分别记录原因。Codex list_agents 及原生命名别名进入同一轮询守门 |
| report | 复用 STATE_DIR / LOG_FILE；准确区分 deny 原因，无 lines 时不展示未知行数。展示 strategy 分布，按实际请求与保留行数估算 KB / Token，处理 EOF、旧日志及无效值，排除 shadow/off 假设节省，拒绝无效 --days |
| Codex 独立包 | 新增 adapters/codex/report.mjs，导入报告前设置 Codex 宿主；维护白名单包含入口与共享实现 |
| 安装与打包 | 本地 capabilities.json 保留且不进入发布包。工作区默认文件名从当前 plugin 版本派生，Git ref 打包从指定 ref 读取版本 |
| 验收脚本 | doctor 末尾通过原环境子进程重读宿主能力；并发测试通过 exitCode 和 finally 完成临时状态清理 |
| 文档与配置 | 根 SKILL.md / AGENTS.md 与规范目录同步；中英文 README、插件元数据、安装说明、Codex 说明与发布记录更新为 0.6.1，补充版本、镜像及 Matcher 一致性断言 |

原生 Orchestrator Lite Guard Mode、Audit 每次 self 派单增加 2 次且上限 10 的 ≤80 行切片额度、AGY 启动能力缓存、Flash 主模型 6 读 / 4 写宽松策略均保留并通过离线回归。

本机 Worker 已移除旧的 gpt-5.6-sol 配置，选用 gpt-6.1-sol / low；当前原生工具可选项为 gpt-6.1-sol、gpt-6-astra。用户配置与验证状态在仓库外保存，不进入提交。历史验收文档里的旧版本与模型保留当时证据。

## 关键改动抽检

终审先执行 git status --porcelain 检查范围，再按以下位置切片检查；行号对应本次最终源码。

| 文件 | 行号 | 抽检重点 | 验证证据 |
| --- | --- | --- | --- |
| scripts/lib.mjs | 245–286 | 旧状态迁移、唯一父会话恢复与失败传播 | doctor、v0.6、regressions |
| scripts/lib.mjs | 317–333 | 合法默认模型与显式覆盖 | capabilities、v0.6 |
| scripts/guard-subagent.mjs | 91–112 | 父 ID 注入幂等与契约重用 | regressions、capabilities |
| scripts/guard-write-file.mjs | 118–161 | 锁内认领、冲突与持久化失败拒绝 | doctor、v0.6、concurrency |
| scripts/report.mjs | 76–117 | 实际行数省流估算与 deny 分类 | v0.6、regressions |
| scripts/codex-hook.mjs | 169–178 | 原生轮询别名归一化 | test-codex |

## 测试结果

以下七套离线测试依次运行，全部成功退出。最终补充原生轮询别名后，重跑 v0.6 与 Codex 套件并重新构建 Codex ZIP。

| 命令 | 最终结果 |
| --- | --- |
| node scripts/doctor.mjs | 117 通过，0 失败 |
| node scripts/test-v060.mjs | 47 通过，0 失败 |
| node scripts/test-regressions.mjs | 40 通过，0 失败 |
| node scripts/test-concurrency.mjs | 4 组集成测试全部通过 |
| node scripts/test-install.mjs | 8 通过，0 失败 |
| node scripts/test-codex.mjs | 42 通过，0 失败 |
| node scripts/test-capabilities.mjs | 42 通过，0 失败 |

doctor 当前宿主能力摘要：strategy=flash-fallback, hasHydrogen=false, source=payload。test-v060.mjs 保留兼容文件名，内部发布版本断言为 0.6.1。

覆盖补强包括父 ID 缺失与歧义、旧状态迁移、契约重注入、损坏状态和写入失败、同批多文件冲突、EOF 与精确省流区间、异常日志与日期参数、提示词镜像、Matcher 对齐、本地状态保留、打包版本、独立 Codex 报告及原生轮询别名。日志保存在忽略目录 .maintenance/review-v0.6.1/，不随源码提交。静态语法、JSON 解析与 git diff --check 均通过。

## 打包与工作区

两个 ZIP 均使用当前工作区构建，并核对实际包内 plugin 版本与独立白名单。

| 包 | 条目数 | 包根目录 | plugin 版本 | 本地状态条目 |
| --- | --- | --- | --- | --- |
| pro-flash-orchestrator-antigravity-v0.6.1.zip | 15 | pro-flash-orchestrator/ | 0.6.1 | 0 |
| pro-flash-orchestrator-codex-v0.6.1.zip | 23 | pro-flash-orchestrator-codex/ | 0.6.1 | 0 |

ZIP 保存在 .maintenance/review-v0.6.1/packages/。发布包排除 .state/、.maintenance/、capabilities.json 和维护测试；原有本地状态保留，测试临时状态自动清理。

提交范围包括核心守门与状态库、报告、Codex 适配器与维护入口、安装打包、七套离线验收、发布工作流、Hook 配置、提示词镜像、中英文说明和发布记录。全仓路径可通过该发布提交的文件清单查看；忽略目录与仓库外用户配置不提交。

## 验收边界

离线测试证明模拟输入下的守门与打包行为，不证明真实宿主完整可用。最小 CLI 模型验证曾成功，但原生子代理遇到上游不可用，原生完整派发闭环仍待验证。Claude Code、账户登录、托管工具、Hook 超时及已获准交互式 shell 的后续输入也尚未完成真实覆盖验收。

本次按用户授权提交并同步 GitHub main；版本号更新与代码推送不等同于创建 Git 标签或发布 GitHub Release。
