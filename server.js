const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const roomHandler = require('./api/room.js');
const {
    createSessionToken,
    verifySessionToken,
    parseCookies,
    safeCompare
} = roomHandler;

if (process.env.NODE_ENV === 'production') {
    if (!process.env.HOST_SECRET || process.env.HOST_SECRET === 'acm-host-secret-2026') {
        console.error("CRITICAL SECURITY ERROR: Server startup aborted. A strong custom HOST_SECRET environment variable is mandatory in production.");
        process.exit(1);
    }
}

// In-memory rate limiting for login attempts to prevent brute force
const loginAttempts = new Map();

function checkLoginRateLimit(ip) {
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (!entry) return true;
    if (entry.lockUntil && now < entry.lockUntil) {
        return false;
    }
    if (entry.resetTime && now > entry.resetTime) {
        loginAttempts.delete(ip);
        return true;
    }
    return entry.count < 5;
}

function recordLoginFailure(ip) {
    const now = Date.now();
    const entry = loginAttempts.get(ip) || { count: 0, resetTime: now + 5 * 60 * 1000 };
    entry.count++;
    if (entry.count >= 5) {
        entry.lockUntil = now + 5 * 60 * 1000; // 5-minute lockout
    }
    loginAttempts.set(ip, entry);
}

function recordLoginSuccess(ip) {
    loginAttempts.delete(ip);
}

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

const server = http.createServer(async (req, res) => {
    // Enable CORS with ETag, delta, and CSRF support
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, If-None-Match, x-host-token, Authorization, x-csrf-token');
    res.setHeader('Access-Control-Expose-Headers', 'ETag');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        return res.end();
    }

    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = reqUrl.pathname;

    // Handle favicon to prevent 404 console errors
    if (pathname === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
    }

    // Provide network information so host screen can auto-bind QR to Wi-Fi IP
    if (pathname === '/api/info') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, ip: getLocalIp(), port: PORT }));
    }

    // Handle /logout endpoint to invalidate host session
    if (pathname === '/logout') {
        res.setHeader('Set-Cookie', [
            'acm_host_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
            'acm_csrf_token=; SameSite=Strict; Path=/; Max-Age=0'
        ]);
        res.writeHead(302, { 'Location': '/login' });
        return res.end();
    }

    // Handle /login endpoint
    if (pathname === '/login') {
        const isProd = process.env.NODE_ENV === 'production';
        const configuredSecret = process.env.HOST_SECRET || (!isProd ? 'acm-host-secret-2026' : null);

        if (req.method === 'GET') {
            const cookies = parseCookies(req);
            const session = cookies['acm_host_session'] && configuredSecret
                ? verifySessionToken(cookies['acm_host_session'], configuredSecret)
                : null;
            if (session) {
                res.writeHead(302, { 'Location': '/host.html' });
                return res.end();
            }
            const loginPath = path.join(ROOT_DIR, 'login.html');
            fs.readFile(loginPath, 'utf8', (err, content) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    return res.end('Login page unavailable');
                }
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(content);
            });
            return;
        }

        if (req.method === 'POST') {
            let bodyData = '';
            req.on('data', chunk => { bodyData += chunk; });
            req.on('end', () => {
                const clientIp = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '127.0.0.1').split(',')[0].trim();
                if (!checkLoginRateLimit(clientIp)) {
                    res.writeHead(302, { 'Location': '/login?error=locked' });
                    return res.end();
                }

                const contentType = req.headers['content-type'] || '';
                let submittedPassword = '';
                if (contentType.includes('application/json')) {
                    try {
                        const parsed = JSON.parse(bodyData);
                        submittedPassword = parsed.password || parsed.hostToken || '';
                    } catch (e) {}
                } else {
                    const params = new URLSearchParams(bodyData);
                    submittedPassword = params.get('password') || params.get('hostToken') || '';
                }

                if (!configuredSecret || !safeCompare(submittedPassword, configuredSecret)) {
                    recordLoginFailure(clientIp);
                    if (contentType.includes('application/json')) {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: 'Invalid Host Secret' }));
                    }
                    res.writeHead(302, { 'Location': '/login?error=1' });
                    return res.end();
                }

                recordLoginSuccess(clientIp);
                const session = createSessionToken(configuredSecret);
                const isSecure = isProd || req.headers['x-forwarded-proto'] === 'https';
                const cookieFlags = `${isSecure ? 'Secure; ' : ''}SameSite=Strict; Path=/; Max-Age=86400`;

                res.setHeader('Set-Cookie', [
                    `acm_host_session=${session.sessionToken}; HttpOnly; ${cookieFlags}`,
                    `acm_csrf_token=${session.csrfToken}; ${cookieFlags}`
                ]);

                if (contentType.includes('application/json')) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: true, csrfToken: session.csrfToken }));
                }

                res.writeHead(302, { 'Location': '/host.html' });
                return res.end();
            });
            return;
        }
    }

    // Host dashboard protection: redirect unauthenticated requests to /login in production
    if (pathname === '/' || pathname === '/host.html') {
        const isProd = process.env.NODE_ENV === 'production';
        const configuredSecret = process.env.HOST_SECRET || (!isProd ? 'acm-host-secret-2026' : null);
        const cookies = parseCookies(req);
        const session = cookies['acm_host_session'] && configuredSecret
            ? verifySessionToken(cookies['acm_host_session'], configuredSecret)
            : null;

        if (!session) {
            if (isProd) {
                res.writeHead(302, { 'Location': '/login' });
                return res.end();
            } else {
                // In development / testing, auto-issue dev session for seamless workflow
                const devSession = createSessionToken(configuredSecret || 'acm-host-secret-2026');
                res.setHeader('Set-Cookie', [
                    `acm_host_session=${devSession.sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
                    `acm_csrf_token=${devSession.csrfToken}; SameSite=Strict; Path=/; Max-Age=86400`
                ]);
            }
        }
    }

    // Handle /api/room endpoint
    if (pathname === '/api/room') {
        req.query = Object.fromEntries(reqUrl.searchParams.entries());

        let bodyData = '';
        req.on('data', chunk => { bodyData += chunk; });
        req.on('end', async () => {
            if (bodyData) {
                try {
                    req.body = JSON.parse(bodyData);
                } catch (e) {
                    req.body = {};
                }
            } else {
                req.body = {};
            }

            // Decorate res with Express-like helpers for Vercel handler
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
                console.error("API error:", err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        });
        return;
    }

    // Serve static files
    let filePath = pathname === '/' ? '/host.html' : pathname;
    const safePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(ROOT_DIR, safePath);

    fs.stat(fullPath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('404 Not Found');
        }

        const ext = path.extname(fullPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-cache'
        });

        const stream = fs.createReadStream(fullPath);
        stream.pipe(res);
    });
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(PORT, '0.0.0.0', () => {
    const localIp = getLocalIp();
    console.log(`\n======================================================`);
    console.log(`🎮 ACM Maze Quest (3D v2) Local Server Active`);
    console.log(`======================================================`);
    console.log(`🖥️  Host / Projector Screen : http://localhost:${PORT}/host.html`);
    console.log(`📱 Player Client (Desktop)  : http://localhost:${PORT}/index.html`);
    console.log(`📶 Phone on Wi-Fi           : http://${localIp}:${PORT}/index.html`);
    console.log(`======================================================\n`);
});
