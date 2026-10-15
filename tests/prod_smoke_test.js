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

// Fetch HOST_SECRET securely from Secret Manager for the smoke test without printing it
function getHostSecret() {
    try {
        const secret = execSync('gcloud secrets versions access 1 --secret=HOST_SECRET --project=acm-maze-runner --account=ultrovision11@gmail.com', { encoding: 'utf8' }).trim();
        return secret;
    } catch (e) {
        throw new Error('Failed to fetch HOST_SECRET from Secret Manager: ' + e.message);
    }
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

    console.log('--- Step 1: Web Entrypoints & Login Flow ---');
    const loginRes = await request('/login');
    assert('Host Login Page Available', loginRes.status === 200 && typeof loginRes.data === 'string' && loginRes.data.includes('Host Authentication'), `Status: ${loginRes.status}`);

    const hostUnauthRes = await request('/host.html');
    assert('Unauthenticated Host Dashboard Redirects to /login', hostUnauthRes.status === 302 && hostUnauthRes.headers['location'] === '/login', `Status: ${hostUnauthRes.status}, Location: ${hostUnauthRes.headers['location']}`);

    const playerRes = await request('/index.html');
    assert('Player Client HTML Delivery', playerRes.status === 200 && typeof playerRes.data === 'string' && playerRes.data.includes('canvas'), `Status: ${playerRes.status}`);

    const threeRes = await request('/three.min.js');
    assert('Three.js Asset Delivery', threeRes.status === 200, `Size: ${threeRes.data.length} bytes`);

    const qrcodeRes = await request('/qrcode.min.js');
    assert('QR Code Library Delivery', qrcodeRes.status === 200, `Size: ${qrcodeRes.data.length} bytes`);

    const faviconRes = await request('/favicon.ico');
    assert('Favicon Endpoint Delivery', faviconRes.status === 200 || faviconRes.status === 204, `Status: ${faviconRes.status}`);

    console.log('\n--- Step 2: Host Session, Cookie & CSRF Security Controls ---');
    const hostSecret = getHostSecret();

    // 1. Invalid Login Attempt
    const badLoginRes = await request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { password: 'wrong-host-password-999' }
    });
    assert('Invalid Password Rejected', badLoginRes.status === 401 || (badLoginRes.status === 302 && badLoginRes.headers['location']?.includes('error')), `Status: ${badLoginRes.status}`);

    // 2. Valid Login Attempt
    const validLoginRes = await request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { password: hostSecret }
    });
    assert('Valid Host Login Success', validLoginRes.status === 200 || validLoginRes.status === 302, `Status: ${validLoginRes.status}`);

    // Extract Set-Cookie headers
    const setCookieHeaders = validLoginRes.headers['set-cookie'] || [];
    const sessionCookieStr = setCookieHeaders.find(c => c.startsWith('acm_host_session='));
    const csrfCookieStr = setCookieHeaders.find(c => c.startsWith('acm_csrf_token='));

    assert('Session Cookie Set with HttpOnly & SameSite=Strict', Boolean(sessionCookieStr && sessionCookieStr.includes('HttpOnly') && sessionCookieStr.includes('SameSite=Strict')));
    assert('CSRF Cookie Set', Boolean(csrfCookieStr));

    const sessionCookieVal = sessionCookieStr?.split(';')[0];
    const csrfCookieVal = csrfCookieStr?.split(';')[0]?.replace('acm_csrf_token=', '');
    const fullCookieHeader = `${sessionCookieVal}; acm_csrf_token=${csrfCookieVal}`;

    // 3. Test Cookie-Authenticated Admin Action with CSRF
    const cookieAdminAction = await request('/api/room', {
        method: 'POST',
        headers: {
            'Cookie': fullCookieHeader,
            'x-csrf-token': csrfCookieVal
        },
        body: { action: 'config', roomId: TEST_ROOM, timeLimit: 120 }
    });
    assert('Cookie + CSRF Authorized Admin Action', cookieAdminAction.status === 200, `Status: ${cookieAdminAction.status}`);

    // 4. Test Cookie-Authenticated Action WITHOUT CSRF (must be rejected)
    const noCsrfAction = await request('/api/room', {
        method: 'POST',
        headers: {
            'Cookie': fullCookieHeader
        },
        body: { action: 'config', roomId: TEST_ROOM, timeLimit: 90 }
    });
    assert('Cookie Action Rejected Without CSRF Token', noCsrfAction.status === 401, `Status: ${noCsrfAction.status}`);

    // 5. Direct Token Header Still Supported
    const directTokenAction = await request('/api/room', {
        method: 'POST',
        headers: { 'x-host-token': hostSecret },
        body: { action: 'config', roomId: TEST_ROOM, timeLimit: 120 }
    });
    assert('Direct Token Header Authorized', directTokenAction.status === 200, `Status: ${directTokenAction.status}`);

    // 6. Unauthorized Action Rejection
    const unauthHost = await request('/api/room', {
        method: 'POST',
        body: { action: 'countdown', roomId: TEST_ROOM }
    });
    assert('Unauthorized Host Action Rejection', unauthHost.status === 401, `Status: ${unauthHost.status}`);

    const badTokenHost = await request('/api/room', {
        method: 'POST',
        headers: { 'x-host-token': 'wrong-token-value' },
        body: { action: 'countdown', roomId: TEST_ROOM }
    });
    assert('Incorrect Token Rejection', badTokenHost.status === 401, `Status: ${badTokenHost.status}`);

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
    const startCountdown = await request('/api/room', {
        method: 'POST',
        headers: { 'x-host-token': hostSecret },
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
        headers: { 'x-host-token': hostSecret },
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
        headers: { 'x-host-token': hostSecret },
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
