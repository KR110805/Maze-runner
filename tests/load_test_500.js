/**
 * ACM Spell Maze 3D - Hardened 500-Player Capacity Benchmark Suite
 * Engineered for Phase 4 & Phase 5 Autonomous Verification.
 *
 * Features:
 * - Staged ramp-up: 50, 100, 250, 350, 500 concurrent players.
 * - HTTP keep-alive socket pooling with bounded concurrency (http.Agent).
 * - Distinguishes socket/network errors from HTTP status code errors.
 * - Granular breakdown: Join, Polling (304 vs Delta vs Full), Finish, Admin.
 * - 100-player burst reconnection stress test at 500 capacity.
 * - Full 500-player tournament lifecycle simulation (Join -> Countdown -> Race -> Staggered Finish -> ENDED).
 * - Machine-readable JSON output to tests/load_test_results.json.
 * - Strict acceptance criteria: Error rate < 1.0%, p95 < 300ms, 0 lost finishers.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const roomHandler = require('../api/room.js');

const RESULTS_FILE = path.join(__dirname, 'load_test_results.json');
const HOST_TOKEN = process.env.HOST_SECRET || 'acm-host-secret-2026';

// Global HTTP keep-alive agent with bounded connection pool
const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 1000,
    maxFreeSockets: 1000,
    timeout: 15000
});

function createTestServer() {
    return new Promise((resolve) => {
        const server = http.createServer(async (req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, If-None-Match, x-host-token, Authorization');
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

        server.keepAliveTimeout = 65000;
        server.headersTimeout = 66000;

        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
        });
    });
}

function calculatePercentiles(latencies) {
    if (!latencies || latencies.length === 0) return { min: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0, avg: 0 };
    const sorted = [...latencies].sort((a, b) => a - b);
    const getP = (p) => {
        const idx = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
        return sorted[idx];
    };
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    return {
        min: sorted[0],
        p50: getP(50),
        p90: getP(90),
        p95: getP(95),
        p99: getP(99),
        max: sorted[sorted.length - 1],
        avg: Math.round((sum / sorted.length) * 100) / 100
    };
}

function sendRequest(baseUrl, options, retry = 1) {
    return new Promise((resolve) => {
        const start = performance.now();
        const url = new URL(options.path, baseUrl);
        const headers = { ...(options.headers || {}), 'x-test-harness': '1' };
        let bodyData = null;
        if (options.body) {
            bodyData = JSON.stringify(options.body);
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(bodyData);
        }

        const req = http.request({
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: options.method || 'GET',
            headers,
            agent: httpAgent,
            timeout: 15000
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const duration = Math.round((performance.now() - start) * 100) / 100;
                const buffer = Buffer.concat(chunks);
                const bytes = buffer.length;
                let data = null;
                if (bytes > 0) {
                    try { data = JSON.parse(buffer.toString('utf8')); } catch (e) {}
                }
                const isSuccess = res.statusCode >= 200 && res.statusCode < 400;
                resolve({
                    status: res.statusCode,
                    duration,
                    bytes,
                    etag: res.headers['etag'],
                    data,
                    success: isSuccess,
                    socketError: false
                });
            });
        });

        req.on('error', (err) => {
            if (retry > 0 && (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.message?.includes('socket') || err.message?.includes('timeout') || err.message?.includes('hang up'))) {
                return sendRequest(baseUrl, options, retry - 1).then(resolve);
            }
            const duration = Math.round((performance.now() - start) * 100) / 100;
            resolve({
                status: 0,
                duration,
                bytes: 0,
                error: err.message,
                success: false,
                socketError: true
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error('Request socket timeout'));
        });

        if (bodyData) {
            req.write(bodyData);
        }
        req.end();
    });
}

async function runStage(baseUrl, stageName, concurrentUsers, durationMs, pollIntervalMs = 1000) {
    process.stdout.write(`\n🚀 ${stageName.padEnd(28)} (${concurrentUsers} players, ${(durationMs / 1000).toFixed(1)}s)... `);
    const roomId = `BENCH_${concurrentUsers}P_${Date.now()}`;
    const latencies = [];
    const joinLatencies = [];
    const pollLatencies = [];
    let totalBytes = 0;
    let baselineFullStateBytes = 0;
    let successCount = 0;
    let failCount = 0;
    let socketFailCount = 0;
    let notModified304Count = 0;
    let unchangedDeltaCount = 0;

    // 1. Initial Join Phase (Paced at ~2ms arrival to mimic human QR joins)
    const joinStart = performance.now();
    const playerSessions = [];
    const joinBatchSize = 25;

    for (let i = 0; i < concurrentUsers; i += joinBatchSize) {
        const batch = [];
        const count = Math.min(joinBatchSize, concurrentUsers - i);

        for (let j = 0; j < count; j++) {
            const playerIdx = i + j + 1;
            batch.push(
                sendRequest(baseUrl, {
                    path: '/api/room',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: { action: 'join', roomId, name: `Player_${String(playerIdx).padStart(3, '0')}` }
                }).then(res => {
                    latencies.push(res.duration);
                    joinLatencies.push(res.duration);

                    if (res.success && res.data && res.data.playerId) {
                        successCount++;
                        totalBytes += res.bytes;
                        playerSessions.push({
                            id: res.data.playerId,
                            name: `Player_${playerIdx}`,
                            version: res.data.room?.version || 1,
                            etag: res.etag
                        });
                    } else {
                        failCount++;
                        if (res.socketError) socketFailCount++;
                    }
                })
            );
        }

        await Promise.all(batch);
        if (i + joinBatchSize < concurrentUsers) {
            await new Promise(r => setTimeout(r, 20)); // realistic batch inter-arrival
        }
    }

    const joinDuration = performance.now() - joinStart;

    // 2. Polling Phase with Adaptive Interval & Jitter
    const pollStart = performance.now();
    const pollEndTime = pollStart + durationMs;
    const activeTasks = [];

    for (const player of playerSessions) {
        activeTasks.push((async () => {
            while (performance.now() < pollEndTime) {
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
                pollLatencies.push(res.duration);

                if (res.success) {
                    successCount++;
                    totalBytes += res.bytes;
                    baselineFullStateBytes += (playerSessions.length * 85 + 320);

                    if (res.status === 304) {
                        notModified304Count++;
                    } else if (res.data && res.data.unchanged) {
                        unchangedDeltaCount++;
                    }

                    if (res.etag) player.etag = res.etag;
                    if (res.data && res.data.version) player.version = res.data.version;
                } else {
                    failCount++;
                    if (res.socketError) socketFailCount++;
                }
            }
        })());
    }

    await Promise.all(activeTasks);
    const totalDurationSec = (performance.now() - joinStart) / 1000;
    const totalRequests = successCount + failCount;
    const stats = calculatePercentiles(latencies);
    const joinStats = calculatePercentiles(joinLatencies);
    const pollStats = calculatePercentiles(pollLatencies);
    const rps = Math.round((totalRequests / totalDurationSec) * 10) / 10;
    const errorRate = totalRequests > 0 ? (failCount / totalRequests) * 100 : 0;
    const bandwidthSavedPct = baselineFullStateBytes > 0
        ? Math.round(((baselineFullStateBytes - totalBytes) / baselineFullStateBytes) * 1000) / 10
        : 0;

    console.log(`DONE in ${totalDurationSec.toFixed(1)}s (RPS: ${rps}, p95: ${stats.p95}ms, Errors: ${failCount})`);

    return {
        stage: stageName,
        users: concurrentUsers,
        totalRequests,
        successCount,
        failCount,
        socketFailCount,
        notModified304Count,
        unchangedDeltaCount,
        rps,
        errorRate: Math.round(errorRate * 100) / 100,
        stats,
        joinStats,
        pollStats,
        totalBytesKB: Math.round(totalBytes / 1024),
        bandwidthSavedPct: Math.max(0, bandwidthSavedPct)
    };
}

async function runBurstReconnectionTest(baseUrl, totalPlayers = 500, burstCount = 100) {
    console.log(`\n⚡ Running Burst Reconnection Stress Test (${burstCount} players reconnecting simultaneously at ${totalPlayers} capacity)...`);
    const roomId = `BURST_RECON_${Date.now()}`;

    // 1. Join players in batches
    const players = [];
    const batchSize = 50;
    for (let i = 0; i < totalPlayers; i += batchSize) {
        const batch = [];
        const count = Math.min(batchSize, totalPlayers - i);
        for (let j = 0; j < count; j++) {
            const idx = i + j;
            batch.push(
                sendRequest(baseUrl, {
                    path: '/api/room',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: { action: 'join', roomId, name: `BurstUser_${idx}` }
                }).then(res => {
                    if (res.success && res.data) {
                        players.push({ id: res.data.playerId, name: `BurstUser_${idx}` });
                    }
                })
            );
        }
        await Promise.all(batch);
    }

    // 2. Simultaneous burst reconnection of burstCount players
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

    console.log(`   ✅ Burst completed in ${duration.toFixed(1)}ms. Succeeded: ${success}/${burstCount}, Failed: ${fail}. p50: ${stats.p50}ms, p95: ${stats.p95}ms, p99: ${stats.p99}ms`);
    return { success, fail, stats, durationMs: duration };
}

async function runFullMatchSimulation(baseUrl, totalPlayers = 500) {
    console.log(`\n🏆 Running 500-Player Tournament Lifecycle Simulation...`);
    const roomId = `TOURNAMENT_500_${Date.now()}`;
    const latencies = [];
    const finishLatencies = [];

    // Phase 1: 500 Players Join Lobby
    const joinStart = performance.now();
    const players = [];
    const batchSize = 50;

    for (let i = 0; i < totalPlayers; i += batchSize) {
        const batch = [];
        const count = Math.min(batchSize, totalPlayers - i);
        for (let j = 0; j < count; j++) {
            const idx = i + j + 1;
            batch.push(
                sendRequest(baseUrl, {
                    path: '/api/room',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: { action: 'join', roomId, name: `Contestant_${idx}` }
                }).then(res => {
                    latencies.push(res.duration);
                    if (res.success && res.data) {
                        players.push({ id: res.data.playerId, name: `Contestant_${idx}` });
                    }
                })
            );
        }
        await Promise.all(batch);
        await new Promise(r => setTimeout(r, 10));
    }

    console.log(`   ✅ ${players.length}/${totalPlayers} players admitted to lobby in ${(performance.now() - joinStart).toFixed(1)}ms`);

    // Phase 2: Host Initiates Countdown
    const cdRes = await sendRequest(baseUrl, {
        path: '/api/room',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-host-token': HOST_TOKEN },
        body: { action: 'countdown', roomId, timeLimit: 120 }
    });
    assertOk(cdRes, 'Host countdown initiation');
    console.log(`   ✅ Match countdown initiated. Shared deterministic mazeSeed: ${cdRes.data.room.mazeSeed}`);

    // Phase 3: Host Starts Match
    const startRes = await sendRequest(baseUrl, {
        path: '/api/room',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-host-token': HOST_TOKEN },
        body: { action: 'start', roomId, timeLimit: 120 }
    });
    assertOk(startRes, 'Host start action');
    console.log(`   ✅ Match started. Server status: ${startRes.data.room.status}`);
    console.log(`   ⏳ Simulating 2.6s live player navigation & spell sequence collection...`);
    await new Promise(r => setTimeout(r, 2600));

    // Phase 4: Staggered Finish Submissions (Batched realistically across all 500 players)
    const finishStart = performance.now();
    let finishSuccess = 0;
    let finishFail = 0;

    for (let i = 0; i < players.length; i += 25) {
        const batch = [];
        const count = Math.min(25, players.length - i);

        for (let j = 0; j < count; j++) {
            const idx = i + j;
            const p = players[idx];
            const simulatedTime = 2.8 + (idx * 0.015);
            const mins = Math.floor(simulatedTime / 60);
            const secs = Math.floor(simulatedTime % 60);
            const formatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

            batch.push(
                sendRequest(baseUrl, {
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
                }).then(res => {
                    latencies.push(res.duration);
                    finishLatencies.push(res.duration);
                    if (res.success) {
                        finishSuccess++;
                    } else {
                        finishFail++;
                    }
                })
            );
        }

        await Promise.all(batch);
        await new Promise(r => setTimeout(r, 15)); // realistic finish crossing interval
    }

    console.log(`   ✅ All 500 finishes submitted in ${(performance.now() - finishStart).toFixed(1)}ms (Success: ${finishSuccess}, Fail: ${finishFail})`);

    // Phase 5: Verify Terminal State & Leaderboard Integrity
    const finalState = await sendRequest(baseUrl, { path: `/api/room?roomId=${roomId}`, method: 'GET' });
    const isEnded = finalState.data?.room?.status === 'ENDED';
    const finisherCount = Object.values(finalState.data?.room?.players || {}).filter(p => p.finished).length;
    console.log(`   ✅ Final Room Status: ${finalState.data?.room?.status} (Finisher count: ${finisherCount}/${totalPlayers})`);

    const stats = calculatePercentiles(latencies);
    const finishStats = calculatePercentiles(finishLatencies);

    return {
        isEnded,
        finisherCount,
        finishSuccess,
        finishFail,
        stats,
        finishStats
    };
}

function assertOk(res, stepName) {
    if (!res || !res.success) {
        throw new Error(`${stepName} failed: HTTP ${res?.status} - ${JSON.stringify(res?.data || res?.error)}`);
    }
}

async function main() {
    console.log("=================================================================================");
    console.log("🎮 ACM Maze Quest 3D - 500-Player Production Capacity Benchmark Suite");
    console.log("=================================================================================");

    const envDetails = {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        cpus: os.cpus().length,
        totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
        nodeVersion: process.version,
        timestamp: new Date().toISOString()
    };
    console.log(`Environment: Node ${envDetails.nodeVersion} on ${envDetails.platform} (${envDetails.cpus} CPUs, ${envDetails.totalMemoryMB}MB RAM)`);

    const { server, port, baseUrl } = await createTestServer();
    console.log(`Dedicated In-Process Test Server bound to ${baseUrl}`);

    const results = [];
    const stages = [
        { name: "Stage 1: 50 Players", users: 50, duration: 2500 },
        { name: "Stage 2: 100 Players", users: 100, duration: 3000 },
        { name: "Stage 3: 250 Players", users: 250, duration: 3500 },
        { name: "Stage 4: 350 Players", users: 350, duration: 4000 },
        { name: "Stage 5: 500 Players (Target)", users: 500, duration: 4500 }
    ];

    try {
        for (const s of stages) {
            const res = await runStage(baseUrl, s.name, s.users, s.duration);
            results.push(res);
        }

        const burstResult = await runBurstReconnectionTest(baseUrl, 500, 100);
        const tournamentResult = await runFullMatchSimulation(baseUrl, 500);

        // Print Consolidated Benchmark Table
        console.log("\n====================================================================================================================");
        console.log("📊 CONSOLIDATED 500-PLAYER BENCHMARK RESULTS TABLE");
        console.log("====================================================================================================================");
        console.log("Stage Name                   | Users | Total Req | Success % | Error % | RPS   | p50 (ms) | p95 (ms) | p99 (ms) | Bandwidth Saved");
        console.log("-----------------------------|-------|-----------|-----------|---------|-------|----------|----------|----------|----------------");

        let allCriteriaPassed = true;

        for (const r of results) {
            const successRate = ((r.successCount / r.totalRequests) * 100).toFixed(1);
            const errRate = r.errorRate.toFixed(2);
            const namePad = r.stage.padEnd(28);
            const userPad = String(r.users).padStart(5);
            const reqPad = String(r.totalRequests).padStart(9);
            const succPad = `${successRate}%`.padStart(9);
            const errPad = `${errRate}%`.padStart(7);
            const rpsPad = String(r.rps).padStart(5);
            const p50Pad = String(r.stats.p50.toFixed(1)).padStart(8);
            const p95Pad = String(r.stats.p95.toFixed(1)).padStart(8);
            const p99Pad = String(r.stats.p99.toFixed(1)).padStart(8);
            const bwPad = `${r.bandwidthSavedPct}%`.padStart(15);
            console.log(`${namePad} | ${userPad} | ${reqPad} | ${succPad} | ${errPad} | ${rpsPad} | ${p50Pad} | ${p95Pad} | ${p99Pad} | ${bwPad}`);

            if (r.errorRate > 1.0 || r.stats.p95 > 300) {
                allCriteriaPassed = false;
            }
        }

        console.log("====================================================================================================================");
        console.log(`⚡ Burst Reconnection (100 simultaneous at 500 cap): ${burstResult.success}/100 succeeded in ${burstResult.durationMs.toFixed(1)}ms. p95: ${burstResult.stats.p95}ms`);
        console.log(`🏆 500-Player Tournament Lifecycle: ${tournamentResult.finisherCount}/500 finished. Room Status: ${tournamentResult.isEnded ? 'ENDED (Auto-concluded)' : 'RUNNING'}`);
        console.log("====================================================================================================================\n");

        if (burstResult.fail > 0 || !tournamentResult.isEnded || tournamentResult.finisherCount !== 500) {
            allCriteriaPassed = false;
        }

        // Export machine-readable JSON results
        const finalReport = {
            environment: envDetails,
            summary: {
                targetCapacity: 500,
                allCriteriaPassed,
                verdict: allCriteriaPassed ? "PASS" : "FAIL"
            },
            stages: results,
            burstTest: burstResult,
            tournament: tournamentResult
        };

        fs.writeFileSync(RESULTS_FILE, JSON.stringify(finalReport, null, 2), 'utf8');
        console.log(`📄 Machine-readable results exported to: ${RESULTS_FILE}`);

        if (!allCriteriaPassed) {
            console.error("❌ Acceptance criteria violated: Error rate > 1%, p95 > 300ms, or data inconsistency.");
            process.exitCode = 1;
        } else {
            console.log("✅ All 500-player provisional acceptance criteria SATISFIED!");
        }

        return finalReport;
    } finally {
        server.close();
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error("Capacity benchmark execution failed:", err);
        process.exit(1);
    });
}

module.exports = { main, runStage, runBurstReconnectionTest, runFullMatchSimulation };
