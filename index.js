const http = require('node:http');
const { PassThrough, Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// =====================DOMAIN=====================
const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");

function parseNonNegativeInt(rawValue, fallbackValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return fallbackValue;
  if (value < 0) return fallbackValue;
  return Math.trunc(value);
}

const MAX_UP_BPS = parseNonNegativeInt(process.env.MAX_UP_BPS, 0); 
const MAX_DOWN_BPS = parseNonNegativeInt(process.env.MAX_DOWN_BPS, 0);

// =================LIMIT=========================
function createGlobalLimiter(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;

  const burstCap = Math.max(bytesPerSecond, 262144);
  let tokens = burstCap;
  let lastRefill = Date.now();
  const queue = [];
  let timer = null;

  function refill() {
    const now = Date.now();
    const elapsedMs = now - lastRefill;
    if (elapsedMs <= 0) return;
    const refillAmount = (elapsedMs * bytesPerSecond) / 1000;
    tokens = Math.min(burstCap, tokens + refillAmount);
    lastRefill = now;
  }

  function tryDrain() {
    refill();
    while (queue.length > 0 && tokens >= 1) {
      const item = queue[0];
      const grant = Math.min(item.maxBytes, Math.max(1, Math.floor(tokens)));
      if (grant < 1) break;
      tokens -= grant;
      queue.shift();
      item.resolve(grant);
    }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      tryDrain();
      if (queue.length > 0) schedule();
    }, 10); 
  }

  return {
    acquire(maxBytes) {
      const requested = Math.max(1, Math.trunc(maxBytes || 1));
      return new Promise((resolve) => {
        queue.push({ maxBytes: requested, resolve });
        tryDrain();
        if (queue.length > 0) schedule();
      });
    },
  };
}

function createThrottleTransform(limiter) {
  if (!limiter) return new PassThrough();

  return new Transform({
    transform(chunk, _encoding, callback) {
      if (!chunk || chunk.length === 0) {
        callback();
        return;
      }

      (async () => {
        let offset = 0;
        while (offset < chunk.length) {
          const maxBytes = chunk.length - offset;
          const grant = await limiter.acquire(maxBytes);
          const piece = chunk.subarray(offset, offset + grant);
          offset += grant;
          this.push(piece);
        }
      })()
        .then(() => callback())
        .catch((err) => callback(err));
    },
  });
}

const GLOBAL_UPLOAD_LIMITER = createGlobalLimiter(MAX_UP_BPS);
const GLOBAL_DOWNLOAD_LIMITER = createGlobalLimiter(MAX_DOWN_BPS);

// ===================HEADERS=======================
const STRIP_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding",
  "upgrade", "forwarded", "x-forwarded-host", "x-forwarded-proto",
  "x-forwarded-port",
]);

// ===================SERVER (Raw Node.js)=======================
const server = http.createServer(async (req, res) => {
  if (!TARGET_BASE) {
    res.statusCode = 500;
    return res.end();
  }

  const controller = new AbortController();
  
  req.on('close', () => {
    controller.abort();
  });

  try {
    const targetUrl = TARGET_BASE + req.url;
    const out = new Headers();
    let clientIp = null;

    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      const v = req.rawHeaders[i + 1];
      const lowerK = k.toLowerCase();
      
      if (STRIP_HEADERS.has(lowerK) || lowerK.startsWith("x-vercel-")) continue;
      
      if (lowerK === "x-real-ip") {
        clientIp = v;
        continue;
      }
      if (lowerK === "x-forwarded-for") {
        if (!clientIp) clientIp = v;
        continue;
      }
      out.set(k, v);
    }
    
    if (clientIp) out.set("x-forwarded-for", clientIp);

    const method = req.method;
    const hasBody = method !== "GET" && method !== "HEAD";

    const fetchOptions = {
      method,
      headers: out,
      duplex: "half", 
      redirect: "manual",
      signal: controller.signal 
    };

    if (hasBody) {
      const uploadNodeStream = GLOBAL_UPLOAD_LIMITER
        ? req.pipe(createThrottleTransform(GLOBAL_UPLOAD_LIMITER))
        : req;
      fetchOptions.body = Readable.toWeb(uploadNodeStream); 
    }

    const targetResponse = await fetch(targetUrl, fetchOptions);

    res.statusCode = targetResponse.status;
    targetResponse.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (lowerKey !== 'transfer-encoding' && lowerKey !== 'connection') {
        res.setHeader(key, value);
      }
    });

    if (targetResponse.body) {
      const upstreamNode = Readable.fromWeb(targetResponse.body);
      const downloadStream = GLOBAL_DOWNLOAD_LIMITER
        ? upstreamNode.pipe(createThrottleTransform(GLOBAL_DOWNLOAD_LIMITER))
        : upstreamNode;

      await pipeline(downloadStream, res);
    } else {
      res.end();
    }

  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 502;
      return res.end(); 
    }
    res.destroy(); 
  }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT);

// ===================MAGIC======================
server.keepAliveTimeout = 60000;
server.headersTimeout = 65000;
server.timeout = 60000;
