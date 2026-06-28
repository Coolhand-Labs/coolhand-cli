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

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return {
      key: fs.readFileSync(keyPath, "utf8"),
      cert: fs.readFileSync(certPath, "utf8"),
    };
  }

  const ca = await mockttp.generateCACertificate();
  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(keyPath, ca.key, { mode: 0o600 });
  fs.writeFileSync(certPath, ca.cert, { mode: 0o644 });

  return ca;
}

/**
 * Returns the path to the CA certificate file.
 */
export function getCertPath(certDir: string = DEFAULT_CERT_DIR): string {
  return path.join(certDir, "ca-cert.pem");
}

/**
 * Returns the default cert directory path.
 */
export function getDefaultCertDir(): string {
  return DEFAULT_CERT_DIR;
}
