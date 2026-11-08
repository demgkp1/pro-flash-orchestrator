---
name: flash-dev
description: >-
  启用 v0.3.2「Pro 主控架构师 + Flash 工程助手」全场景通用分流工作流。Whenever the task involves reading >=3 files, exploring an unfamiliar codebase, debugging/fixing multi-file issues, code review, refactoring, writing tests, or building any feature/script/UI/backend/algorithm (>50 lines or >=2 files), use this workflow to delegate exploration and implementation to flash. 派单契约由 Hook 自动注入（[PRO-CONTRACT]）。
---

# `/flash-dev` (v0.3.2)：主控标杆 + Flash 执行全场景工作流

> 模型降级、递归与轮询拦截、写入与切片守门均由 Hook 物理兜底。子代理统一使用 `Model="flash"`。派单后立即结束当前回合静默等待系统异步唤醒，严禁调用 `manage_subagents` 轮询。

## 1. 核心流程：三明治协同四步法

1. **探路定位（`TypeName: "research"`, `Model: "flash"`）**：
   目标未知、涉及 ≥3 个文件或通读长文档/大代码时，派发探路代理提取关键结构、行号与根因，严禁主模型切片连读。
2. **标杆落地（Pro 亲自落盘）**：
   Pro 亲自编写核心接口、数据结构、关键算法或标杆组件（限制 ≤2 个文件）。
3. **同轮外派（`TypeName: "self"`, `Model: "flash"`）**：
   在落盘核心的**同一回复轮次**并发发出 `invoke_subagent`，将外围模块、CRUD、测试用例等派发给 Flash 助手，实现零等待外派。
4. **切片终审（Pro Audit）**：
   收到完成通知后，通过 `git status --porcelain` 审视变更范围；按汇报行号切片抽检 20–60 行，不重读全文；复跑一条集成验证。

---

## 2. 常用单代理派单模板

### 探路与审查模板（`research`, `Model="flash"`）
```text
[FLASH-WORKER] 阅读以下内容并返回结构化摘要（严禁粘贴长源码）：
目标：<文档路径 / 目录 / 待查代码库 / 报错日志>
提取：核心功能清单、关键起止行号、问题根因定位、受影响文件列表。直接在消息中结构化返回。
```

### 工程实现与测试补齐模板（`self`, `Model="flash"`）
```text
[FLASH-WORKER] 你是最终执行代理（禁止再调用 invoke_subagent）。严格基于主创标杆完成实现：
## 1. 必读标杆
- `<Pro 刚写入的核心文件绝对路径>`
- 约定与思路：<核心改动逻辑与变更规范>
## 2. 待实现/修改清单
- `<文件 1 路径>`：<实现具体逻辑或同步调用调整>
- `<测试文件路径>`：<编写单元测试覆盖核心分支>
## 3. 自测闭环
执行 `<npm test / pytest tests/ / cargo test>`，报错自行修复闭环。
```

---

## 3. 多 Subagent 并发编排（Fan-out Swarm）

面对跨模块开发、全栈前后端双工或多维度深度调研时，在单轮会话中并发扇出 2~5 个 Flash 子代理并行作业。

### 并发三大铁律
1. **同轮扇出（Single-turn Fan-out）**：必须在**同一回复轮次**连续调用多个 `invoke_subagent`（上限 5 个），严禁串行逐个等待；派完立即结束回合静默等待。
2. **互斥分区（Disjoint Sets）**：指派给各子代理的修改文件集合**严格互斥**，严禁重叠修改；自检仅运行各自模块的单文件局部测试，严禁全量构建。
3. **聚合终审（Aggregated Audit）**：各代理通过 `send_message` 汇报后，Pro 统一通过 `git status --porcelain` 与切片抽检完成最终集成验收。

### 并发编排模板

#### 模板 A：分模块并行工程扩写（`self`, `Model="flash"`）
```text
<!-- 同轮并发派发 Agent 1 -->
[FLASH-WORKER] 你是最终执行代理。根据标杆实现【模块 A】：
## 1. 必读标杆：`<核心接口文件绝对路径>`
## 2. 专属写入文件（互斥红线，禁止触碰其他模块）：`<src/module_a/impl.ts>`
## 3. 局部自测：仅运行 `<npm test tests/module_a.test.ts>`。

<!-- 同轮并发派发 Agent 2 -->
[FLASH-WORKER] 你是最终执行代理。根据标杆实现【模块 B】：
## 1. 必读标杆：`<核心接口文件绝对路径>`
## 2. 专属写入文件（互斥红线，禁止触碰其他模块）：`<src/module_b/impl.ts>`
## 3. 局部自测：仅运行 `<npm test tests/module_b.test.ts>`。
```

#### 模板 B：多维并行调研 / 前后端双工（`Model="flash"`）
```text
<!-- 维度一 / 前端代理 -->
[FLASH-WORKER] 维度一：外部规范/前端组件实现
- 范围：<规范文档 / src/frontend/views>
- 要求：提取设计规范核心摘要或完成视图绑定，运行局部验证。

<!-- 维度二 / 后端代理 -->
[FLASH-WORKER] 维度二：内部架构调用链/后端 API 实现
- 范围：<服务端模块 / src/backend/api>
- 要求：提取依赖拓扑或完成 API 路由，运行局部测试。
```

---

## 4. 汇报契约（Hook 自动追加）

| 文件绝对路径 | 起止行号 | 核心变更 | 自检命令与结果 |
| :--- | :--- | :--- | :--- |

- 完整分析写入 artifact 目录，聊天消息中仅返回四列表格。
- 严禁子代理粘贴 >10 行源码；自检命令必须真实执行并提供明确的 Pass/Fail 结果。
