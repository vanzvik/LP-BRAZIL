const crypto = require("crypto");
const { list, get } = require("@vercel/blob");

// ADMIN_PASSWORD_HASH format: scrypt$<salt hex>$<hash hex>  (create with: node scripts/hash-password.js)
const COOKIE = "lp_admin";
const TTL = 8 * 60 * 60 * 1000;
const fails = new Map();

function secret() { return process.env.ADMIN_PASSWORD_HASH || ""; }
function sign(v) { return crypto.createHmac("sha256", "lp-admin:" + secret()).update(v).digest("hex"); }
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

function checkPassword(pw) {
  const parts = secret().split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt" || !pw) return false;
  const got = crypto.scryptSync(String(pw), Buffer.from(parts[1], "hex"), 64).toString("hex");
  return safeEq(got, parts[2]);
}
function cookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach(function (c) { const i = c.indexOf("="); if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  return out;
}
function authed(req) {
  if (!secret()) return false;
  const v = cookies(req)[COOKIE] || "";
  const [exp, mac] = v.split(".");
  return !!exp && !!mac && Number(exp) > Date.now() && safeEq(mac, sign(exp));
}
function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function page(res, status, body) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("X-Frame-Options", "DENY");
  res.status(status).send("<!doctype html><html lang=\"he\" dir=\"rtl\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"robots\" content=\"noindex\"><title>לידים</title><style>body{font-family:Arial,sans-serif;margin:2rem;color:#1a3344}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:.5rem;text-align:right;vertical-align:top}input,button{font:inherit;padding:.5rem}.bar{display:flex;gap:1rem;align-items:center;margin-bottom:1rem}</style>" + body + "</html>");
}
function loginForm(res, msg, status) {
  page(res, status || 200, "<h1>כניסת מנהל</h1>" + (msg ? "<p style=\"color:#b00\">" + esc(msg) + "</p>" : "") + "<form method=\"post\" action=\"/admin/leads\"><input type=\"hidden\" name=\"action\" value=\"login\"><input type=\"password\" name=\"password\" autocomplete=\"current-password\" required autofocus> <button>כניסה</button></form>");
}
function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  if (typeof req.body === "string") return Promise.resolve(Object.fromEntries(new URLSearchParams(req.body)));
  return new Promise(function (resolve) {
    let data = ""; req.on("data", function (c) { data += c; if (data.length > 10000) req.destroy(); });
    req.on("end", function () { resolve(Object.fromEntries(new URLSearchParams(data))); });
  });
}
function sameOrigin(req) {
  try { return new URL(req.headers.origin || "").host === req.headers.host; } catch (e) { return false; }
}
async function loadLeads() {
  const blobs = [];
  let cursor;
  do {
    const r = await list({ prefix: "leads/", cursor: cursor, limit: 1000 });
    blobs.push.apply(blobs, r.blobs);
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor && blobs.length < 5000);
  blobs.sort(function (a, b) { return a.pathname < b.pathname ? 1 : -1; });
  const leads = [];
  const top = blobs.slice(0, 1000);
  for (let i = 0; i < top.length; i += 20) {
    const chunk = await Promise.all(top.slice(i, i + 20).map(async function (b) {
      try {
        const r = await get(b.pathname, { access: "private" });
        if (!r || !r.stream) return null;
        const text = await new Response(r.stream).text();
        return JSON.parse(text);
      } catch (e) { return { at: b.pathname, name: "(שגיאה בקריאה)" }; }
    }));
    chunk.forEach(function (l) { if (l) leads.push(l); });
  }
  return leads;
}
function csvCell(v) {
  let s = String(v == null ? "" : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula injection
  return "\"" + s.replace(/"/g, "\"\"") + "\"";
}
function ilTime(iso) {
  try { return new Date(iso).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" }); } catch (e) { return iso; }
}

module.exports = async function handler(req, res) {
  if (req.method === "POST") {
    if (!sameOrigin(req)) return res.status(403).send("forbidden");
    const body = await readBody(req);
    if (body.action === "logout") {
      res.setHeader("Set-Cookie", COOKIE + "=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
      res.statusCode = 303; res.setHeader("Location", "/admin/leads"); return res.end();
    }
    if (!secret()) return loginForm(res, "הכניסה עדיין לא הוגדרה (חסר ADMIN_PASSWORD_HASH).", 503);
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const now = Date.now();
    const recent = (fails.get(ip) || []).filter(function (t) { return now - t < 15 * 60 * 1000; });
    if (recent.length >= 5) return loginForm(res, "יותר מדי ניסיונות. נסו שוב מאוחר יותר.", 429);
    if (!checkPassword(body.password)) {
      recent.push(now); fails.set(ip, recent);
      console.warn("admin login failed", JSON.stringify({ ip: ip }));
      return loginForm(res, "סיסמה שגויה.", 401);
    }
    const exp = String(now + TTL);
    res.setHeader("Set-Cookie", COOKIE + "=" + exp + "." + sign(exp) + "; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=" + TTL / 1000);
    res.statusCode = 303; res.setHeader("Location", "/admin/leads"); return res.end();
  }
  if (req.method !== "GET") return res.status(405).send("method not allowed");
  if (!secret()) return loginForm(res, "הכניסה עדיין לא הוגדרה (חסר ADMIN_PASSWORD_HASH).", 503);
  if (!authed(req)) return loginForm(res, "", 401);

  let leads;
  try { leads = await loadLeads(); } catch (e) {
    console.error("admin list failed", String(e && e.message || e).slice(0, 300));
    return page(res, 500, "<p>שגיאה בטעינת הלידים.</p>");
  }
  const fields = ["at", "name", "phone", "rawPhone", "eligibility", "note", "host"];
  const q = req.query || {};
  if (q.format === "csv") {
    const csv = "\ufeff" + fields.join(",") + "\r\n" + leads.map(function (l) { return fields.map(function (f) { return csvCell(f === "at" ? ilTime(l.at) : l[f]); }).join(","); }).join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"leads-" + new Date().toISOString().slice(0, 10) + ".csv\"");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(csv);
  }
  const rows = leads.map(function (l) {
    return "<tr><td>" + esc(ilTime(l.at)) + "</td><td>" + esc(l.name) + "</td><td dir=\"ltr\">" + esc(l.phone) + "</td><td>" + esc(l.eligibility) + "</td><td>" + esc(l.note).replace(/\n/g, "<br>") + "</td></tr>";
  }).join("");
  page(res, 200, "<div class=\"bar\"><h1 style=\"margin:0\">לידים (" + leads.length + ")</h1><a href=\"/admin/leads?format=csv\">הורדת CSV</a><form method=\"post\" action=\"/admin/leads\"><input type=\"hidden\" name=\"action\" value=\"logout\"><button>יציאה</button></form></div><table><tr><th>זמן (ישראל)</th><th>שם</th><th>טלפון</th><th>האם אני</th><th>הערה</th></tr>" + rows + "</table>");
};
