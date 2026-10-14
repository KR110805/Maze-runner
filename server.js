const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const roomHandler = require('./api/room.js');

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
    // Enable CORS with ETag and delta support
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, If-None-Match');
    res.setHeader('Access-Control-Expose-Headers', 'ETag');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        return res.end();
    }

    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = reqUrl.pathname;

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
