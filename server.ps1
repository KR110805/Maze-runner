$port = 3000
$ip = "192.168.0.37"
$root = $PSScriptRoot

$tcpListener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $port)
try {
    $tcpListener.Start()
    Write-Host "=========================================================="
    Write-Host "  ACM MAZE SERVER (WITH CENTRAL /api/room API SUPPORT)"
    Write-Host "=========================================================="
    Write-Host "  Wi-Fi Host URL:   http://${ip}:${port}/host.html"
    Write-Host "  Wi-Fi Player URL: http://${ip}:${port}/index.html"
    Write-Host "  Local Host URL:   http://localhost:${port}/host.html"
    Write-Host "=========================================================="
} catch {
    Write-Host "Error starting TCP listener: $_"
    exit
}

# In-memory central room storage
$globalRooms = @{}

function Get-Room($roomId) {
    $id = if ($roomId) { $roomId.ToUpper() } else { "ACM2026" }
    if (-not $globalRooms.ContainsKey($id)) {
        $globalRooms[$id] = @{
            id             = $id
            status         = "LOBBY"
            timeLimit      = 120
            startTime      = $null
            countdownStart = $null
            players        = @{}
            lastUpdated    = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }
    }
    return $globalRooms[$id]
}

$mimeTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".svg"  = "image/svg+xml"
    ".ico"  = "image/x-icon"
}

while ($true) {
    try {
        $client = $tcpListener.AcceptTcpClient()
        $stream = $client.GetStream()
        $reader = New-Object System.IO.StreamReader($stream)

        $requestLine = $reader.ReadLine()
        if (-not $requestLine) {
            $client.Close()
            continue
        }

        # Parse METHOD /path HTTP/1.1
        $parts = $requestLine.Split(" ")
        $method = $parts[0]
        $rawUrl = if ($parts.Length -ge 2) { $parts[1] } else { "/" }
        $urlPath = $rawUrl.Split("?")[0]
        $queryStr = if ($rawUrl.Contains("?")) { $rawUrl.Split("?")[1] } else { "" }

        # Read headers
        $contentLength = 0
        while ($line = $reader.ReadLine()) {
            if ($line.Trim() -eq "") { break }
            if ($line.ToLower().StartsWith("content-length:")) {
                $contentLength = [int]($line.Split(":")[1].Trim())
            }
        }

        # Read body if POST
        $body = ""
        if ($contentLength -gt 0) {
            $buffer = New-Object char[] $contentLength
            $readCount = 0
            while ($readCount -lt $contentLength) {
                $count = $reader.Read($buffer, $readCount, $contentLength - $readCount)
                if ($count -le 0) { break }
                $readCount += $count
            }
            $body = -join $buffer
        }

        # ---------------------------------------------
        # HANDLE CENTRAL /api/room ENDPOINT
        # ---------------------------------------------
        if ($urlPath -eq "/api/room") {
            # Extract roomId from query or body
            $targetRoomId = "ACM2026"
            if ($queryStr -match "roomId=([^&]+)") {
                $targetRoomId = $matches[1]
            }

            if ($method -eq "OPTIONS") {
                $corsHeader = "HTTP/1.1 200 OK`r`nAccess-Control-Allow-Origin: *`r`nAccess-Control-Allow-Methods: GET, POST, OPTIONS`r`nAccess-Control-Allow-Headers: Content-Type`r`nConnection: close`r`n`r`n"
                $cBytes = [System.Text.Encoding]::UTF8.GetBytes($corsHeader)
                $stream.Write($cBytes, 0, $cBytes.Length)
                $stream.Flush()
                $client.Close()
                continue
            }

            $room = Get-Room $targetRoomId

            # Auto-advance from COUNTDOWN to STARTED
            $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            if ($room.status -eq "COUNTDOWN" -and $room.countdownStart -and ($nowMs -ge ($room.countdownStart + 3000))) {
                $room.status = "STARTED"
                if (-not $room.startTime) { $room.startTime = $nowMs }
            }

            # Auto-advance from STARTED to ENDED if all players finished playing
            if ($room.status -eq "STARTED" -and $room.players.Count -gt 0) {
                $allFin = $true
                foreach ($p in $room.players.Values) {
                    if (-not $p.finished) { $allFin = $false; break }
                }
                if ($allFin) {
                    $room.status = "ENDED"
                }
            }

            if ($method -eq "POST" -and $body) {
                try {
                    $jsonBody = ConvertFrom-Json $body
                    $action = $jsonBody.action

                    if ($action -eq "join") {
                        $pName = ($jsonBody.name).Trim()
                        # Check duplicate
                        $isTaken = $false
                        foreach ($existing in $room.players.Values) {
                            if ($existing.name -and $existing.name.ToLower() -eq $pName.ToLower()) {
                                $isTaken = $true
                                break
                            }
                        }

                        if ($isTaken) {
                            $errJson = @{ success = $false; error = "The name '$pName' is already taken! Please enter a different name." } | ConvertTo-Json
                            $h = "HTTP/1.1 400 Bad Request`r`nContent-Type: application/json; charset=utf-8`r`nAccess-Control-Allow-Origin: *`r`nConnection: close`r`n`r`n"
                            $hB = [System.Text.Encoding]::UTF8.GetBytes($h + $errJson)
                            $stream.Write($hB, 0, $hB.Length)
                            $stream.Flush()
                            $client.Close()
                            continue
                        }

                        $playerId = "p_" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + "_" + (Get-Random -Minimum 100 -Maximum 999)
                        $newPlayer = @{
                            id                 = $playerId
                            name               = $pName
                            joinedAt           = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                            finished           = $false
                            finishTimeSeconds  = $null
                            finishTimeFormatted = $null
                        }
                        $room.players[$playerId] = $newPlayer
                        $room.lastUpdated = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

                        $respData = @{ success = $true; playerId = $playerId; player = $newPlayer; room = $room } | ConvertTo-Json -Depth 5
                        $h = "HTTP/1.1 200 OK`r`nContent-Type: application/json; charset=utf-8`r`nAccess-Control-Allow-Origin: *`r`nConnection: close`r`n`r`n"
                        $hB = [System.Text.Encoding]::UTF8.GetBytes($h + $respData)
                        $stream.Write($hB, 0, $hB.Length)
                        $stream.Flush()
                        $client.Close()
                        continue
                    }

                    if ($action -eq "config") {
                        if ($jsonBody.timeLimit) {
                            $room.timeLimit = [int]$jsonBody.timeLimit
                        }
                    }

                    if ($action -eq "countdown") {
                        $tLimit = if ($jsonBody.timeLimit) { [int]$jsonBody.timeLimit } else { 120 }
                        $room.status = "COUNTDOWN"
                        $room.timeLimit = $tLimit
                        $room.countdownStart = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                        $room.startTime = $null
                        # Reset finishers
                        foreach ($p in $room.players.Values) {
                            $p.finished = $false
                            $p.finishTimeSeconds = $null
                            $p.finishTimeFormatted = $null
                        }
                    }

                    if ($action -eq "start") {
                        $tLimit = if ($jsonBody.timeLimit) { [int]$jsonBody.timeLimit } else { 120 }
                        $room.status = "STARTED"
                        $room.timeLimit = $tLimit
                        $room.startTime = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                    }

                    if ($action -eq "finish") {
                        $finPlayerId = $jsonBody.playerId
                        if ($finPlayerId -and $room.players.ContainsKey($finPlayerId)) {
                            $room.players[$finPlayerId].finished = $true
                            $room.players[$finPlayerId].finishTimeSeconds = $jsonBody.seconds
                            $room.players[$finPlayerId].finishTimeFormatted = $jsonBody.formatted

                            # Auto-end if all players have completed the maze
                            if ($room.status -eq "STARTED" -and $room.players.Count -gt 0) {
                                $allFin = $true
                                foreach ($p in $room.players.Values) {
                                    if (-not $p.finished) { $allFin = $false; break }
                                }
                                if ($allFin) {
                                    $room.status = "ENDED"
                                }
                            }
                        }
                    }

                    if ($action -eq "end") {
                        $room.status = "ENDED"
                    }

                    if ($action -eq "reset") {
                        $room.status = "LOBBY"
                        $room.startTime = $null
                        $room.countdownStart = $null
                        $room.players = @{}
                    }
                    $room.lastUpdated = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                } catch {}
            }

            # Return room JSON
            $respData = @{ success = $true; room = $room } | ConvertTo-Json -Depth 5
            $h = "HTTP/1.1 200 OK`r`nContent-Type: application/json; charset=utf-8`r`nAccess-Control-Allow-Origin: *`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
            $hB = [System.Text.Encoding]::UTF8.GetBytes($h + $respData)
            $stream.Write($hB, 0, $hB.Length)
            $stream.Flush()
            $client.Close()
            continue
        }

        # ---------------------------------------------
        # STATIC FILES HANDLER
        # ---------------------------------------------
        if ($urlPath -eq "/" -or $urlPath -eq "") { $urlPath = "/host.html" }

        $localPath = Join-Path $root ($urlPath.TrimStart('/').Replace('/', '\'))
        if (Test-Path $localPath -PathType Leaf) {
            $bytes = [System.IO.File]::ReadAllBytes($localPath)
            $ext = [System.IO.Path]::GetExtension($localPath).ToLower()
            $mime = $mimeTypes[$ext]
            if (-not $mime) { $mime = "application/octet-stream" }

            $header = "HTTP/1.1 200 OK`r`nContent-Type: $mime`r`nContent-Length: $($bytes.Length)`r`nAccess-Control-Allow-Origin: *`r`nConnection: close`r`n`r`n"
            $headerBytes = [System.Text.Encoding]::UTF8.GetBytes($header)
            $stream.Write($headerBytes, 0, $headerBytes.Length)
            $stream.Write($bytes, 0, $bytes.Length)
        } else {
            $notFound = "HTTP/1.1 404 Not Found`r`nContent-Length: 9`r`nConnection: close`r`n`r`nNot Found"
            $nfBytes = [System.Text.Encoding]::UTF8.GetBytes($notFound)
            $stream.Write($nfBytes, 0, $nfBytes.Length)
        }

        $stream.Flush()
        $client.Close()
    } catch {
        # continue loop
    }
}
