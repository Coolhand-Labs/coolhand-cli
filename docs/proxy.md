# Coolhand Proxy

`coolhand claude` routes Claude CLI traffic through an in-process HTTPS MITM proxy powered by [mockttp](https://github.com/httptoolkit/mockttp). The proxy intercepts outbound LLM API calls and forwards them to Coolhand for capture and analysis.

## CA Certificate

On first run, `coolhand claude` generates a self-signed CA certificate and stores it at:

```
~/.coolhand/proxy/ca-cert.pem   # public CA certificate — safe to distribute
~/.coolhand/proxy/ca-key.pem    # CA private key — keep this secret
```

> **Security note:** `ca-key.pem` is the CA private key. Anyone who obtains it can issue certificates trusted by any system that has installed the corresponding `ca-cert.pem`. Only distribute `ca-cert.pem` when installing system-wide trust.

The spawned Claude process is pointed at this cert via `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, and `REQUESTS_CA_BUNDLE`. For Claude (Node.js-based), `NODE_EXTRA_CA_CERTS` is the variable that matters; `SSL_CERT_FILE` covers OpenSSL-linked tools (curl, Python's `ssl` module) and `REQUESTS_CA_BUNDLE` covers Python's `requests` library.

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

Delete the cert directory and re-run `coolhand claude`:

```bash
rm -rf ~/.coolhand/proxy
coolhand claude          # starts the proxy; cert is regenerated on first run
```

If you previously installed the old cert system-wide, remove it first.

## Proxy environment variables

The proxy sets these environment variables in the spawned Claude process:

| Variable | Purpose |
|----------|---------|
| `HTTP_PROXY` | Route HTTP traffic through the local proxy. Respected by curl, Python, Go, and many CLIs. |
| `HTTPS_PROXY` | Route HTTPS traffic through the local proxy. Claude Code's HTTP client respects this variable so its outbound LLM API calls are captured via MITM interception. Note: Node.js's raw `https.request` ignores this variable without an explicit proxy agent — other Node.js subprocesses may not route through the proxy unless they use a proxy-aware library. |
| `NO_PROXY` | Bypass the proxy for loopback addresses (`localhost,127.0.0.1,::1`) so local MCP servers and tools are not routed through the MITM proxy |
| `SSL_CERT_FILE` | Trust the Coolhand CA cert (used by curl, Python, etc.) |
| `NODE_EXTRA_CA_CERTS` | Trust the CA cert in Node.js subprocesses |
| `REQUESTS_CA_BUNDLE` | Trust the CA cert in Python's `requests` library |
| `COOLHAND_API_KEY` | Expose the Coolhand public API key to the spawned Claude process and its subprocesses |

## Known limitations

**All HTTPS traffic is proxied.** The Coolhand proxy intercepts all HTTPS traffic from the Claude process, not just LLM API calls. Connections to servers with non-standard certificate chains (corporate PKI, certificate pinning) may fail if the proxy cannot verify the upstream certificate. If you encounter TLS errors for non-AI endpoints, add those hosts to a `NO_PROXY` extension or run `coolhand claude` without the proxy.

**Partial cert file deletion.** If `ca-cert.pem` is removed but `ca-key.pem` remains (e.g. manual cleanup), `coolhand claude` generates a new key/cert pair, silently replacing both files. Any previously installed CA cert in your system trust store will no longer match. Re-install the new `ca-cert.pem` after regeneration — see [Regenerating the cert](#regenerating-the-cert) above.
