# DesignCraft CLI 설치 (Windows). '원본 수정' 화면이 쓰는 MCP 서버다.
#
#   powershell -ExecutionPolicy Bypass -File deploy\install_designcraft.ps1
#
# 하는 일: 릴리스 zip 내려받기 → SHA256 대조 → designcraft-cli.exe만 기본 위치에 두기 → 확인.
# 관리자 권한이 필요 없다(내 계정 폴더에만 쓴다). 지울 때는 그 폴더를 지우면 끝이다.
#
# 앱은 아래 순서로 CLI를 찾는다. 기본 위치에 두면 설정이 필요 없다.
#   1) 환경변수 PG_DESIGNCRAFT_CLI   2) PATH   3) 각 OS의 기본 설치 위치

[CmdletBinding()]
param(
  # 올리고 싶은 판이 있으면 태그를 준다. 비우면 가장 최근 릴리스를 쓴다.
  [string]$Tag = "",
  # 다른 곳에 두고 싶을 때. 기본값은 앱이 알아서 찾는 자리다.
  [string]$Dest = "$env:LOCALAPPDATA\Programs\ArtCraft\DesignCraft",
  # 이미 있어도 다시 받는다.
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # 진행 막대가 있으면 내려받기가 몇 배 느려진다
$repo = "storytold/designcraft"
$exe = Join-Path $Dest "designcraft-cli.exe"

function Step($n, $t) { Write-Host "[$n/5] $t" -ForegroundColor Cyan }

if ((Test-Path $exe) -and -not $Force) {
  Write-Host "이미 있습니다: $exe" -ForegroundColor Green
  & $exe --version
  Write-Host "다시 받으려면 -Force 를 붙이세요."
  exit 0
}

# 이 PC가 무엇인지에 따라 받을 것이 다르다
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  "AMD64" { "x64" }
  "ARM64" { "arm64" }
  "x86"   { "x86" }
  default { throw "모르는 CPU입니다: $env:PROCESSOR_ARCHITECTURE" }
}

Step 1 "릴리스 정보 받는 중 ($repo, $arch)"
$api = if ($Tag) { "https://api.github.com/repos/$repo/releases/tags/$Tag" }
       else { "https://api.github.com/repos/$repo/releases/latest" }
$rel = Invoke-RestMethod -Uri $api -Headers @{ "User-Agent" = "PrintGuard-AI" }
$ver = $rel.tag_name
$zipName = "designcraft-$($ver.TrimStart('v'))-windows-$arch-portable.zip"
$zipAsset = $rel.assets | Where-Object { $_.name -eq $zipName }
$sumAsset = $rel.assets | Where-Object { $_.name -eq "SHA256SUMS.txt" }
if (-not $zipAsset) { throw "$ver 에 $zipName 이 없습니다. 릴리스 페이지를 확인하세요." }
Write-Host "    $ver / $zipName ($([math]::Round($zipAsset.size / 1MB)) MB)"

$tmp = Join-Path $env:TEMP "pg-designcraft-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  $zip = Join-Path $tmp $zipName
  Step 2 "내려받는 중 — 100MB가 넘어 몇 분 걸립니다"
  Invoke-WebRequest -Uri $zipAsset.browser_download_url -OutFile $zip

  Step 3 "체크섬 대조"
  if ($sumAsset) {
    # GitHub은 릴리스 자산을 octet-stream으로 준다. 그러면 PS 5.1의 .Content가 byte[]라서
    # 글자처럼 다루면 깨진다 — 파일로 받아서 읽는다.
    $sumFile = Join-Path $tmp "SHA256SUMS.txt"
    Invoke-WebRequest -Uri $sumAsset.browser_download_url -OutFile $sumFile
    $line = Get-Content $sumFile | Where-Object { $_ -match [regex]::Escape($zipName) } | Select-Object -First 1
    if (-not $line) { throw "SHA256SUMS.txt 에 $zipName 이 없습니다" }
    $want = ($line.Trim() -split '\s+')[0]
    $got = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $want.ToLower()) { throw "체크섬이 다릅니다. 받은 파일을 쓰지 않습니다.`n  기대 $want`n  실제 $got" }
    Write-Host "    일치 $got"
  } else {
    Write-Warning "    SHA256SUMS.txt 가 없어 대조를 건너뜁니다"
  }

  Step 4 "CLI만 꺼내 두는 중 → $Dest"
  $unzip = Join-Path $tmp "x"
  Expand-Archive -LiteralPath $zip -DestinationPath $unzip -Force
  $found = Get-ChildItem -Path $unzip -Recurse -Filter "designcraft-cli.exe" | Select-Object -First 1
  if (-not $found) { throw "압축 안에 designcraft-cli.exe 가 없습니다" }
  New-Item -ItemType Directory -Path $Dest -Force | Out-Null
  Copy-Item -Path $found.FullName -Destination $exe -Force
  # 라이선스·고지 파일도 같이 둔다(실행에는 필요 없지만 어떤 판인지 남긴다)
  Get-ChildItem -Path $unzip -Recurse -Include "LICENSE-*", "NOTICE", "OFL-*.txt" |
    ForEach-Object { Copy-Item $_.FullName -Destination $Dest -Force -ErrorAction SilentlyContinue }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Step 5 "확인"
& $exe --version
Write-Host ""
Write-Host "설치 끝: $exe" -ForegroundColor Green
Write-Host "에이전트를 다시 켜면 '원본 수정' 화면에 '연결됨'으로 바뀝니다." -ForegroundColor Green
Write-Host "  conda activate dev; python agents\run_agents.py"
