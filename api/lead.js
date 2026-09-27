const nodemailer = require("nodemailer");

const ELIGIBILITY = ["מוכר משרד הביטחון", "שרתתי למעלה מ-200 יום"];
const hits = new Map();

function clean(value, max, keepLines) {
  var pattern = keepLines ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g;
  return String(value || "").replace(pattern, "").trim().slice(0, max);
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
  if (!sameOrigin(req)) return res.status(403).json({ ok: false });
  if (limited(clientIp(req))) return res.status(429).json({ ok: false });

  const body = req.body || {};
  if (clean(body.company, 200)) return res.status(200).json({ ok: true });

  const name = clean(body.name, 80);
  const phone = clean(body.phone, 20);
  const note = clean(body.note, 1000, true);
  const eligibility = clean(body.eligibility, 80);
  const digits = phone.replace(/\D/g, "");
  if (!name || digits.length < 9 || digits.length > 15 || ELIGIBILITY.indexOf(eligibility) === -1) {
    return res.status(400).json({ ok: false });
  }

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const to = process.env.LEAD_TO;
  const port = Number(process.env.SMTP_PORT || 587);
  if (!host || !user || !pass || !to) return res.status(503).json({ ok: false });

  const transporter = nodemailer.createTransport({
    host: host,
    port: port,
    secure: port === 465,
    auth: { user: user, pass: pass },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 8000
  });
  const text = "שם מלא: " + name + "\nטלפון: " + phone + "\nהאם אני: " + eligibility + "\nפרטים נוספים: " + note + "\n";

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await transporter.sendMail({
        from: user,
        to: to,
        subject: "פנייה חדשה — מתנת חיים",
        text: text
      });
      return res.status(200).json({ ok: true });
    } catch (err) {
      if (attempt === 2) return res.status(502).json({ ok: false });
    }
  }
};
