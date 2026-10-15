// Normalize an Israeli (or international) phone number. Returns { ok, phone } .
function normalizePhone(raw) {
  var s = String(raw || "").trim();
  var plus = /^\s*(\+|00)/.test(s);
  var d = s.replace(/\D/g, "");
  if (/^00/.test(d)) d = d.slice(2);
  // browser autofill bug: "+1" glued in front of a local Israeli number (+10523366593)
  if (/^10\d{8,9}$/.test(d)) d = d.slice(1);
  // +972 / 972 → 0
  if (/^9720?\d{8,9}$/.test(d)) { d = "0" + d.slice(3); if (/^00/.test(d)) d = d.slice(1); }
  // local number missing the leading 0 (521234567)
  if (!plus && /^[23489]\d{7}$|^5\d{8}$|^7\d{8}$/.test(d)) d = "0" + d;
  if (/^0(5\d|7\d)\d{7}$|^0[23489]\d{7}$/.test(d)) return { ok: true, phone: d };
  if (plus && d.length >= 9 && d.length <= 15) return { ok: true, phone: "+" + d };
  return { ok: false, phone: d };
}
module.exports = { normalizePhone: normalizePhone };
