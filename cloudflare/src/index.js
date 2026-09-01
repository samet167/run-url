import { neon } from '@neondatabase/serverless';

// -----------------------------------------------------------------------------
// Core Ping Logic
// -----------------------------------------------------------------------------
async function performHttpPing(targetUrl, timeoutMs = 15000) {
  const startTime = Date.now();
  const headers = {
    'User-Agent': 'Render-KeepAlive-Hub/1.0 (+Cloudflare-Worker)',
    'Accept': '*/*',
    'Cache-Control': 'no-cache',
  };

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow'
    });

    const elapsedMs = Date.now() - startTime;
    const statusCode = response.status;

    let statusLabel = `Active ${statusCode}`;
    if (statusCode >= 200 && statusCode < 300) {
      statusLabel = `Active ${statusCode}`;
    } else if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
      statusLabel = `Waking Up (${statusCode})`;
    } else if (statusCode >= 300 && statusCode < 400) {
      statusLabel = `Redirect (${statusCode})`;
    } else if (statusCode >= 400 && statusCode < 500) {
      statusLabel = `Active (${statusCode})`;
    } else {
      statusLabel = `HTTP ${statusCode}`;
    }

    return {
      status: statusLabel,
      http_code: statusCode,
      response_time_ms: elapsedMs,
      error: null
    };
  } catch (err) {
    const elapsedMs = Date.now() - startTime;
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      status: isTimeout ? 'Timeout (>15s)' : 'Failed / Unreachable',
      http_code: isTimeout ? 408 : 0,
      response_time_ms: elapsedMs,
      error: err.message
    };
  }
}

// -----------------------------------------------------------------------------
// Database Operations (Neon DB Serverless)
// -----------------------------------------------------------------------------
function getSql(env) {
  return neon(env.DATABASE_URL);
}

async function ensureTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS monitored_urls (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      url VARCHAR(1024) UNIQUE NOT NULL,
      status VARCHAR(100) DEFAULT 'Pending Initial Ping',
      response_time_ms INT,
      http_code INT,
      last_ping TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `;
}

async function pingAndSaveUrl(sql, id, url) {
  const result = await performHttpPing(url);
  await sql`
    UPDATE monitored_urls
    SET status = ${result.status},
        http_code = ${result.http_code},
        response_time_ms = ${result.response_time_ms},
        last_ping = NOW()
    WHERE id = ${id}
  `;
  return result;
}

async function sweepAllUrls(sql) {
  const urls = await sql`SELECT id, url, name FROM monitored_urls`;
  if (!urls || urls.length === 0) return;

  const pingPromises = urls.map(u => pingAndSaveUrl(sql, u.id, u.url));
  await Promise.allSettled(pingPromises);
}

// -----------------------------------------------------------------------------
// Cloudflare Worker Handlers
// -----------------------------------------------------------------------------
export default {
  // 1. Native Cron Trigger (Runs every 10 mins automatically at Cloudflare Edge)
  async scheduled(event, env, ctx) {
    const sql = getSql(env);
    await ensureTable(sql);
    ctx.waitUntil(sweepAllUrls(sql));
  },

  // 2. HTTP Request Router
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const sql = getSql(env);

    // Ensure database table exists
    try {
      await ensureTable(sql);
    } catch (e) {
      console.error('DB Init Error:', e);
    }

    // CORS Headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Router: Web Dashboard
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(renderDashboardHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // Router: GET /api/urls
    if (url.pathname === '/api/urls' && request.method === 'GET') {
      try {
        const rows = await sql`SELECT * FROM monitored_urls ORDER BY id DESC`;
        return new Response(JSON.stringify(rows), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // Router: POST /api/urls
    if (url.pathname === '/api/urls' && request.method === 'POST') {
      try {
        const body = await request.json();
        let targetUrl = (body.url || '').trim();
        const name = (body.name || '').trim();

        if (!name || !targetUrl) {
          return new Response(JSON.stringify({ detail: 'Project name and URL are required.' }), {
            status: 400,
            headers: corsHeaders
          });
        }

        if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
          targetUrl = 'https://' + targetUrl;
        }

        // Insert into Neon DB
        const inserted = await sql`
          INSERT INTO monitored_urls (name, url, status)
          VALUES (${name}, ${targetUrl}, 'Waking Up...')
          ON CONFLICT (url) DO UPDATE SET name = EXCLUDED.name
          RETURNING *
        `;

        const newRec = inserted[0];
        // Trigger immediate background ping
        ctx.waitUntil(pingAndSaveUrl(sql, newRec.id, newRec.url));

        return new Response(JSON.stringify({
          success: true,
          message: `Successfully added '${name}'. Health check triggered.`,
          data: newRec
        }), { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ detail: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // Router: DELETE /api/urls/:id
    if (url.pathname.startsWith('/api/urls/') && request.method === 'DELETE') {
      const id = parseInt(url.pathname.split('/').pop(), 10);
      if (isNaN(id)) {
        return new Response(JSON.stringify({ detail: 'Invalid ID' }), { status: 400, headers: corsHeaders });
      }
      try {
        await sql`DELETE FROM monitored_urls WHERE id = ${id}`;
        return new Response(JSON.stringify({ success: true, message: 'Target removed from monitoring.' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ detail: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // Router: POST /api/ping/:id
    if (url.pathname.startsWith('/api/ping/') && request.method === 'POST') {
      const id = parseInt(url.pathname.split('/').pop(), 10);
      if (isNaN(id)) {
        return new Response(JSON.stringify({ detail: 'Invalid ID' }), { status: 400, headers: corsHeaders });
      }
      try {
        const rows = await sql`SELECT * FROM monitored_urls WHERE id = ${id}`;
        if (!rows || rows.length === 0) {
          return new Response(JSON.stringify({ detail: 'Target not found' }), { status: 404, headers: corsHeaders });
        }
        const pingRes = await pingAndSaveUrl(sql, id, rows[0].url);
        return new Response(JSON.stringify({ success: true, data: { ...rows[0], ...pingRes } }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ detail: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // Router: POST /api/ping-all
    if (url.pathname === '/api/ping-all' && request.method === 'POST') {
      ctx.waitUntil(sweepAllUrls(sql));
      return new Response(JSON.stringify({ success: true, message: 'Sweep started across all targets!' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Router: GET /api/stats
    if (url.pathname === '/api/stats' && request.method === 'GET') {
      try {
        const rows = await sql`SELECT status FROM monitored_urls`;
        const total = rows.length;
        const alive = rows.filter(r => r.status && r.status.startsWith('Active')).length;
        const waking = rows.filter(r => r.status && (r.status.includes('Waking') || r.status.includes('Redirect'))).length;
        const failed = rows.filter(r => r.status && (r.status.includes('Failed') || r.status.includes('Timeout') || r.status.includes('Unreachable'))).length;

        return new Response(JSON.stringify({
          total,
          alive,
          waking,
          failed,
          cron_schedule: 'Every 10 Minutes (Native Cloudflare Edge Cron)'
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // Router: GET /api/health
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return new Response(JSON.stringify({
        status: 'ok',
        platform: 'Cloudflare Workers (Edge)',
        database: 'Neon PostgreSQL Serverless',
        cron: 'Active (*/10 * * * *)',
        timestamp: new Date().toISOString()
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response('404 Not Found', { status: 404, headers: corsHeaders });
  }
};

// -----------------------------------------------------------------------------
// Responsive Dashboard HTML (Single File Edge Distribution)
// -----------------------------------------------------------------------------
function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Render 24/7 Keep-Alive Hub (Cloudflare Edge)</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/lucide@latest"></script>
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    fontFamily: {
                        sans: ['"Plus Jakarta Sans"', 'sans-serif'],
                        mono: ['"JetBrains Mono"', 'monospace'],
                    },
                    screens: { 'xs': '420px' }
                }
            }
        }
    </script>
    <style>
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: #0f172a; }
        ::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
        .glass-panel {
            background: rgba(15, 23, 42, 0.75);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border: 1px solid rgba(51, 65, 85, 0.6);
        }
        button, a, input { -webkit-tap-highlight-color: transparent; }
    </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen font-sans antialiased selection:bg-orange-500 selection:text-white flex flex-col">

    <div class="fixed top-0 left-1/2 -translate-x-1/2 w-full max-w-7xl h-64 bg-gradient-to-b from-orange-600/15 via-emerald-600/5 to-transparent blur-3xl pointer-events-none -z-10"></div>

    <header class="sticky top-0 z-40 border-b border-slate-800/80 bg-slate-950/90 backdrop-blur-md">
        <div class="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-2">
            <div class="flex items-center gap-2.5 min-w-0">
                <div class="relative flex items-center justify-center w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-br from-orange-500 to-amber-600 shadow-lg shadow-orange-500/20 text-white font-bold shrink-0">
                    <i data-lucide="cloud-lightning" class="w-4 h-4 sm:w-5 sm:h-5"></i>
                    <span class="absolute -top-1 -right-1 flex h-2.5 w-2.5 sm:h-3 sm:w-3">
                        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span class="relative inline-flex rounded-full h-2.5 w-2.5 sm:h-3 sm:w-3 bg-emerald-500"></span>
                    </span>
                </div>
                <div class="truncate">
                    <h1 class="text-sm sm:text-base md:text-lg font-bold tracking-tight text-white flex items-center gap-1.5 truncate">
                        <span>Keep-Alive Hub</span>
                        <span class="text-[10px] sm:text-xs px-1.5 sm:px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-400 font-semibold border border-orange-500/30">Cloudflare Edge 24/7</span>
                    </h1>
                    <p class="hidden xs:block text-[11px] text-slate-400 truncate">Native Edge Cron &bull; Auto-ping every 10 min</p>
                </div>
            </div>

            <div class="flex items-center gap-1.5 sm:gap-3 shrink-0">
                <div class="flex items-center gap-1.5 text-[11px] sm:text-xs text-slate-400 bg-slate-900/90 border border-slate-800 px-2 sm:px-2.5 py-1.5 rounded-lg">
                    <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                    <span class="hidden xs:inline">Sync in</span>
                    <strong id="refresh-countdown" class="text-slate-200 font-mono">15s</strong>
                </div>

                <button onclick="triggerPingAll()" id="btn-sweep-all" class="inline-flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-orange-600 hover:bg-orange-500 text-white shadow-sm shadow-orange-900/40 transition active:scale-95 cursor-pointer">
                    <i data-lucide="activity" class="w-3.5 h-3.5"></i>
                    <span class="hidden sm:inline">Sweep All</span>
                </button>

                <button onclick="fetchData(true)" title="Manual Refresh" class="p-1.5 sm:p-2 rounded-lg text-slate-400 hover:text-slate-200 bg-slate-900 hover:bg-slate-800 border border-slate-800 transition active:scale-95 cursor-pointer">
                    <i data-lucide="rotate-cw" id="refresh-icon" class="w-3.5 h-3.5 sm:w-4 sm:h-4"></i>
                </button>
            </div>
        </div>
    </header>

    <main class="flex-1 max-w-7xl w-full mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-8 space-y-4 sm:space-y-6">
        <section class="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-4">
            <div class="glass-panel p-3.5 sm:p-5 rounded-xl sm:rounded-2xl relative overflow-hidden group">
                <div class="flex items-center justify-between">
                    <span class="text-[10px] sm:text-xs font-medium text-slate-400 uppercase tracking-wider">Total</span>
                    <div class="p-1.5 sm:p-2 rounded-lg sm:rounded-xl bg-slate-800/80 text-slate-300">
                        <i data-lucide="server" class="w-3.5 h-3.5 sm:w-4 sm:h-4"></i>
                    </div>
                </div>
                <div class="mt-2 sm:mt-3 flex items-baseline gap-1 sm:gap-2">
                    <span id="metric-total" class="text-2xl sm:text-3xl font-extrabold text-white font-mono">0</span>
                    <span class="text-[10px] sm:text-xs text-slate-400">endpoints</span>
                </div>
            </div>

            <div class="glass-panel p-3.5 sm:p-5 rounded-xl sm:rounded-2xl relative overflow-hidden group border-emerald-500/20">
                <div class="flex items-center justify-between">
                    <span class="text-[10px] sm:text-xs font-medium text-emerald-400 uppercase tracking-wider">Awake</span>
                    <div class="p-1.5 sm:p-2 rounded-lg sm:rounded-xl bg-emerald-950/60 text-emerald-400 border border-emerald-500/20">
                        <i data-lucide="check-circle-2" class="w-3.5 h-3.5 sm:w-4 sm:h-4"></i>
                    </div>
                </div>
                <div class="mt-2 sm:mt-3 flex items-baseline gap-1 sm:gap-2">
                    <span id="metric-alive" class="text-2xl sm:text-3xl font-extrabold text-emerald-400 font-mono">0</span>
                    <span class="text-[10px] sm:text-xs text-slate-400">online</span>
                </div>
            </div>

            <div class="glass-panel p-3.5 sm:p-5 rounded-xl sm:rounded-2xl relative overflow-hidden group border-amber-500/20">
                <div class="flex items-center justify-between">
                    <span class="text-[10px] sm:text-xs font-medium text-amber-400 uppercase tracking-wider">Waking</span>
                    <div class="p-1.5 sm:p-2 rounded-lg sm:rounded-xl bg-amber-950/60 text-amber-400 border border-amber-500/20">
                        <i data-lucide="loader-2" class="w-3.5 h-3.5 sm:w-4 sm:h-4"></i>
                    </div>
                </div>
                <div class="mt-2 sm:mt-3 flex items-baseline gap-1 sm:gap-2">
                    <span id="metric-waking" class="text-2xl sm:text-3xl font-extrabold text-amber-400 font-mono">0</span>
                    <span class="text-[10px] sm:text-xs text-slate-400">cold boot</span>
                </div>
            </div>

            <div class="glass-panel p-3.5 sm:p-5 rounded-xl sm:rounded-2xl relative overflow-hidden group border-rose-500/20">
                <div class="flex items-center justify-between">
                    <span class="text-[10px] sm:text-xs font-medium text-rose-400 uppercase tracking-wider">Offline</span>
                    <div class="p-1.5 sm:p-2 rounded-lg sm:rounded-xl bg-rose-950/60 text-rose-400 border border-rose-500/20">
                        <i data-lucide="alert-triangle" class="w-3.5 h-3.5 sm:w-4 sm:h-4"></i>
                    </div>
                </div>
                <div class="mt-2 sm:mt-3 flex items-baseline gap-1 sm:gap-2">
                    <span id="metric-failed" class="text-2xl sm:text-3xl font-extrabold text-rose-400 font-mono">0</span>
                    <span class="text-[10px] sm:text-xs text-slate-400">failed</span>
                </div>
            </div>
        </section>

        <section class="glass-panel p-4 sm:p-6 rounded-xl sm:rounded-2xl shadow-xl shadow-black/40">
            <div class="flex items-center gap-2 mb-3 sm:mb-4">
                <i data-lucide="plus-circle" class="w-4 h-4 sm:w-5 sm:h-5 text-orange-400"></i>
                <h2 class="text-sm sm:text-base font-bold text-white">Register Target Render Deployment</h2>
            </div>
            
            <form id="add-url-form" onsubmit="handleAddUrl(event)" class="grid grid-cols-1 md:grid-cols-12 gap-3 sm:gap-4 items-end">
                <div class="md:col-span-4">
                    <label for="project-name" class="block text-xs font-medium text-slate-300 mb-1">
                        Project Name <span class="text-rose-400">*</span>
                    </label>
                    <div class="relative">
                        <span class="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-slate-500">
                            <i data-lucide="box" class="w-4 h-4"></i>
                        </span>
                        <input type="text" id="project-name" required placeholder="e.g. Pharmacy POS Backend" 
                               class="w-full h-11 bg-slate-900/90 border border-slate-700/80 rounded-xl pl-9 pr-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent transition">
                    </div>
                </div>

                <div class="md:col-span-6">
                    <label for="target-url" class="block text-xs font-medium text-slate-300 mb-1">
                        Render URL (Health Check Endpoint) <span class="text-rose-400">*</span>
                    </label>
                    <div class="relative">
                        <span class="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-slate-500">
                            <i data-lucide="globe" class="w-4 h-4"></i>
                        </span>
                        <input type="text" id="target-url" required placeholder="https://my-backend.onrender.com/" 
                               class="w-full h-11 bg-slate-900/90 border border-slate-700/80 rounded-xl pl-9 pr-3 text-sm text-white font-mono placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent transition">
                    </div>
                </div>

                <div class="md:col-span-2">
                    <button type="submit" id="btn-submit-url" class="w-full h-11 inline-flex items-center justify-center gap-2 px-4 rounded-xl font-semibold text-sm bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 text-white shadow-lg shadow-orange-950/50 transition active:scale-[0.98] cursor-pointer">
                        <i data-lucide="plus" class="w-4 h-4"></i>
                        <span>Monitor URL</span>
                    </button>
                </div>
            </form>
        </section>

        <section class="glass-panel rounded-xl sm:rounded-2xl overflow-hidden shadow-xl shadow-black/40">
            <div class="px-4 sm:px-6 py-3.5 sm:py-4 border-b border-slate-800 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                <div class="flex items-center justify-between sm:justify-start gap-2">
                    <div class="flex items-center gap-2">
                        <i data-lucide="list-checks" class="w-4 h-4 sm:w-5 sm:h-5 text-orange-400"></i>
                        <h2 class="text-sm sm:text-base font-bold text-white">Active Monitored Targets</h2>
                    </div>
                    <span id="badge-count" class="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 font-mono">0 items</span>
                </div>
                
                <div class="w-full sm:w-64 relative">
                    <span class="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-slate-500">
                        <i data-lucide="search" class="w-3.5 h-3.5"></i>
                    </span>
                    <input type="text" id="filter-input" oninput="filterUrls()" placeholder="Search project or URL..." 
                           class="w-full h-9 bg-slate-900 border border-slate-800 rounded-lg pl-8 pr-3 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-orange-500">
                </div>
            </div>

            <div id="mobile-cards-container" class="block md:hidden divide-y divide-slate-800/80 p-2 sm:p-3 space-y-3"></div>

            <div class="hidden md:block overflow-x-auto">
                <table class="w-full text-left text-sm">
                    <thead class="bg-slate-900/70 border-b border-slate-800 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                        <tr>
                            <th scope="col" class="px-6 py-3.5">Project</th>
                            <th scope="col" class="px-6 py-3.5">Target URL</th>
                            <th scope="col" class="px-6 py-3.5">Live Status</th>
                            <th scope="col" class="px-6 py-3.5">Latency</th>
                            <th scope="col" class="px-6 py-3.5">Last Checked</th>
                            <th scope="col" class="px-6 py-3.5 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody id="url-table-body" class="divide-y divide-slate-800/60 font-normal"></tbody>
                </table>
            </div>

            <div id="empty-state-view" class="hidden px-4 py-12 text-center text-slate-500">
                <div class="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-slate-900/80 border border-slate-800 text-slate-400 mb-3">
                    <i data-lucide="radio" class="w-6 h-6"></i>
                </div>
                <h3 class="text-sm font-semibold text-slate-300">No Target URLs Registered</h3>
                <p class="text-xs text-slate-500 mt-1 max-w-sm mx-auto">Add your Render web services above. Cloudflare Native Edge Crons will keep them awake 24/7.</p>
            </div>
        </section>
    </main>

    <footer class="border-t border-slate-900 py-6 text-center text-xs text-slate-500 px-4">
        <p>Render 24/7 Keep-Alive Hub &bull; Running on Cloudflare Workers &bull; Neon PostgreSQL</p>
    </footer>

    <div id="toast-container" class="fixed bottom-4 inset-x-3 sm:inset-x-auto sm:right-5 z-50 flex flex-col gap-2 pointer-events-none"></div>

    <script>
        let allUrls = [];
        let refreshTimer = null;
        let countdown = 15;

        document.addEventListener('DOMContentLoaded', () => {
            lucide.createIcons();
            fetchData();
            startCountdown();
        });

        async function fetchData(manual = false) {
            const icon = document.getElementById('refresh-icon');
            if (manual && icon) icon.classList.add('animate-spin');

            try {
                const [urlsRes, statsRes] = await Promise.all([
                    fetch('/api/urls'),
                    fetch('/api/stats')
                ]);

                if (!urlsRes.ok || !statsRes.ok) throw new Error('Failed to fetch data');

                allUrls = await urlsRes.json();
                const stats = await statsRes.json();

                updateStats(stats);
                renderAll(allUrls);
                countdown = 15;

                if (manual) showToast('Data synchronized successfully', 'info');
            } catch (err) {
                console.error('Fetch error:', err);
                if (manual) showToast('Failed to connect to Cloudflare Worker API.', 'error');
            } finally {
                if (icon) setTimeout(() => icon.classList.remove('animate-spin'), 600);
            }
        }

        function startCountdown() {
            if (refreshTimer) clearInterval(refreshTimer);
            refreshTimer = setInterval(() => {
                countdown--;
                const elem = document.getElementById('refresh-countdown');
                if (elem) elem.innerText = countdown + 's';

                if (countdown <= 0) {
                    countdown = 15;
                    fetchData();
                }
            }, 1000);
        }

        function updateStats(stats) {
            document.getElementById('metric-total').innerText = stats.total || 0;
            document.getElementById('metric-alive').innerText = stats.alive || 0;
            document.getElementById('metric-waking').innerText = stats.waking || 0;
            document.getElementById('metric-failed').innerText = stats.failed || 0;
            document.getElementById('badge-count').innerText = (stats.total || 0) + ' items';
        }

        function formatRelativeTime(isoString) {
            if (!isoString) return 'Never checked';
            const date = new Date(isoString);
            const now = new Date();
            const diffSeconds = Math.floor((now - date) / 1000);

            if (diffSeconds < 5) return 'Just now';
            if (diffSeconds < 60) return diffSeconds + 's ago';
            const diffMins = Math.floor(diffSeconds / 60);
            if (diffMins < 60) return diffMins + 'm ago';
            const diffHours = Math.floor(diffMins / 60);
            if (diffHours < 24) return diffHours + 'h ago';
            return date.toLocaleDateString();
        }

        function getStatusBadge(status, httpCode) {
            if (!status || status === 'Pending Initial Ping') {
                return '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 sm:py-1 rounded-full text-[11px] sm:text-xs font-semibold bg-slate-800 text-slate-300 border border-slate-700"><span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span> Pending</span>';
            }
            if (status.startsWith('Active')) {
                return '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 sm:py-1 rounded-full text-[11px] sm:text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shadow-sm shadow-emerald-500/10"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> ' + status + '</span>';
            }
            if (status.includes('Waking') || status.includes('Redirect')) {
                return '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 sm:py-1 rounded-full text-[11px] sm:text-xs font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30 shadow-sm shadow-amber-500/10"><span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span> ' + status + '</span>';
            }
            return '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 sm:py-1 rounded-full text-[11px] sm:text-xs font-semibold bg-rose-500/15 text-rose-400 border border-rose-500/30 shadow-sm shadow-rose-500/10"><span class="w-1.5 h-1.5 rounded-full bg-rose-400"></span> ' + status + '</span>';
        }

        function getLatencyBadge(ms) {
            if (ms === null || ms === undefined) return '<span class="text-slate-500 font-mono text-xs">--</span>';
            let color = 'text-emerald-400';
            if (ms > 1000) color = 'text-amber-400';
            if (ms > 4000) color = 'text-rose-400';
            return '<span class="font-mono text-xs font-medium ' + color + '">' + ms + ' ms</span>';
        }

        function renderAll(urls) {
            const emptyView = document.getElementById('empty-state-view');
            const tbody = document.getElementById('url-table-body');
            const mobileContainer = document.getElementById('mobile-cards-container');

            if (!urls || urls.length === 0) {
                emptyView.classList.remove('hidden');
                tbody.innerHTML = '';
                mobileContainer.innerHTML = '';
                lucide.createIcons();
                return;
            }

            emptyView.classList.add('hidden');

            mobileContainer.innerHTML = urls.map(item => \`
                <div class="glass-panel p-4 rounded-xl border border-slate-800/90 space-y-3">
                    <div class="flex items-start justify-between gap-2">
                        <div>
                            <h3 class="font-bold text-slate-100 text-sm">\${escapeHtml(item.name)}</h3>
                            <span class="text-[11px] text-slate-500">Added \${formatRelativeTime(item.created_at)}</span>
                        </div>
                        <div>\${getStatusBadge(item.status, item.http_code)}</div>
                    </div>
                    <div class="bg-slate-900/80 border border-slate-800 rounded-lg p-2.5 flex items-center justify-between gap-2">
                        <a href="\${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="font-mono text-xs text-orange-400 hover:underline truncate">
                            \${escapeHtml(item.url)}
                        </a>
                        <div class="flex items-center gap-1 shrink-0">
                            <button onclick="copyToClipboard('\${escapeHtml(item.url)}')" title="Copy URL" class="p-1.5 text-slate-400 hover:text-white rounded bg-slate-800 cursor-pointer">
                                <i data-lucide="copy" class="w-3.5 h-3.5"></i>
                            </button>
                            <a href="\${escapeHtml(item.url)}" target="_blank" class="p-1.5 text-slate-400 hover:text-white rounded bg-slate-800">
                                <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
                            </a>
                        </div>
                    </div>
                    <div class="grid grid-cols-2 gap-2 text-xs py-1 border-t border-slate-800/60">
                        <div>
                            <span class="text-slate-500 block text-[10px] uppercase">Latency</span>
                            \${getLatencyBadge(item.response_time_ms)}
                        </div>
                        <div>
                            <span class="text-slate-500 block text-[10px] uppercase">Last Checked</span>
                            <span class="text-slate-300 font-medium">\${formatRelativeTime(item.last_ping)}</span>
                        </div>
                    </div>
                    <div class="grid grid-cols-2 gap-2 pt-1">
                        <button onclick="triggerPing(\${item.id}, this)" class="w-full h-9 inline-flex items-center justify-center gap-1.5 rounded-lg bg-orange-600/20 hover:bg-orange-600/30 text-orange-300 border border-orange-500/30 text-xs font-semibold active:scale-95 transition cursor-pointer">
                            <i data-lucide="zap" class="w-3.5 h-3.5"></i>
                            <span>Ping Now</span>
                        </button>
                        <button onclick="deleteUrl(\${item.id}, '\${escapeHtml(item.name)}')" class="w-full h-9 inline-flex items-center justify-center gap-1.5 rounded-lg bg-rose-600/15 hover:bg-rose-600/25 text-rose-300 border border-rose-500/30 text-xs font-semibold active:scale-95 transition cursor-pointer">
                            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                            <span>Delete</span>
                        </button>
                    </div>
                </div>
            \`).join('');

            tbody.innerHTML = urls.map(item => \`
                <tr class="hover:bg-slate-900/50 transition duration-150 group">
                    <td class="px-6 py-4 whitespace-nowrap">
                        <div class="font-semibold text-slate-200">\${escapeHtml(item.name)}</div>
                        <div class="text-[11px] text-slate-500">Added \${formatRelativeTime(item.created_at)}</div>
                    </td>
                    <td class="px-6 py-4 max-w-xs truncate">
                        <div class="flex items-center gap-2">
                            <a href="\${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="font-mono text-xs text-orange-400 hover:underline truncate">
                                \${escapeHtml(item.url)}
                            </a>
                            <button onclick="copyToClipboard('\${escapeHtml(item.url)}')" title="Copy URL" class="text-slate-500 hover:text-slate-300 opacity-0 group-hover:opacity-100 transition cursor-pointer">
                                <i data-lucide="copy" class="w-3.5 h-3.5"></i>
                            </button>
                        </div>
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap">\${getStatusBadge(item.status, item.http_code)}</td>
                    <td class="px-6 py-4 whitespace-nowrap">\${getLatencyBadge(item.response_time_ms)}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-xs text-slate-400">\${formatRelativeTime(item.last_ping)}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-right text-xs font-medium space-x-2">
                        <button onclick="triggerPing(\${item.id}, this)" class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-orange-600 text-slate-300 hover:text-white border border-slate-700 transition cursor-pointer">
                            <i data-lucide="zap" class="w-3.5 h-3.5"></i>
                            <span>Ping</span>
                        </button>
                        <button onclick="deleteUrl(\${item.id}, '\${escapeHtml(item.name)}')" class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-rose-600 text-slate-300 hover:text-white border border-slate-700 transition cursor-pointer">
                            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                        </button>
                    </td>
                </tr>
            \`).join('');

            lucide.createIcons();
        }

        async function handleAddUrl(event) {
            event.preventDefault();
            const name = document.getElementById('project-name').value.trim();
            const url = document.getElementById('target-url').value.trim();
            const submitBtn = document.getElementById('btn-submit-url');

            submitBtn.disabled = true;
            submitBtn.innerHTML = '<span>Adding...</span>';

            try {
                const res = await fetch('/api/urls', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, url })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || 'Failed');
                showToast(data.message || 'Added successfully!', 'success');
                document.getElementById('project-name').value = '';
                document.getElementById('target-url').value = '';
                fetchData();
            } catch (err) {
                showToast(err.message, 'error');
            } finally {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i data-lucide="plus" class="w-4 h-4"></i><span>Monitor URL</span>';
                lucide.createIcons();
            }
        }

        async function triggerPing(id, btn) {
            btn.disabled = true;
            try {
                const res = await fetch('/api/ping/' + id, { method: 'POST' });
                const data = await res.json();
                showToast('Pinged target: ' + data.data.status, 'success');
                fetchData();
            } catch (err) {
                showToast('Ping error: ' + err.message, 'error');
            } finally {
                btn.disabled = false;
            }
        }

        async function triggerPingAll() {
            try {
                const res = await fetch('/api/ping-all', { method: 'POST' });
                const data = await res.json();
                showToast(data.message, 'info');
                setTimeout(fetchData, 2000);
            } catch (err) {
                showToast('Error: ' + err.message, 'error');
            }
        }

        async function deleteUrl(id, name) {
            if (!confirm('Stop monitoring ' + name + '?')) return;
            try {
                const res = await fetch('/api/urls/' + id, { method: 'DELETE' });
                showToast('Removed ' + name, 'info');
                fetchData();
            } catch (err) {
                showToast('Delete failed: ' + err.message, 'error');
            }
        }

        function filterUrls() {
            const q = document.getElementById('filter-input').value.toLowerCase();
            renderAll(allUrls.filter(u => u.name.toLowerCase().includes(q) || u.url.toLowerCase().includes(q)));
        }

        function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard', 'info'));
        }

        function escapeHtml(str) {
            if (!str) return '';
            return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
        }

        function showToast(message, type = 'info') {
            const container = document.getElementById('toast-container');
            const toast = document.createElement('div');
            toast.className = 'pointer-events-auto flex items-center gap-2.5 px-4 py-3 rounded-xl text-xs font-medium shadow-2xl backdrop-blur-md border transition-all duration-300 ' + (
                type === 'success' ? 'bg-emerald-950/95 text-emerald-200 border-emerald-500/40' :
                type === 'error' ? 'bg-rose-950/95 text-rose-200 border-rose-500/40' :
                'bg-slate-900/95 text-slate-200 border-slate-700/80'
            );
            toast.innerHTML = '<span>' + escapeHtml(message) + '</span>';
            container.appendChild(toast);
            setTimeout(() => toast.remove(), 3500);
        }
    </script>
</body>
</html>`;
}
