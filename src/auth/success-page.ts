export const SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Coolhand — Token captured</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
           background: #f8fafc; color: #0f172a; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px;
            padding: 32px 40px; max-width: 420px; text-align: center;
            box-shadow: 0 4px 20px rgba(15,23,42,0.06); }
    h1 { margin: 0 0 8px; font-size: 20px; }
    p { margin: 8px 0 0; color: #475569; line-height: 1.5; font-size: 14px; }
    .check { font-size: 36px; color: #16a34a; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">&#x2713;</div>
    <h1>Token captured</h1>
    <p>coolhand-cli has received your API token. You can close this tab and return to your terminal.</p>
  </div>
</body>
</html>
`;

export function errorHtml(message: string): string {
  const safe = message.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
  return `<!doctype html><html><body style="font-family:sans-serif;padding:32px;">
<h1>Coolhand — Request rejected</h1>
<p>${safe}</p>
<p>Return to your terminal for details.</p>
</body></html>`;
}
