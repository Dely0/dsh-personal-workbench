#Requires -Version 7
<#
.SYNOPSIS
    创建 / 更新 GitHub Release。**只做这一件事**，凭据从本机约定位置读，绝不回显。

.DESCRIPTION
    为什么要有这个脚本而不是手搓 JSON（发布 skill 第 3/7 条）：
      1. **Title 硬校验**：Release 的 `name`（标题）只允许版本号（如 `v1.16.0`）。
         历史上真写成了 `v1.15.2 — 今日容量规则透明化…`，用户明确要求标题不带描述。
         `## 主题` 那一段属于 body。本脚本在**发请求之前**就拒绝带描述的标题。
      2. **正文必须 UTF-8**：Windows PowerShell 5.1 会把中文按 ANSI/GBK 编码 → 乱码。
         `#Requires -Version 7` 让它只能被 pwsh 7 执行（读无 BOM UTF-8 中文没问题）。
      3. **只推 tag ≠ 建了 Release**：`/releases` 页面显示的是 Release 条目。
         所以本脚本建完**必须复核 `releases/latest`** 指向新 tag，而不是只看 POST 返回 200。

.PARAMETER Tag
    已存在并已推送的 tag，例如 `v1.16.0`。

.PARAMETER Title
    Release 标题。**只允许版本号**（可与 Tag 不同大小写，别的都不行）。

.PARAMETER BodyFile
    Release 正文（Markdown）路径，通常是 `docs/releases/v<version>.md`。

.PARAMETER Repo
    默认本仓库。格式 `owner/name`。

.PARAMETER Prerelease
    标记为预发布。

.EXAMPLE
    pwsh -File scripts/new-github-release.ps1 -Tag v1.16.0 -BodyFile docs/releases/v1.16.0.md
#>
param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [string]$Title,
  [Parameter(Mandatory = $true)][string]$BodyFile,
  [string]$Repo = 'Dely0/dsh-personal-workbench',
  [switch]$Prerelease
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Title)) { $Title = $Tag }

# ── 1. Title 硬校验：只允许版本号 ────────────────────────────────────────────
if ($Title -notmatch '^v?\d+\.\d+\.\d+(-[0-9A-Za-z.\-]+)?$') {
  throw "Release Title 只允许写版本号（如 v1.16.0），当前是「$Title」。主题/变更内容请放进 body（发布 skill 第 2 条）。"
}

# ── 2. 正文必须存在且是 UTF-8 文本 ───────────────────────────────────────────
if (-not (Test-Path -LiteralPath $BodyFile)) { throw "正文文件不存在：$BodyFile" }
$body = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $BodyFile), [Text.UTF8Encoding]::new($false))
if ($body.Length -lt 100) { throw "正文过短（$($body.Length) 字符），像是空文件：$BodyFile" }

# ── 3. tag 必须已存在（本地），否则 Release 会指向不存在的 ref ────────────────
$localTag = (git tag -l $Tag) -join ''
if ($localTag -eq '') { throw "本地没有 tag $Tag —— 先 `git tag -a $Tag -F <msg>` 再 `git push origin $Tag`。" }

# ── 4. 凭据：按 DSH_TOKEN_DIR → 本机隐含位置依次找，绝不回显 ──────────────────
function Get-GitHubToken {
  $candidates = @()
  if ($env:DSH_TOKEN_DIR) { $candidates += (Join-Path $env:DSH_TOKEN_DIR '.gh_token.txt') }
  $candidates += (Join-Path $env:USERPROFILE '.dsh\team-keys\.gh_token.txt')
  $candidates += (Join-Path $env:USERPROFILE '.dsh\.secrets\.gh_token.txt')
  foreach ($path in $candidates) {
    if (Test-Path -LiteralPath $path) {
      $raw = Get-Content -LiteralPath $path -Raw
      $m = [regex]::Match($raw, 'gh[pousr]_[A-Za-z0-9]{20,}')
      if ($m.Success) { return $m.Value }
      $m2 = [regex]::Match($raw, 'GithubToken\s*=\s*(\S+)')
      if ($m2.Success) { return $m2.Groups[1].Value }
    }
  }
  # 回退：git credential（fine-grained PAT 常在 git 里，而它可能缺 Issues 写权限）
  $cred = "protocol=https`nhost=github.com`n`n" | git credential fill 2>$null
  $m3 = [regex]::Match(($cred -join "`n"), 'password=(\S+)')
  if ($m3.Success) { return $m3.Groups[1].Value }
  throw '找不到 GitHub token（试过 DSH_TOKEN_DIR、~/.dsh/team-keys、~/.dsh/.secrets、git credential）。'
}

$token = Get-GitHubToken
Write-Host "凭据已取得（长度 $($token.Length)，不回显）"

# ── 5. 建 Release（已存在则改用 PATCH 更新标题与正文，避免 422）─────────────
$proxy = $env:DSH_GITHUB_PROXY
$headers = @{
  Authorization          = "Bearer $token"
  Accept                 = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
  'User-Agent'           = 'dsh-personal-workbench-release'
}
$payload = @{
  tag_name   = $Tag
  name       = $Title
  body       = $body
  draft      = $false
  prerelease = [bool]$Prerelease
} | ConvertTo-Json -Depth 4

$api = "https://api.github.com/repos/$Repo/releases"
if ($proxy) { $env:HTTPS_PROXY = $proxy }

try {
  $created = Invoke-RestMethod -Method Post -Uri $api -Headers $headers -Body $payload -ContentType 'application/json; charset=utf-8'
  Write-Host "✅ 已创建 Release：$($created.html_url)"
} catch {
  $status = $_.Exception.Response.StatusCode.value__
  if ($status -eq 422) {
    Write-Host '该 tag 已有 Release（422）→ 改为更新标题与正文'
    $existing = Invoke-RestMethod -Method Get -Uri "$api/tags/$Tag" -Headers $headers
    $updated = Invoke-RestMethod -Method Patch -Uri "$api/$($existing.id)" -Headers $headers -Body $payload -ContentType 'application/json; charset=utf-8'
    Write-Host "✅ 已更新 Release：$($updated.html_url)"
  } else {
    throw
  }
}

# ── 6. 复核：必须查 latest，不能只看 POST 返回 ───────────────────────────────
$latest = Invoke-RestMethod -Method Get -Uri "$api/latest" -Headers $headers
Write-Host "releases/latest = $($latest.tag_name)  标题 = $($latest.name)"
if ($latest.tag_name -ne $Tag) {
  throw "复核失败：releases/latest 指向 $($latest.tag_name)，不是 $Tag（可能被更晚的 prerelease 挤掉了）。"
}
Write-Host '✅ 复核通过：releases/latest 指向本次 tag'
