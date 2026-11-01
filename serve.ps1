<#
  Layer dashboard: serve this folder to your browser, with nothing installed.

  Browsers refuse to run the dashboard's analysis engine (WebAssembly in a worker) from a page
  opened as a plain file, so the page has to come from a web server. This is a small one built
  from what every Windows PC already has (PowerShell and .NET). It listens on this computer only
  (http://localhost), never on the network, and serves files from this folder only.

  Double-click "Open in browser.cmd", or run:  powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8765] [-NoBrowser]
  Close the window (or press Ctrl+C) to stop it.
#>
param([int]$Port = 8765, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'
$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript'; '.mjs' = 'text/javascript'; '.css' = 'text/css'
  '.json' = 'application/json'; '.wasm' = 'application/wasm'; '.pbf' = 'application/x-protobuf'; '.png' = 'image/png'
  '.jpg' = 'image/jpeg'; '.svg' = 'image/svg+xml'; '.pmtiles' = 'application/octet-stream'; '.data' = 'application/octet-stream'
  '.txt' = 'text/plain; charset=utf-8'; '.map' = 'application/json'; '.ico' = 'image/x-icon'
}

if (-not (Test-Path (Join-Path $root 'index.html'))) { Write-Host "index.html is not next to serve.ps1 ($root)."; exit 1 }

# first free port from $Port upwards
$listener = $null
for ($p = $Port; $p -lt $Port + 30; $p++) {
  $l = New-Object System.Net.HttpListener
  $l.Prefixes.Add("http://localhost:$p/")
  try { $l.Start(); $listener = $l; break } catch { $l.Close() }
}
if (-not $listener) { Write-Host "No free port between $Port and $($Port + 29)."; exit 1 }
$url = "http://localhost:$p/"

Write-Host ''
Write-Host '  Layer dashboard is running at' $url
Write-Host '  Keep this window open while you use it. Close it to stop.'
Write-Host ''
if (-not $NoBrowser) { Start-Process $url }

function Send-File($ctx, $file) {
  $req = $ctx.Request; $res = $ctx.Response
  $ext = [IO.Path]::GetExtension($file).ToLowerInvariant()
  $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
  $res.Headers['Accept-Ranges'] = 'bytes'
  $res.Headers['Cache-Control'] = 'no-cache'
  $fs = [IO.File]::Open($file, 'Open', 'Read', 'ReadWrite')
  try {
    $size = $fs.Length; $start = 0; $end = $size - 1
    $range = $req.Headers['Range']
    if ($range -and $range -match '^bytes=(\d*)-(\d*)$') {
      # byte ranges: the offline basemap reads small slices of one large file
      if ($Matches[1] -eq '') { $start = [Math]::Max(0, $size - [long]$Matches[2]) }
      else { $start = [long]$Matches[1]; if ($Matches[2] -ne '') { $end = [Math]::Min([long]$Matches[2], $size - 1) } }
      if ($start -gt $end -or $start -ge $size) {
        $res.StatusCode = 416; $res.Headers['Content-Range'] = "bytes */$size"; return
      }
      $res.StatusCode = 206
      $res.Headers['Content-Range'] = "bytes $start-$end/$size"
    }
    $len = $end - $start + 1
    $res.ContentLength64 = $len
    if ($req.HttpMethod -eq 'HEAD') { return }
    [void]$fs.Seek($start, 'Begin')
    $buf = New-Object byte[] 262144
    $left = $len
    while ($left -gt 0) {
      $n = $fs.Read($buf, 0, [int][Math]::Min([long]$buf.Length, [long]$left))
      if ($n -le 0) { break }
      $res.OutputStream.Write($buf, 0, $n)
      $left -= $n
    }
  } finally { $fs.Close() }
}

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    try {
      $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
      if ($rel -eq '') { $rel = 'index.html' }
      $file = [IO.Path]::GetFullPath((Join-Path $root $rel))
      if (-not $file.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { $ctx.Response.StatusCode = 403 }
      elseif (-not (Test-Path -LiteralPath $file -PathType Leaf)) { $ctx.Response.StatusCode = 404 }
      else { Send-File $ctx $file }
    } catch {
      # the browser gave up on a request (page reloaded, tile no longer needed): carry on
    } finally {
      try { $ctx.Response.Close() } catch { }
    }
  }
} finally {
  $listener.Stop(); $listener.Close()
}
