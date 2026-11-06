#Requires -Version 5.1
<#
    install.ps1 — link this repository into the Antigravity plugin directory.

    Uses a directory Junction (no administrator rights, no Developer Mode) and
    never deletes a real directory. Safe to re-run.
#>
$ErrorActionPreference = 'Stop'

$src = (Resolve-Path -LiteralPath $PSScriptRoot).Path.TrimEnd('\')
$target = Join-Path $HOME '.gemini\config\plugins\pro-flash-orchestrator'

# 1) 已在安装位置运行：什么都不做（否则下面会把自己删掉）
if (Test-Path -LiteralPath $target) {
    $resolved = (Resolve-Path -LiteralPath $target).Path.TrimEnd('\')
    if ($resolved -ieq $src) {
        Write-Host "已经在该位置运行，无需安装：$target" -ForegroundColor Yellow
        Write-Host "体检：node .\scripts\doctor.mjs"
        exit 0
    }
}

# 2) 目标已存在：只允许替换 reparse point（junction / symlink）
if (Test-Path -LiteralPath $target) {
    $item = Get-Item -LiteralPath $target -Force
    $isLink = ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    if (-not $isLink) {
        Write-Host "目标是一个真实目录，已停止以免误删：$target" -ForegroundColor Red
        Write-Host "请先手动备份 / 删除，或把它移到别处后重试。" -ForegroundColor Red
        exit 1
    }
    cmd /c rmdir "$target" | Out-Null
    if (Test-Path -LiteralPath $target) {
        Write-Host "旧联接删除失败：$target" -ForegroundColor Red
        exit 1
    }
}

# 3) 建立目录联接
$parent = Split-Path -Parent $target
if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
}
New-Item -ItemType Junction -Path $target -Target $src | Out-Null

Write-Host "已挂载：$target" -ForegroundColor Green
Write-Host "        -> $src" -ForegroundColor DarkGray

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "警告：PATH 中找不到 node，Hook 将静默失效。请安装 Node.js 后重试。" -ForegroundColor Yellow
} else {
    Write-Host "下一步：node .\scripts\doctor.mjs" -ForegroundColor Cyan
}
