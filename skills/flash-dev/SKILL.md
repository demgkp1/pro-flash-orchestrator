---
name: flash-dev
description: >-
  启用 v3.3「Pro 主控架构师 + Flash/Flash-Lite 工程助手」分流工作流。覆盖后端与系统架构、CV/AI 与课业作业、
  Web 前端高审美、Blender/3ds Max、Unity/Unreal 及全栈工程，支持长文档探路、同轮并发派单与双档轻量模型调度。
  派单契约由 Hook 自动注入（`[PRO-CONTRACT]`），本技能只提供具体的派单步骤与 Prompt 模板。
---

# `/flash-dev` (v3.3)：主创把关 + 额度节流标准工作流

> 汇报契约、模型降级、递归拦截、大文件切片都由 Hook 兜底，**不需要在 Prompt 里手写契约**。本技能只负责"什么时候派、派给谁、给什么料、怎么验收"。

## 标准四步闭环

### 步骤 1：探路与提取（`TypeName: "research"`, `Model: "flash_lite"`）

需要检索未知工程结构、定位报错、或读取**需求文档（PRD）/API 规范/作业说明/数据库 Schema**时，必须派 `flash_lite`，不要自己通读：

```text
[FLASH-WORKER] 阅读以下内容并只返回结构化摘要（严禁粘贴长源码）：
目标：<文档路径 / 目录 / 报错日志>
提取：核心功能清单、字段约束与类型、路由或接口定义、评分标准、关键起止行号。
```

### 步骤 2+3：主创落盘标杆 + 同轮派发扩写（`TypeName: "self"`, `Model: "flash"`）

先由 Pro 写好标杆（Schema / 核心接口 / 算法骨架 / Design Tokens / Shader 核心），**在同一轮里**同时发出 `write_to_file` 与 `invoke_subagent`，省掉一次主模型唤醒。

#### 场景 A：后端与服务端工程

```text
[FLASH-WORKER] 你是最终执行代理（禁止再调用 invoke_subagent）。严格复用主创已落盘的架构与标杆代码：
## 1. 必读标杆
- `<Pro 刚写入的 Schema / 标杆 Controller / Service 绝对路径>`
- 约定：<ORM、统一响应体、错误码、认证中间件>
## 2. 扩写清单
- DAO/Repository：CRUD、分页与过滤查询；
- Service：其余业务分支、参数校验、数据转换；
- Controller/Router：注册路由并绑定中间件；
- 迁移与配置：Migration、docker-compose.yml、.env.example；
- 测试：单测 + 接口端到端（pytest / jest / go test）。
## 3. 自测
执行 `<npm test / pytest tests/ / go test ./...>`，报错自行修复闭环。
```

#### 场景 B：CV / AI 课业

```text
[FLASH-WORKER] 你是最终执行代理（禁止再调用 invoke_subagent）。基于主创已落盘的算法骨架完成实现：
## 1. 必读标杆
- `<核心模型/算法定义文件绝对路径>`
- 关键公式与设计要点：<Pro 的简述>
## 2. 实现清单
- DataLoader、增强（Resize/Normalize/Augmentation）、批处理；
- Train/Validation Loop、优化器与学习率调度；
- 指标（准确率/混淆矩阵/mAP）与 matplotlib 曲线；
- argparse/CLI 入口。
## 3. 自测
执行 `<python main.py --dry-run / pytest test_pipeline.py>`，报错自行修复闭环。
```

#### 场景 C：前端 / 3D / 引擎

```text
[FLASH-WORKER] 你是最终执行代理（禁止再调用 invoke_subagent）。严格复用主创标杆，禁止篡改其中的审美参数、CSS 变量、几何比例与材质配方：
## 1. 必读标杆
- `<Pro 刚写入的标杆文件绝对路径>`
## 2. 实现清单
- `<目标文件 1>`：<复刻标杆完成其余子组件 / 注册 Blender Panel & Operator / 封装 FBX 批量导出 / Unity 数据序列化>
- `<目标文件 2>`：<明细>
## 3. 自测
执行 `<构建 / 语法检查 / 单测>`，报错自行修复闭环。
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
