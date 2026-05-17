/**
 * The HTML the local callback listener returns to the browser after a
 * successful token capture. Pure inline CSS, no external assets, no JS.
 * Color palette mirrors coolhandlabs.com (shadcn dark mode HSL values).
 */
const BASE_STYLES = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
                 "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: hsl(222.2 84% 4.9%);
    color: hsl(210 40% 98%);
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 24px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  .wrap { width: 100%; max-width: 440px; }
  .brand {
    text-align: center;
    margin-bottom: 32px;
  }
  .brand-logo {
    height: 112px;
    width: auto;
    display: inline-block;
  }
  .brand-text {
    display: none;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: hsl(215 20.2% 65.1%);
    align-items: center;
    justify-content: center;
  }
  .brand-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: hsl(217.2 91.2% 59.8%);
    margin-right: 8px;
    vertical-align: middle;
    transform: translateY(-1px);
  }
  .card {
    background: hsl(222.2 84% 4.9%);
    border: 1px solid hsl(217.2 32.6% 17.5%);
    border-radius: 12px;
    padding: 40px 32px 32px;
    text-align: center;
    box-shadow: 0 24px 48px -16px rgba(0, 0, 0, 0.5);
  }
  .icon-wrap {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto 20px;
  }
  .icon-svg { width: 32px; height: 32px; }
  h1 {
    font-size: 20px;
    font-weight: 600;
    color: hsl(210 40% 98%);
    margin-bottom: 8px;
    letter-spacing: -0.01em;
  }
  p {
    color: hsl(215 20.2% 65.1%);
    font-size: 14px;
  }
  p + p { margin-top: 12px; }
  .foot {
    text-align: center;
    margin-top: 24px;
    font-size: 12px;
    color: hsl(215 20.2% 65.1%);
  }
`;

const BRAND_BLOCK = `
  <div class="brand">
    <img src="https://coolhandlabs.com/coolhand-logo.png" alt="Coolhand"
         class="brand-logo"
         onerror="this.style.display='none'; this.nextElementSibling.style.display='inline-flex';">
    <span class="brand-text"><span class="brand-dot"></span>coolhand</span>
  </div>
`;

const SUCCESS_BODY = `
  ${BRAND_BLOCK}
  <div class="card">
    <div class="icon-wrap" style="background: hsl(217.2 91.2% 59.8% / 0.12);">
      <svg class="icon-svg" viewBox="0 0 24 24" fill="none"
           stroke="hsl(217.2 91.2% 59.8%)" stroke-width="2.5"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    </div>
    <h1>Token captured</h1>
    <p>You can close this tab and return to your terminal.</p>
  </div>
  <p class="foot">coolhand-cli received your API token securely.</p>
`;

export const SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Coolhand — Token captured</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="robots" content="noindex">
  <style>${BASE_STYLES}</style>
</head>
<body>
  <main class="wrap">${SUCCESS_BODY}</main>
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
  const body = `
    ${BRAND_BLOCK}
    <div class="card">
      <div class="icon-wrap" style="background: hsl(0 62.8% 30.6% / 0.15);">
        <svg class="icon-svg" viewBox="0 0 24 24" fill="none"
             stroke="hsl(0 84% 60%)" stroke-width="2.5"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </div>
      <h1>Request rejected</h1>
      <p>${safe}</p>
      <p>Return to your terminal for details.</p>
    </div>
  `;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Coolhand — Request rejected</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="robots" content="noindex">
  <style>${BASE_STYLES}</style>
</head>
<body>
  <main class="wrap">${body}</main>
</body>
</html>
`;
}
