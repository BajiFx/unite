# ============================================================
#  fix-dropped-columns.ps1
#  Removes references to products.discount_percent, products.rating,
#  products.contact, products.shipping — all four were dropped by
#  migrations/sql/20260930-drop-product-legacy-columns.sql, but the
#  code still reads/writes them, which 500s GET /api/businesses.
#
#  Run from the project root:  .\fix-dropped-columns.ps1
# ============================================================

$ErrorActionPreference = 'Stop'

$dropped = @('discount_percent', 'rating', 'contact', 'shipping')

$targets = @(
    'src/routes/businesses.js',
    'src/routes/products.js',
    'src/routes/business-admin.js',
    'src/models/Product.js'
)

Write-Host ''
Write-Host 'Backing up files to .\backup-dropped-columns\' -ForegroundColor Cyan
$backupDir = Join-Path (Get-Location) 'backup-dropped-columns'
if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir | Out-Null }

foreach ($rel in $targets) {
    $path = Join-Path (Get-Location) $rel
    if (-not (Test-Path $path)) {
        Write-Host "  skip (not found): $rel" -ForegroundColor DarkGray
        continue
    }
    $dest = Join-Path $backupDir ($rel -replace '[\\/]', '__')
    Copy-Item $path $dest -Force
}

Write-Host ''
Write-Host 'Scanning for references...' -ForegroundColor Cyan

foreach ($rel in $targets) {
    $path = Join-Path (Get-Location) $rel
    if (-not (Test-Path $path)) { continue }

    $raw = Get-Content -Raw -LiteralPath $path
    $original = $raw

    foreach ($col in $dropped) {
        # alias-prefixed column followed by a comma, on its own line
        $raw = $raw -replace "(?m)^\s*[A-Za-z_][A-Za-z0-9_]*\.$col\s*,\s*\r?\n", ''

        # bare column name on its own line with a trailing comma
        $raw = $raw -replace "(?m)^\s*$col\s*,\s*\r?\n", ''

        # inline ", alias.col" inside a SELECT list
        $raw = $raw -replace ",\s*[A-Za-z_][A-Za-z0-9_]*\.$col\s*(?=,|\r|\n)", ''
    }

    foreach ($col in $dropped) {
        # JS allowed-field array entries
        $raw = $raw -replace "'\s*$col\s*'\s*,\s*", ''
        $raw = $raw -replace '"\s*$col\s*"\s*,\s*', ''
        $raw = $raw -replace ",\s*'\s*$col\s*'", ''
        $raw = $raw -replace ",\s*""\s*$col\s*""", ''
    }

    if ($raw -ne $original) {
        Set-Content -LiteralPath $path -Value $raw -NoNewline
        $n = ([regex]::Matches($original, ($dropped -join '|'))).Count
        Write-Host "  patched: $rel  ($n reference(s) touched)" -ForegroundColor Green
    } else {
        Write-Host "  unchanged: $rel" -ForegroundColor DarkGray
    }
}

Write-Host ''
Write-Host 'Rescanning whole project for any remaining hits...' -ForegroundColor Cyan

$hits = Get-ChildItem -Path . -Recurse -File -Include *.js -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\(node_modules|backup-dropped-columns)\\' } |
    Select-String -Pattern 'discount_percent|\brating\b|\bcontact\b|\bshipping\b' -List

if ($hits) {
    Write-Host '  Remaining references (review by hand):' -ForegroundColor Yellow
    $hits | ForEach-Object {
        Write-Host ('    {0}:{1}' -f $_.Path.Replace((Get-Location).Path + '\', ''), $_.LineNumber)
    }
} else {
    Write-Host '  Clean - no references left.' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Now restart the server, then verify with:' -ForegroundColor Cyan
Write-Host '  curl -i "http://localhost:3000/api/businesses?page=1&limit=12&sort=newest"' -ForegroundColor White
Write-Host ''
Write-Host 'Backups are in .\backup-dropped-columns\ if you need to revert.' -ForegroundColor DarkGray