# Build libvpx 1.16.0 for x64 MSVC with static library and /MT runtime.
# vcpkg's pinned port verifies the source archive hash and provides MSVC/NASM tooling.
param([Parameter(Mandatory=$true)][string]$OutDir)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'This build requires Windows x64 and Visual Studio Build Tools.' }
$OutDir = [IO.Path]::GetFullPath($OutDir)
if (Test-Path $OutDir) { throw "Output directory must be new: $OutDir" }
New-Item -ItemType Directory -Path $OutDir | Out-Null
$vcpkg = Join-Path $OutDir 'vcpkg'
$revision = '4cb050be2cfa7a947cdd2dd1a70e24b17774c979'
function Checked([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Exe failed with exit code $LASTEXITCODE" }
}
Checked 'git' @('init', $vcpkg)
Checked 'git' @('-C', $vcpkg, 'remote', 'add', 'origin', 'https://github.com/microsoft/vcpkg.git')
Checked 'git' @('-C', $vcpkg, 'fetch', '--depth=1', 'origin', $revision)
Checked 'git' @('-C', $vcpkg, 'checkout', '--detach', 'FETCH_HEAD')
Checked (Join-Path $vcpkg 'bootstrap-vcpkg.bat') @('-disableMetrics')
Checked (Join-Path $vcpkg 'vcpkg.exe') @('install', 'libvpx:x64-windows-static', '--disable-metrics')
$prefix = Join-Path $OutDir 'prefix'
New-Item -ItemType Directory -Path $prefix | Out-Null
$installed = Join-Path $vcpkg 'installed/x64-windows-static'
Copy-Item (Join-Path $installed 'include') $prefix -Recurse
New-Item -ItemType Directory -Path (Join-Path $prefix 'lib') | Out-Null
Copy-Item (Join-Path $installed 'lib/vpx.lib') (Join-Path $prefix 'lib/vpx.lib')
# The port's copyright includes BSD-3-Clause and the assembled x86inc ISC notice.
Copy-Item (Join-Path $installed 'share/libvpx/copyright') (Join-Path $prefix 'LICENSE')
$patents = @(Get-ChildItem (Join-Path $vcpkg 'buildtrees/libvpx/src') -Filter PATENTS -Recurse -File)
if ($patents.Count -ne 1) { throw 'Expected exactly one libvpx PATENTS file.' }
Copy-Item $patents[0].FullName (Join-Path $prefix 'PATENTS')
$notices = "libvpx 1.16.0 (BSD-3-Clause), x86inc assembly macros (ISC), statically linked`n`n"
$notices += Get-Content (Join-Path $prefix 'LICENSE') -Raw
$notices += "`n`nWebM patent grant`n`n"
$notices += Get-Content (Join-Path $prefix 'PATENTS') -Raw
Set-Content (Join-Path $prefix 'THIRD_PARTY_LICENSES.txt') $notices -Encoding utf8
Write-Host "DESKLINK_VPX_STATIC_DIR=$prefix"
