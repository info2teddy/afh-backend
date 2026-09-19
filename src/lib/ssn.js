// src/lib/ssn.js
// Field-level encryption for resident Social Security numbers.
//
// Stored in the existing residents.social_security_number column as
//   enc:v1:<base64( iv(12) | authTag(16) | ciphertext )>
// using AES-256-GCM. The key comes from SSN_ENCRYPTION_KEY (base64, 32 bytes;
// generate with `openssl rand -base64 32`). Lose the key and every stored SSN
// is unrecoverable — keep a copy in a password manager, not just in Railway.
//
// The resident's id is bound in as GCM additional data, so a ciphertext copied
// from one resident's row into another's fails to decrypt instead of quietly
// showing the wrong person's number.
//
// The "v1" prefix is what makes key rotation possible later without guessing
// which rows are on which key.
//
// The plaintext never leaves the server except through
// GET /residents/:id/social-security-number (see routes/residents.js) — every
// other query strips the column via the global `omit` in middleware/tenant.js,
// and the UI shows only the last four digits (residents.social_security_last4).

const crypto = require("crypto");

const PREFIX = "enc:v1:";

class SsnKeyError extends Error {}
class SsnFormatError extends Error {}

function getKey() {
  const raw = process.env.SSN_ENCRYPTION_KEY;
  if (!raw) throw new SsnKeyError("SSN_ENCRYPTION_KEY is not set.");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new SsnKeyError("SSN_ENCRYPTION_KEY must be 32 bytes, base64-encoded.");
  return key;
}

function keyConfigured() {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

function isEncrypted(stored) {
  return typeof stored === "string" && stored.startsWith(PREFIX);
}

// Accepts "123-45-6789", "123 45 6789" or "123456789"; returns the canonical
// "123-45-6789". Throws SsnFormatError for anything that isn't nine digits.
function normalizeSsn(input) {
  const digits = String(input).replace(/[\s-]/g, "");
  if (!/^\d{9}$/.test(digits)) {
    throw new SsnFormatError("A Social Security number must be 9 digits.");
  }
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

function last4(canonicalSsn) {
  return canonicalSsn.slice(-4);
}

function encryptSsn(plain, residentId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  cipher.setAAD(Buffer.from(residentId));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

// Returns the plaintext, or null if nothing is stored. A value without the
// enc:v1: prefix is a legacy plaintext row from before encryption existed and
// is returned as-is (the startup migration in migrateLegacySsns rewrites those).
function decryptSsn(stored, residentId) {
  if (!stored) return null;
  if (!isEncrypted(stored)) return stored;
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), buf.subarray(0, 12));
  decipher.setAAD(Buffer.from(residentId));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

// Idempotent one-time upgrade for rows saved before encryption existed: any
// non-null value without the enc:v1: prefix gets encrypted in place and its
// last four digits recorded. Safe to run on every boot — once everything is
// encrypted the query matches nothing. Does nothing without a key (the app
// then simply can't save SSNs, see routes/residents.js), and skips values
// that aren't nine digits rather than destroying whatever was typed there.
async function migrateLegacySsns(prisma) {
  if (!keyConfigured()) return { migrated: 0, skipped: 0, keyMissing: true };
  const rows = await prisma.resident.findMany({
    where: { socialSecurityNumber: { not: null }, NOT: { socialSecurityNumber: { startsWith: PREFIX } } },
    // An explicit select of the column overrides the client-wide omit.
    select: { id: true, socialSecurityNumber: true },
  });
  let migrated = 0;
  let skipped = 0;
  for (const row of rows) {
    let canonical;
    try {
      canonical = normalizeSsn(row.socialSecurityNumber);
    } catch {
      skipped++;
      continue;
    }
    await prisma.resident.update({
      where: { id: row.id },
      data: { socialSecurityNumber: encryptSsn(canonical, row.id), socialSecurityLast4: last4(canonical) },
    });
    migrated++;
  }
  return { migrated, skipped, keyMissing: false };
}

module.exports = {
  SsnKeyError,
  SsnFormatError,
  keyConfigured,
  isEncrypted,
  normalizeSsn,
  last4,
  encryptSsn,
  decryptSsn,
  migrateLegacySsns,
};
