# Local Windows build. Usage (from the fork root):  pwsh fastvault/build-win.ps1 [-SkipNative]
#
# Builds FastVault Desktop the same way CI does (.github/workflows/fastvault-desktop.yml), but in a
# disposable worktree so the checkout you're editing in is never touched by apply.mjs or by a build.
# See fastvault/README.md for why the overlay always runs against a throwaway copy.
#
# -SkipNative skips the Rust native module build (desktop_native/build.js --release) and the
# electron-builder packaging step that consumes it, stopping after `npm run build` and
# fastvault/verify-build.mjs. That's the local Angular/Electron JS build and the post-build brand
# check — real verification, just short of a runnable .exe. Use it on a machine without the MSVC
# Build Tools; drop the switch once that toolchain is available to produce real installers.
param([switch]$SkipNative)
$ErrorActionPreference = "Stop"

$src = Split-Path -Parent $PSScriptRoot            # e.g. C:\Projects\fastvault-clients
$bw  = Join-Path (Split-Path -Parent $src) "fastvault-clients-build"
$ver = (Get-Content (Join-Path $PSScriptRoot "version.txt")).Trim()

# The build worktree holds a copy of the `fastvault` branch, reused across runs (never deleted here
# — recreate it by hand if it ever gets corrupted). `fastvault` is already checked out in $src, and
# git refuses to check out the same branch in a second worktree, so this one stays detached
# permanently: `reset --hard` below moves its HEAD to wherever `fastvault` currently points without
# ever naming the branch in this worktree. The `git reset --hard` here is fine specifically because
# this worktree is defined as never holding real edits — never do this in a worktree you edit in.
if (-not (Test-Path $bw)) { git -C $src worktree add --detach $bw fastvault }
git -C $bw checkout -- .
git -C $bw clean -fd `
  -e node_modules `
  -e apps/desktop/desktop_native/target `
  -e apps/desktop/desktop_native/dist `
  -e apps/desktop/dist `
  -e apps/desktop/build
git -C $bw reset --hard (git -C $src rev-parse fastvault)

# Junction node_modules and the Rust target dir to the main checkout's, so neither `npm ci` nor a
# from-scratch cargo build has to happen again every time the worktree resets above.
if (-not (Test-Path (Join-Path $bw "node_modules"))) {
  New-Item -ItemType Junction -Path (Join-Path $bw "node_modules") -Target (Join-Path $src "node_modules") | Out-Null
}
$srcNativeTarget = Join-Path $src "apps\desktop\desktop_native\target"
$bwNativeTarget  = Join-Path $bw "apps\desktop\desktop_native\target"
if ((Test-Path $srcNativeTarget) -and -not (Test-Path $bwNativeTarget)) {
  New-Item -ItemType Junction -Path $bwNativeTarget -Target $srcNativeTarget | Out-Null
}

Push-Location $bw
try {
  node fastvault/apply.mjs
  if ($LASTEXITCODE) { throw "apply failed" }

  if (-not $SkipNative) {
    Push-Location apps/desktop/desktop_native
    try {
      node build.js --release
      if ($LASTEXITCODE) { throw "native build failed" }
    } finally { Pop-Location }
  }

  Push-Location apps/desktop
  try {
    npm run build
    if ($LASTEXITCODE) { throw "app build failed" }
  } finally { Pop-Location }

  # Same brand check CI runs right after `npm run build`, before the long packaging step.
  node fastvault/verify-build.mjs
  if ($LASTEXITCODE) { throw "verify-build failed" }

  if ($SkipNative) {
    Write-Host "-SkipNative: stopping here. apply.mjs, npm run build and verify-build.mjs all passed;" `
      "electron-builder packaging needs the compiled native module (desktop_native/dist/*.exe)," `
      "so it's skipped rather than left to fail on a missing file. Re-run without -SkipNative once" `
      "the MSVC Build Tools are installed."
    return
  }

  Push-Location apps/desktop
  try {
    npx electron-builder --win nsis portable --x64 -p never
    if ($LASTEXITCODE) { throw "pack failed" }
  } finally { Pop-Location }

  $out = Join-Path $src "artifacts\$ver"
  New-Item -ItemType Directory -Force $out | Out-Null
  Copy-Item apps/desktop/dist/FastVault-*.exe, apps/desktop/dist/latest.yml, apps/desktop/dist/*.blockmap $out -Force
  Get-ChildItem $out
} finally {
  Pop-Location
}
