const express = require('express');
const app = express();

// دقیقاً همون متغیر محیطی که خودت داشتی
const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");

const STRIP_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding",
  "upgrade", "forwarded", "x-forwarded-host", "x-forwarded-proto",
  "x-forwarded-port",
]);

// ما بادیِ ریکوئست رو پردازش نمی‌کنیم تا به صورت "استریمِ خام" برای XHTTP بمونه
app.use((req, res, next) => {
  next();
});

app.all('*', async (req, res) => {
  if (!TARGET_BASE) {
    return res.status(500).send("Misconfigured: TARGET_DOMAIN is not set");
  }

  try {
    // بازسازی دقیق مسیر (path)
    const targetUrl = TARGET_BASE + req.originalUrl;

    const out = new Headers();
    let clientIp = null;

    for (const [k, v] of Object.entries(req.headers)) {
      const lowerK = k.toLowerCase();
      if (STRIP_HEADERS.has(lowerK)) continue;
      if (lowerK.startsWith("x-vercel-")) continue;
      
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

    // تنظیمات دقیقِ Fetch بر اساس کد خودت
    const fetchOptions = {
      method,
      headers: out,
      duplex: "half", // حیاتی‌ترین بخش برای XHTTP
      redirect: "manual",
    };

    if (hasBody) {
      fetchOptions.body = req; // ارسال مستقیم استریم کلاینت به سرور آلمان
    }

    const targetResponse = await fetch(targetUrl, fetchOptions);

    // تنظیم هدرهای بازگشتی به کلاینت
    res.status(targetResponse.status);
    targetResponse.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    // استریم کردنِ پاسخ سرور آلمان به سمت کلاینت تو (بدون قطع شدن)
    if (targetResponse.body) {
      for await (const chunk of targetResponse.body) {
        res.write(chunk);
      }
      res.end();
    } else {
      res.end();
    }

  } catch (err) {
    console.error("relay error:", err);
    return res.status(502).send("Bad Gateway: Tunnel Failed");
  }
});

// این همون بخشیه که به گوگل اجازه می‌ده پورت رو داینامیک تنظیم کنه
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`XHTTP Proxy is actively listening on Port ${PORT}`);
});
