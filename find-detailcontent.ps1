$path = 'public\html\product-detail.html'
$lines = Get-Content $path
for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i] -match 'detailContent') {
        Write-Host ("Line {0}:" -f ($i + 1))
        $start = [Math]::Max(0, $i - 1)
        $end   = [Math]::Min($lines.Length - 1, $i + 2)
        for ($j = $start; $j -le $end; $j++) {
            Write-Host ("  [{0}]  {1}" -f ($j + 1), $lines[$j])
        }
    }
}
