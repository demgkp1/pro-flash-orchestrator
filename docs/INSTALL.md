# Pro-Flash Orchestrator 运行安装目录

此目录包含插件运行文件、提示词、图标和日志复盘工具。维护工程位于 `{{MAINTENANCE_DIR}}`，安装目录为 `{{INSTALL_DIR}}`。

更新时，在维护工程更新代码并完成测试，然后执行：

```powershell
node "{{MAINTENANCE_DIR}}/scripts/install.mjs" --target "{{INSTALL_DIR}}"
```

部署只复制运行文件，保留安装目录中的 `.state/`。`.state/mode.json` 为用户配置，由用户手动编辑；默认模式为 `enforce`，也支持 `shadow` 与 `off`。

诊断与回归测试在维护工程执行：

```powershell
node "{{MAINTENANCE_DIR}}/scripts/doctor.mjs"
node "{{MAINTENANCE_DIR}}/scripts/test-concurrency.mjs"
node "{{MAINTENANCE_DIR}}/scripts/test-regressions.mjs"
node "{{MAINTENANCE_DIR}}/scripts/test-install.mjs"
```

查看本安装目录的决策日志：

```powershell
node "{{INSTALL_DIR}}/scripts/report.mjs"
```

发布包中的尖括号路径需替换为本机实际路径。首次部署脚本会自动写入实际路径。
