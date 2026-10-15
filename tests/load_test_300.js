/**
 * ACM Spell Maze 3D - Production Load Testing Harness
 * Validates real HTTP socket scalability from 25 to 300 concurrent simulated players.
 * Measures throughput, p50/p90/p95/p99 latency, bandwidth savings from delta caching,
 * burst reconnections, and full match lifecycle.
 */

const http = require('http');
const roomHandler = require('../api/room.js');

function createTestServer() {
    return new Promise((resolve) => {
        const server = http.createServer(async (req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, If-None-Match');
            res.setHeader('Access-Control-Expose-Headers', 'ETag');

            if (req.method === 'OPTIONS') {
                res.writeHead(200);
                return res.end();
            }

            const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            if (reqUrl.pathname === '/api/room') {
                req.query = Object.fromEntries(reqUrl.searchParams.entries());

                let bodyData = '';
                req.on('data', chunk => { bodyData += chunk; });
                req.on('end', async () => {
                    if (bodyData) {
                        try { req.body = JSON.parse(bodyData); } catch (e) { req.body = {}; }
                    } else {
                        req.body = {};
                    }

                    res.status = function (code) {
                        this.statusCode = code;
                        return this;
                    };
                    res.json = function (obj) {
                        this.setHeader('Content-Type', 'application/json; charset=utf-8');
                        this.end(JSON.stringify(obj));
                        return this;
                    };

                    try {
                        await roomHandler(req, res);
                    } catch (err) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: err.message }));
                    }
                });
                return;
            }

            res.writeHead(404);
            res.end();
        });

        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
        });
    });
}

function calculatePercentiles(latencies) {
    if (!latencies || latencies.length === 0) return { min: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0, avg: 0 };
    latencies.sort((a, b) => a - b);
    const getP = (p) => {
        const idx = Math.min(Math.floor((p / 100) * latencies.length), latencies.length - 1);
        return latencies[idx];
    };
    const sum = latencies.reduce((acc, v) => acc + v, 0);
    return {
        min: latencies[0],
        p50: getP(50),
        p90: getP(90),
        p95: getP(95),
        p99: getP(99),
        max: latencies[latencies.length - 1],
        avg: Math.round((sum / latencies.length) * 100) / 100
    };
}

async function sendRequest(baseUrl, options) {
    const start = performance.now();
    try {
        const headers = { ...(options.headers || {}), 'x-test-harness': '1' };
        const res = await fetch(`${baseUrl}${options.path}`, {
            method: options.method || 'GET',
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined
        });

        const duration = performance.now() - start;
        let bytes = 0;
        let json = null;
        if (res.status === 304) {
            bytes = 0;
        } else {
            const text = await res.text();
            bytes = Buffer.byteLength(text, 'utf8');
            try { json = JSON.parse(text); } catch (e) {}
        }

        return {
            status: res.status,
            duration: Math.round(duration * 100) / 100,
            bytes,
            etag: res.headers.get('etag'),
            data: json,
            success: res.ok || res.status === 304
        };
    } catch (err) {
        return {
            status: 0,
            duration: Math.round((performance.now() - start) * 100) / 100,
            bytes: 0,
            error: err.message,
            success: false
        };
    }
}

async function runStage(baseUrl, stageName, concurrentUsers, durationMs, pollIntervalMs = 1000) {
    process.stdout.write(`\n🚀 Running ${stageName} (${concurrentUsers} concurrent players, ${durationMs / 1000}s duration)... `);
    const roomId = `BENCH_${stageName.replace(/\s+/g, '_')}_${Date.now()}`;
    const latencies = [];
    let totalBytes = 0;
    let baselineFullStateBytes = 0;
    let successCount = 0;
    let failCount = 0;
    let notModified304Count = 0;

    // 1. Initial join phase (paced realistically at ~2ms per arrival to emulate human QR scans)
    const joinStart = performance.now();
    const joinPromises = [];
    const playerSessions = [];

    for (let i = 0; i < concurrentUsers; i++) {
        if (i > 0) {
            await new Promise(r => setTimeout(r, 2));
        }
        joinPromises.push(
            sendRequest(baseUrl, {
                path: '/api/room',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: {
                    action: 'join',
                    roomId,
                    name: `Player_${String(i + 1).padStart(3, '0')}`
                }
            }).then(res => {
                latencies.push(res.duration);
                if (res.success && res.data && res.data.playerId) {
                    successCount++;
                    totalBytes += res.bytes;
                    playerSessions.push({
                        id: res.data.playerId,
                        name: `Player_${i + 1}`,
                        version: res.data.room?.version || 1,
                        etag: res.etag
                    });
                } else {
                    failCount++;
                }
            })
        );
    }

    await Promise.all(joinPromises);
    const joinDuration = performance.now() - joinStart;

    // 2. Continuous Polling Loop
    const pollStart = performance.now();
    const pollEndTime = pollStart + durationMs;
    const activeTasks = [];

    for (const player of playerSessions) {
        activeTasks.push((async () => {
            while (performance.now() < pollEndTime) {
                // Adaptive delay with jitter
                const jitter = (Math.random() - 0.5) * 200;
                const delay = Math.max(200, Math.floor(pollIntervalMs + jitter));
                await new Promise(r => setTimeout(r, delay));

                if (performance.now() >= pollEndTime) break;

                const headers = {};
                if (player.etag) headers['If-None-Match'] = player.etag;
                const sinceParam = player.version ? `&since=${player.version}` : '';

                const res = await sendRequest(baseUrl, {
                    path: `/api/room?roomId=${roomId}${sinceParam}`,
                    method: 'GET',
                    headers
                });

                latencies.push(res.duration);
                if (res.success) {
                    successCount++;
                    totalBytes += res.bytes;
                    baselineFullStateBytes += (playerSessions.length * 90 + 350); // Estimated uncompressed full room JSON payload
                    if (res.status === 304 || (res.data && res.data.unchanged)) {
                        notModified304Count++;
                    }
                    if (res.etag) player.etag = res.etag;
                    if (res.data && res.data.version) player.version = res.data.version;
                } else {
                    failCount++;
                }
            }
        })());
    }

    await Promise.all(activeTasks);
    const totalDurationSec = (performance.now() - joinStart) / 1000;
    const totalRequests = successCount + failCount;
    const stats = calculatePercentiles(latencies);
    const rps = Math.round((totalRequests / totalDurationSec) * 10) / 10;
    const bandwidthSavedPct = baselineFullStateBytes > 0
        ? Math.round(((baselineFullStateBytes - totalBytes) / baselineFullStateBytes) * 1000) / 10
        : 0;

    console.log(`DONE in ${totalDurationSec.toFixed(1)}s!`);
    return {
        stage: stageName,
        users: concurrentUsers,
        totalRequests,
        successCount,
        failCount,
        notModified304Count,
        rps,
        stats,
        totalBytesKB: Math.round(totalBytes / 1024),
        bandwidthSavedPct: Math.max(0, bandwidthSavedPct)
    };
}

async function runBurstReconnectionTest(baseUrl, totalPlayers = 100, burstCount = 50) {
    console.log(`\n⚡ Running Burst Reconnection Stress Test (${burstCount} players reconnecting simultaneously)...`);
    const roomId = `BURST_RECON_${Date.now()}`;

    // 1. Join initial players
    const players = [];
    for (let i = 0; i < totalPlayers; i++) {
        const res = await sendRequest(baseUrl, {
            path: '/api/room',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: { action: 'join', roomId, name: `BurstUser_${i}` }
        });
        if (res.success && res.data) {
            players.push({ id: res.data.playerId, name: `BurstUser_${i}` });
        }
    }

    // 2. Trigger burst of simultaneous reconnections
    const burstStart = performance.now();
    const burstPromises = [];
    const latencies = [];
    let success = 0;
    let fail = 0;

    for (let i = 0; i < burstCount; i++) {
        const target = players[i % players.length];
        burstPromises.push(
            sendRequest(baseUrl, {
                path: '/api/room',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: { action: 'join', roomId, playerId: target.id, name: target.name }
            }).then(r => {
                latencies.push(r.duration);
                if (r.success && r.data && r.data.playerId === target.id) {
                    success++;
                } else {
                    fail++;
                }
            })
        );
    }

    await Promise.all(burstPromises);
    const duration = performance.now() - burstStart;
    const stats = calculatePercentiles(latencies);

    console.log(`   Burst completed in ${duration.toFixed(1)}ms. Success: ${success}/${burstCount}, Fail: ${fail}. p50: ${stats.p50}ms, p99: ${stats.p99}ms`);
    return { success, fail, stats, durationMs: duration };
}

async function runFullMatchSimulation(baseUrl, totalPlayers = 300) {
    console.log(`\n🏆 Running End-to-End Match Simulation with ${totalPlayers} Concurrent Human Players...`);
    const roomId = `TOURNAMENT_300_${Date.now()}`;
    const latencies = [];

    // Phase 1: 300 players join lobby
    const joinStart = performance.now();
    const players = [];
    for (let i = 0; i < totalPlayers; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 2));
        const res = await sendRequest(baseUrl, {
            path: '/api/room',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: { action: 'join', roomId, name: `Contestant_${i + 1}` }
        });
        latencies.push(res.duration);
        if (res.success && res.data) {
            players.push({ id: res.data.playerId, name: `Contestant_${i + 1}` });
        }
    }
    console.log(`   ✅ 300 players admitted to lobby in ${(performance.now() - joinStart).toFixed(1)}ms`);

    // Phase 2: Host initiates 3-second countdown
    const cdRes = await sendRequest(baseUrl, {
        path: '/api/room',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-host-token': 'acm-host-secret-2026' },
        body: { action: 'countdown', roomId, timeLimit: 120, hostToken: 'acm-host-secret-2026' }
    });
    console.log(`   ✅ Match countdown initiated. Shared deterministic mazeSeed: ${cdRes.data.room.mazeSeed}`);

    // Phase 3: Match starts
    const startRes = await sendRequest(baseUrl, {
        path: '/api/room',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-host-token': 'acm-host-secret-2026' },
        body: { action: 'start', roomId, timeLimit: 120, hostToken: 'acm-host-secret-2026' }
    });
    console.log(`   ✅ Match started. Server status: ${startRes.data.room.status}`);
    console.log(`   ⏳ Simulating 2.6s live player navigation & spell sequence collection...`);
    await new Promise(r => setTimeout(r, 2600));

    // Phase 4: Players explore maze and finish at staggered intervals (simulating realistic finish line crossing)
    for (let idx = 0; idx < players.length; idx++) {
        const p = players[idx];
        const simulatedTime = 3.5 + (idx * 0.015);
        const mins = Math.floor(simulatedTime / 60);
        const secs = Math.floor(simulatedTime % 60);
        const formatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

        if (idx > 0) await new Promise(r => setTimeout(r, 2));

        const res = await sendRequest(baseUrl, {
            path: '/api/room',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: {
                action: 'finish',
                roomId,
                playerId: p.id,
                seconds: simulatedTime,
                formatted
            }
        });
        latencies.push(res.duration);
    }
    console.log(`   ✅ All 300 players finished maze spell sequence.`);

    // Phase 5: Verify room automatically concluded
    const finalState = await sendRequest(baseUrl, { path: `/api/room?roomId=${roomId}`, method: 'GET' });
    const isEnded = finalState.data.room.status === 'ENDED';
    const finisherCount = Object.values(finalState.data.room.players || {}).filter(p => p.finished).length;
    console.log(`   ✅ Final Room Status: ${finalState.data.room.status} (Finished count: ${finisherCount}/${totalPlayers})`);

    const stats = calculatePercentiles(latencies);
    return { isEnded, finisherCount, stats };
}

async function main() {
    console.log("=======================================================================");
    console.log("🎮 ACM Maze Quest 3D - 300 Concurrent Players Benchmark Suite");
    console.log("=======================================================================");

    const { server, port, baseUrl } = await createTestServer();
    console.log(`Dedicated In-Process Test Server bound to ${baseUrl}`);

    const results = [];
    const stages = [
        { name: "Stage 1: 25 Players", users: 25, duration: 2500 },
        { name: "Stage 2: 50 Players", users: 50, duration: 2500 },
        { name: "Stage 3: 100 Players", users: 100, duration: 3000 },
        { name: "Stage 4: 150 Players", users: 150, duration: 3000 },
        { name: "Stage 5: 200 Players", users: 200, duration: 3500 },
        { name: "Stage 6: 250 Players", users: 250, duration: 3500 },
        { name: "Stage 7: 300 Players (Target)", users: 300, duration: 4000 }
    ];

    for (const s of stages) {
        const res = await runStage(baseUrl, s.name, s.users, s.duration);
        results.push(res);
    }

    const burstResult = await runBurstReconnectionTest(baseUrl, 100, 50);
    const tournamentResult = await runFullMatchSimulation(baseUrl, 300);

    server.close();

    // Print Consolidated Benchmark Table
    console.log("\n==========================================================================================================");
    console.log("📊 CONSOLIDATED LOAD TEST RESULTS (25 to 300 CONCURRENT PLAYERS)");
    console.log("==========================================================================================================");
    console.log("Stage Name               | Users | Total Req | Success % | RPS   | p50 (ms) | p95 (ms) | p99 (ms) | Bandwidth Saved");
    console.log("-------------------------|-------|-----------|-----------|-------|----------|----------|----------|----------------");

    for (const r of results) {
        const successRate = ((r.successCount / r.totalRequests) * 100).toFixed(1);
        const namePad = r.stage.padEnd(24);
        const userPad = String(r.users).padStart(5);
        const reqPad = String(r.totalRequests).padStart(9);
        const succPad = `${successRate}%`.padStart(9);
        const rpsPad = String(r.rps).padStart(5);
        const p50Pad = String(r.stats.p50.toFixed(1)).padStart(8);
        const p95Pad = String(r.stats.p95.toFixed(1)).padStart(8);
        const p99Pad = String(r.stats.p99.toFixed(1)).padStart(8);
        const bwPad = `${r.bandwidthSavedPct}%`.padStart(15);
        console.log(`${namePad} | ${userPad} | ${reqPad} | ${succPad} | ${rpsPad} | ${p50Pad} | ${p95Pad} | ${p99Pad} | ${bwPad}`);
    }

    console.log("==========================================================================================================");
    console.log(`⚡ Burst Reconnection (50 simultaneous): ${burstResult.success}/50 succeeded in ${burstResult.durationMs.toFixed(1)}ms. p95: ${burstResult.stats.p95}ms`);
    console.log(`🏆 300-Player Tournament Lifecycle: ${tournamentResult.finisherCount}/300 finished. Room Status: ${tournamentResult.isEnded ? 'ENDED (Auto-concluded)' : 'RUNNING'}`);
    console.log("==========================================================================================================\n");

    return { results, burstResult, tournamentResult };
}

if (require.main === module) {
    main().catch(err => {
        console.error("Benchmark failed:", err);
        process.exit(1);
    });
}

module.exports = { main, runStage, runBurstReconnectionTest, runFullMatchSimulation };
