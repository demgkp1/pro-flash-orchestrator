# Pro-Flash Orchestrator 运行安装目录

此目录包含插件运行文件、提示词、图标和日志复盘工具。维护工程位于 `{{MAINTENANCE_DIR}}`，安装目录为 `{{INSTALL_DIR}}`。

## 升级说明

### 1. Release 用户免 Git 一键在线升级（推荐）

v0.8.1 起，在 Antigravity App 打开 **Plugins → pro-flash-orchestrator**，在 **Pro-Flash Orchestrator** 面板（支持右上角 `中 / EN` 语言切换）中选择并保存一项统一的 Worker 档位（**Auto / 自动** 恢复默认），也可点击 **获取最新版本 / Check for updates** 升级。主模型按任务决定 `research` 或 `self`，角色环境变量仍可覆盖统一档位。面板未显示时，先启用插件及其 sidecar，再重载 App。

CLI 或旧版 Release 用户无需 Git，仍可运行安装目录中的更新脚本，在线拉取 GitHub Releases 最新精简包升级（保留 `.state/` 目录与用户配置）：

```powershell
node "{{INSTALL_DIR}}/scripts/update.mjs"
```

- 如网络受限，可先手动下载[官方 Release](https://github.com/demgkp1/pro-flash-orchestrator/releases) 的 `pro-flash-orchestrator-antigravity-v*.zip`，然后通过本地文件升级：
  ```powershell
  node "{{INSTALL_DIR}}/scripts/update.mjs" --zip "path/to/archive.zip"
  ```
- 支持 `--dry-run` 参数预览待更新文件，更新过程会自动验证包结构安全性并拒绝路径逃逸或符号链接。

### 2. 源码开发者/维护工程部署更新

在维护工程更新代码并完成测试，然后执行：

```powershell
node "{{MAINTENANCE_DIR}}/scripts/install.mjs" --target "{{INSTALL_DIR}}"
```

部署只复制运行文件，保留安装目录中的 `.state/`。`.state/mode.json` 为用户配置，由用户手动编辑；默认模式为 `enforce`，也支持 `shadow` 与 `off`。

## 诊断与回归测试

诊断与回归测试在维护工程执行：

```powershell
node "{{MAINTENANCE_DIR}}/scripts/doctor.mjs"
node "{{MAINTENANCE_DIR}}/scripts/test-concurrency.mjs"
node "{{MAINTENANCE_DIR}}/scripts/test-regressions.mjs"
node "{{MAINTENANCE_DIR}}/scripts/test-v060.mjs"
node "{{MAINTENANCE_DIR}}/scripts/test-capabilities.mjs"
node "{{MAINTENANCE_DIR}}/scripts/test-install.mjs"
node "{{MAINTENANCE_DIR}}/scripts/test-codex.mjs"
node "{{MAINTENANCE_DIR}}/scripts/test-update.mjs"
node "{{MAINTENANCE_DIR}}/scripts/test-contract-dual-track.mjs"
```

## 决策复盘

查看本安装目录的决策日志：

```powershell
node "{{INSTALL_DIR}}/scripts/report.mjs"
```

发布包中的尖括号路径需替换为本机实际路径。首次部署脚本会自动写入实际路径。
