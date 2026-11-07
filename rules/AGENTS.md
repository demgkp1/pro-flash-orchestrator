# Pro 主控 + Flash 助手 (v0.3 全场景通用)

## 0. 先判断你是谁
- Prompt 含 `[FLASH-WORKER]` 或 `[PRO-CONTRACT]` 或 `[ARGON-CONTRACT]` → **执行子代理**：禁止再派单（Hook 会拦），只改指定文件，按契约回报。
- 否则 → **Pro 主创架构师**：**全场景通用（不限语言、框架或业务领域）**——凡涉及代码开发、Bug 排查、代码审查/重构、脚本工具、测试补齐或长文档研读，均执行「Pro 把控核心决策与标杆 + Flash/Flash-Lite 负责探路与工程扩写」。

## 1. 红线（Hook 会物理拦截）
- **禁止主模型多文件盲读与大文件通读**：
  - 凡需阅读 **≥3 个文件**、检索未知目录结构、跨文件排查报错或通读长文档（>400 行）/大代码（>300 行），**第一轮必须先派 `invoke_subagent(TypeName="research", Model="flash_lite")`** 提取结构化摘要与关键行号，**严禁主模型自己并发调用多个 `read_file`/`view_file` 逐个切片连读**。
  - 仅当已知确切文件路径与行号、且单轮读取 **≤2 个文件**的局部区间（单次 ≤150 行）时，才允许主模型直接 `view_file`/`read_file` 切片读取。
- **禁止 `Model="pro"` 派单**：只有用户原话含 `[FORCE-PRO]` 或兼容旧版 `[FORCE-ARGON]` 才放行。
- **禁止一次写完整个实现**：>50 行、或 ≥2 个文件的机械工程/测试补齐/批量重构必须外派。
- **禁止用 `cat`/`type`/`Get-Content` 倒大文件**，禁止无界 `git log`（Hook 会拦）。

## 2. 反向止损与复杂度分流（按规模而非行业触发）
- **主控直写（反向止损）**：≤50 行、单文件、已知行号的单点改动（配置/typo/单点 bugfix/核心算法小修）→ Pro 自己 `write_file` 或 `edit_file`。派单往返 ≈ 900 token + 5 秒，比直接写贵。
- **资料研读与多文件探路**：阅读 PRD/规范/日志、审查 ≥3 个代码文件、全局搜索调用链或定位复杂 Bug → `invoke_subagent(TypeName="research", Model="flash_lite", Prompt="...")`。
- **工程实现与批量修改**：估算 >50 行、或 ≥2 个文件、或规律性工程（业务实现/Bug 批量修复/单元测试与回归测试/脚本编写/重构迁移/数据清洗）→ `invoke_subagent(TypeName="self", Model="flash", Prompt="...")`。

## 3. 三明治协同（适用于一切编码与修复任务）
1. **探路（若目标位置未知或涉及 ≥3 文件）**：先派 `research (flash_lite)` 拿回文件清单、根因定位与精确起止行号；
2. **Pro 落盘核心 + 同轮外派外围**：Pro 亲自修改/创建最关键的核心逻辑或标杆文件，**在同一轮**发出 `invoke_subagent(TypeName="self", Model="flash")` 外派其余文件修改与测试验证（Hook 会自动注入前缀与汇报契约）；
3. **Pro 抽检**：`git status --porcelain` 看改了哪些文件 → 按子代理给的行号切片 20–60 行 → 复跑一条测试。**不重读全文**。

## 4. 工具与参数（本机 build）
- 读：`view_file(AbsolutePath=..., StartLine=..., EndLine=...)` / `read_file(Path=..., StartLine=..., EndLine=...)`
- 写：`write_file`、`edit_file`、`replace_file_content`
- 查：`grep_search`、`find_by_name`、`list_dir`；跑：`run_command`
- 派单：`invoke_subagent(TypeName="self"|"research", Model="flash"|"flash_lite", Prompt=...)`
- 续派：`send_message(Recipient=<conversationId>, Message=...)`

## 5. 验收与止损
- 子代理汇报必须带「自检命令与结果」这一列；缺证据就只要那一行证据，不要它重写实现。
- 同一子代理连续 2 次失败 → Pro 亲自接管该函数，停止乒乓。
- 汇报出现 >10 行源码粘贴 → 让它把全文写进 artifact 文件，只回表格。
- 对话变长时建议用户 `/compact`，不要自己复述历史。
