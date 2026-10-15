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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, If-None-Match, x-host-token, Authorization, x-csrf-token, x-requested-with, x-event-mode, x-acm-event-control');
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

    // Handle /logout: In event mode, redirect cleanly to /host.html while clearing any legacy cookies
    if (pathname === '/logout') {
        res.setHeader('Set-Cookie', [
            'acm_host_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
            'acm_csrf_token=; SameSite=Strict; Path=/; Max-Age=0'
        ]);
        res.writeHead(302, { 'Location': '/host.html' });
        return res.end();
    }

    // Handle /login: In event mode, login is removed; redirect directly to /host.html
    if (pathname === '/login') {
        res.writeHead(302, { 'Location': '/host.html' });
        return res.end();
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
