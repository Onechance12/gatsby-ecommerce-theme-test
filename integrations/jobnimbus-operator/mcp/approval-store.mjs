import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_BYTES = 18 * 1024 * 1024; // Includes an encrypted 8 MiB PDF snapshot.
const TERMINAL = new Set(["verified", "unknown", "invalid"]);
const fail = (code) => { throw new Error(`Approval store: ${code}. Stop and review the exact approval/receipt state; never retry automatically.`); };

// No credential lookup, network, installed server import, or customer fixtures.
// Production supplies the credential already pinned by its existing transport.
// Domain/version-separated encryption makes credential/package changes fail closed.
export function createEncryptedApprovalStore({ directory, secret, namespace, now = Date.now }) {
  if (!path.isAbsolute(directory) || typeof secret !== "string" || secret.length < 24
    || typeof namespace !== "string" || !namespace) throw new TypeError("Invalid approval-store configuration.");
  const root = path.resolve(directory);
  const key = Buffer.from(hkdfSync("sha256", secret, "jobnimbus-approval-store-v1", namespace, 32));
  const uid = process.getuid();
  const checked = (stat, isDirectory = false) => {
    if ((isDirectory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== uid
      || (stat.mode & 0o777) !== (isDirectory ? 0o700 : 0o600)
      || (!isDirectory && (stat.nlink !== 1 || stat.size > MAX_BYTES * 2))) fail("unsafe_storage");
  };
  function prepareDirectory() {
    // Refuse symlink components; do not chmod or repair an unsafe existing path.
    let current = path.parse(root).root;
    for (const component of root.slice(current.length).split(path.sep)) {
      current = path.join(current, component);
      try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe_storage");
    }
    checked(lstatSync(root), true);
  }
  const filename = (id) => {
    if (typeof id !== "string" || !id || id.length > 256) fail("invalid_identifier");
    // A credential/package change starts an isolated namespace. It cannot
    // reopen old approvals, and old ciphertext cannot block a NEW explicit plan.
    return path.join(root, `${createHmac("sha256", key).update(`record\0${id}`).digest("hex")}.json`);
  };
  function read(id) {
    let fd;
    try { fd = openSync(filename(id), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error.code === "ENOENT") return undefined; fail("unreadable"); }
    try {
      checked(fstatSync(fd));
      const envelope = JSON.parse(readFileSync(fd, "utf8"));
      if (envelope.version !== 1) fail("unsupported_format");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(Buffer.from(`${namespace}\0${id}`, "utf8"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const bytes = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]);
      if (bytes.length > MAX_BYTES) fail("too_large");
      const row = JSON.parse(bytes.toString("utf8"));
      if (!row.approvalId || !Number.isFinite(row.expiresAt)
        || !["pending", "executing", ...TERMINAL].includes(row.status)) fail("invalid_record");
      return row;
    } catch { fail("integrity_or_credential_mismatch"); }
    finally { closeSync(fd); }
  }
  function write(id, row) {
    const bytes = Buffer.from(JSON.stringify(row), "utf8");
    if (bytes.length > MAX_BYTES) fail("too_large");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`${namespace}\0${id}`, "utf8"));
    const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const envelope = JSON.stringify({ version: 1, iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
    const temporary = path.join(root, `${randomBytes(16).toString("hex")}.tmp`);
    let fd;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, envelope); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, filename(id));
      const dirFd = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  function locked(id, callback) {
    prepareDirectory();
    const lock = `${filename(id)}.lock`;
    let fd;
    try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { fail("busy_or_interrupted_lock"); } // Never steal a potentially live lock.
    try { return callback(); }
    finally { closeSync(fd); unlinkSync(lock); }
  }
  const tombstone = (row, status, reason) => ({ approvalId: row.approvalId, kind: row.kind,
    expiresAt: row.expiresAt, status, reason, updatedAt: now() });
  return Object.freeze({
    get(id) { return locked(id, () => {
      const row = read(id);
      if (row?.status === "pending" && row.expiresAt <= now()) {
        const expired = tombstone(row, "invalid", "expired"); write(id, expired); return expired;
      }
      return row;
    }); },
    has(id) { return this.get(id) !== undefined; },
    set(id, row) { return locked(id, () => {
      const previous = read(id);
      if (previous && ["executing", "unknown", "verified"].includes(previous.status)) fail("receipt_review_required");
      if (row.status !== "pending" || row.expiresAt <= now() || row.expiresAt > now() + 3600000) fail("invalid_expiry");
      write(id, row);
    }); },
    transition(id, approvalId, from, to, reason) { return locked(id, () => {
      const row = read(id);
      if (!row || row.approvalId !== approvalId || row.status !== from) return false;
      if (!((from === "pending" && ["executing", "invalid"].includes(to))
        || (from === "executing" && ["verified", "unknown"].includes(to)))) fail("invalid_transition");
      if (from === "pending" && to === "executing" && row.expiresAt <= now()) {
        write(id, tombstone(row, "invalid", "expired")); return false;
      }
      // Remove content/challenge/bytes before the effect request. A crash leaves
      // only an executing tombstone: it can never recreate or replay the plan.
      write(id, tombstone(row, to, reason)); return true;
    }); }
  });
}
