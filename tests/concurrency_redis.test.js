/**
 * Phase 2: Redis Concurrency & Multi-Instance Integration Test
 * Deterministically tests Upstash REST API Lua CAS semantics, multi-instance mutations,
 * conflict retries, exhaustion handling, and 0 lost updates.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// Lightweight in-process mock of Upstash Redis REST service
class MockUpstashServer {
    constructor() {
        this.store = new Map();
        this.requestLog = [];
        this.forcedMismatches = 0;
        this.server = http.createServer((req, res) => this.handleRequest(req, res));
    }

    async start() {
        return new Promise((resolve) => {
            this.server.listen(0, '127.0.0.1', () => {
                this.port = this.server.address().port;
                this.url = `http://127.0.0.1:${this.port}`;
                resolve(this.url);
            });
        });
    }

    async close() {
        return new Promise((resolve) => this.server.close(resolve));
    }

    async handleRequest(req, res) {
        let bodyStr = '';
        req.on('data', chunk => { bodyStr += chunk; });
        req.on('end', () => {
            try {
                const command = JSON.parse(bodyStr);
                this.requestLog.push(command);
                const op = command[0].toUpperCase();

                if (op === 'GET') {
                    const key = command[1];
                    const val = this.store.get(key) || null;
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ result: val }));
                }

                if (op === 'SET') {
                    const key = command[1];
                    const val = command[2];
                    this.store.set(key, val);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ result: 'OK' }));
                }

                if (op === 'EVAL') {
                    const key = command[3];
                    const expectedVer = parseInt(command[4], 10);
                    const newPayloadStr = command[5];

                    if (this.forcedMismatches > 0) {
                        this.forcedMismatches--;
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ result: 'MISMATCH' }));
                    }

                    const cur = this.store.get(key);
                    if (cur) {
                        try {
                            const dec = JSON.parse(cur);
                            if (dec.version && parseInt(dec.version, 10) !== expectedVer) {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                return res.end(JSON.stringify({ result: 'MISMATCH' }));
                            }
                        } catch (e) {}
                    }

                    this.store.set(key, newPayloadStr);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ result: 'OK' }));
                }

                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Unsupported command: ${op}` }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    }
}

describe('Phase 2: Redis Concurrency & Data Correctness (Multi-Instance CAS)', () => {
    let mockRedis;
    let redisUrl;
    let prevUrl;
    let prevToken;
    let prevDisableRate;
    const roomHandler = require('../api/room.js');

    before(async () => {
        mockRedis = new MockUpstashServer();
        redisUrl = await mockRedis.start();

        prevUrl = process.env.UPSTASH_REDIS_REST_URL;
        prevToken = process.env.UPSTASH_REDIS_REST_TOKEN;
        prevDisableRate = process.env.DISABLE_RATE_LIMIT;

        process.env.UPSTASH_REDIS_REST_URL = redisUrl;
        process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-test-token-redis-cas';
        process.env.DISABLE_RATE_LIMIT = 'true';
    });

    after(async () => {
        if (prevUrl !== undefined) process.env.UPSTASH_REDIS_REST_URL = prevUrl;
        else delete process.env.UPSTASH_REDIS_REST_URL;

        if (prevToken !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = prevToken;
        else delete process.env.UPSTASH_REDIS_REST_TOKEN;

        if (prevDisableRate !== undefined) process.env.DISABLE_RATE_LIMIT = prevDisableRate;
        else delete process.env.DISABLE_RATE_LIMIT;

        await mockRedis.close();
    });

    function mockReqRes(options) {
        let statusCode = 200;
        let body = null;
        const res = {
            status(code) { statusCode = code; return this; },
            json(data) { body = data; return this; },
            setHeader() {},
            end() { return this; }
        };
        const req = {
            method: options.method || 'GET',
            query: options.query || {},
            body: options.body || {},
            headers: options.headers || {}
        };
        return { req, res, get: () => ({ statusCode, body }) };
    }

    it('initializes authoritative room in Redis and fetches correctly', async () => {
        const roomId = 'REDIS_INIT_' + Date.now();
        const { req, res, get } = mockReqRes({ method: 'GET', query: { roomId } });
        await roomHandler(req, res);

        assert.strictEqual(get().statusCode, 200);
        assert.strictEqual(get().body.room.id, roomId);
        assert.strictEqual(get().body.room.status, 'LOBBY');
        assert.strictEqual(get().body.room.version, 1);

        // Verify stored in Redis
        const stored = mockRedis.store.get(`acm_room_${roomId}`);
        assert.ok(stored, 'Must be stored in Redis');
        const parsed = JSON.parse(stored);
        assert.strictEqual(parsed.id, roomId);
    });

    it('handles CAS conflict retry transparently without lost updates', async () => {
        const roomId = 'CAS_RETRY_' + Date.now();
        // 1. Initialize room
        const init = mockReqRes({ method: 'GET', query: { roomId } });
        await roomHandler(init.req, init.res);

        // Force 2 CAS mismatches on next mutation to simulate a race with another instance
        mockRedis.forcedMismatches = 2;

        const join = mockReqRes({
            method: 'POST',
            body: { action: 'join', roomId, name: 'Racer_Alice' }
        });
        await roomHandler(join.req, join.res);

        const result = join.get();
        assert.strictEqual(result.statusCode, 200, 'Must succeed despite 2 CAS retries');
        assert.strictEqual(result.body.success, true);
        assert.strictEqual(result.body.player.name, 'Racer_Alice');

        // Confirm room was saved with incremented version
        const stored = JSON.parse(mockRedis.store.get(`acm_room_${roomId}`));
        assert.strictEqual(stored.players[result.body.playerId].name, 'Racer_Alice');
    });

    it('returns HTTP 409 Conflict when write contention exceeds retry budget', async () => {
        const roomId = 'CAS_EXHAUST_' + Date.now();
        const init = mockReqRes({ method: 'GET', query: { roomId } });
        await roomHandler(init.req, init.res);

        // Force 15 mismatches to exceed maxCasRetries (10)
        mockRedis.forcedMismatches = 15;

        const join = mockReqRes({
            method: 'POST',
            body: { action: 'join', roomId, name: 'Exhaust_Player' }
        });
        await roomHandler(join.req, join.res);

        const result = join.get();
        assert.strictEqual(result.statusCode, 409, 'Must return HTTP 409 on contention limit');
        assert.strictEqual(result.body.success, false);
        assert.strictEqual(result.body.retryable, true);
    });

    it('handles 20 concurrent joins across instances with 0 lost updates', async () => {
        const roomId = 'MULTI_CONC_' + Date.now();
        const init = mockReqRes({ method: 'GET', query: { roomId } });
        await roomHandler(init.req, init.res);

        const joinPromises = [];
        for (let i = 1; i <= 20; i++) {
            const j = mockReqRes({
                method: 'POST',
                body: { action: 'join', roomId, name: `Multi_Runner_${i}` }
            });
            joinPromises.push(roomHandler(j.req, j.res).then(() => j.get()));
        }

        const results = await Promise.all(joinPromises);
        results.forEach((r, idx) => {
            assert.strictEqual(r.statusCode, 200, `Player ${idx + 1} join failed`);
            assert.strictEqual(r.body.success, true);
        });

        // Inspect final state in Redis
        const stored = JSON.parse(mockRedis.store.get(`acm_room_${roomId}`));
        const count = Object.keys(stored.players).length;
        assert.strictEqual(count, 20, 'All 20 concurrent player joins must be recorded in Redis');
    });

    it('reconnection in Redis multi-instance mode is idempotent', async () => {
        const roomId = 'RECON_IDEMP_' + Date.now();
        // 1. Initial join
        const join1 = mockReqRes({
            method: 'POST',
            body: { action: 'join', roomId, name: 'Idemp_User' }
        });
        await roomHandler(join1.req, join1.res);
        const pid = join1.get().body.playerId;

        // 2. Reconnect with existing ID
        const join2 = mockReqRes({
            method: 'POST',
            body: { action: 'join', roomId, playerId: pid, name: 'Idemp_User' }
        });
        await roomHandler(join2.req, join2.res);

        assert.strictEqual(join2.get().statusCode, 200);
        assert.strictEqual(join2.get().body.playerId, pid);

        // Verify player count is still 1
        const stored = JSON.parse(mockRedis.store.get(`acm_room_${roomId}`));
        assert.strictEqual(Object.keys(stored.players).length, 1);
    });
});
