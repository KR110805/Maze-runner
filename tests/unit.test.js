const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
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

        // 2. Start game
        const start = mockRequestResponse({
            method: 'POST',
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
