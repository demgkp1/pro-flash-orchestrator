---
name: flash-dev
description: >-
  启用 v0.3「Pro 主控架构师 + Flash/Flash-Lite 工程助手」全场景通用分流工作流。Whenever the task involves reading >=3 files, exploring an unfamiliar codebase, debugging/fixing multi-file issues, code review, refactoring, writing tests, or building any feature/script/UI/backend/algorithm (>50 lines or >=2 files), use this workflow to delegate exploration to flash_lite and mechanical implementation/testing to flash. 派单契约由 Hook 自动注入（[PRO-CONTRACT]）。
---

# `/flash-dev` (v0.3)：主创把关 + 额度节流全场景通用工作流

> 汇报契约、模型降级、递归拦截、大文件切片都由 Hook 兜底，**不需要在 Prompt 里手写契约**。本技能只负责“什么时候派、派给谁、给什么料、怎么验收”。

## 触发准则（全场景按规模触发，不限领域）

- **多文件探路 / 审查 / 排错（≥3 个文件或长文档/日志）**：
  必须先派 `invoke_subagent(TypeName="research", Model="flash_lite")` 提取结构化摘要与关键起止行号，**严禁主模型自己连续并发调用 `read_file`/`view_file` 逐个切片探路**。
- **多文件修改 / 批量实现 / 测试补齐（>50 行或 ≥2 个文件）**：
  Pro 只写最关键的核心标杆或关键修复点，**在同一轮并发派发** `invoke_subagent(TypeName="self", Model="flash")` 完成外围修改与自测闭环。
- **单点微调（≤50 行、≤2 个已知文件且行号明确）**：
  Pro 直接切片读取并修改，无需派单（避免派单通信开销与往返时延）。

---

## 标准四步闭环

### 步骤 1：探路与定位（`TypeName: "research"`, `Model: "flash_lite"`）

需要检索未知工程结构、定位跨文件报错、审查代码库或通读**需求文档（PRD）/API 规范/作业说明/数据库 Schema/长日志**时，派发轻量探路者：

```text
[FLASH-WORKER] 阅读以下内容并只返回结构化摘要（严禁粘贴长源码）：
目标：<文档路径 / 目录 / 待查代码库 / 报错日志>
提取：核心功能清单、关键起止行号、问题根因定位、受影响文件列表。直接在消息中结构化返回。
```

### 步骤 2+3：主创落盘标杆 + 同轮派发扩写（`TypeName: "self"`, `Model: "flash"`）

Pro 亲自落盘核心接口/标杆代码/关键修补点，**并在同一轮回复中**发出 `write_file`/`edit_file` 与 `invoke_subagent`，实现零等待外派。

#### 模板 A：代码审查 / Bug 排查 / 跨文件重构与修复（日常最高频）
适用于多文件 Bug 修复、接口变更引起的批量重构、代码规范与 Lint 治理。
- **探路**：先派 `research (flash_lite)` 定位所有引用点、调用链及关键起止行号；
- **Pro 改核心**：Pro 修复核心根因或标杆函数；
- **同轮外派**：派发 `self (flash)` 同步修改其余调用点并运行测试套件验证。

```text
[FLASH-WORKER] 你是最终执行代理（禁止再调用 invoke_subagent）。修复其余关联文件并验证测试：
## 1. 核心修复与标杆
- Pro 已修复的核心文件：`<核心文件绝对路径#起止行号>`
- 修复思路与约定：<说明核心改动逻辑与变更规范>
## 2. 待修改清单
- `<文件 1 路径>`：<根据标杆同步修改调用传参或类型定义>
- `<文件 2 路径>`：<同步调整适配>
## 3. 自测闭环
执行 `<npm test / pytest tests/ / cargo test / go test ./...>`，若有报错自行排查修复直至测试全部通过。
```

#### 模板 B：通用功能开发 / 后端服务 / CLI 与脚本工具 / 插件工程
适用于业务开发、服务端 API、自动化脚本、插件及各种工程脚手架。
- **Pro 立标杆**：Pro 编写核心 Schema、核心数据结构、核心接口声明或核心处理器；
- **同轮外派**：派发 `self (flash)` 扩写子模块、参数解析、数据转换层与单测。

```text
[FLASH-WORKER] 你是最终执行代理（禁止再调用 invoke_subagent）。严格复用主创已落盘的架构与标杆代码：
## 1. 必读标杆
- `<Pro 刚写入的 Schema / 标杆 Controller / Service / 核心模块 绝对路径>`
- 约定：<ORM/统一响应/错误码/认证/CLI参数规范>
## 2. 扩写清单
- 子模块/DAO/Service：实现具体 CRUD 分支、参数校验与数据转换；
- Controller/CLI：注册路由/解析子命令并绑定处理器；
- 配置文件与测试：配置模板、单元测试与端到端集成测试（覆盖正常与异常分支）。
## 3. 自测闭环
执行 `<构建与测试命令，如 npm test / pytest tests/>`，确保语法正确且测试全部通过。
```

#### 模板 C：前端 UI / 客户端界面 / 3D 与游戏视觉
适用于 Web 前端、桌面客户端、移动端、Blender/3ds Max 插件、Unity/Unreal 脚本等。
- **Pro 控审美**：Pro 锁死 Design Tokens、CSS 变量、关键布局比例、Shader 核心或标杆组件；
- **同轮外派**：派发 `self (flash)` 扩写其余视图、次级组件、交互状态与资源绑定。

```text
[FLASH-WORKER] 你是最终执行代理（禁止再调用 invoke_subagent）。严格复用主创标杆，禁止篡改其中的审美参数、CSS 变量、几何比例与材质配方：
## 1. 必读标杆
- `<Pro 刚写入的标杆组件 / 样式 Token / 脚本文件绝对路径>`
- 视觉与交互约定：<设计规范、色彩规范、响应式断点、状态机约定>
## 2. 实现清单
- `<目标文件 1>`：<复刻标杆完成其余子视图 / 状态切换 / 动效绑定>
- `<目标文件 2>`：<表单组件 / 布局适配 / 资产导出与序列化>
## 3. 自测闭环
执行 `<npm run build / lint / 单元测试 / 预览验证>`，报错自行修复闭环。
```

#### 模板 D：算法实验 / 数据处理 / AI 与工程作业
适用于数据分析清洗、机器学习/深度学习训练、数值计算、算法实验及课业设计。
- **探路**：派 `research (flash_lite)` 读取需求说明/数据 Schema/评分标准；
- **Pro 写核心**：Pro 编写核心算法骨架、数学公式实现或核心模型架构；
- **同轮外派**：派发 `self (flash)` 编写数据管道、训练/评测循环、可视化及命令行入口。

```text
[FLASH-WORKER] 你是最终执行代理（禁止再调用 invoke_subagent）。基于主创已落盘的核心算法骨架完成完整流水线：
## 1. 必读标杆
- `<核心算法 / 模型定义文件绝对路径>`
- 数学逻辑与设计要点：<Pro 简述算法要点与输入输出规范>
## 2. 实现清单
- 数据管道：数据加载、清洗过滤、数据增强与批处理（Batching）；
- 实验流水线：执行循环、评估指标（准确率/损失/混淆矩阵/召回率等）；
- 结果输出与入口：绘制曲线图表（如 matplotlib / UI 表格）及 CLI 参数解析入口。
## 3. 自测闭环
执行 `<python main.py --dry-run / pytest test_pipeline.py>`，报错自行修复闭环。
```

### 步骤 4：切片终审（Pro Audit）

1. `git status --porcelain` 看实际改动范围，防止子代理越界改文件；
2. 按汇报的行号 `view_file(AbsolutePath, StartLine, EndLine)` 抽检 20–60 行（不重读全文）；
3. 核心事务/算法/视觉微调 → Pro 亲自 `edit_file`；
4. 逻辑/依赖报错 → `send_message(Recipient="<conversationId>", Message="报错原文 + 期望行为")` 打回**同一**子代理；
5. 同一子代理连续 2 次失败 → Pro 接管该函数。

## 汇报契约（由 Hook 自动追加，仅供理解）

| 文件绝对路径 | 起止行号 | 核心变更 | 自检命令与结果 |
| --- | --- | --- | --- |

- 完整报告写入 artifact 目录下的 `<task>.report.md`，聊天里只回表格；
- 子代理若粘贴 >10 行源码，主代理应要求"写入文件、只回表格"，而不是接受它。
