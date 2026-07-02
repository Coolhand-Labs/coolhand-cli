import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as mockttp from "mockttp";

const DEFAULT_CERT_DIR = path.join(os.homedir(), ".coolhand", "proxy");

export interface CACredentials {
  key: string;
  cert: string;
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

  try {
    // Known limitation: if both files exist but are from different generations
    // (e.g. a partial write left mismatched files), the stale pair is loaded
    // silently. The temp+rename write strategy below prevents this for new
    // writes, but does not detect pre-existing mismatches.
    return {
      key: fs.readFileSync(keyPath, "utf8"),
      cert: fs.readFileSync(certPath, "utf8"),
    };
  } catch (err) {
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
  fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });
  // Write via temp+rename so a crash between the two writes never leaves a
  // mismatched key/cert pair on disk (TOCTOU guard).
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

