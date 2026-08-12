import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as mockttp from "mockttp";
import { CliError } from "../errors.js";

const DEFAULT_CERT_DIR = path.join(os.homedir(), ".coolhand", "proxy");

export interface CACredentials {
  key: string;
  cert: string;
}

function assertRegularFile(filePath: string, stat: fs.Stats): void {
  if (!stat.isFile()) {
    throw new CliError(
      "CERT_FILE_INSECURE",
      `Refusing to use ${filePath}: it is not a regular file (symlink, pipe, or other special file). ` +
      "Remove it and re-run to generate a fresh CA."
    );
  }
}

// POSIX-only: Windows has no comparable uid/mode semantics and process.getuid
// doesn't exist there, so these checks are no-ops on win32.
function assertOwnedByCurrentUser(filePath: string, stat: fs.Stats): void {
  if (process.platform === "win32") { return; }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new CliError(
      "CERT_FILE_INSECURE",
      `Refusing to use ${filePath}: it is owned by a different user (uid ${stat.uid}), not the current user (uid ${uid}). ` +
      "This file must have been created by this CLI. Remove it and re-run to generate a fresh CA."
    );
  }
}

function assertKeyFilePermissions(filePath: string, stat: fs.Stats): void {
  if (process.platform === "win32") { return; }
  if ((stat.mode & 0o077) !== 0) {
    throw new CliError(
      "CERT_FILE_INSECURE",
      `Refusing to use ${filePath}: it is readable or writable by group/other (mode ${(stat.mode & 0o777).toString(8)}). ` +
      `Run \`chmod 600 ${filePath}\` or remove it and re-run to generate a fresh CA.`
    );
  }
}

/**
 * Rejects certDir itself if it's a symlink, not a directory, or owned by another
 * user, before it's ever passed to mkdirSync — otherwise the per-file checks below
 * would be moot, since mkdirSync(..., {recursive: true}) treats an existing path as
 * already satisfied (even through a symlink), so a pre-planted
 * "~/.coolhand/proxy -> attacker-owned dir" symlink would have every subsequent
 * operation silently apply to the attacker's directory instead.
 * POSIX-only, like the file-level ownership check.
 */
function assertCertDirIsSecure(dir: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") { return; }
    throw err;
  }
  if (process.platform === "win32") { return; }
  if (stat.isSymbolicLink()) {
    throw new CliError(
      "CERT_FILE_INSECURE",
      `Refusing to use ${dir}: it is a symlink, which could point to a directory outside your control. ` +
      "Remove it and re-run to create a fresh cert directory."
    );
  }
  if (!stat.isDirectory()) {
    throw new CliError(
      "CERT_FILE_INSECURE",
      `Refusing to use ${dir}: it exists but is not a directory. Remove it and re-run to create a fresh cert directory.`
    );
  }
  assertOwnedByCurrentUser(dir, stat);
}

/**
 * Opens filePath and returns its contents plus the fstat of the exact fd that was
 * read, running `checks` against that fstat before reading. Using fstat on the open
 * fd (rather than a separate stat-then-read) closes the TOCTOU window where a
 * concurrent attacker could swap the file for something else between checking it
 * and reading it. On POSIX, O_NOFOLLOW makes a symlinked path fail open() with
 * ELOOP (reported as CERT_FILE_INSECURE below) instead of silently dereferencing
 * it, and O_NONBLOCK keeps open() from hanging forever if the path is a FIFO
 * with no writer — assertRegularFile then rejects the FIFO before any read is
 * attempted, so O_NONBLOCK never affects the actual regular-file read.
 */
function readCertFileSecurely(
  filePath: string,
  checks: Array<(filePath: string, stat: fs.Stats) => void>
): string {
  const flags = process.platform === "win32"
    ? fs.constants.O_RDONLY
    : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

  let fd: number;
  try {
    fd = fs.openSync(filePath, flags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new CliError(
        "CERT_FILE_INSECURE",
        `Refusing to use ${filePath}: it is a symlink, which could point to unrelated file content outside this directory. ` +
        "Remove it and re-run to generate a fresh CA."
      );
    }
    throw err;
  }
  try {
    const stat = fs.fstatSync(fd);
    for (const check of checks) { check(filePath, stat); }
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Get or create a CA certificate for MITM proxy interception.
 * Certs are persisted to disk so they can be installed in the system trust store.
 */
export async function getOrCreateCA(
  certDir: string = DEFAULT_CERT_DIR
): Promise<CACredentials> {
  const keyPath = path.join(certDir, "ca-key.pem");
  const certPath = path.join(certDir, "ca-cert.pem");

  assertCertDirIsSecure(certDir);

  // Tighten certDir's permissions on every call, not just when generating a fresh
  // CA — otherwise a directory left group/world-writable by an older CLI version
  // (or a shared machine) stays that way indefinitely as long as the cert files
  // inside it keep passing their own ownership/mode checks below.
  fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    // Open with O_NOFOLLOW|O_DIRECTORY and fchmod the resulting fd, rather than
    // chmodSync-by-path, so a symlink swapped in for certDir between mkdirSync
    // above and this call is rejected (ELOOP) instead of silently followed —
    // narrowing (though, absent a dirfd-relative write API in Node's fs module,
    // not fully eliminating) the race between checking certDir and using it.
    let dirFd: number;
    try {
      dirFd = fs.openSync(certDir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ELOOP") {
        throw new CliError(
          "CERT_FILE_INSECURE",
          `Refusing to use ${certDir}: it is a symlink, which could point to a directory outside your control. ` +
          "Remove it and re-run to create a fresh cert directory."
        );
      }
      throw err;
    }
    try {
      fs.fchmodSync(dirFd, 0o700);
    } catch (err) {
      throw new CliError(
        "CERT_FILE_INSECURE",
        `Failed to restrict ${certDir} to owner-only permissions: ${(err as Error).message}. ` +
        "This directory holds the CA private key and must not be group/world-accessible."
      );
    } finally {
      fs.closeSync(dirFd);
    }
  }

  try {
    // Known limitation: if both files exist but are from different generations
    // (e.g. a partial write left mismatched files), the stale pair is loaded
    // silently. The temp+rename write strategy below prevents this for new
    // writes, but does not detect pre-existing mismatches.
    const key = readCertFileSecurely(keyPath, [assertRegularFile, assertOwnedByCurrentUser, assertKeyFilePermissions]);
    const cert = readCertFileSecurely(certPath, [assertRegularFile, assertOwnedByCurrentUser]);
    return { key, cert };
  } catch (err) {
    if (err instanceof CliError) { throw err; }
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") { throw err; }
    // One or both files absent — fall through to generate a fresh CA pair.
    // If only one is missing, the installed CA cert will be invalidated; warn.
    if (fs.existsSync(keyPath) || fs.existsSync(certPath)) {
      process.stderr.write(
        "[coolhand] Warning: CA certificate files are incomplete — regenerating key/cert pair." +
        " If you installed the previous ca-cert.pem in your system trust store, re-install the new one.\n"
      );
    }
  }

  const ca = await mockttp.generateCACertificate();
  // Write via temp+rename so a crash between the two writes never leaves a
  // mismatched key/cert pair on disk (TOCTOU guard).
  //
  // Known limitation: these writes are still path-based (certDir gets re-resolved
  // by the OS, not accessed via the fd validated above), since Node's fs module has
  // no dirfd-relative ("openat") write API. A symlink swapped in for certDir in the
  // narrow window between the fchmod check above and these writes would still be
  // followed. This is an accepted residual risk given the tooling available.
  const keyTmp = keyPath + ".tmp";
  const certTmp = certPath + ".tmp";
  try {
    fs.writeFileSync(keyTmp, ca.key, { mode: 0o600 });
    fs.writeFileSync(certTmp, ca.cert, { mode: 0o644 });
    fs.renameSync(keyTmp, keyPath);
    fs.renameSync(certTmp, certPath);
  } catch (err) {
    for (const tmp of [keyTmp, certTmp]) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
    throw err;
  }

  return ca;
}

/**
 * Returns the path to the CA certificate file.
 */
export function getCertPath(certDir: string = DEFAULT_CERT_DIR): string {
  return path.join(certDir, "ca-cert.pem");
}

