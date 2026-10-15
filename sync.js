/**
 * ACM Spell Maze - Universal Real-Time Synchronization Engine
 * Automatically selects the best sync provider:
 * 1. Vercel Serverless API (/api/room) with Cloud Persistence
 * 2. Firebase Cloud Firestore
 * 3. Local BroadcastChannel + LocalStorage (Offline testing fallback)
 */
function getCookieValue(name) {
    if (typeof document === 'undefined') return null;
    const match = document.cookie.match(new RegExp('(^|;\\s*)' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[2]) : null;
}

class GameSync {
    constructor(roomId = "ACM2026", hostToken = null) {
        this.roomId = (roomId || "ACM2026").toUpperCase();
        this.hostToken = hostToken || null;
        this.provider = null; // Will resolve via initPromise
        this.db = null;
        this.listeners = [];
        this.isPolling = false;
        this.cachedState = {
            status: "LOBBY", // LOBBY | COUNTDOWN | STARTED | ENDED
            timeLimit: 120, // seconds
            startTime: null,
            countdownStart: null,
            players: {}
        };

        this.initPromise = this.init();
    }

    setHostToken(token) {
        this.hostToken = token;
    }

    async init() {
        // Priority 1: Firebase if configured
        if (typeof window !== 'undefined' && typeof window.isFirebaseConfigured === 'function' && window.isFirebaseConfigured()) {
            this.provider = "FIREBASE";
            await this.initFirebase();
            return;
        }

        // Priority 2: Check if Vercel /api/room is reachable
        const hasVercelApi = await this.checkVercelApi();
        if (hasVercelApi) {
            this.provider = "VERCEL";
            this.initVercelSync();
            return;
        }

        // Priority 3: Local cross-tab sync fallback
        this.provider = "LOCAL";
        this.initLocalSync();
    }

    async checkVercelApi() {
        if (typeof window !== 'undefined' && window.location && window.location.protocol === "file:") return false;
        try {
            const res = await fetch(`/api/room?roomId=${this.roomId}`, {
                method: "GET",
                cache: "no-store"
            });
            if (res.ok) {
                const data = await res.json();
                if (data && data.room) {
                    this.cachedState = Object.assign(this.cachedState, data.room);
                    this.notifyListeners();
                }
                return true;
            }
        } catch (e) {}
        return false;
    }

    /* -----------------------------------------------------
       PROVIDER 1: VERCEL SERVERLESS API SYNC
       ----------------------------------------------------- */
    initVercelSync() {
        console.log("⚡ Cloud Serverless Sync Active for Room:", this.roomId);
        if (this.isPolling) return;
        this.isPolling = true;

        let pollTimer = null;
        let backoffOnError = 1000;

        const pollRoom = async () => {
            if (!this.isPolling) return;
            try {
                const versionParam = this.cachedState && this.cachedState.version ? `&since=${this.cachedState.version}` : '';
                const headers = {};
                if (this.lastEtag) {
                    headers['If-None-Match'] = this.lastEtag;
                }

                const res = await fetch(`/api/room?roomId=${this.roomId}${versionParam}`, {
                    headers,
                    cache: "no-store"
                });

                if (res.status === 304) {
                    // State unchanged on server (saved 99% bandwidth)
                    backoffOnError = 1000;
                    scheduleNext();
                    return;
                }

                const etag = res.headers ? res.headers.get('ETag') : null;
                if (etag) this.lastEtag = etag;

                if (res.ok) {
                    const data = await res.json();
                    backoffOnError = 1000;

                    if (data && data.unchanged) {
                        // Delta response indicates no change
                        scheduleNext();
                        return;
                    }

                    if (data && data.room) {
                        this.cachedState = Object.assign(this.cachedState, data.room);
                        if (this.cachedState.status === "COUNTDOWN" && this.cachedState.countdownStart) {
                            if (Date.now() >= this.cachedState.countdownStart + 3000) {
                                this.cachedState.status = "STARTED";
                                if (!this.cachedState.startTime) {
                                    this.cachedState.startTime = this.cachedState.countdownStart + 3000;
                                }
                            }
                        }
                        this.notifyListeners();
                    }
                } else {
                    backoffOnError = Math.min(backoffOnError * 1.5, 4000);
                }
            } catch (e) {
                backoffOnError = Math.min(backoffOnError * 1.5, 4000);
            }
            scheduleNext();
        };

        const scheduleNext = () => {
            if (!this.isPolling) return;
            // Adaptive polling rates based on game lifecycle & tab visibility
            let baseInterval = 1000;
            if (typeof document !== 'undefined' && document.hidden) {
                baseInterval = 3000; // Sleep in background
            } else if (this.cachedState.status === "COUNTDOWN") {
                baseInterval = 600;  // Responsive start countdown
            } else if (this.cachedState.status === "LOBBY") {
                baseInterval = 1200; // Responsive lobby check
            } else if (this.cachedState.status === "STARTED") {
                baseInterval = 1000; // Responsive race & timer sync
            } else if (this.cachedState.status === "ENDED") {
                baseInterval = 2500; // Low frequency once ended
            }

            // Jitter to eliminate 300-player thundering herd synchronization
            const jitter = (Math.random() - 0.5) * 300;
            const delay = Math.max(350, Math.floor(baseInterval + jitter));
            pollTimer = setTimeout(pollRoom, delay);
        };

        pollRoom();
    }

    async vercelAction(action, payload = {}) {
        try {
            const body = { action, roomId: this.roomId, ...payload };
            if (this.hostToken) {
                body.hostToken = this.hostToken;
            }
            const headers = { "Content-Type": "application/json" };
            if (this.hostToken) {
                headers["x-host-token"] = this.hostToken;
            }
            const csrfToken = getCookieValue("acm_csrf_token");
            if (csrfToken) {
                headers["x-csrf-token"] = csrfToken;
            }

            const res = await fetch(`/api/room`, {
                method: "POST",
                headers,
                credentials: "same-origin",
                body: JSON.stringify(body)
            });
            let data = {};
            try {
                data = await res.json();
            } catch (err) {
                data = { success: false, error: "Non-JSON response from server" };
            }

            if (res.status === 401) {
                console.warn("Host administrative action rejected: Valid host session required.");
                if (typeof window !== 'undefined' && window.location && window.location.pathname.includes('host.html')) {
                    window.location.href = '/login';
                }
                return { success: false, error: data.error || "Unauthorized: Valid host session required", unauthorized: true };
            }

            if (data && data.room) {
                this.cachedState = Object.assign(this.cachedState, data.room);
                this.notifyListeners();
            }
            return data;
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    /* -----------------------------------------------------
       PROVIDER 2: FIREBASE FIRESTORE SYNC
       ----------------------------------------------------- */
    async initFirebase() {
        try {
            const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js");
            const { getFirestore, doc, onSnapshot } = 
                await import("https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js");

            const app = initializeApp(window.FIREBASE_CONFIG);
            this.db = getFirestore(app);

            const roomRef = doc(this.db, "acm_rooms", this.roomId);

            onSnapshot(roomRef, (snapshot) => {
                if (snapshot.exists()) {
                    const data = snapshot.data();
                    this.cachedState.status = data.status || "LOBBY";
                    this.cachedState.timeLimit = data.timeLimit || 120;
                    this.cachedState.startTime = data.startTime ? (data.startTime.toMillis ? data.startTime.toMillis() : data.startTime) : null;
                    this.cachedState.countdownStart = data.countdownStart || null;
                    this.cachedState.players = data.players || {};
                    this.notifyListeners();
                }
            });
        } catch (err) {
            console.warn("Firebase init failed, falling back to Local Sync:", err);
            this.provider = "LOCAL";
            this.initLocalSync();
        }
    }

    /* -----------------------------------------------------
       PROVIDER 3: LOCAL TAB SYNC
       ----------------------------------------------------- */
    initLocalSync() {
        try {
            this.bc = new BroadcastChannel(`acm_sync_${this.roomId}`);
            this.bc.onmessage = (e) => {
                if (e.data && e.data.type === "STATE_UPDATE" && e.data.state) {
                    this.cachedState = e.data.state;
                    this.notifyListeners();
                }
            };
        } catch (e) {}

        window.addEventListener("storage", (e) => {
            if (e.key === `acm_state_${this.roomId}` && e.newValue) {
                try {
                    this.cachedState = JSON.parse(e.newValue);
                    this.notifyListeners();
                } catch (err) {}
            }
        });

        try {
            const saved = localStorage.getItem(`acm_state_${this.roomId}`);
            if (saved) {
                this.cachedState = Object.assign(this.cachedState, JSON.parse(saved));
            } else {
                this.saveLocalState();
            }
        } catch (e) {}

        setInterval(() => {
            try {
                const saved = localStorage.getItem(`acm_state_${this.roomId}`);
                if (saved) {
                    const parsed = JSON.parse(saved);
                    if (JSON.stringify(parsed) !== JSON.stringify(this.cachedState)) {
                        this.cachedState = parsed;
                        this.notifyListeners();
                    }
                }
            } catch (e) {}
        }, 150);

        this.notifyListeners();
    }

    saveLocalState() {
        try {
            localStorage.setItem(`acm_state_${this.roomId}`, JSON.stringify(this.cachedState));
            localStorage.setItem(`acm_state_ts_${this.roomId}`, Date.now().toString());
            if (this.bc) {
                this.bc.postMessage({ type: "STATE_UPDATE", state: this.cachedState });
            }
        } catch (e) {}
        this.notifyListeners();
    }

    onUpdate(callback) {
        this.listeners.push(callback);
        try {
            callback(this.cachedState);
        } catch (e) {}
    }

    notifyListeners() {
        for (const cb of this.listeners) {
            try {
                cb(this.cachedState);
            } catch (e) {}
        }
    }

    // Check if nickname is unique (case-insensitive)
    isNameAvailable(name, existingPlayerId = null) {
        if (this.provider === "LOCAL") {
            try {
                const saved = localStorage.getItem(`acm_state_${this.roomId}`);
                if (saved) {
                    const parsed = JSON.parse(saved);
                    if (parsed.players) {
                        this.cachedState.players = Object.assign({}, this.cachedState.players, parsed.players);
                    }
                }
            } catch (e) {}
        }

        const clean = name.trim().toLowerCase();
        for (const pid in this.cachedState.players) {
            const p = this.cachedState.players[pid];
            // If it is the same player ID reconnecting, allow it
            if (existingPlayerId && (pid === existingPlayerId || p.id === existingPlayerId)) {
                continue;
            }
            if (p.name && p.name.trim().toLowerCase() === clean) {
                return false;
            }
        }
        return true;
    }

    joinLocalPlayer(trimmed, existingPlayerId = null) {
        const clean = trimmed.toLowerCase();
        for (const pid in this.cachedState.players) {
            const p = this.cachedState.players[pid];
            if ((existingPlayerId && (pid === existingPlayerId || p.id === existingPlayerId)) ||
                (p.name && p.name.trim().toLowerCase() === clean)) {
                p.name = trimmed;
                this.saveLocalState();
                return { success: true, playerId: p.id || pid, player: p };
            }
        }

        const playerId = existingPlayerId || ("p_" + Date.now() + "_" + Math.floor(Math.random() * 1000));
        const playerObj = {
            id: playerId,
            name: trimmed,
            joinedAt: Date.now(),
            finished: false,
            finishTimeSeconds: null,
            finishTimeFormatted: null
        };
        this.cachedState.players[playerId] = playerObj;
        this.saveLocalState();
        return { success: true, playerId, player: playerObj };
    }

    async joinPlayer(name, existingPlayerId = null) {
        // Ensure provider initialization has finished
        if (this.initPromise) {
            await this.initPromise;
        }

        const trimmed = name.trim();
        if (!trimmed) {
            return { success: false, error: "Please enter a valid nickname." };
        }

        if (this.provider === "VERCEL") {
            try {
                const res = await this.vercelAction("join", { name: trimmed, playerId: existingPlayerId });
                if (res && res.success) {
                    return res;
                }
                // If it returned a validation error (other than network), return it
                if (res && res.error && !res.error.includes("fetch") && !res.error.includes("Network")) {
                    return res;
                }
            } catch (err) {}
            // Transparently fallback to local sync on network failure
            console.warn("API join unreachable, falling back to local provider");
            this.provider = "LOCAL";
            this.initLocalSync();
            return this.joinLocalPlayer(trimmed, existingPlayerId);
        }

        if (this.provider === "FIREBASE" && this.db) {
            try {
                if (!this.isNameAvailable(trimmed, existingPlayerId)) {
                    for (const pid in this.cachedState.players) {
                        const p = this.cachedState.players[pid];
                        if (p.name && p.name.trim().toLowerCase() === trimmed.toLowerCase()) {
                            return { success: true, playerId: p.id || pid, player: p };
                        }
                    }
                }
                const playerId = existingPlayerId || ("p_" + Date.now() + "_" + Math.floor(Math.random() * 1000));
                const playerObj = {
                    id: playerId,
                    name: trimmed,
                    joinedAt: Date.now(),
                    finished: false,
                    finishTimeSeconds: null,
                    finishTimeFormatted: null
                };
                const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js");
                const roomRef = doc(this.db, "acm_rooms", this.roomId);
                await setDoc(roomRef, {
                    players: { [playerId]: playerObj }
                }, { merge: true });
                return { success: true, playerId, player: playerObj };
            } catch (e) {
                console.warn("Firebase join failed, falling back to local:", e);
                this.provider = "LOCAL";
                this.initLocalSync();
                return this.joinLocalPlayer(trimmed, existingPlayerId);
            }
        }

        // Local fallback
        return this.joinLocalPlayer(trimmed, existingPlayerId);
    }

    async markPlayerFinished(playerId, seconds, formatted) {
        if (this.initPromise) await this.initPromise;

        if (this.provider === "VERCEL") {
            return await this.vercelAction("finish", { playerId, seconds, formatted });
        }

        if (this.provider === "FIREBASE" && this.db) {
            try {
                const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js");
                const roomRef = doc(this.db, "acm_rooms", this.roomId);
                const updatedPlayer = {
                    ...this.cachedState.players[playerId],
                    finished: true,
                    finishTimeSeconds: seconds,
                    finishTimeFormatted: formatted
                };

                const updatePayload = {
                    players: {
                        [playerId]: updatedPlayer
                    }
                };

                // Check if all players finished
                const allPlayers = { ...this.cachedState.players, [playerId]: updatedPlayer };
                const pList = Object.values(allPlayers);
                if (this.cachedState.status === "STARTED" && pList.length > 0 && pList.every(p => p.finished)) {
                    updatePayload.status = "ENDED";
                }

                await setDoc(roomRef, updatePayload, { merge: true });
            } catch (e) {}
            return;
        }

        // Local fallback
        if (this.cachedState.players[playerId]) {
            this.cachedState.players[playerId].finished = true;
            this.cachedState.players[playerId].finishTimeSeconds = seconds;
            this.cachedState.players[playerId].finishTimeFormatted = formatted;

            // Check if all players have completed the game
            const pList = Object.values(this.cachedState.players);
            if (this.cachedState.status === "STARTED" && pList.length > 0 && pList.every(p => p.finished)) {
                this.cachedState.status = "ENDED";
            }

            this.saveLocalState();
        }
    }

    async setLobbyTimeLimit(timeLimitSeconds) {
        if (this.initPromise) await this.initPromise;
        const timeLimit = Math.max(10, parseInt(timeLimitSeconds) || 120);
        this.cachedState.timeLimit = timeLimit;

        if (this.provider === "VERCEL") {
            return await this.vercelAction("config", { timeLimit });
        }
        if (this.provider === "FIREBASE" && this.db) {
            try {
                const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js");
                const roomRef = doc(this.db, "acm_rooms", this.roomId);
                await setDoc(roomRef, { timeLimit }, { merge: true });
            } catch (e) {}
            return;
        }
        this.saveLocalState();
    }

    async startHostGame(timeLimitSeconds) {
        if (this.initPromise) await this.initPromise;
        const timeLimit = Math.max(10, parseInt(timeLimitSeconds) || 120);

        if (this.provider === "VERCEL") {
            // Trigger 3s countdown on server
            const res = await this.vercelAction("countdown", { timeLimit });
            if (res && res.unauthorized) {
                return res;
            }
            setTimeout(async () => {
                await this.vercelAction("start", { timeLimit });
            }, 3000);
            return res;
        }

        if (this.provider === "FIREBASE" && this.db) {
            try {
                const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js");
                const roomRef = doc(this.db, "acm_rooms", this.roomId);
                const now = Date.now();

                // Reset finisher stats in cached players
                if (this.cachedState.players) {
                    Object.values(this.cachedState.players).forEach(p => {
                        p.finished = false;
                        p.finishTimeSeconds = null;
                        p.finishTimeFormatted = null;
                    });
                }

                await setDoc(roomRef, {
                    status: "COUNTDOWN",
                    timeLimit: timeLimit,
                    countdownStart: now,
                    startTime: now + 3000,
                    players: this.cachedState.players || {}
                }, { merge: true });

                setTimeout(async () => {
                    const { serverTimestamp } = await import("https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js");
                    await setDoc(roomRef, {
                        status: "STARTED",
                        startTime: serverTimestamp()
                    }, { merge: true });
                }, 3000);
            } catch (e) {}
            return;
        }

        // Local fallback
        this.cachedState.status = "COUNTDOWN";
        this.cachedState.timeLimit = timeLimit;
        this.cachedState.countdownStart = Date.now();
        if (this.cachedState.players) {
            Object.values(this.cachedState.players).forEach(p => {
                p.finished = false;
                p.finishTimeSeconds = null;
                p.finishTimeFormatted = null;
            });
        }
        this.saveLocalState();

        setTimeout(() => {
            if (this.cachedState.status === "COUNTDOWN") {
                this.cachedState.status = "STARTED";
                this.cachedState.startTime = Date.now();
                this.saveLocalState();
            }
        }, 3500);
    }

    async endHostGame() {
        if (this.initPromise) await this.initPromise;
        if (this.provider === "VERCEL") {
            return await this.vercelAction("end");
        }
        if (this.provider === "FIREBASE" && this.db) {
            try {
                const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js");
                const roomRef = doc(this.db, "acm_rooms", this.roomId);
                await setDoc(roomRef, { status: "ENDED" }, { merge: true });
            } catch (e) {}
            return;
        }
        this.cachedState.status = "ENDED";
        this.saveLocalState();
    }

    async resetRoom() {
        if (this.initPromise) await this.initPromise;
        if (this.provider === "VERCEL") {
            return await this.vercelAction("reset");
        }
        if (this.provider === "FIREBASE" && this.db) {
            try {
                const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js");
                const roomRef = doc(this.db, "acm_rooms", this.roomId);
                await setDoc(roomRef, {
                    status: "LOBBY",
                    startTime: null,
                    countdownStart: null,
                    players: {}
                });
            } catch (e) {}
            return;
        }
        this.cachedState = {
            status: "LOBBY",
            timeLimit: 120,
            startTime: null,
            countdownStart: null,
            players: {}
        };
        this.saveLocalState();
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = GameSync;
}
