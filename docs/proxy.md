# Coolhand Proxy

`coolhand claude` routes Claude CLI traffic through an in-process HTTPS MITM proxy powered by [mockttp](https://github.com/httptoolkit/mockttp). The proxy intercepts outbound LLM API calls and forwards them to Coolhand for capture and analysis. `coolhand monitor [--] <command> [args...]` (see [docs/commands.md](./commands.md#monitor)) routes any other CLI's traffic through the same proxy.

## CA Certificate

On first run, `coolhand claude` (or `coolhand monitor`) generates a self-signed CA certificate and stores it at:

```
~/.coolhand/proxy/ca-cert.pem   # public CA certificate — safe to distribute
~/.coolhand/proxy/ca-key.pem    # CA private key — keep this secret
```

> **Security note:** `ca-key.pem` is the CA private key. Anyone who obtains it can issue certificates trusted by any system that has installed the corresponding `ca-cert.pem`. Only distribute `ca-cert.pem` when installing system-wide trust.

The spawned process (Claude, or whatever command `monitor` was given) is pointed at this cert via `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, and `REQUESTS_CA_BUNDLE`. For Node.js-based CLIs, `NODE_EXTRA_CA_CERTS` is the variable that matters; `SSL_CERT_FILE` covers OpenSSL-linked tools (curl, Python's `ssl` module) and `REQUESTS_CA_BUNDLE` covers Python's `requests` library.

### Installing the cert system-wide (optional)

If you use other tools that route traffic through the proxy, install the CA cert in your system trust store:

**macOS**
```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain ~/.coolhand/proxy/ca-cert.pem
```

**Linux (Debian/Ubuntu)**
```bash
sudo cp ~/.coolhand/proxy/ca-cert.pem /usr/local/share/ca-certificates/coolhand-proxy.crt
sudo update-ca-certificates
```

**Windows**
```powershell
Import-Certificate -FilePath "$env:USERPROFILE\.coolhand\proxy\ca-cert.pem" `
  -CertStoreLocation Cert:\LocalMachine\Root
```

### Regenerating the cert

Delete the cert directory and re-run `coolhand claude` (or `coolhand monitor`):

```bash
rm -rf ~/.coolhand/proxy
coolhand claude                    # starts the proxy; cert is regenerated on first run
coolhand monitor -- kimi        # equivalent for a wrapped tool
```

If you previously installed the old cert system-wide, remove it first.

## Proxy environment variables

The proxy sets these environment variables in the spawned process:

| Variable | Purpose |
|----------|---------|
| `HTTP_PROXY` | Route HTTP traffic through the local proxy. Respected by curl, Python, Go, and many CLIs. |
| `HTTPS_PROXY` | Route HTTPS traffic through the local proxy. Claude Code's HTTP client respects this variable so its outbound LLM API calls are captured via MITM interception. Note: Node.js's raw `https.request` ignores this variable without an explicit proxy agent — other Node.js subprocesses may not route through the proxy unless they use a proxy-aware library. |
| `NO_PROXY` | Bypass the proxy for loopback addresses (`localhost,127.0.0.1,::1`) so local MCP servers and tools are not routed through the MITM proxy |
| `SSL_CERT_FILE` | Trust the Coolhand CA cert (used by curl, Python, etc.) |
| `NODE_EXTRA_CA_CERTS` | Trust the CA cert in Node.js subprocesses |
| `REQUESTS_CA_BUNDLE` | Trust the CA cert in Python's `requests` library |
| `COOLHAND_API_KEY` | Expose the Coolhand public API key to the spawned process and its subprocesses |

## Known limitations

**All HTTPS traffic is proxied.** The Coolhand proxy intercepts all HTTPS traffic from the spawned process, not just LLM API calls. Connections to servers with non-standard certificate chains (corporate PKI, certificate pinning) may fail if the proxy cannot verify the upstream certificate. If you encounter TLS errors for non-AI endpoints, add those hosts to a `NO_PROXY` extension or run `coolhand claude`/`coolhand monitor` without the proxy.

**Partial cert file deletion.** If `ca-cert.pem` is removed but `ca-key.pem` remains (e.g. manual cleanup), the next `coolhand claude`/`coolhand monitor` run generates a new key/cert pair, silently replacing both files. Any previously installed CA cert in your system trust store will no longer match. Re-install the new `ca-cert.pem` after regeneration — see [Regenerating the cert](#regenerating-the-cert) above.

**Ownership and permission checks on the CA files.** Before trusting an existing `ca-key.pem`/`ca-cert.pem` pair, the CLI verifies both files (and the `~/.coolhand/proxy` directory itself) are regular files/directories — not symlinks, pipes, or other special files — owned by the current user, and that `ca-key.pem` is not readable or writable by group/other (the same model `ssh` applies to `~/.ssh/id_rsa`). The directory's permissions are also tightened to `0700` on every run, not just when generating a fresh CA. This guards against a file (or directory symlink) pre-seeded into `~/.coolhand/proxy` by another user or process before first run, since the cert is meant for installation into the system trust store. If any check fails, the command exits with a `CERT_FILE_INSECURE` error — remove the offending file(s)/directory (or `chmod 600 ca-key.pem`) and re-run to generate a fresh CA. **These checks are POSIX-only** (macOS/Linux) — Windows has no equivalent uid/mode model, so on Windows the CLI relies on NTFS ACLs (the current user's default file permissions) rather than the checks described here.
