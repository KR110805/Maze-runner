const https = require('https');
const { execSync } = require('child_process');

const BASE_URL = 'https://acm-maze-runner-153208250440.asia-south1.run.app';
const TEST_ROOM = 'PROD_' + Math.floor(1000 + Math.random() * 9000);

console.log(`Starting Production Verification against ${BASE_URL} (Room: ${TEST_ROOM})...\n`);

function request(urlPath, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlPath, BASE_URL);
        const reqOpts = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname + url.search,
            method: options.method || 'GET',
            headers: options.headers || {}
        };

        if (options.body) {
            reqOpts.headers['Content-Type'] = 'application/json';
        }

        const req = https.request(reqOpts, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch(e) {}
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    data: parsed || data
                });
            });
        });

        req.on('error', reject);
        if (options.body) {
            req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
        }
        req.end();
    });
}

async function runSmokeTests() {
    let passed = 0;
    let failed = 0;

    function assert(name, condition, details = '') {
        if (condition) {
            console.log(`  ✔ ${name} ${details ? '(' + details + ')' : ''}`);
            passed++;
        } else {
            console.error(`  ✖ FAIL: ${name} ${details ? '- ' + details : ''}`);
            failed++;
        }
    }

    console.log('--- Step 1: Web Entrypoints & Direct Host Access ---');
    const rootRes = await request('/');
    assert('Direct Root Serves Host Dashboard', rootRes.status === 200 && typeof rootRes.data === 'string' && rootRes.data.includes('HOST & PROJECTOR CONTROL'), `Status: ${rootRes.status}`);

    const hostRes = await request('/host.html');
    assert('Host Dashboard Directly Accessible Without Login', hostRes.status === 200 && typeof hostRes.data === 'string' && hostRes.data.includes('HOST & PROJECTOR CONTROL'), `Status: ${hostRes.status}`);

    const loginRes = await request('/login');
    assert('Legacy /login Redirects to /host.html', loginRes.status === 302 && loginRes.headers['location'] === '/host.html', `Status: ${loginRes.status}, Location: ${loginRes.headers['location']}`);

    const playerRes = await request('/index.html');
    assert('Player Client HTML Delivery', playerRes.status === 200 && typeof playerRes.data === 'string' && playerRes.data.includes('canvas'), `Status: ${playerRes.status}`);

    const threeRes = await request('/three.min.js');
    assert('Three.js Asset Delivery', threeRes.status === 200, `Size: ${threeRes.data.length} bytes`);

    const qrcodeRes = await request('/qrcode.min.js');
    assert('QR Code Library Delivery', qrcodeRes.status === 200, `Size: ${qrcodeRes.data.length} bytes`);

    const faviconRes = await request('/favicon.ico');
    assert('Favicon Endpoint Delivery', faviconRes.status === 200 || faviconRes.status === 204, `Status: ${faviconRes.status}`);

    console.log('\n--- Step 2: Event Mode & Host Control (No Login/Secret Required) ---');
    // 1. Direct Event-Mode Host Action (No password or secret key required!)
    const eventAdminAction = await request('/api/room', {
        method: 'POST',
        headers: {
            'x-requested-with': 'ACMHostDashboard',
            'x-event-mode': 'true',
            'origin': BASE_URL
        },
        body: { action: 'config', roomId: TEST_ROOM, timeLimit: 120 }
    });
    assert('Direct Event-Mode Admin Action Without Secret/Login', eventAdminAction.status === 200, `Status: ${eventAdminAction.status}`);

    // 2. Cross-site untrusted origin rejected
    const crossOriginAction = await request('/api/room', {
        method: 'POST',
        headers: {
            'x-requested-with': 'ACMHostDashboard',
            'origin': 'https://unauthorized-third-party.com'
        },
        body: { action: 'config', roomId: TEST_ROOM, timeLimit: 90 }
    });
    assert('Cross-Origin Request Rejected', crossOriginAction.status === 401, `Status: ${crossOriginAction.status}`);

    // 3. Bare Unauthenticated Action Rejection
    const unauthHost = await request('/api/room', {
        method: 'POST',
        body: { action: 'countdown', roomId: TEST_ROOM }
    });
    assert('Bare Unauthorized Action Rejection', unauthHost.status === 401, `Status: ${unauthHost.status}`);

    console.log('\n--- Step 3: Room Lifecycle & Redis Integration ---');
    const initRoom = await request(`/api/room?roomId=${TEST_ROOM}`);
    assert('Room Initialization in Redis', initRoom.status === 200 && initRoom.data?.room?.status === 'LOBBY', `Status: ${initRoom.data?.room?.status}`);
    const mazeSeed = initRoom.data?.room?.mazeSeed;
    assert('Deterministic Maze Seed Assigned', typeof mazeSeed === 'number' && mazeSeed > 0, `Seed: ${mazeSeed}`);

    console.log('\n--- Step 4: Multi-Player Joining & QR Flow Simulation ---');
    const join1 = await request('/api/room', {
        method: 'POST',
        body: { action: 'join', roomId: TEST_ROOM, name: 'Alice_Racer' }
    });
    assert('Player 1 Join Success', join1.status === 200 && join1.data?.playerId, `PlayerId: ${join1.data?.playerId}`);
    const p1Id = join1.data?.playerId;

    const join2 = await request('/api/room', {
        method: 'POST',
        body: { action: 'join', roomId: TEST_ROOM, name: 'Bob_Explorer' }
    });
    assert('Player 2 Join Success', join2.status === 200 && join2.data?.playerId, `PlayerId: ${join2.data?.playerId}`);
    const p2Id = join2.data?.playerId;

    const p1Reconnect = await request('/api/room', {
        method: 'POST',
        body: { action: 'join', roomId: TEST_ROOM, name: 'Alice_Racer', playerId: p1Id }
    });
    const playersCount = Object.keys(p1Reconnect.data?.room?.players || {}).length;
    assert('Reconnection Idempotency (No duplicate player)', playersCount === 2, `Total Players: ${playersCount}`);

    console.log('\n--- Step 5: Synchronized Countdown & Authoritative Start ---');
    const eventHeaders = {
        'x-requested-with': 'ACMHostDashboard',
        'x-event-mode': 'true',
        'origin': BASE_URL
    };

    const startCountdown = await request('/api/room', {
        method: 'POST',
        headers: eventHeaders,
        body: { action: 'countdown', roomId: TEST_ROOM }
    });
    assert('Host Starts Countdown', startCountdown.status === 200 && startCountdown.data?.room?.status === 'COUNTDOWN');
    const countdownStart = startCountdown.data?.room?.countdownStart;
    const authoritativeStart = startCountdown.data?.room?.startTime;
    const matchMazeSeed = startCountdown.data?.room?.mazeSeed;
    assert('Authoritative Start Timestamp Established', typeof authoritativeStart === 'number' && authoritativeStart > countdownStart, `Delta: ${authoritativeStart - countdownStart}ms`);

    // Verify both clients see identical synchronized start time and match maze seed
    const pollP1 = await request(`/api/room?roomId=${TEST_ROOM}`);
    const pollP2 = await request(`/api/room?roomId=${TEST_ROOM}`);
    assert('Synchronized State for Player 1', pollP1.data?.room?.startTime === authoritativeStart && pollP1.data?.room?.mazeSeed === matchMazeSeed);
    assert('Synchronized State for Player 2', pollP2.data?.room?.startTime === authoritativeStart && pollP2.data?.room?.mazeSeed === matchMazeSeed);

    console.log('\n--- Step 6: Match Start, Collectibles & Leaderboard Finish ---');
    // Start match
    const startMatch = await request('/api/room', {
        method: 'POST',
        headers: eventHeaders,
        body: { action: 'start', roomId: TEST_ROOM }
    });
    assert('Match Transitions to STARTED', startMatch.status === 200 && startMatch.data?.room?.status === 'STARTED');

    // Anti-cheat requires serverElapsed >= 2.5s from startTime
    console.log('  Waiting 3.0s for Player 1 (Alice) to finish...');
    await new Promise(r => setTimeout(r, 3000));

    // Player 1 finishes with authentic elapsed time
    const finishP1 = await request('/api/room', {
        method: 'POST',
        body: {
            action: 'finish',
            roomId: TEST_ROOM,
            playerId: p1Id,
            seconds: 3.0,
            formatted: '00:03.00'
        }
    });
    assert('Player 1 Finish Submission', finishP1.status === 200 && finishP1.data?.room?.players[p1Id]?.finished === true, `Status: ${finishP1.status}`);

    console.log('  Waiting 1.5s for Player 2 (Bob) to finish...');
    await new Promise(r => setTimeout(r, 1500));

    // Player 2 finishes behind Alice
    const finishP2 = await request('/api/room', {
        method: 'POST',
        body: {
            action: 'finish',
            roomId: TEST_ROOM,
            playerId: p2Id,
            seconds: 4.5,
            formatted: '00:04.50'
        }
    });
    assert('Player 2 Finish Submission', finishP2.status === 200 && finishP2.data?.room?.players[p2Id]?.finished === true, `Status: ${finishP2.status}`);

    // Verify leaderboard rank order
    const finalRoom = await request(`/api/room?roomId=${TEST_ROOM}`);
    const rankedPlayers = Object.values(finalRoom.data?.room?.players || {})
        .filter(p => p.finished)
        .sort((a, b) => a.finishTimeSeconds - b.finishTimeSeconds);

    assert('Leaderboard Order (P1 1st, P2 2nd)', rankedPlayers[0]?.id === p1Id && rankedPlayers[1]?.id === p2Id, `1st: ${rankedPlayers[0]?.name} (${rankedPlayers[0]?.finishTimeFormatted}), 2nd: ${rankedPlayers[1]?.name} (${rankedPlayers[1]?.finishTimeFormatted})`);

    console.log('\n--- Step 7: Host Match End & Reset ---');
    const resetMatch = await request('/api/room', {
        method: 'POST',
        headers: eventHeaders,
        body: { action: 'reset', roomId: TEST_ROOM }
    });
    assert('Host Room Reset', resetMatch.status === 200 && resetMatch.data?.room?.status === 'LOBBY' && Object.keys(resetMatch.data?.room?.players || {}).length === 0);

    console.log(`\n======================================================`);
    console.log(`Live Smoke Test Complete: ${passed} PASSED, ${failed} FAILED.`);
    console.log(`======================================================\n`);

    if (failed > 0) {
        process.exit(1);
    }
}

runSmokeTests().catch(err => {
    console.error('Smoke test fatal error:', err);
    process.exit(1);
});
