const http = require('http');
const https = require('https');

const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");
const PORT = process.env.PORT || 8080;

const STRIP_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding",
  "upgrade", "forwarded", "x-forwarded-host", "x-forwarded-proto",
  "x-forwarded-port",
]);

const server = http.createServer((req, res) => {
  if (!TARGET_BASE) {
    if (!res.headersSent) res.writeHead(500);
    return res.end();
  }

  try {
    const targetUrl = new URL(req.url, TARGET_BASE);
    const options = {
      method: req.method,
      headers: {},
    };

    let clientIp = null;

    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      const v = req.rawHeaders[i + 1];
      const lowerK = k.toLowerCase();

      if (STRIP_HEADERS.has(lowerK)) continue;

      if (lowerK === "x-real-ip") {
        clientIp = v;
        continue;
      }
      if (lowerK === "x-forwarded-for") {
        if (!clientIp) clientIp = v;
        continue;
      }
      options.headers[k] = v;
    }

    if (clientIp) options.headers["x-forwarded-for"] = clientIp;

    const protocol = targetUrl.protocol === 'http:' ? http : https;

    const proxyReq = protocol.request(targetUrl, options, (proxyRes) => {
      const resHeaders = { ...proxyRes.headers };
      
      delete resHeaders['transfer-encoding'];
      delete resHeaders['connection'];

      if (!res.headersSent) {
        res.writeHead(proxyRes.statusCode, resHeaders);
      }
      
      proxyRes.pipe(res);

      proxyRes.on('error', () => {
        if (!res.destroyed) res.destroy();
      });
    });

    proxyReq.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end();
      } else if (!res.destroyed) {
        res.destroy(); 
      }
    });

    proxyReq.setTimeout(60000, () => {
      if (!proxyReq.destroyed) proxyReq.destroy();
    });

    const safeMemoryCleanup = () => {
      if (!proxyReq.destroyed) proxyReq.destroy();
    };

    req.on('aborted', safeMemoryCleanup);
    req.on('error', safeMemoryCleanup);
    
    res.on('close', safeMemoryCleanup);
    res.on('error', safeMemoryCleanup);

    req.pipe(proxyReq);

  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    } else if (!res.destroyed) {
      res.destroy();
    }
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

server.listen(PORT, '0.0.0.0');
