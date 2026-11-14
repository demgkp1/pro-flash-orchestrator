# Pro-Flash Orchestrator 运行安装目录

此目录包含插件运行文件、提示词、图标和日志复盘工具。维护工程位于 `{{MAINTENANCE_DIR}}`，安装目录为 `{{INSTALL_DIR}}`。

## 升级说明

### 1. Release 用户免 Git 一键在线升级（推荐）

普通 Release 用户无需维护 Git 仓库或源码，直接在安装目录下执行以下命令，即可一键在线拉取 GitHub Releases 最新精简包覆盖升级（自动保留 `.state/` 目录与用户配置）：

```powershell
node "{{INSTALL_DIR}}/scripts/update.mjs"
```

- 如网络受限，可先手动下载最新 Release 的 `pro-flash-orchestrator-antigravity-v*.zip`，然后通过本地文件升级：
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
```

## 决策复盘

查看本安装目录的决策日志：

```powershell
node "{{INSTALL_DIR}}/scripts/report.mjs"
```

发布包中的尖括号路径需替换为本机实际路径。首次部署脚本会自动写入实际路径。
