const assert = require("assert");
const Module = require("module");
const calls = { put: [], mail: 0 };
const fakeBlob = {
  put: async (p, body, o) => { calls.put.push({ p, o }); if (process.env.FAIL_BLOB) throw new Error("blob down"); return {}; },
  list: async () => ({ blobs: [{ pathname: "leads/2026-10-15/a.json" }, { pathname: "leads/2026-10-16/b.json" }], hasMore: false }),
  get: async (p) => ({ stream: new Blob([JSON.stringify({ at: p.includes("16") ? "2026-10-16T08:00:00Z" : "2026-10-15T08:00:00Z", name: "=bad", phone: "0523366593" })]).stream() })
};
const fakeMail = { createTransport: () => ({ sendMail: async () => { calls.mail++; } }) };
const orig = Module._load;
Module._load = function (r, ...a) { if (r === "@vercel/blob") return fakeBlob; if (r === "nodemailer") return fakeMail; return orig.call(this, r, ...a); };
function mkRes() { const r = { h: {}, statusCode: 200, setHeader(k, v) { this.h[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, end() { return this; } }; return r; }
(async () => {
  Object.assign(process.env, { SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASS: "p", LEAD_TO: "t", BLOB_READ_WRITE_TOKEN: "x" });
  const lead = require("../api/lead.js");
  const req = (phone, ip) => ({ method: "POST", headers: { origin: "https://a.com", host: "a.com", "x-forwarded-for": ip }, socket: {}, body: { name: "TEST", phone, eligibility: "מוכר משרד הביטחון", note: "" } });
  let res = mkRes(); await lead(req("+10523366593", "1"), res);
  assert.strictEqual(res.statusCode, 200); assert.strictEqual(calls.mail, 1); assert.strictEqual(calls.put[0].o.access, "private"); assert.match(calls.put[0].p, /^leads\/\d{4}-\d\d-\d\d\/.+\.json$/);
  process.env.FAIL_BLOB = "1"; res = mkRes(); await lead(req("052-3366593", "2"), res);
  assert.strictEqual(res.statusCode, 200); assert.strictEqual(calls.mail, 2); delete process.env.FAIL_BLOB;
  res = mkRes(); await lead(req("12345", "3"), res); assert.deepStrictEqual([res.statusCode, res.body.error], [400, "phone"]);
  res = mkRes(); await lead({ ...req("0523366593", "4"), body: { hp_x: "x" } }, res); assert.strictEqual(res.statusCode, 200);
  // admin
  const crypto = require("crypto"); const salt = crypto.randomBytes(16);
  const admin = require("../api/admin.js");
  delete process.env.ADMIN_PASSWORD_HASH;
  res = mkRes(); await admin({ method: "POST", headers: { origin: "https://a.com", host: "a.com" }, body: { action: "login", password: "anything" } }, res); assert.strictEqual(res.statusCode, 503);
  process.env.ADMIN_PASSWORD_HASH = "scrypt$" + salt.toString("hex") + "$" + crypto.scryptSync("correct horse 1", salt, 64).toString("hex");
  res = mkRes(); await admin({ method: "GET", headers: {}, query: {} }, res); assert.strictEqual(res.statusCode, 401);
  res = mkRes(); await admin({ method: "POST", headers: { origin: "https://a.com", host: "a.com" }, body: { action: "login", password: "wrong" } }, res); assert.strictEqual(res.statusCode, 401);
  res = mkRes(); await admin({ method: "POST", headers: { origin: "https://evil.com", host: "a.com" }, body: { action: "login", password: "correct horse 1" } }, res); assert.strictEqual(res.statusCode, 403);
  res = mkRes(); await admin({ method: "POST", headers: { origin: "https://a.com", host: "a.com" }, body: { action: "login", password: "correct horse 1" } }, res);
  assert.strictEqual(res.statusCode, 303); const ck = res.h["Set-Cookie"]; assert.match(ck, /HttpOnly; Secure; SameSite=Strict/);
  const cookie = ck.split(";")[0];
  res = mkRes(); await admin({ method: "GET", headers: { cookie }, query: {} }, res); assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.indexOf("16.10.2026") < res.body.indexOf("15.10.2026"), "newest first");
  res = mkRes(); await admin({ method: "GET", headers: { cookie }, query: { format: "csv" } }, res); assert.match(res.body, /"'=bad"/);
  res = mkRes(); await admin({ method: "GET", headers: { cookie: cookie.replace(/.$/, "0") }, query: {} }, res); assert.strictEqual(res.statusCode, 401);
  console.log("handler tests passed");
})().catch(e => { console.error(e); process.exit(1); });
