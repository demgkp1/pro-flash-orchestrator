---
name: flash-dev
description: >-
  启用 v0.4.1「Pro 主控架构师 + Flash 工程助手」全场景通用分流工作流。Whenever the task involves reading >=3 files, exploring an unfamiliar codebase, debugging/fixing multi-file issues, code review, refactoring, writing tests, or building any feature/script/UI/backend/algorithm (>50 lines or >=2 files), use this workflow to delegate exploration and implementation to flash. 派单契约由 Hook 自动注入（[PRO-CONTRACT]）。
---

# `/flash-dev` (v0.4.1)：主控标杆 + Flash 执行工作流

> 降级、防嵌套、写入与切片守门均由 Hook 兜底。子代理统一 `Model="flash"`。派单后静默等待，严禁 `manage_subagents` 轮询。

## 1. 三明治协同四步法

1. **探路（`research`）**：目标未知、查 ≥3 文件或长代码时派发，提取结构与根因，严禁切片连读。
2. **标杆（Pro 直写）**：Pro 亲自落盘核心接口、数据结构、算法或标杆组件（≤2 文件）。
3. **外派（`self`）**：同轮并发发出 `invoke_subagent` 派发外围模块与测试，零等待外派。
4. **终审（Audit）**：`git status --porcelain` 查范围，按汇报行号抽检 20–60 行，复跑集成验证。

## 2. 并发三铁律（Fan-out Swarm）

跨模块、前后端或多维调研时，单轮扇出 2~5 个 Flash 子代理并行：
1. **同轮扇出（Fan-out）**：单轮上限 5 个，同轮并发派发全部子代理，严禁串行等待；派完立即静默等待唤醒。
2. **互斥分区（Disjoint Sets）**：专属修改文件严格互斥，严禁重叠；自检仅限单文件局部测试，严禁全量构建。
3. **聚合终审（Audit）**：按四列表格汇报后，Pro 统一通过 `git status --porcelain` 与抽检验收。

## 3. 标准派单模板

### 探路调研（`TypeName="research"`, `Model="flash"`）
```text
[FLASH-WORKER] 调研：<路径/目录/代码库/日志>
提取功能清单、关键行号、根因与受影响文件列表，直接在消息中返回，严禁粘贴长源码。
```

### 工程实现（`TypeName="self"`, `Model="flash"`）
```text
[FLASH-WORKER] 严格基于标杆实现（禁止再派单）：
1. 必读标杆：<Pro 写入的核心文件绝对路径>
2. 专属修改（互斥红线）：<目标文件路径与实现要求>
3. 局部自测：仅运行单模块测试 <npm test path/to/test>，报错自行闭环。
```

## 4. 汇报契约（Hook 自动追加）

| 文件绝对路径 | 起止行号 | 核心变更 | 自检命令与结果 |
| :--- | :--- | :--- | :--- |

- 完整分析写入 artifact 目录，聊天仅回四列表格。
- 严禁粘贴 >10 行源码；自检命令必须真实执行并提供明确结果。
