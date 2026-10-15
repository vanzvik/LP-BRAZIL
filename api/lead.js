const nodemailer = require("nodemailer");
const crypto = require("crypto");
const { put } = require("@vercel/blob");
const { normalizePhone } = require("../lib/phone");

async function saveLead(lead) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) { console.error("lead backup skipped: BLOB_READ_WRITE_TOKEN missing"); return false; }
  const day = lead.at.slice(0, 10);
  const path = "leads/" + day + "/" + lead.at.replace(/[:.]/g, "-") + "-" + crypto.randomBytes(4).toString("hex") + ".json";
  try {
    await put(path, JSON.stringify(lead), { access: "private", contentType: "application/json", addRandomSuffix: false });
    console.log("lead backed up", JSON.stringify({ path: path }));
    return true;
  } catch (err) {
    console.error("lead backup failed", JSON.stringify({ message: String(err && err.message || err).slice(0, 300) }));
    return false;
  }
}

const ELIGIBILITY = ["מוכר משרד הביטחון", "שרתתי למעלה מ-200 יום"];
const hits = new Map();

function clean(value, max, keepLines) {
  var pattern = keepLines ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g;
  return String(value || "").replace(pattern, "").trim().slice(0, max);
}


function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "\u0026amp;")
    .replace(/</g, "\u0026lt;")
    .replace(/>/g, "\u0026gt;");
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded || req.socket.remoteAddress || "";
  return String(raw).split(",")[0].trim() || "unknown";
}

function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(function (t) { return now - t < 10 * 60 * 1000; });
  if (recent.length >= 5) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

function sameOrigin(req) {
  const origin = req.headers.origin || "";
  const host = req.headers.host || "";
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch (err) {
    return false;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false });
  }
  const body = req.body || {};
  const peek = function () { return JSON.stringify({ origin: req.headers.origin || "", host: req.headers.host || "", name: clean(body.name, 80), phone: clean(body.phone, 30) }); };
  if (!sameOrigin(req)) { console.warn("lead rejected 403 origin", peek()); return res.status(403).json({ ok: false, error: "origin" }); }
  if (limited(clientIp(req))) { console.warn("lead rejected 429 rate", peek()); return res.status(429).json({ ok: false }); }

  const trap = clean(body.hp_x, 200) || clean(body.company, 200);
  if (trap) {
    console.warn("lead honeypot hit", JSON.stringify({ ip: clientIp(req), trap: trap.slice(0, 80), name: clean(body.name, 80), phone: clean(body.phone, 20) }));
    return res.status(200).json({ ok: true });
  }

  const name = clean(body.name, 80);
  const rawPhone = clean(body.phone, 30);
  const normalized = normalizePhone(rawPhone);
  const phone = normalized.phone;
  const note = clean(body.note, 1000, true);
  const eligibility = clean(body.eligibility, 80);
  if (!name || ELIGIBILITY.indexOf(eligibility) === -1) { console.warn("lead rejected 400 required", peek()); return res.status(400).json({ ok: false, error: "required" }); }
  if (!normalized.ok) { console.warn("lead rejected 400 phone", peek()); return res.status(400).json({ ok: false, error: "phone" }); }

  const lead = { at: new Date().toISOString(), name: name, phone: phone, rawPhone: rawPhone, eligibility: eligibility, note: note, host: req.headers.host || "" };
  console.log("lead received", JSON.stringify(lead));
  await saveLead(lead);

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const to = process.env.LEAD_TO;
  const port = Number(process.env.SMTP_PORT || 587);
  if (!host || !user || !pass || !to) { console.error("lead send skipped: SMTP env missing"); return res.status(503).json({ ok: false }); }

  const transporter = nodemailer.createTransport({
    host: host,
    port: port,
    secure: port === 465,
    auth: { user: user, pass: pass },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 8000
  });
  const text = "שם מלא: " + name + "\nטלפון: " + phone + "\nהאם אני: " + eligibility + "\nמשהו נוסף שתרצה שנדע?: " + note + "\n";
  const html = "<div dir=\"rtl\" lang=\"he\" style=\"direction:rtl;text-align:right;font-family:Arial,sans-serif;font-size:16px;line-height:1.5\">"
    + "<p style=\"margin:0 0 12px\"><b>שם מלא</b><br>" + escapeHtml(name) + "</p>"
    + "<p style=\"margin:0 0 12px\"><b>טלפון</b><br><bdi dir=\"ltr\">" + escapeHtml(phone) + "</bdi></p>"
    + "<p style=\"margin:0 0 12px\"><b>האם אני</b><br>" + escapeHtml(eligibility) + "</p>"
    + "<p style=\"margin:0 0 12px\"><b>משהו נוסף שתרצה שנדע?</b><br>" + escapeHtml(note).replace(/\n/g, "<br>") + "</p>"
    + "</div>";

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await transporter.sendMail({
        from: user,
        to: to,
        subject: "פנייה חדשה — מתנת חיים",
        text: text,
        html: html,
        headers: { "Content-Language": "he" }
      });
      console.log("lead sent", JSON.stringify({ phone: phone }));
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("lead send failed", JSON.stringify({ attempt: attempt + 1, code: err && err.code, command: err && err.command, responseCode: err && err.responseCode, response: err && String(err.response || err.message || "").slice(0, 300) }));
      if (err && err.responseCode === 535) return res.status(502).json({ ok: false });
      if (attempt === 2) return res.status(502).json({ ok: false });
    }
  }
};
