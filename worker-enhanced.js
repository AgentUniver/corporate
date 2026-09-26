/**
 * Cloudflare Worker Edge Gateway for agentuniver.com
 * High-Availability Failover between Vercel, Netlify, and Tencent EdgeOne
 */

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname + url.search;

  const PRIMARY = typeof PRIMARY_ORIGIN !== 'undefined' ? PRIMARY_ORIGIN : 'https://vercel.agentuniver.com';
  const SECONDARY = typeof SECONDARY_ORIGIN !== 'undefined' ? SECONDARY_ORIGIN : 'https://netlify.agentuniver.com';
  const TERTIARY = typeof TERTIARY_ORIGIN !== 'undefined' ? TERTIARY_ORIGIN : 'https://qcloud.agentuniver.com';

  const origins = [PRIMARY, SECONDARY, TERTIARY];

  for (let i = 0; i < origins.length; i++) {
    const origin = origins[i];
    try {
      const targetUrl = new URL(path, origin).toString();
      const originReq = new Request(targetUrl, request);
      originReq.headers.set('X-Forwarded-Host', url.hostname);
      originReq.headers.set('X-Gateway', 'Cloudflare-AgentUniver-Edge');

      const response = await fetch(originReq, {
        cf: { cacheTtl: 3600, cacheEverything: true }
      });

      if (response.ok || response.status === 304 || (response.status >= 300 && response.status < 400)) {
        const newHeaders = new Headers(response.headers);
        newHeaders.set('X-Edge-Origin', origin);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });
      }
    } catch (e) {
      // Failover to next origin
    }
  }

  // Fallback when all edge origins are unavailable
  const isApiRequest = url.pathname.startsWith('/api/');
  if (isApiRequest) {
    return new Response(JSON.stringify({
      status: "degraded",
      code: 503,
      gateway: "Cloudflare-AgentUniver-Edge",
      message: "AgentUniver Edge Gateway Fallback: Multi-origin cluster synchronizing.",
      timestamp: new Date().toISOString()
    }), {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '15',
        'X-AgentUniver-Fallback': 'active'
      }
    });
  }

  const fallbackHtml = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgentUniver - Edge Gateway Fallback</title>
  <script defer src="https://umami.wangteng.tech/script.js" data-website-id="149c2d42-6560-4aaf-87de-d4b2b51c3e4c"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: #020617;
      color: #f8fafc;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .container {
      max-width: 640px;
      width: 100%;
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 16px;
      padding: 36px 32px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 4px 10px;
      border-radius: 6px;
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: #34d399;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      margin-bottom: 20px;
    }
    .pulse-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #10b981;
      animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
    h1 {
      font-size: 26px;
      font-weight: 700;
      letter-spacing: -0.025em;
      margin-bottom: 12px;
      color: #ffffff;
    }
    p.lead {
      color: #94a3b8;
      font-size: 14px;
      line-height: 1.6;
      margin-bottom: 24px;
    }
    .metrics-bar {
      display: flex;
      align-items: center;
      justify-content: space-around;
      background: #020617;
      border: 1px solid #1e293b;
      border-radius: 10px;
      padding: 14px;
      margin-bottom: 24px;
    }
    .metric-item {
      text-align: center;
    }
    .metric-num {
      font-family: ui-monospace, monospace;
      font-size: 18px;
      font-weight: 700;
      color: #38bdf8;
    }
    .metric-label {
      font-size: 11px;
      color: #64748b;
      text-transform: uppercase;
      margin-top: 2px;
    }
    .links-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .link-btn {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-radius: 8px;
      border: 1px solid #334155;
      background: #1e293b;
      color: #f8fafc;
      text-decoration: none;
      font-size: 13px;
      font-weight: 500;
      transition: background 0.2s, border-color 0.2s;
    }
    .link-btn:hover {
      background: #334155;
      border-color: #475569;
      color: #ffffff;
    }
    .link-btn.primary {
      background: #10b981;
      color: #020617;
      border-color: #10b981;
      font-weight: 600;
    }
    .link-btn.primary:hover {
      background: #34d399;
    }
    .footer-action {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-top: 16px;
      border-top: 1px solid #1e293b;
      font-size: 12px;
      color: #64748b;
      font-family: ui-monospace, monospace;
    }
    button.retry-btn {
      background: transparent;
      border: 1px solid #334155;
      color: #cbd5e1;
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-family: ui-monospace, monospace;
      font-size: 12px;
      transition: background 0.2s;
    }
    button.retry-btn:hover {
      background: #1e293b;
      color: #ffffff;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="badge">
      <div class="pulse-dot"></div>
      <span>AGENTUNIVER GATEWAY // FAILOVER ACTIVE</span>
    </div>
    <h1>AgentUniver Official Portal</h1>
    <p class="lead">
      Edge clusters (Vercel, Netlify, QCloud) are currently synchronizing latest deployment updates. The gateway has smoothly routed traffic to the sovereign static fallback layer.
    </p>

    <div class="metrics-bar">
      <div class="metric-item">
        <div class="metric-num">2.86M</div>
        <div class="metric-label">Verified Agents</div>
      </div>
      <div class="metric-item">
        <div class="metric-num">237M</div>
        <div class="metric-label">ACP Messages</div>
      </div>
      <div class="metric-item">
        <div class="metric-num">0%</div>
        <div class="metric-label">Genesis Commission</div>
      </div>
    </div>

    <div class="links-grid">
      <a href="https://github.com/AgentUniver" class="link-btn primary" target="_blank" rel="noreferrer">
        <span>Genesis Developer Hub</span>
        <span>&rarr;</span>
      </a>
      <a href="https://x.com/TheAgentMarket" class="link-btn" target="_blank" rel="noreferrer">
        <span>Official X (@TheAgentMarket)</span>
        <span>&rarr;</span>
      </a>
      <a href="https://agentfriendly.network" class="link-btn" target="_blank" rel="noreferrer">
        <span>AFN Consortium Bridge</span>
        <span>&rarr;</span>
      </a>
      <a href="https://github.com/AgentUniver/agentuniver" class="link-btn" target="_blank" rel="noreferrer">
        <span>GitHub Repository</span>
        <span>&rarr;</span>
      </a>
      <a href="mailto:developer@agentuniver.com" class="link-btn">
        <span>Developer Support</span>
        <span>&rarr;</span>
      </a>
    </div>

    <div class="footer-action">
      <span>Auto retry in <strong id="cd">15</strong>s</span>
      <button class="retry-btn" onclick="location.reload()">Retry Now</button>
    </div>
  </div>

  <script>
    let t = 15;
    const cdEl = document.getElementById('cd');
    setInterval(() => {
      t--;
      if (cdEl) cdEl.textContent = t;
      if (t <= 0) location.reload();
    }, 1000);
  </script>
</body>
</html>`;

  return new Response(fallbackHtml, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Retry-After': '15',
      'X-AgentUniver-Fallback': 'active'
    }
  });
}

