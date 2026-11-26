const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const APP_ENV = process.env.APP_ENV || "development";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "..", "data", "targets.json");

const DEFAULT_TARGETS = [
  {
    id: "github-api",
    name: "GitHub API",
    url: "https://api.github.com",
    note: "Kod ve API erişimi",
    expectedStatus: "2xx",
    history: []
  },
  {
    id: "example-web",
    name: "Example Web",
    url: "https://example.com",
    note: "Temel HTTPS kontrolü",
    expectedStatus: "2xx",
    history: []
  },
  {
    id: "httpbin-200",
    name: "HTTPBin 200",
    url: "https://httpbin.org/status/200",
    note: "200 durum testi",
    expectedStatus: "200",
    history: []
  }
];

function ensureTargetsFile(filePath = DATA_FILE) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(DEFAULT_TARGETS, null, 2), "utf8");
  }
}

function normalizeExpectedStatus(raw) {
  const val = String(raw || "2xx").trim().toLowerCase();
  if (["2xx", "3xx", "200", "201", "204", "301", "302", "404"].includes(val)) {
    return val;
  }
  return "2xx";
}

function isStatusExpected(httpCode, expectedStatus) {
  if (!httpCode) return false;
  const rule = normalizeExpectedStatus(expectedStatus);
  if (rule === "2xx") return httpCode >= 200 && httpCode < 300;
  if (rule === "3xx") return httpCode >= 300 && httpCode < 400;
  return String(httpCode) === rule;
}

function normalizeTargetItem(raw, idx = 0) {
  return {
    id: String(raw.id || `target-${idx + 1}`),
    name: String(raw.name || `Hedef ${idx + 1}`).trim(),
    url: String(raw.url || "").trim(),
    note: String(raw.note || "Özel hedef").trim() || "Özel hedef",
    expectedStatus: normalizeExpectedStatus(raw.expectedStatus),
    history: Array.isArray(raw.history) ? raw.history.slice(-5) : []
  };
}

function loadTargets(filePath = DATA_FILE) {
  ensureTargetsFile(filePath);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((item, i) => normalizeTargetItem(item, i));
    }
  } catch {
    // Bozuk dosyada varsayılana dön
  }
  saveTargets(DEFAULT_TARGETS, filePath);
  return DEFAULT_TARGETS.map((item, i) => normalizeTargetItem(item, i));
}

function saveTargets(targets, filePath = DATA_FILE) {
  ensureTargetsFile(filePath);
  const cleaned = targets.map((t, i) => normalizeTargetItem(t, i));
  fs.writeFileSync(filePath, JSON.stringify(cleaned, null, 2), "utf8");
}

function normalizeUrl(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function appendHistory(target, entry) {
  const prev = Array.isArray(target.history) ? target.history : [];
  return [...prev, entry].slice(-5);
}

function checkTarget(target, timeoutMs = 4500) {
  const normalized = normalizeTargetItem(target);
  return new Promise((resolve) => {
    const start = Date.now();
    const checkedAt = new Date().toLocaleTimeString("tr-TR");

    let targetUrl;
    try {
      targetUrl = new URL(normalized.url);
    } catch {
      const latencyMs = Date.now() - start;
      const history = appendHistory(normalized, {
        status: "DOWN",
        httpCode: null,
        latencyMs,
        checkedAt
      });
      return resolve({
        ...normalized,
        status: "DOWN",
        httpCode: null,
        latencyMs,
        detail: `Geçersiz URL (Beklenen: ${normalized.expectedStatus})`,
        checkedAt,
        history
      });
    }

    const client = targetUrl.protocol === "https:" ? https : http;
    const req = client.request(
      targetUrl,
      { method: "GET", timeout: timeoutMs, headers: { "User-Agent": "ServiceControlPanel/2.1" } },
      (res) => {
        res.resume();
        const latencyMs = Date.now() - start;
        const code = res.statusCode || 0;
        const matches = isStatusExpected(code, normalized.expectedStatus);
        const status = matches ? "UP" : "DEGRADED";
        const history = appendHistory(normalized, {
          status,
          httpCode: code,
          latencyMs,
          checkedAt
        });
        resolve({
          ...normalized,
          status,
          httpCode: code,
          latencyMs,
          detail: `HTTP ${code} · ${latencyMs} ms (Beklenen: ${normalized.expectedStatus})`,
          checkedAt,
          history
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      const latencyMs = Date.now() - start;
      const history = appendHistory(normalized, {
        status: "DOWN",
        httpCode: null,
        latencyMs,
        checkedAt
      });
      resolve({
        ...normalized,
        status: "DOWN",
        httpCode: null,
        latencyMs,
        detail: "Zaman aşımı",
        checkedAt,
        history
      });
    });

    req.on("error", (err) => {
      const latencyMs = Date.now() - start;
      const history = appendHistory(normalized, {
        status: "DOWN",
        httpCode: null,
        latencyMs,
        checkedAt
      });
      resolve({
        ...normalized,
        status: "DOWN",
        httpCode: null,
        latencyMs,
        detail: err.code || err.message || "Bağlantı hatası",
        checkedAt,
        history
      });
    });

    req.end();
  });
}

async function runAllChecks(targets, filePath = null) {
  const results = await Promise.all(targets.map((t) => checkTarget(t)));
  if (filePath) {
    saveTargets(results, filePath);
  }
  const upCount = results.filter((r) => r.status === "UP").length;
  const avgMs =
    results.length > 0
      ? Math.round(results.reduce((sum, r) => sum + r.latencyMs, 0) / results.length)
      : 0;

  return {
    env: APP_ENV,
    upCount,
    totalCount: results.length,
    avgMs,
    results
  };
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderHistoryRow(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return `<div class="hist-empty">Henüz geçmiş kayıt yok</div>`;
  }
  const pills = history
    .map((h) => {
      const cls = h.status === "UP" ? "pill-up" : h.status === "DEGRADED" ? "pill-deg" : "pill-down";
      const codeLabel = h.httpCode ? `HTTP ${h.httpCode}` : h.status;
      return `<span class="pill ${cls}" title="${escapeHtml(h.checkedAt)}">${escapeHtml(codeLabel)} · ${h.latencyMs}ms</span>`;
    })
    .join("");
  return `<div class="hist-row">${pills}</div>`;
}

function renderDashboard(report) {
  const badgeColors = {
    UP: "background:#14532d;color:#86efac;border:1px solid #22c55e;",
    DEGRADED: "background:#713f12;color:#fde047;border:1px solid #eab308;",
    DOWN: "background:#7f1d1d;color:#fca5a5;border:1px solid #ef4444;"
  };

  const cardsHtml = report.results
    .map(
      (item) => `
      <div class="card" data-id="${escapeHtml(item.id)}">
        <div class="card-top">
          <div>
            <div class="title">${escapeHtml(item.name)}</div>
            <div class="url">${escapeHtml(item.url)}</div>
          </div>
          <span class="badge" style="${badgeColors[item.status] || badgeColors.DOWN}">${item.status}</span>
        </div>
        <div class="detail">${escapeHtml(item.detail)}</div>
        ${renderHistoryRow(item.history)}
        <div class="footer-meta">
          <span>${escapeHtml(item.note || "Hedef")}</span>
          <span>${escapeHtml(item.checkedAt)}</span>
        </div>
        <div class="card-actions">
          <button class="btn-sm btn-ghost" onclick="checkOne('${escapeHtml(item.id)}')">Şimdi Test Et</button>
          <button class="btn-sm btn-danger" onclick="deleteTarget('${escapeHtml(item.id)}')">Sil</button>
        </div>
      </div>
    `
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Servis Kontrol Paneli</title>
  <style>
    * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
    body { margin: 0; background: #0b1120; color: #f1f5f9; padding: 28px 16px; }
    .wrap { max-width: 980px; margin: 0 auto; }
    .top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 18px; }
    h1 { margin: 0; font-size: 22px; }
    .sub { color: #94a3b8; font-size: 13px; margin-top: 4px; }
    .btns { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    button, a.link-btn, select { background: #2563eb; color: #fff; border: 0; padding: 9px 13px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; text-decoration: none; }
    button:hover, a.link-btn:hover { background: #1d4ed8; }
    a.link-btn.sec, button.btn-ghost, select { background: #1e293b; border: 1px solid #334155; color: #e2e8f0; }
    button.btn-ghost:hover { background: #334155; }
    button.btn-danger { background: #7f1d1d; border: 1px solid #991b1b; color: #fecaca; }
    button.btn-danger:hover { background: #991b1b; }
    .btn-sm { padding: 6px 10px; font-size: 12px; border-radius: 6px; }
    .form-bar { display: grid; grid-template-columns: 1fr 1.8fr 0.9fr 1.1fr auto; gap: 8px; background: #111827; border: 1px solid #1f2937; padding: 12px; border-radius: 12px; margin-bottom: 18px; }
    input { background: #0b1120; color: #f8fafc; border: 1px solid #334155; border-radius: 8px; padding: 9px 11px; font-size: 13px; }
    input:focus, select:focus { outline: none; border-color: #3b82f6; }
    .msg { min-height: 18px; font-size: 12px; color: #f87171; margin-bottom: 10px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 18px; }
    .stat { background: #111827; border: 1px solid #1f2937; border-radius: 10px; padding: 14px; }
    .stat-k { color: #94a3b8; font-size: 12px; }
    .stat-v { font-size: 20px; font-weight: 700; margin-top: 4px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 16px; display: flex; flex-direction: column; justify-content: space-between; gap: 10px; }
    .card-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
    .title { font-weight: 700; font-size: 15px; }
    .url { color: #94a3b8; font-size: 12px; word-break: break-all; margin-top: 2px; }
    .badge { padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; }
    .detail { font-size: 13px; color: #e2e8f0; }
    .hist-row { display: flex; flex-wrap: wrap; gap: 5px; }
    .pill { font-size: 11px; padding: 2px 7px; border-radius: 6px; font-weight: 600; }
    .pill-up { background: rgba(20, 83, 45, 0.55); color: #86efac; }
    .pill-deg { background: rgba(113, 63, 18, 0.55); color: #fde047; }
    .pill-down { background: rgba(127, 29, 29, 0.55); color: #fca5a5; }
    .hist-empty { font-size: 11px; color: #64748b; }
    .footer-meta { display: flex; justify-content: space-between; font-size: 11px; color: #64748b; border-top: 1px solid #1e293b; padding-top: 8px; }
    .card-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
    @media (max-width: 820px) { .form-bar { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1>Servis Kontrol Paneli</h1>
        <div class="sub">Ortam: <strong>${escapeHtml(report.env)}</strong> · Beklenen durum kodu, geçmiş kayıtlar ve otomatik tarama</div>
      </div>
      <div class="btns">
        <select id="autoInterval" title="Otomatik tarama aralığı" onchange="setAutoInterval(this.value)">
          <option value="0">Oto: Kapalı</option>
          <option value="30000">Oto: 30 sn</option>
          <option value="60000">Oto: 60 sn</option>
        </select>
        <button onclick="runAllNow()">Tümünü Kontrol Et</button>
        <a class="link-btn sec" href="/health" target="_blank">/health</a>
        <a class="link-btn sec" href="/api/checks" target="_blank">JSON</a>
      </div>
    </div>

    <form class="form-bar" onsubmit="addTarget(event)">
      <input id="tName" type="text" placeholder="Hedef adı (örn. Ana Site)" required />
      <input id="tUrl" type="text" placeholder="URL (örn. https://www.atauni.edu.tr)" required />
      <select id="tExpected">
        <option value="2xx" selected>Beklenen: 2xx</option>
        <option value="200">Beklenen: 200</option>
        <option value="3xx">Beklenen: 3xx</option>
        <option value="404">Beklenen: 404</option>
      </select>
      <input id="tNote" type="text" placeholder="Not (opsiyonel)" />
      <button type="submit">Ekle ve Test Et</button>
    </form>
    <div id="msg" class="msg"></div>

    <div class="stats">
      <div class="stat">
        <div class="stat-k">Erişilebilir Hedef</div>
        <div class="stat-v">${report.upCount} / ${report.totalCount}</div>
      </div>
      <div class="stat">
        <div class="stat-k">Ortalama Gecikme</div>
        <div class="stat-v">${report.avgMs} ms</div>
      </div>
      <div class="stat">
        <div class="stat-k">Çalışma Ortamı</div>
        <div class="stat-v">${escapeHtml(report.env)}</div>
      </div>
    </div>

    <div class="grid">${cardsHtml}</div>
  </div>

  <script>
    const msgEl = document.getElementById("msg");
    let timerId = null;

    function setAutoInterval(msStr) {
      if (timerId) {
        clearInterval(timerId);
        timerId = null;
      }
      const ms = Number(msStr);
      if (ms > 0) {
        timerId = setInterval(() => {
          runAllNow();
        }, ms);
      }
    }

    async function runAllNow() {
      const res = await fetch("/api/checks?persist=1");
      if (res.ok) location.reload();
    }

    async function addTarget(e) {
      e.preventDefault();
      msgEl.textContent = "";
      const name = document.getElementById("tName").value.trim();
      const url = document.getElementById("tUrl").value.trim();
      const expectedStatus = document.getElementById("tExpected").value;
      const note = document.getElementById("tNote").value.trim();

      const res = await fetch("/api/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, url, expectedStatus, note })
      });
      const data = await res.json();
      if (!res.ok) {
        msgEl.textContent = data.error || "Hedef eklenemedi.";
        return;
      }
      location.reload();
    }

    async function deleteTarget(id) {
      const res = await fetch("/api/targets/" + encodeURIComponent(id), { method: "DELETE" });
      if (res.ok) location.reload();
    }

    async function checkOne(id) {
      const card = document.querySelector('[data-id="' + id + '"]');
      if (!card) return;
      card.querySelector(".detail").textContent = "Kontrol ediliyor...";
      const res = await fetch("/api/targets/" + encodeURIComponent(id) + "/check", { method: "POST" });
      if (!res.ok) return;
      location.reload();
    }
  </script>
</body>
</html>`;
}

function readBodyJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function sendJson(res, code, payload) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function createServer(filePath = DATA_FILE) {
  return http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = reqUrl.pathname;

    if (req.method === "GET" && pathname === "/health") {
      return sendJson(res, 200, { status: "ok", env: APP_ENV });
    }

    if (req.method === "GET" && pathname === "/api/checks") {
      const targets = loadTargets(filePath);
      const persist = reqUrl.searchParams.get("persist") === "1";
      const report = await runAllChecks(targets, persist ? filePath : null);
      return sendJson(res, 200, report);
    }

    if (req.method === "POST" && pathname === "/api/targets") {
      try {
        const body = await readBodyJson(req);
        const name = String(body.name || "").trim();
        const normalized = normalizeUrl(body.url);
        const expectedStatus = normalizeExpectedStatus(body.expectedStatus);
        const note = String(body.note || "Özel hedef").trim() || "Özel hedef";

        if (!name || !normalized) {
          return sendJson(res, 400, { error: "Geçerli bir hedef adı ve URL gir." });
        }

        const targets = loadTargets(filePath);
        const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        targets.push({ id, name, url: normalized, expectedStatus, note, history: [] });
        saveTargets(targets, filePath);
        return sendJson(res, 201, { id, name, url: normalized, expectedStatus, note, history: [] });
      } catch {
        return sendJson(res, 400, { error: "Geçersiz istek gövdesi." });
      }
    }

    const deleteMatch = pathname.match(/^\/api\/targets\/([^/]+)$/);
    if (req.method === "DELETE" && deleteMatch) {
      const id = decodeURIComponent(deleteMatch[1]);
      const targets = loadTargets(filePath);
      const next = targets.filter((t) => t.id !== id);
      if (next.length === targets.length) {
        return sendJson(res, 404, { error: "Hedef bulunamadı." });
      }
      saveTargets(next, filePath);
      return sendJson(res, 200, { deleted: id });
    }

    const checkMatch = pathname.match(/^\/api\/targets\/([^/]+)\/check$/);
    if (req.method === "POST" && checkMatch) {
      const id = decodeURIComponent(checkMatch[1]);
      const targets = loadTargets(filePath);
      const idx = targets.findIndex((t) => t.id === id);
      if (idx === -1) {
        return sendJson(res, 404, { error: "Hedef bulunamadı." });
      }
      const result = await checkTarget(targets[idx]);
      targets[idx] = result;
      saveTargets(targets, filePath);
      return sendJson(res, 200, result);
    }

    if (req.method === "GET" && pathname === "/") {
      const targets = loadTargets(filePath);
      const report = await runAllChecks(targets, filePath);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(renderDashboard(report));
    }

    return sendJson(res, 404, { error: "Not Found" });
  });
}

if (require.main === module) {
  ensureTargetsFile(DATA_FILE);
  const server = createServer(DATA_FILE);
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[${APP_ENV}] Servis Kontrol Paneli aktif: http://127.0.0.1:${PORT}`);
  });
}

module.exports = {
  normalizeUrl,
  isStatusExpected,
  checkTarget,
  runAllChecks,
  createServer
};
