// stream. — local IPTV proxy
// Run: node proxy.js
// Requires Node.js 18+ (uses built-in fetch)

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = 3001;
const TIMEOUT = 60000; // 60s for large playlists

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Fetch a URL following redirects, return { finalUrl, statusCode, body }
function fetchWithRedirects(targetUrl, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) { reject(new Error('Too many redirects')); return; }
    const parsed = new URL(targetUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: TIMEOUT,
      rejectUnauthorized: false,
    }, (upstream) => {
      if ([301, 302, 307, 308].includes(upstream.statusCode) && upstream.headers.location) {
        upstream.resume();
        const next = new URL(upstream.headers.location, targetUrl).toString();
        fetchWithRedirects(next, depth + 1).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      upstream.on('data', c => chunks.push(c));
      upstream.on('end', () => resolve({ finalUrl: targetUrl, statusCode: upstream.statusCode, body: Buffer.concat(chunks).toString() }));
      upstream.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function makeRequest(targetUrl, res, depth = 0) {
  if (depth > 5) {
    res.writeHead(502, CORS_HEADERS);
    res.end('Too many redirects');
    return;
  }

  const parsed = new URL(targetUrl);
  const lib = parsed.protocol === 'https:' ? https : http;

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: TIMEOUT,
    rejectUnauthorized: false,
  };

  const req = lib.request(options, (upstream) => {
    if ([301, 302, 307, 308].includes(upstream.statusCode) && upstream.headers.location) {
      upstream.resume();
      const next = new URL(upstream.headers.location, targetUrl).toString();
      makeRequest(next, res, depth + 1);
      return;
    }
    const ct = upstream.headers['content-type'] || 'application/octet-stream';
    // Normalise non-standard status codes (e.g. 884 from some IPTV providers)
    const statusCode = (upstream.statusCode >= 100 && upstream.statusCode <= 599)
      ? upstream.statusCode : 200;
    res.writeHead(statusCode, { ...CORS_HEADERS, 'Content-Type': ct });
    upstream.pipe(res);
  });

  req.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, CORS_HEADERS);
      res.end('Proxy error: ' + err.message);
    }
  });

  req.on('timeout', () => {
    req.destroy();
    if (!res.headersSent) {
      res.writeHead(504, CORS_HEADERS);
      res.end('Timeout');
    }
  });

  req.end();
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);

  // Serve the player UI at /
  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'iptv-player.html');
    fs.readFile(htmlPath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('iptv-player.html not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  if (parsed.pathname === '/health') {
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, port: PORT }));
    return;
  }

  const CACHE_FILE = path.join(__dirname, 'channel-cache.json');

  // GET /cache — return cached channel list
  if (req.method === 'GET' && parsed.pathname === '/cache') {
    fs.readFile(CACHE_FILE, (err, data) => {
      if (err) {
        res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No cache found' }));
        return;
      }
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(data);
    });
    return;
  }

  // POST /cache — save channel list to disk
  if (req.method === 'POST' && parsed.pathname === '/cache') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      fs.writeFile(CACHE_FILE, body, (err) => {
        if (err) {
          res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    return;
  }

  // GET /hls?url=... — fetch HLS manifest, rewrite segment URLs through this proxy
  if (req.method === 'GET' && parsed.pathname === '/hls') {
    let target = parsed.query.url;
    if (!target) { res.writeHead(400, CORS_HEADERS); res.end('Missing ?url='); return; }
    // Auto-fix old-style .ts stream URLs → /live/…/id.m3u8
    if (target.endsWith('.ts') && !target.includes('/live/') && !target.includes('/hls/')) {
      target = target.replace(/\/([^/]+)\/([^/]+)\/(\d+)\.ts$/, '/live/$1/$2/$3.m3u8');
    }
    fetchWithRedirects(target).then(({ finalUrl, body }) => {
      const rewritten = body.split('\n').map(line => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return line;
        const abs = new URL(t, finalUrl).toString();
        return `http://localhost:${PORT}/proxy?url=${encodeURIComponent(abs)}`;
      }).join('\n');
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/x-mpegURL' });
      res.end(rewritten);
    }).catch(err => {
      if (!res.headersSent) { res.writeHead(502, CORS_HEADERS); res.end(err.message); }
    });
    return;
  }

  if (parsed.pathname === '/proxy') {
    const target = parsed.query.url;
    if (!target) {
      res.writeHead(400, CORS_HEADERS);
      res.end('Missing ?url= parameter');
      return;
    }
    try {
      new URL(target);
    } catch {
      res.writeHead(400, CORS_HEADERS);
      res.end('Invalid URL');
      return;
    }
    makeRequest(target, res);
    return;
  }

  res.writeHead(404, CORS_HEADERS);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  stream. proxy running');
  console.log('  ➜  http://localhost:' + PORT);
  console.log('  Press Ctrl+C to stop');
  console.log('');
});
