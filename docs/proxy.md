# Coolhand Proxy

`coolhand claude` routes Claude CLI traffic through an in-process HTTPS MITM proxy powered by [mockttp](https://github.com/httptoolkit/mockttp). The proxy intercepts outbound LLM API calls and forwards them to Coolhand for capture and analysis.

## CA Certificate

On first run, `coolhand claude` generates a self-signed CA certificate and stores it at:

```
~/.coolhand/proxy/ca-cert.pem
```

The spawned Claude process is pointed at this cert via `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, and `REQUESTS_CA_BUNDLE`. For Claude (Node.js-based) this is sufficient.

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
coolhand claude --help   # triggers cert regeneration
```

If you previously installed the old cert system-wide, remove it first.

## Proxy environment variables

The proxy sets these environment variables in the spawned Claude process:

| Variable | Purpose |
|----------|---------|
| `HTTP_PROXY` | Route HTTP traffic through the local proxy |
| `HTTPS_PROXY` | Route HTTPS traffic through the local proxy |
| `SSL_CERT_FILE` | Trust the Coolhand CA cert (used by curl, Python, etc.) |
| `NODE_EXTRA_CA_CERTS` | Trust the CA cert in Node.js subprocesses |
| `REQUESTS_CA_BUNDLE` | Trust the CA cert in Python's `requests` library |
| `COOLHAND_API_KEY` | Forward the configured API key to subprocesses |
