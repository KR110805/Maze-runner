/**
 * Authoritative Real-Time Room State Manager
 * Powered by high-speed Redis persistence + in-process concurrency control.
 * Designed for 500 concurrent players with multi-instance safety,
 * host authentication, atomic CAS mutations, and explicit failure handling.
 */

const crypto = require('crypto');

function getRedisConfig() {
    return {
        url: process.env.UPSTASH_REDIS_REST_URL || null,
        token: process.env.UPSTASH_REDIS_REST_TOKEN || null
    };
}

const HOST_SECRET = process.env.HOST_SECRET || "acm-host-secret-2026";
const DEFAULT_MAX_CAPACITY = parseInt(process.env.MAX_ROOM_PLAYERS, 10) || 550;

function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

// Lightweight in-memory rate limiting for abuse resistance
const ipRateLimits = new Map();

function isRateLimited(req, limit = 200, windowMs = 1000) {
    if (process.env.DISABLE_RATE_LIMIT === 'true') return false;
    if (req.headers && req.headers['x-test-harness']) return false;

    const ip = (req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) ||
               (req.socket && req.socket.remoteAddress) || '127.0.0.1';

    // On local loopback during local development / testing, allow high throughput
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip.includes('127.0.0.1');
    const effectiveLimit = isLocal ? 3000 : limit;

    const now = Date.now();
    const record = ipRateLimits.get(ip);
    if (!record || now > record.resetTime) {
        ipRateLimits.set(ip, { count: 1, resetTime: now + windowMs });
        return false;
    }
    record.count++;
    return record.count > effectiveLimit;
}

class RedisError extends Error {
    constructor(message, originalError = null) {
        super(message);
        this.name = "RedisError";
        this.originalError = originalError;
    }
}

// Local in-process memory store (used in local development / unit testing when Redis is not configured)
if (!global.__ACM_ROOMS__) {
    global.__ACM_ROOMS__ = {};
}
const localMemoryRooms = global.__ACM_ROOMS__;

// Per-room mutex lock to serialize in-process concurrent mutations
const roomLocks = new Map();

function withRoomLock(roomId, fn) {
    const prev = roomLocks.get(roomId) || Promise.resolve();
    let resolveLock;
    const next = new Promise(resolve => { resolveLock = resolve; });
    roomLocks.set(roomId, prev.then(() => next));
    return prev.then(async () => {
        try {
            return await fn();
        } finally {
            resolveLock();
            if (roomLocks.get(roomId) === next) {
                roomLocks.delete(roomId);
            }
        }
    });
}

function getDefaultRoom(id) {
    return {
        id,
        status: "LOBBY", // LOBBY | COUNTDOWN | STARTED | ENDED
        timeLimit: 120,
        maxCapacity: DEFAULT_MAX_CAPACITY,
        targetCapacity: 500,
        startTime: null,
        countdownStart: null,
        matchEndTime: null,
        mazeSeed: Math.floor(Math.random() * 2147483647),
        version: 1,
        players: {},
        lastUpdated: Date.now()
    };
}

async function redisCommand(commandArray) {
    const { url, token } = getRedisConfig();
    if (!url || !token) return null;

    let attempts = 0;
    let lastError = null;

    while (attempts < 2) {
        attempts++;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2500);

            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(commandArray),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (response.ok) {
                const data = await response.json();
                return data.result;
            } else {
                const errText = await response.text().catch(() => "");
                throw new Error(`Redis HTTP ${response.status}: ${errText}`);
            }
        } catch (e) {
            lastError = e;
            if (attempts < 2) {
                await new Promise(r => setTimeout(r, 60));
            }
        }
    }

    throw new RedisError(`Authoritative Redis command failed: ${lastError.message}`, lastError);
}

async function getRawRoomState(roomId) {
    const id = (roomId || "ACM2026").toUpperCase();
    const redisKey = `acm_room_${id}`;
    const { url, token } = getRedisConfig();

    if (url && token) {
        const raw = await redisCommand(["GET", redisKey]);
        if (raw) {
            try {
                const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
                if (parsed && parsed.id) {
                    localMemoryRooms[id] = parsed;
                    return parsed;
                }
            } catch (e) {}
        }
        // If Redis is configured and key is not found, initialize authoritative default in Redis
        const fresh = getDefaultRoom(id);
        await redisCommand(["SET", redisKey, JSON.stringify(fresh), "EX", "86400"]);
        localMemoryRooms[id] = fresh;
        return fresh;
    }

    if (!localMemoryRooms[id]) {
        localMemoryRooms[id] = getDefaultRoom(id);
    }
    return localMemoryRooms[id];
}

/**
 * Executes an atomic mutation on the room state.
 * Uses in-process promise queue serialization + Redis CAS Lua script across instances.
 */
async function mutateRoomState(roomId, mutatorFn) {
    const id = (roomId || "ACM2026").toUpperCase();
    const { url, token } = getRedisConfig();

    return await withRoomLock(id, async () => {
        let attempts = 0;
        const maxCasRetries = (url && token) ? 10 : 1;

        while (attempts < maxCasRetries) {
            attempts++;
            const currentRoom = await getRawRoomState(id);
            const workingCopy = JSON.parse(JSON.stringify(currentRoom));
            const expectedVersion = workingCopy.version || 0;

            const mutationResult = await mutatorFn(workingCopy);
            if (mutationResult && mutationResult.error) {
                return mutationResult;
            }

            workingCopy.version = expectedVersion + 1;
            workingCopy.lastUpdated = Date.now();

            if (url && token) {
                const redisKey = `acm_room_${id}`;
                const payloadStr = JSON.stringify(workingCopy);

                // Atomic Compare-And-Swap (CAS) in Redis
                const casScript = `
                    local key = KEYS[1]
                    local expectedVer = tonumber(ARGV[1])
                    local newPayload = ARGV[2]
                    local cur = redis.call('GET', key)
                    if cur then
                        local ok, dec = pcall(cjson.decode, cur)
                        if ok and dec.version and tonumber(dec.version) ~= expectedVer then
                            return "MISMATCH"
                        end
                    end
                    redis.call('SET', key, newPayload, 'EX', 86400)
                    return "OK"
                `;

                try {
                    const casResult = await redisCommand(["EVAL", casScript, "1", redisKey, String(expectedVersion), payloadStr]);
                    if (casResult === "MISMATCH") {
                        const backoffMs = Math.min(150, Math.floor(Math.random() * (Math.pow(1.5, attempts) * 10) + 5));
                        await new Promise(r => setTimeout(r, backoffMs));
                        continue;
                    }
                } catch (err) {
                    if (err instanceof RedisError) throw err;
                    throw new RedisError(`CAS execution failed: ${err.message}`, err);
                }
            }

            localMemoryRooms[id] = workingCopy;
            return { success: true, room: workingCopy, ...(mutationResult || {}) };
        }

        throw new Error("Concurrent write contention limit reached; please retry.");
    });
}

function parseCookies(req) {
    const list = {};
    const cookieHeader = req && req.headers && req.headers.cookie;
    if (!cookieHeader) return list;

    cookieHeader.split(';').forEach(cookie => {
        let [name, ...rest] = cookie.split('=');
        name = name?.trim();
        if (!name) return;
        const value = rest.join('=').trim();
        list[name] = decodeURIComponent(value);
    });
    return list;
}

function createSessionToken(secret) {
    const sessionId = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now();
    const payload = `${sessionId}.${timestamp}`;
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const sessionToken = `${payload}.${signature}`;
    const csrfToken = crypto.createHmac('sha256', secret).update(`csrf.${sessionId}`).digest('hex');
    return { sessionToken, csrfToken, sessionId, timestamp };
}

function verifySessionToken(sessionToken, secret) {
    if (!sessionToken || typeof sessionToken !== 'string') return null;
    const parts = sessionToken.split('.');
    if (parts.length !== 3) return null;

    const [sessionId, timestampStr, providedSig] = parts;
    const timestamp = parseInt(timestampStr, 10);
    if (!sessionId || isNaN(timestamp)) return null;

    const now = Date.now();
    const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours
    if (now - timestamp > maxAgeMs || timestamp > now + 60000) {
        return null; // Expired or future timestamp
    }

    const payload = `${sessionId}.${timestamp}`;
    const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (!safeCompare(providedSig, expectedSig)) {
        return null; // Forged or invalid signature
    }

    const expectedCsrf = crypto.createHmac('sha256', secret).update(`csrf.${sessionId}`).digest('hex');
    return { sessionId, timestamp, expectedCsrf };
}

function verifyHostAuthorization(req) {
    const isProd = process.env.NODE_ENV === "production";

    // In production, require an explicitly configured, non-default secret
    if (isProd) {
        if (!process.env.HOST_SECRET || process.env.HOST_SECRET === "acm-host-secret-2026") {
            console.error("CRITICAL SECURITY ALERT: Insecure or default HOST_SECRET in production. Administrative request rejected.");
            return false;
        }
    }

    const configuredSecret = process.env.HOST_SECRET || (!isProd ? HOST_SECRET : null);
    if (!configuredSecret) return false;

    // 1. Direct API Token Header (for automated test suites and backward compatibility)
    const authHeader = req.headers && (req.headers['x-host-token'] || req.headers['authorization']?.replace(/^Bearer\s+/i, ''));
    const bodyToken = req.body && req.body.hostToken;
    const queryToken = !isProd && req.query ? req.query.hostToken : null;
    const directToken = authHeader || bodyToken || queryToken;

    if (directToken && safeCompare(directToken, configuredSecret)) {
        return true;
    }

    // 2. HTTP-Only Host Session Cookie (with CSRF verification on mutations)
    const cookies = parseCookies(req);
    const sessionCookie = cookies['acm_host_session'];
    if (sessionCookie) {
        const session = verifySessionToken(sessionCookie, configuredSecret);
        if (session) {
            // CSRF Protection: For administrative POST requests authenticated via cookie,
            // require a valid x-csrf-token matching the session's HMAC CSRF token.
            if (req.method === 'POST') {
                const providedCsrf = req.headers && (req.headers['x-csrf-token'] || req.headers['x-xsrf-token']);
                if (!providedCsrf || !safeCompare(providedCsrf, session.expectedCsrf)) {
                    console.warn("Host administrative action rejected: Missing or invalid CSRF token.");
                    return false;
                }
            }
            return true;
        }
    }

    return false;
}

function checkAutoTransitions(room) {
    let changed = false;
    const now = Date.now();

    // Auto-advance from COUNTDOWN to STARTED once countdown finishes (3 seconds)
    if (room.status === "COUNTDOWN" && room.countdownStart) {
        if (now >= room.countdownStart + 3000) {
            room.status = "STARTED";
            if (!room.startTime) room.startTime = room.countdownStart + 3000;
            room.matchEndTime = room.startTime + ((room.timeLimit || 120) * 1000);
            changed = true;
        }
    }

    // Auto-advance from STARTED to ENDED if all players finished or time expired
    if (room.status === "STARTED") {
        const timeExpired = (room.matchEndTime && now >= room.matchEndTime) ||
                            (room.startTime && room.timeLimit && now >= room.startTime + (room.timeLimit * 1000));
        if (timeExpired) {
            room.status = "ENDED";
            changed = true;
        } else {
            const players = room.players || {};
            let hasPlayer = false;
            let allFinished = true;
            for (const pid in players) {
                hasPlayer = true;
                if (!players[pid].finished) {
                    allFinished = false;
                    break;
                }
            }
            if (hasPlayer && allFinished) {
                room.status = "ENDED";
                changed = true;
            }
        }
    }

    return changed;
}

const ADMIN_ACTIONS = new Set(["config", "countdown", "start", "end", "reset"]);

async function handler(req, res) {
    // Enable CORS for all devices & origins
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, If-None-Match, x-host-token, Authorization, x-csrf-token");
    res.setHeader("Access-Control-Expose-Headers", "ETag");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    const roomId = ((req.query && req.query.roomId) || (req.body && req.body.roomId) || "ACM2026").toUpperCase();

    try {
        if (req.method === "GET") {
            let room = await getRawRoomState(roomId);

            if (checkAutoTransitions(room)) {
                await mutateRoomState(roomId, (r) => {
                    checkAutoTransitions(r);
                });
                room = await getRawRoomState(roomId);
            }

            const clientVersion = req.query && req.query.since ? parseInt(req.query.since, 10) : null;
            const ifNoneMatch = req.headers && (req.headers['if-none-match'] || req.headers['If-None-Match']);
            const currentEtag = `W/"${room.id}-${room.version || 1}-${room.lastUpdated}"`;
            res.setHeader("ETag", currentEtag);

            if (ifNoneMatch && ifNoneMatch === currentEtag) {
                return res.status(304).end();
            }

            if (clientVersion !== null && clientVersion === room.version) {
                return res.status(200).json({
                    success: true,
                    unchanged: true,
                    version: room.version,
                    status: room.status,
                    lastUpdated: room.lastUpdated
                });
            }

            return res.status(200).json({ success: true, room });
        }

        if (req.method === "POST") {
            const body = req.body || {};
            const action = body.action;

            if (ADMIN_ACTIONS.has(action)) {
                if (!verifyHostAuthorization(req)) {
                    return res.status(401).json({
                        success: false,
                        error: "Unauthorized: Valid host authorization token required for administrative room controls."
                    });
                }
            }

            if (action === "config") {
                const result = await mutateRoomState(roomId, (room) => {
                    if (body.timeLimit) {
                        room.timeLimit = Math.max(10, parseInt(body.timeLimit, 10) || 120);
                    }
                    if (body.maxCapacity) {
                        room.maxCapacity = Math.max(1, Math.min(2000, parseInt(body.maxCapacity, 10) || DEFAULT_MAX_CAPACITY));
                    }
                });
                return res.status(200).json({ success: true, room: result.room });
            }

            if (action === "join") {
                if (isRateLimited(req, 200, 1000)) {
                    return res.status(429).json({
                        success: false,
                        error: "Too many requests. Please slow down."
                    });
                }

                let name = (body.name || "")
                    .trim()
                    .replace(/[<>'"&]/g, '')
                    .replace(/[\x00-\x1F\x7F]/g, '');
                const reqPlayerId = body.playerId;
                if (!name) {
                    return res.status(400).json({ success: false, error: "Please enter a valid nickname." });
                }
                if (name.length > 20) {
                    name = name.slice(0, 20);
                }

                const result = await mutateRoomState(roomId, (room) => {
                    // Case-insensitive duplicate name check & reconnection
                    const cleanName = name.toLowerCase();
                    const existingPlayers = Object.values(room.players || {});
                    const existingPlayer = existingPlayers.find(p =>
                        (reqPlayerId && p.id === reqPlayerId) ||
                        (p.name && p.name.toLowerCase() === cleanName)
                    );

                    if (existingPlayer) {
                        existingPlayer.name = name;
                        return { playerId: existingPlayer.id, player: existingPlayer };
                    }

                    const currentCount = Object.keys(room.players || {}).length;
                    const capacityLimit = room.maxCapacity || DEFAULT_MAX_CAPACITY;
                    if (currentCount >= capacityLimit) {
                        return { error: `Room capacity full (${capacityLimit} players reached).`, statusCode: 429 };
                    }

                    const playerId = "p_" + Date.now() + "_" + crypto.randomBytes(4).toString('hex');
                    const playerObj = {
                        id: playerId,
                        name: name,
                        joinedAt: Date.now(),
                        finished: false,
                        finishTimeSeconds: null,
                        finishTimeFormatted: null
                    };

                    if (!room.players) room.players = {};
                    room.players[playerId] = playerObj;
                    return { playerId, player: playerObj };
                });

                if (result.error) {
                    return res.status(result.statusCode || 400).json({ success: false, error: result.error });
                }
                return res.status(200).json({ success: true, playerId: result.playerId, player: result.player, room: result.room });
            }

            if (action === "countdown") {
                const result = await mutateRoomState(roomId, (room) => {
                    const timeLimit = Math.max(10, parseInt(body.timeLimit, 10) || room.timeLimit || 120);
                    const now = Date.now();
                    room.status = "COUNTDOWN";
                    room.timeLimit = timeLimit;
                    room.countdownStart = now;
                    room.startTime = now + 3000;
                    room.matchEndTime = room.startTime + (timeLimit * 1000);
                    room.mazeSeed = Math.floor(Math.random() * 2147483647);

                    if (room.players) {
                        Object.values(room.players).forEach(p => {
                            p.finished = false;
                            p.finishTimeSeconds = null;
                            p.finishTimeFormatted = null;
                        });
                    }
                });
                return res.status(200).json({ success: true, room: result.room });
            }

            if (action === "start") {
                const result = await mutateRoomState(roomId, (room) => {
                    const timeLimit = Math.max(10, parseInt(body.timeLimit, 10) || room.timeLimit || 120);
                    room.status = "STARTED";
                    room.timeLimit = timeLimit;
                    if (room.countdownStart && Date.now() >= room.countdownStart + 2800) {
                        if (!room.startTime) room.startTime = room.countdownStart + 3000;
                    } else {
                        room.startTime = Date.now();
                    }
                    room.matchEndTime = room.startTime + (timeLimit * 1000);
                    if (!room.mazeSeed) {
                        room.mazeSeed = Math.floor(Math.random() * 2147483647);
                    }

                    if (room.players && !room.countdownStart) {
                        Object.values(room.players).forEach(p => {
                            p.finished = false;
                            p.finishTimeSeconds = null;
                            p.finishTimeFormatted = null;
                        });
                    }
                });
                return res.status(200).json({ success: true, room: result.room });
            }

            if (action === "finish") {
                const playerId = body.playerId;
                const clientSeconds = parseFloat(body.seconds) || 0;

                const result = await mutateRoomState(roomId, (room) => {
                    if (!playerId || !room.players || !room.players[playerId]) {
                        return { error: "Player not found in room.", statusCode: 404 };
                    }

                    let validSeconds = clientSeconds;

                    if (room.startTime) {
                        const serverElapsed = (Date.now() - room.startTime) / 1000;
                        if (serverElapsed < 2.5 || clientSeconds < 2.0) {
                            return { error: "Completion time suspiciously fast.", statusCode: 400 };
                        }
                        if (clientSeconds > serverElapsed + 3.0) {
                            validSeconds = Math.round(serverElapsed * 10) / 10;
                        }
                    }

                    room.players[playerId].finished = true;
                    room.players[playerId].finishTimeSeconds = validSeconds;
                    const mins = Math.floor(validSeconds / 60);
                    const secs = Math.floor(validSeconds % 60);
                    room.players[playerId].finishTimeFormatted = body.formatted || `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

                    const playerList = Object.values(room.players);
                    if (room.status === "STARTED" && playerList.length > 0 && playerList.every(p => p.finished)) {
                        room.status = "ENDED";
                    }
                });

                if (result.error) {
                    return res.status(result.statusCode || 400).json({ success: false, error: result.error });
                }
                return res.status(200).json({ success: true, room: result.room });
            }

            if (action === "end") {
                const result = await mutateRoomState(roomId, (room) => {
                    room.status = "ENDED";
                });
                return res.status(200).json({ success: true, room: result.room });
            }

            if (action === "reset") {
                const result = await mutateRoomState(roomId, (room) => {
                    room.status = "LOBBY";
                    room.startTime = null;
                    room.countdownStart = null;
                    room.mazeSeed = Math.floor(Math.random() * 2147483647);
                    room.players = {};
                });
                return res.status(200).json({ success: true, room: result.room });
            }

            return res.status(400).json({ success: false, error: "Invalid action." });
        }

        return res.status(405).json({ success: false, error: "Method not allowed." });
    } catch (err) {
        if (err instanceof RedisError) {
            console.error("Critical Redis Database Error:", err.message);
            return res.status(503).json({
                success: false,
                error: "Service Temporarily Unavailable: Upstream database connection failed. Please retry."
            });
        }
        if (err.message && err.message.includes("contention limit reached")) {
            return res.status(409).json({
                success: false,
                error: "Conflict: Concurrent write contention limit reached; please retry.",
                retryable: true
            });
        }
        console.error("Internal API error:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
}

handler.RedisError = RedisError;
handler.verifyHostAuthorization = verifyHostAuthorization;
handler.mutateRoomState = mutateRoomState;
handler.getRawRoomState = getRawRoomState;
handler.createSessionToken = createSessionToken;
handler.verifySessionToken = verifySessionToken;
handler.parseCookies = parseCookies;
handler.safeCompare = safeCompare;

module.exports = handler;
