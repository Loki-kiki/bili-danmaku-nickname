$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -like '*hermes*' }
if (-not $procs) { "no hermes edge"; exit }
$procs | ForEach-Object {
  $cl = $_.CommandLine
  $ud = ''
  if ($cl -match '--user-data-dir="?([^"\s]+)') { $ud = $Matches[1] }
  [pscustomobject]@{ Pid = $_.ProcessId; Parent = $_.ParentProcessId; UserDataDir = $ud; Type = $(if ($cl -match '--type=([a-z-]+)') { $Matches[1] } else { 'browser' }) }
} | Format-Table -AutoSize | Out-String -Width 220