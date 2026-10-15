const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const Maze = require('../maze.js');
const roomHandler = require('../api/room.js');

// Mock request / response helper for API testing
function mockRequestResponse({ method = 'GET', query = {}, body = {}, headers = {} }) {
    const req = {
        method,
        query,
        body,
        headers
    };
    let statusCode = 200;
    let responseHeaders = {};
    let responseBody = null;
    let ended = false;

    const res = {
        statusCode,
        setHeader(key, val) {
            responseHeaders[key.toLowerCase()] = val;
        },
        getHeader(key) {
            return responseHeaders[key.toLowerCase()];
        },
        status(code) {
            this.statusCode = code;
            statusCode = code;
            return this;
        },
        json(data) {
            responseBody = data;
            ended = true;
            return this;
        },
        end(data) {
            if (data) responseBody = data;
            ended = true;
            return this;
        }
    };

    return { req, res, getResult: () => ({ statusCode: res.statusCode, headers: responseHeaders, body: responseBody, ended }) };
}

describe('1. Deterministic Maze Generation & Multiplayer Fairness', () => {
    it('generates 100% identical labyrinth geometry and letters for identical seeds', () => {
        const seed = 987654;
        const m1 = new Maze(16, 16, seed);
        const m2 = new Maze(16, 16, seed);

        assert.strictEqual(m1.seed, m2.seed);
        assert.deepStrictEqual(m1.letters, m2.letters);
        assert.deepStrictEqual(m1.cells, m2.cells);
        assert.strictEqual(m1.letters.length, 3, 'Must contain letters A, C, M');
    });

    it('generates distinct labyrinth geometry for different seeds', () => {
        const m1 = new Maze(16, 16, 11111);
        const m2 = new Maze(16, 16, 22222);

        assert.notStrictEqual(m1.seed, m2.seed);
        const json1 = JSON.stringify(m1.cells);
        const json2 = JSON.stringify(m2.cells);
        assert.notStrictEqual(json1, json2, 'Different seeds must produce different labyrinths');
    });

    it('preserves seed across state export and rehydration', () => {
        const m1 = new Maze(16, 16, 54321);
        const exported = m1.exportState();
        assert.strictEqual(exported.seed, 54321);

        const m2 = new Maze(16, 16);
        m2.importState(exported);
        assert.strictEqual(m2.seed, 54321);
        assert.deepStrictEqual(m1.cells, m2.cells);
    });
});

describe('2. Authoritative Room State Machine & Security', () => {
    const testRoomId = 'TEST_ROOM_' + Date.now();

    it('creates a fresh room with LOBBY status, mazeSeed, and version 1', async () => {
        const { req, res, getResult } = mockRequestResponse({
            method: 'GET',
            query: { roomId: testRoomId }
        });

        await roomHandler(req, res);
        const result = getResult();
        assert.strictEqual(result.statusCode, 200);
        assert.strictEqual(result.body.success, true);
        assert.strictEqual(result.body.room.status, 'LOBBY');
        assert.ok(result.body.room.mazeSeed > 0, 'Room must have a deterministic mazeSeed');
        assert.strictEqual(result.body.room.version, 1);
    });

    it('sanitizes player nickname and strips script/HTML injection', async () => {
        const { req, res, getResult } = mockRequestResponse({
            method: 'POST',
            body: {
                action: 'join',
                roomId: testRoomId,
                name: '<b>Hacker<script>alert(1)</script></b>'
            }
        });

        await roomHandler(req, res);
        const result = getResult();
        assert.strictEqual(result.statusCode, 200);
        assert.ok(!result.body.player.name.includes('<'), 'Must strip <');
        assert.ok(!result.body.player.name.includes('>'), 'Must strip >');
        assert.ok(!result.body.player.name.includes('"'), 'Must strip quotes');
        assert.ok(result.body.playerId.startsWith('p_'));
    });

    it('reconnects existing player seamlessly without duplicating lobby entries', async () => {
        // 1. First join
        const join1 = mockRequestResponse({
            method: 'POST',
            body: {
                action: 'join',
                roomId: testRoomId,
                name: 'Alice_Runner'
            }
        });
        await roomHandler(join1.req, join1.res);
        const pid = join1.getResult().body.playerId;

        // 2. Reconnect with same playerId
        const reconnect = mockRequestResponse({
            method: 'POST',
            body: {
                action: 'join',
                roomId: testRoomId,
                playerId: pid,
                name: 'Alice_Runner'
            }
        });
        await roomHandler(reconnect.req, reconnect.res);
        const recResult = reconnect.getResult();
        assert.strictEqual(recResult.statusCode, 200);
        assert.strictEqual(recResult.body.playerId, pid, 'PlayerId must match reconnected player');
    });

    it('returns delta unchanged or HTTP 304 when client version matches', async () => {
        // Query current version
        const get1 = mockRequestResponse({
            method: 'GET',
            query: { roomId: testRoomId }
        });
        await roomHandler(get1.req, get1.res);
        const currentVersion = get1.getResult().body.room.version;
        const currentEtag = get1.getResult().headers['etag'];

        // Query with ?since=<version>
        const getSince = mockRequestResponse({
            method: 'GET',
            query: { roomId: testRoomId, since: String(currentVersion) }
        });
        await roomHandler(getSince.req, getSince.res);
        const sinceResult = getSince.getResult();
        assert.strictEqual(sinceResult.statusCode, 200);
        assert.strictEqual(sinceResult.body.unchanged, true);

        // Query with If-None-Match ETag
        const getEtag = mockRequestResponse({
            method: 'GET',
            query: { roomId: testRoomId },
            headers: { 'if-none-match': currentEtag }
        });
        await roomHandler(getEtag.req, getEtag.res);
        const etagResult = getEtag.getResult();
        assert.strictEqual(etagResult.statusCode, 304, 'Must return HTTP 304 on matching ETag');
    });

    it('advances room from COUNTDOWN to STARTED and updates mazeSeed', async () => {
        const cd = mockRequestResponse({
            method: 'POST',
            headers: { 'x-host-token': 'acm-host-secret-2026' },
            body: {
                action: 'countdown',
                roomId: testRoomId,
                timeLimit: 90
            }
        });
        await roomHandler(cd.req, cd.res);
        const cdResult = cd.getResult();
        assert.strictEqual(cdResult.body.room.status, 'COUNTDOWN');
        assert.ok(cdResult.body.room.countdownStart > 0);
        assert.ok(cdResult.body.room.mazeSeed > 0);
    });

    it('establishes common authoritative startTime during countdown and preserves it on match start', async () => {
        const syncRoomId = 'SYNC_ROOM_' + Date.now();
        // 1. Host initiates countdown
        const cd = mockRequestResponse({
            method: 'POST',
            headers: { 'x-host-token': 'acm-host-secret-2026' },
            body: {
                action: 'countdown',
                roomId: syncRoomId,
                timeLimit: 120
            }
        });
        await roomHandler(cd.req, cd.res);
        const cdRoom = cd.getResult().body.room;
        assert.strictEqual(cdRoom.status, 'COUNTDOWN');
        assert.strictEqual(cdRoom.startTime, cdRoom.countdownStart + 3000, 'Authoritative startTime must be countdownStart + 3000ms');

        // 2. Client queries room during countdown
        const clientPoll = mockRequestResponse({
            method: 'GET',
            query: { roomId: syncRoomId }
        });
        await roomHandler(clientPoll.req, clientPoll.res);
        const pollRoom = clientPoll.getResult().body.room;
        assert.strictEqual(pollRoom.startTime, cdRoom.startTime, 'All polling clients receive identical server startTime');

        // 3. Simulate host start action after countdown interval
        await new Promise(r => setTimeout(r, 2850));
        const start = mockRequestResponse({
            method: 'POST',
            headers: { 'x-host-token': 'acm-host-secret-2026' },
            body: {
                action: 'start',
                roomId: syncRoomId,
                timeLimit: 120
            }
        });
        await roomHandler(start.req, start.res);
        const startRoom = start.getResult().body.room;
        assert.strictEqual(startRoom.status, 'STARTED');
        assert.strictEqual(startRoom.startTime, cdRoom.startTime, 'Authoritative startTime must remain locked to countdownStart + 3000');
    });

    it('authoritatively rejects impossible/cheat finish times', async () => {
        // 1. Join a test player
        const join = mockRequestResponse({
            method: 'POST',
            body: {
                action: 'join',
                roomId: testRoomId,
                name: 'SpeedyCheater'
            }
        });
        await roomHandler(join.req, join.res);
        const pid = join.getResult().body.playerId;

        // 2. Start game with host authorization
        const start = mockRequestResponse({
            method: 'POST',
            headers: { 'x-host-token': 'acm-host-secret-2026' },
            body: {
                action: 'start',
                roomId: testRoomId,
                timeLimit: 90
            }
        });
        await roomHandler(start.req, start.res);

        // 3. Attempt impossible instant finish (0.2s)
        const cheat = mockRequestResponse({
            method: 'POST',
            body: {
                action: 'finish',
                roomId: testRoomId,
                playerId: pid,
                seconds: 0.2
            }
        });
        await roomHandler(cheat.req, cheat.res);
        const cheatResult = cheat.getResult();
        assert.strictEqual(cheatResult.statusCode, 400, 'Must reject physically impossible finish times');
        assert.strictEqual(cheatResult.body.success, false);
    });
});

describe('3. Host Authorization & Security Controls', () => {
    const authRoomId = 'AUTH_ROOM_' + Date.now();

    it('rejects unauthorized host actions without token (HTTP 401)', async () => {
        const unauthorizedActions = ['config', 'countdown', 'start', 'end', 'reset'];
        for (const action of unauthorizedActions) {
            const { req, res, getResult } = mockRequestResponse({
                method: 'POST',
                body: { action, roomId: authRoomId }
            });
            await roomHandler(req, res);
            const result = getResult();
            assert.strictEqual(result.statusCode, 401, `Action ${action} must require host authorization`);
            assert.strictEqual(result.body.success, false);
            assert.ok(result.body.error.includes('Unauthorized'));
        }
    });

    it('rejects host actions with incorrect token (HTTP 401)', async () => {
        const { req, res, getResult } = mockRequestResponse({
            method: 'POST',
            headers: { 'x-host-token': 'wrong-password-123' },
            body: { action: 'start', roomId: authRoomId }
        });
        await roomHandler(req, res);
        const result = getResult();
        assert.strictEqual(result.statusCode, 401);
        assert.strictEqual(result.body.success, false);
    });

    it('accepts administrative actions with valid host token (HTTP 200)', async () => {
        const { req, res, getResult } = mockRequestResponse({
            method: 'POST',
            headers: { 'x-host-token': 'acm-host-secret-2026' },
            body: { action: 'config', roomId: authRoomId, timeLimit: 180, maxCapacity: 600 }
        });
        await roomHandler(req, res);
        const result = getResult();
        assert.strictEqual(result.statusCode, 200);
        assert.strictEqual(result.body.success, true);
        assert.strictEqual(result.body.room.timeLimit, 180);
        assert.strictEqual(result.body.room.maxCapacity, 600);
    });

    it('accepts administrative actions in event mode without password or secret key (HTTP 200)', async () => {
        const { req, res, getResult } = mockRequestResponse({
            method: 'POST',
            headers: {
                'x-requested-with': 'ACMHostDashboard',
                'x-event-mode': 'true',
                'origin': 'https://acm-maze-runner-153208250440.asia-south1.run.app',
                'host': 'acm-maze-runner-153208250440.asia-south1.run.app'
            },
            body: { action: 'config', roomId: authRoomId, timeLimit: 90, maxCapacity: 500 }
        });
        await roomHandler(req, res);
        const result = getResult();
        assert.strictEqual(result.statusCode, 200);
        assert.strictEqual(result.body.success, true);
        assert.strictEqual(result.body.room.timeLimit, 90);
    });

    it('rejects administrative actions when origin is an untrusted third party (HTTP 401)', async () => {
        const { req, res, getResult } = mockRequestResponse({
            method: 'POST',
            headers: {
                'x-requested-with': 'ACMHostDashboard',
                'origin': 'https://malicious-external-site.com',
                'host': 'acm-maze-runner-153208250440.asia-south1.run.app'
            },
            body: { action: 'start', roomId: authRoomId }
        });
        await roomHandler(req, res);
        const result = getResult();
        assert.strictEqual(result.statusCode, 401);
        assert.strictEqual(result.body.success, false);
    });
});

describe('4. Configurable Room Capacity & Limit Enforcement', () => {
    const capRoomId = 'CAP_ROOM_' + Date.now();

    it('initializes room with target capacity 500 and headroom 550', async () => {
        const { req, res, getResult } = mockRequestResponse({
            method: 'GET',
            query: { roomId: capRoomId }
        });
        await roomHandler(req, res);
        const result = getResult();
        assert.strictEqual(result.statusCode, 200);
        assert.strictEqual(result.body.room.targetCapacity, 500);
        assert.strictEqual(result.body.room.maxCapacity, 550);
    });

    it('strictly enforces configurable capacity limit (HTTP 429)', async () => {
        // Set room capacity to 3 players
        const cfg = mockRequestResponse({
            method: 'POST',
            headers: { 'x-host-token': 'acm-host-secret-2026' },
            body: { action: 'config', roomId: capRoomId, maxCapacity: 3 }
        });
        await roomHandler(cfg.req, cfg.res);

        // Join 3 players (1, 2, 3)
        for (let i = 1; i <= 3; i++) {
            const j = mockRequestResponse({
                method: 'POST',
                body: { action: 'join', roomId: capRoomId, name: `Player_${i}` }
            });
            await roomHandler(j.req, j.res);
            assert.strictEqual(j.getResult().statusCode, 200);
        }

        // 4th player attempts to join -> 429
        const overflow = mockRequestResponse({
            method: 'POST',
            body: { action: 'join', roomId: capRoomId, name: 'Overflow_Player' }
        });
        await roomHandler(overflow.req, overflow.res);
        const overResult = overflow.getResult();
        assert.strictEqual(overResult.statusCode, 429, 'Must return 429 when capacity reached');
        assert.strictEqual(overResult.body.success, false);
    });

    it('allows existing player to reconnect even when room is at full capacity', async () => {
        // Reconnect Player_1
        const recon = mockRequestResponse({
            method: 'POST',
            body: { action: 'join', roomId: capRoomId, name: 'Player_1' }
        });
        await roomHandler(recon.req, recon.res);
        assert.strictEqual(recon.getResult().statusCode, 200, 'Existing player must be reconnected');
    });
});

describe('5. High Concurrency & Atomic State Protection', () => {
    const concRoomId = 'CONC_ROOM_' + Date.now();

    it('handles 30 concurrent simultaneous joins with 0 lost updates', async () => {
        const joinPromises = [];
        for (let i = 1; i <= 30; i++) {
            const mock = mockRequestResponse({
                method: 'POST',
                body: {
                    action: 'join',
                    roomId: concRoomId,
                    name: `Concurrent_Runner_${i}`
                }
            });
            joinPromises.push(roomHandler(mock.req, mock.res).then(() => mock.getResult()));
        }

        const results = await Promise.all(joinPromises);
        results.forEach((r, idx) => {
            assert.strictEqual(r.statusCode, 200, `Player ${idx + 1} join failed: ${JSON.stringify(r.body)}`);
            assert.strictEqual(r.body.success, true);
        });

        // Verify that final state contains all 30 players with no clobbering
        const check = mockRequestResponse({
            method: 'GET',
            query: { roomId: concRoomId }
        });
        await roomHandler(check.req, check.res);
        const room = check.getResult().body.room;
        const playerCount = Object.keys(room.players || {}).length;
        assert.strictEqual(playerCount, 30, 'All 30 concurrent players must be saved atomically without clobbering');
    });

    it('handles concurrent simultaneous finishes across multiple players', async () => {
        // 1. Start match
        const start = mockRequestResponse({
            method: 'POST',
            headers: { 'x-host-token': 'acm-host-secret-2026' },
            body: { action: 'start', roomId: concRoomId, timeLimit: 120 }
        });
        await roomHandler(start.req, start.res);

        // Fetch registered player IDs
        const fetchRoom = mockRequestResponse({
            method: 'GET',
            query: { roomId: concRoomId }
        });
        await roomHandler(fetchRoom.req, fetchRoom.res);
        const pids = Object.keys(fetchRoom.getResult().body.room.players).slice(0, 5);

        // Sleep 2.6s to satisfy physical anti-cheat threshold
        await new Promise(r => setTimeout(r, 2600));

        // Submit 5 finishes simultaneously
        const finishPromises = pids.map((pid, idx) => {
            const fMock = mockRequestResponse({
                method: 'POST',
                body: {
                    action: 'finish',
                    roomId: concRoomId,
                    playerId: pid,
                    seconds: 3.5 + idx * 0.1
                }
            });
            return roomHandler(fMock.req, fMock.res).then(() => fMock.getResult());
        });

        const finishResults = await Promise.all(finishPromises);
        finishResults.forEach((r, idx) => {
            assert.strictEqual(r.statusCode, 200, `Finish for player ${idx} failed`);
        });

        // Verify all 5 finishes are accurately recorded
        const finalCheck = mockRequestResponse({
            method: 'GET',
            query: { roomId: concRoomId }
        });
        await roomHandler(finalCheck.req, finalCheck.res);
        const finalRoom = finalCheck.getResult().body.room;
        const finishedCount = Object.values(finalRoom.players).filter(p => p.finished).length;
        assert.strictEqual(finishedCount, 5, 'All 5 concurrent finishes must be recorded');
    });
});

describe('6. Explicit Redis Failure Handling', () => {
    it('returns explicit HTTP 503 error when Redis is configured to an unreachable endpoint', async () => {
        // Create an isolated sub-process with invalid Redis URL to test fail-fast 503 behavior
        const http = require('http');
        const roomHandlerModule = require('../api/room.js');

        // Temporarily set unreachable Redis URL in environment
        const prevUrl = process.env.UPSTASH_REDIS_REST_URL;
        const prevToken = process.env.UPSTASH_REDIS_REST_TOKEN;
        process.env.UPSTASH_REDIS_REST_URL = 'http://127.0.0.1:59999/unreachable_redis';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'test_token';

        const { req, res, getResult } = mockRequestResponse({
            method: 'GET',
            query: { roomId: 'REDIS_FAIL_TEST_' + Date.now() }
        });

        await roomHandlerModule(req, res);
        const result = getResult();

        // Restore environment variables
        process.env.UPSTASH_REDIS_REST_URL = prevUrl || '';
        process.env.UPSTASH_REDIS_REST_TOKEN = prevToken || '';
        if (!prevUrl) delete process.env.UPSTASH_REDIS_REST_URL;
        if (!prevToken) delete process.env.UPSTASH_REDIS_REST_TOKEN;

        assert.strictEqual(result.statusCode, 503, 'Must return HTTP 503 when authoritative database is unreachable');
        assert.strictEqual(result.body.success, false);
        assert.ok(result.body.error.includes('database connection failed') || result.body.error.includes('Service Temporarily Unavailable'));
    });
});

describe('7. Production Secret Validation & Abuse Resistance', () => {
    const secRoomId = 'SEC_ROOM_' + Date.now();

    it('rejects default dev secret when running in production mode', async () => {
        const prevEnv = process.env.NODE_ENV;
        const prevSecret = process.env.HOST_SECRET;
        try {
            process.env.NODE_ENV = 'production';
            delete process.env.HOST_SECRET;

            const { req, res, getResult } = mockRequestResponse({
                method: 'POST',
                headers: { 'x-host-token': 'acm-host-secret-2026' },
                body: { action: 'start', roomId: secRoomId }
            });

            await roomHandler(req, res);
            const result = getResult();
            assert.strictEqual(result.statusCode, 401, 'Must reject default dev secret in production');
            assert.strictEqual(result.body.success, false);
        } finally {
            if (prevEnv !== undefined) process.env.NODE_ENV = prevEnv;
            else delete process.env.NODE_ENV;
            if (prevSecret !== undefined) process.env.HOST_SECRET = prevSecret;
            else delete process.env.HOST_SECRET;
        }
    });

    it('accepts strong custom secret in production via x-host-token header', async () => {
        const prevEnv = process.env.NODE_ENV;
        const prevSecret = process.env.HOST_SECRET;
        try {
            process.env.NODE_ENV = 'production';
            process.env.HOST_SECRET = 'strong-production-token-998877';

            const { req, res, getResult } = mockRequestResponse({
                method: 'POST',
                headers: { 'x-host-token': 'strong-production-token-998877' },
                body: { action: 'config', roomId: secRoomId, timeLimit: 90 }
            });

            await roomHandler(req, res);
            const result = getResult();
            assert.strictEqual(result.statusCode, 200, 'Must accept valid custom secret in production');
            assert.strictEqual(result.body.success, true);
        } finally {
            if (prevEnv !== undefined) process.env.NODE_ENV = prevEnv;
            else delete process.env.NODE_ENV;
            if (prevSecret !== undefined) process.env.HOST_SECRET = prevSecret;
            else delete process.env.HOST_SECRET;
        }
    });

    it('sanitizes control characters and rejects purely blank nicknames', async () => {
        // Blank name
        const blank = mockRequestResponse({
            method: 'POST',
            body: { action: 'join', roomId: secRoomId, name: '   \t  \n  ' }
        });
        await roomHandler(blank.req, blank.res);
        assert.strictEqual(blank.getResult().statusCode, 400);

        // Control characters stripped
        const ctrl = mockRequestResponse({
            method: 'POST',
            body: { action: 'join', roomId: secRoomId, name: 'Hero\x00\x08Name' }
        });
        await roomHandler(ctrl.req, ctrl.res);
        assert.strictEqual(ctrl.getResult().statusCode, 200);
        assert.strictEqual(ctrl.getResult().body.player.name, 'HeroName');
    });

    it('player join and finish operations never require host credentials', async () => {
        // Join without credentials
        const join = mockRequestResponse({
            method: 'POST',
            body: { action: 'join', roomId: secRoomId, name: 'NormalPlayer' }
        });
        await roomHandler(join.req, join.res);
        assert.strictEqual(join.getResult().statusCode, 200);
        const pid = join.getResult().body.playerId;

        // Finish without credentials
        const finish = mockRequestResponse({
            method: 'POST',
            body: { action: 'finish', roomId: secRoomId, playerId: pid, seconds: 15.0 }
        });
        await roomHandler(finish.req, finish.res);
        assert.strictEqual(finish.getResult().statusCode, 200);
    });
});

describe('8. End-to-End Gameplay Journey & Leaderboard Ranking', () => {
    const playRoomId = 'PLAY_ROOM_' + Date.now();

    it('executes full player journey: join, countdown, maze seed sync, finish, leaderboard order, and reset', async () => {
        // 1. Host creates / views room
        const hostView = mockRequestResponse({ method: 'GET', query: { roomId: playRoomId } });
        await roomHandler(hostView.req, hostView.res);
        assert.strictEqual(hostView.getResult().body.room.status, 'LOBBY');
        assert.strictEqual(Object.keys(hostView.getResult().body.room.players).length, 0);

        // 2. Three players join
        const p1 = mockRequestResponse({ method: 'POST', body: { action: 'join', roomId: playRoomId, name: 'Runner_Gold' } });
        await roomHandler(p1.req, p1.res);
        const p1Id = p1.getResult().body.playerId;

        const p2 = mockRequestResponse({ method: 'POST', body: { action: 'join', roomId: playRoomId, name: 'Runner_Silver' } });
        await roomHandler(p2.req, p2.res);
        const p2Id = p2.getResult().body.playerId;

        const p3 = mockRequestResponse({ method: 'POST', body: { action: 'join', roomId: playRoomId, name: 'Runner_Bronze' } });
        await roomHandler(p3.req, p3.res);
        const p3Id = p3.getResult().body.playerId;

        // 3. Host initiates countdown
        const cd = mockRequestResponse({
            method: 'POST',
            headers: { 'x-host-token': 'acm-host-secret-2026' },
            body: { action: 'countdown', roomId: playRoomId, timeLimit: 60 }
        });
        await roomHandler(cd.req, cd.res);
        const seed = cd.getResult().body.room.mazeSeed;
        assert.ok(seed > 0, 'Deterministic mazeSeed must be generated');

        // Both players generate identical maze from this seed
        const m1 = new Maze(16, 16, seed);
        const m2 = new Maze(16, 16, seed);
        assert.deepStrictEqual(m1.letters, m2.letters, 'Maze runes must be 100% identical for all players');

        // 4. Host starts game
        const start = mockRequestResponse({
            method: 'POST',
            headers: { 'x-host-token': 'acm-host-secret-2026' },
            body: { action: 'start', roomId: playRoomId, timeLimit: 60 }
        });
        await roomHandler(start.req, start.res);
        assert.strictEqual(start.getResult().body.room.status, 'STARTED');

        // Sleep 2.6s for anti-cheat
        await new Promise(r => setTimeout(r, 2600));

        // 5. Players finish with different times (staggered after 2.6s elapsed)
        // p1 finishes at 2.7s (1st place)
        const f1 = mockRequestResponse({ method: 'POST', body: { action: 'finish', roomId: playRoomId, playerId: p1Id, seconds: 2.7, formatted: '00:02' } });
        await roomHandler(f1.req, f1.res);

        // p2 finishes at 3.2s (2nd place)
        const f2 = mockRequestResponse({ method: 'POST', body: { action: 'finish', roomId: playRoomId, playerId: p2Id, seconds: 3.2, formatted: '00:03' } });
        await roomHandler(f2.req, f2.res);

        // p3 finishes at 3.8s (3rd place)
        const f3 = mockRequestResponse({ method: 'POST', body: { action: 'finish', roomId: playRoomId, playerId: p3Id, seconds: 3.8, formatted: '00:03' } });
        await roomHandler(f3.req, f3.res);

        // 6. Verify room auto-ended since all players finished
        const finalRoom = mockRequestResponse({ method: 'GET', query: { roomId: playRoomId } });
        await roomHandler(finalRoom.req, finalRoom.res);
        const room = finalRoom.getResult().body.room;
        assert.strictEqual(room.status, 'ENDED', 'Room must auto-transition to ENDED when all players finish');

        // 7. Verify leaderboard sorting
        const sorted = Object.values(room.players)
            .filter(p => p.finished)
            .sort((a, b) => a.finishTimeSeconds - b.finishTimeSeconds);

        assert.strictEqual(sorted[0].name, 'Runner_Gold');
        assert.strictEqual(sorted[1].name, 'Runner_Silver');
        assert.strictEqual(sorted[2].name, 'Runner_Bronze');

        // 8. Host resets room
        const reset = mockRequestResponse({
            method: 'POST',
            headers: { 'x-host-token': 'acm-host-secret-2026' },
            body: { action: 'reset', roomId: playRoomId }
        });
        await roomHandler(reset.req, reset.res);
        assert.strictEqual(reset.getResult().body.room.status, 'LOBBY');
        assert.strictEqual(Object.keys(reset.getResult().body.room.players).length, 0);
    });
});

describe('9. HTTP-Only Host Session Cookie & CSRF Security Controls', () => {
    const sessionRoomId = 'SESSION_ROOM_' + Date.now();
    const testSecret = 'production-strong-secret-key-445566';
    const { createSessionToken, verifySessionToken, parseCookies, safeCompare } = roomHandler;

    it('generates opaque, cryptographically signed session and CSRF tokens without exposing secret', () => {
        const session = createSessionToken(testSecret);
        assert.ok(session.sessionToken, 'Must generate sessionToken');
        assert.ok(session.csrfToken, 'Must generate csrfToken');
        assert.strictEqual(typeof session.sessionToken, 'string');
        assert.strictEqual(typeof session.csrfToken, 'string');
        // Raw secret must NOT be part of the session or CSRF token string
        assert.strictEqual(session.sessionToken.includes(testSecret), false, 'Raw secret must not be in session token');
        assert.strictEqual(session.csrfToken.includes(testSecret), false, 'Raw secret must not be in CSRF token');
    });

    it('verifies valid session token within 24 hours', () => {
        const session = createSessionToken(testSecret);
        const verified = verifySessionToken(session.sessionToken, testSecret);
        assert.ok(verified, 'Valid session token must verify successfully');
        assert.strictEqual(verified.expectedCsrf, session.csrfToken, 'Expected CSRF must match generated CSRF token');
    });

    it('rejects forged, tampered, or wrong-secret session tokens', () => {
        const session = createSessionToken(testSecret);
        const parts = session.sessionToken.split('.');
        const tampered = `${parts[0]}.${parts[1]}.badsignature123456`;
        assert.strictEqual(verifySessionToken(tampered, testSecret), null, 'Tampered signature must be rejected');
        assert.strictEqual(verifySessionToken(session.sessionToken, 'completely-different-secret'), null, 'Wrong secret must be rejected');
        assert.strictEqual(verifySessionToken('garbage-token', testSecret), null, 'Malformed token must be rejected');
    });

    it('rejects expired session tokens (> 24 hours)', () => {
        const oldTimestamp = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago
        const sessionId = 'fake_session_id_123456';
        const payload = `${sessionId}.${oldTimestamp}`;
        const signature = crypto.createHmac('sha256', testSecret).update(payload).digest('hex');
        const expiredToken = `${payload}.${signature}`;

        assert.strictEqual(verifySessionToken(expiredToken, testSecret), null, 'Expired session token (>24h) must be rejected');
    });

    it('accepts administrative action with valid session cookie and matching x-csrf-token', async () => {
        const prevEnv = process.env.NODE_ENV;
        const prevSecret = process.env.HOST_SECRET;
        try {
            process.env.NODE_ENV = 'production';
            process.env.HOST_SECRET = testSecret;

            const session = createSessionToken(testSecret);

            const { req, res, getResult } = mockRequestResponse({
                method: 'POST',
                headers: {
                    cookie: `acm_host_session=${session.sessionToken}; other_cookie=xyz`,
                    'x-csrf-token': session.csrfToken
                },
                body: { action: 'config', roomId: sessionRoomId, timeLimit: 150 }
            });

            await roomHandler(req, res);
            const result = getResult();
            assert.strictEqual(result.statusCode, 200, 'Must authorize with valid session cookie and matching CSRF token');
            assert.strictEqual(result.body.success, true);
            assert.strictEqual(result.body.room.timeLimit, 150);
        } finally {
            if (prevEnv !== undefined) process.env.NODE_ENV = prevEnv;
            else delete process.env.NODE_ENV;
            if (prevSecret !== undefined) process.env.HOST_SECRET = prevSecret;
            else delete process.env.HOST_SECRET;
        }
    });

    it('rejects administrative action when session cookie is present but x-csrf-token is missing', async () => {
        const prevEnv = process.env.NODE_ENV;
        const prevSecret = process.env.HOST_SECRET;
        try {
            process.env.NODE_ENV = 'production';
            process.env.HOST_SECRET = testSecret;

            const session = createSessionToken(testSecret);

            const { req, res, getResult } = mockRequestResponse({
                method: 'POST',
                headers: {
                    cookie: `acm_host_session=${session.sessionToken}`
                    // Missing x-csrf-token
                },
                body: { action: 'countdown', roomId: sessionRoomId }
            });

            await roomHandler(req, res);
            const result = getResult();
            assert.strictEqual(result.statusCode, 401, 'Must reject cookie-authenticated POST when CSRF token is missing');
            assert.strictEqual(result.body.success, false);
        } finally {
            if (prevEnv !== undefined) process.env.NODE_ENV = prevEnv;
            else delete process.env.NODE_ENV;
            if (prevSecret !== undefined) process.env.HOST_SECRET = prevSecret;
            else delete process.env.HOST_SECRET;
        }
    });

    it('rejects administrative action when x-csrf-token does not match session', async () => {
        const prevEnv = process.env.NODE_ENV;
        const prevSecret = process.env.HOST_SECRET;
        try {
            process.env.NODE_ENV = 'production';
            process.env.HOST_SECRET = testSecret;

            const session = createSessionToken(testSecret);

            const { req, res, getResult } = mockRequestResponse({
                method: 'POST',
                headers: {
                    cookie: `acm_host_session=${session.sessionToken}`,
                    'x-csrf-token': 'wrong-csrf-token-value'
                },
                body: { action: 'countdown', roomId: sessionRoomId }
            });

            await roomHandler(req, res);
            const result = getResult();
            assert.strictEqual(result.statusCode, 401, 'Must reject when CSRF token does not match');
            assert.strictEqual(result.body.success, false);
        } finally {
            if (prevEnv !== undefined) process.env.NODE_ENV = prevEnv;
            else delete process.env.NODE_ENV;
            if (prevSecret !== undefined) process.env.HOST_SECRET = prevSecret;
            else delete process.env.HOST_SECRET;
        }
    });
});

describe('10. Production QR Code & Dynamic URL Generation', () => {
    const fs = require('fs');
    const path = require('path');
    const hostHtmlPath = path.join(__dirname, '../host.html');
    const hostHtml = fs.readFileSync(hostHtmlPath, 'utf8');

    it('ensures host.html does not contain hardcoded LAN IP in encodedUrlInput value', () => {
        assert.doesNotMatch(
            hostHtml,
            /<input[^>]*id=["']encodedUrlInput["'][^>]*value=["']http:\/\/192\.168\./,
            'encodedUrlInput must not contain a hardcoded LAN IP in its HTML markup value'
        );
    });

    it('ensures host.html defines getPlayerJoinUrl and dynamically derives player URL', () => {
        assert.match(hostHtml, /function getPlayerJoinUrl\(/, 'Must define getPlayerJoinUrl');
        assert.match(hostHtml, /window\.location\.origin/, 'Must use window.location.origin dynamically');
        assert.match(hostHtml, /acm-maze-runner-153208250440\.asia-south1\.run.app/, 'Must reference the production origin fallback');
    });

    it('ensures host.html configures high-contrast QR generation with dark modules on light background', () => {
        assert.match(hostHtml, /colorDark:\s*["']#000000["']/, 'QR dark modules must be high-contrast pure black');
        assert.match(hostHtml, /colorLight:\s*["']#ffffff["']/, 'QR light background must be white');
        assert.match(hostHtml, /generateQRCode\(/, 'Must have generateQRCode function');
        assert.match(hostHtml, /updateCustomQr\(/, 'Must have updateCustomQr function');
    });

    it('validates dynamic URL resolution logic for production and custom room codes', () => {
        const match = hostHtml.match(/function getPlayerJoinUrl\([\s\S]*?^ {8}\}/m);
        assert.ok(match, 'Must find getPlayerJoinUrl function in host.html');

        const simulateGetUrl = new Function('window', 'currentRoomId', `
            ${match[0]}
            return getPlayerJoinUrl;
        `);

        // Test production origin
        const prodWindow = {
            location: {
                protocol: 'https:',
                origin: 'https://acm-maze-runner-153208250440.asia-south1.run.app'
            }
        };
        const getProdUrl = simulateGetUrl(prodWindow, 'ACM2026');
        assert.strictEqual(
            getProdUrl('ACM2026'),
            'https://acm-maze-runner-153208250440.asia-south1.run.app/index.html?room=ACM2026'
        );
        assert.strictEqual(
            getProdUrl('CUSTOM_ROOM'),
            'https://acm-maze-runner-153208250440.asia-south1.run.app/index.html?room=CUSTOM_ROOM'
        );

        // Test fallback origin when window.location is unavailable (e.g. file:// or null origin)
        const fileWindow = { location: { protocol: 'file:', origin: 'null' } };
        const getFallbackUrl = simulateGetUrl(fileWindow, 'ACM2026');
        assert.strictEqual(
            getFallbackUrl('ACM2026'),
            'https://acm-maze-runner-153208250440.asia-south1.run.app/index.html?room=ACM2026'
        );
    });

    it('ensures sync.js parses cleanly and GameSync instantiates without syntax errors', () => {
        const GameSync = require('../sync.js');
        assert.strictEqual(typeof GameSync, 'function', 'GameSync must be a constructor class');
        const instance = new GameSync('ACM2026');
        assert.strictEqual(instance.roomId, 'ACM2026');
    });
});



