// Usage: node scripts/hash-password.js 'the password'  → paste output into Vercel env ADMIN_PASSWORD_HASH
const crypto = require("crypto");
const pw = process.argv[2];
if (!pw || pw.length < 12) { console.error("Give a password of at least 12 characters."); process.exit(1); }
const salt = crypto.randomBytes(16);
console.log("scrypt$" + salt.toString("hex") + "$" + crypto.scryptSync(pw, salt, 64).toString("hex"));
