import { neon } from '@neondatabase/serverless';

const GOOGLE_CLIENT_ID = '1015295193209-pqllnd3a5d5m1m11nu4hvkvfdpbapm87.apps.googleusercontent.com';

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
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      google_id VARCHAR(255) UNIQUE NOT NULL,
      email VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      picture VARCHAR(1024),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS monitored_urls (
      id SERIAL PRIMARY KEY,
      user_id INT,
      user_email VARCHAR(255),
      name VARCHAR(255) NOT NULL,
      url VARCHAR(1024) NOT NULL,
      status VARCHAR(100) DEFAULT 'Pending Initial Ping',
      response_time_ms INT,
      http_code INT,
      is_active BOOLEAN DEFAULT TRUE,
      last_ping TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `;
  try {
    await sql`ALTER TABLE monitored_urls ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;`;
    await sql`ALTER TABLE monitored_urls ADD COLUMN IF NOT EXISTS user_id INT;`;
    await sql`ALTER TABLE monitored_urls ADD COLUMN IF NOT EXISTS user_email VARCHAR(255);`;
  } catch (e) {
    // Columns already exist
  }
}

async function pingAndSaveUrl(sql, id, url) {
  const result = await performHttpPing(url);
  await sql`
    UPDATE monitored_urls
    SET status = ${result.status},
        http_code = ${result.http_code},
        response_time_ms = ${result.response_time_ms},
        last_ping = NOW()
    WHERE id = ${id} AND is_active = TRUE
  `;
  return result;
}

async function sweepAllUrls(sql) {
  // Pings all active URLs across all users to keep everyone's apps awake 24/7
  const urls = await sql`SELECT id, url, name FROM monitored_urls WHERE is_active = TRUE`;
  if (!urls || urls.length === 0) return;

  const pingPromises = urls.map(u => pingAndSaveUrl(sql, u.id, u.url));
  await Promise.allSettled(pingPromises);
}

// -----------------------------------------------------------------------------
// Google Authentication Verification
// -----------------------------------------------------------------------------
async function verifyGoogleToken(authHeader, sql) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Authentication required. Please sign in with Google.');
  }

  const token = authHeader.split(' ')[1].trim();
  if (!token) throw new Error('Empty authentication token.');

  // Validate token via Google tokeninfo endpoint
  const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
  if (!verifyRes.ok) {
    throw new Error('Google token expired or invalid. Please sign in again.');
  }

  const idinfo = await verifyRes.json();
  const googleId = idinfo.sub;
  const email = (idinfo.email || '').toLowerCase();
  const name = idinfo.name || email.split('@')[0];
  const picture = idinfo.picture || '';

  if (!googleId || !email) {
    throw new Error('Invalid Google token claims.');
  }

  // Find or upsert user in DB
  const existingUsers = await sql`SELECT * FROM users WHERE google_id = ${googleId} OR email = ${email} LIMIT 1`;
  let user;
  if (existingUsers && existingUsers.length > 0) {
    user = existingUsers[0];
    await sql`UPDATE users SET name = ${name}, picture = ${picture}, email = ${email} WHERE id = ${user.id}`;
  } else {
    const inserted = await sql`
      INSERT INTO users (google_id, email, name, picture)
      VALUES (${googleId}, ${email}, ${name}, ${picture})
      RETURNING *
    `;
    user = inserted[0];
  }

  return { id: user.id, google_id: googleId, email, name, picture };
}

// -----------------------------------------------------------------------------
// Cloudflare Worker Handlers
// -----------------------------------------------------------------------------
export default {
  // 1. Native Cron Trigger (Every 10 mins at Cloudflare Edge)
  async scheduled(event, env, ctx) {
    const sql = getSql(env);
    await ensureTable(sql);
    ctx.waitUntil(sweepAllUrls(sql));
  },

  // 2. HTTP Request Router
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const sql = getSql(env);

    try {
      await ensureTable(sql);
    } catch (e) {
      console.error('DB Init Error:', e);
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Web Dashboard UI
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(renderDashboardHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // Self Health Check (Public)
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return new Response(JSON.stringify({
        status: 'ok',
        platform: 'Cloudflare Workers (Edge)',
        database: 'Neon PostgreSQL Serverless',
        cron: 'Active (*/10 * * * *)',
        timestamp: new Date().toISOString()
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Authenticated Routes
    const authHeader = request.headers.get('Authorization');
    let currentUser;
    try {
      if (url.pathname.startsWith('/api/')) {
        currentUser = await verifyGoogleToken(authHeader, sql);
      }
    } catch (authErr) {
      return new Response(JSON.stringify({ detail: authErr.message }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Router: GET /api/me
    if (url.pathname === '/api/me' && request.method === 'GET') {
      return new Response(JSON.stringify({ success: true, user: currentUser }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Router: GET /api/urls (Isolated to Current User)
    if (url.pathname === '/api/urls' && request.method === 'GET') {
      try {
        const rows = await sql`
          SELECT * FROM monitored_urls
          WHERE user_id = ${currentUser.id} OR user_email = ${currentUser.email}
          ORDER BY id DESC
        `;
        return new Response(JSON.stringify(rows), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // Router: POST /api/urls (Add URL under Current User)
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

        const inserted = await sql`
          INSERT INTO monitored_urls (user_id, user_email, name, url, status, is_active)
          VALUES (${currentUser.id}, ${currentUser.email}, ${name}, ${targetUrl}, 'Waking Up...', TRUE)
          RETURNING *
        `;

        const newRec = inserted[0];
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

    // Router: POST /api/urls/:id/toggle (Pause / Resume)
    if (url.pathname.match(/^\/api\/urls\/\d+\/toggle$/) && request.method === 'POST') {
      const id = parseInt(url.pathname.split('/')[3], 10);
      try {
        const rows = await sql`
          SELECT * FROM monitored_urls
          WHERE id = ${id} AND (user_id = ${currentUser.id} OR user_email = ${currentUser.email})
        `;
        if (!rows || rows.length === 0) {
          return new Response(JSON.stringify({ detail: 'Target not found in your account' }), { status: 404, headers: corsHeaders });
        }

        const current = rows[0];
        const nextActive = !current.is_active;
        const nextStatus = nextActive ? 'Resuming...' : 'Paused';

        const updated = await sql`
          UPDATE monitored_urls
          SET is_active = ${nextActive}, status = ${nextStatus}
          WHERE id = ${id}
          RETURNING *
        `;

        const updatedRec = updated[0];
        if (nextActive) {
          ctx.waitUntil(pingAndSaveUrl(sql, id, updatedRec.url));
        }

        const stateStr = nextActive ? 'Resumed (Active)' : 'Paused';
        return new Response(JSON.stringify({
          success: true,
          message: `'${updatedRec.name}' is now ${stateStr}.`,
          data: updatedRec
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ detail: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // Router: DELETE /api/urls/:id
    if (url.pathname.startsWith('/api/urls/') && request.method === 'DELETE') {
      const id = parseInt(url.pathname.split('/').pop(), 10);
      try {
        await sql`
          DELETE FROM monitored_urls
          WHERE id = ${id} AND (user_id = ${currentUser.id} OR user_email = ${currentUser.email})
        `;
        return new Response(JSON.stringify({ success: true, message: 'Target removed from your monitor.' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ detail: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // Router: POST /api/ping/:id
    if (url.pathname.startsWith('/api/ping/') && request.method === 'POST') {
      const id = parseInt(url.pathname.split('/').pop(), 10);
      try {
        const rows = await sql`
          SELECT * FROM monitored_urls
          WHERE id = ${id} AND (user_id = ${currentUser.id} OR user_email = ${currentUser.email})
        `;
        if (!rows || rows.length === 0) {
          return new Response(JSON.stringify({ detail: 'Target not found in your account' }), { status: 404, headers: corsHeaders });
        }
        const pingRes = await performHttpPing(rows[0].url);
        await sql`
          UPDATE monitored_urls
          SET status = ${pingRes.status},
              http_code = ${pingRes.http_code},
              response_time_ms = ${pingRes.response_time_ms},
              last_ping = NOW()
          WHERE id = ${id}
        `;
        return new Response(JSON.stringify({ success: true, data: { ...rows[0], ...pingRes } }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ detail: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // Router: POST /api/ping-all
    if (url.pathname === '/api/ping-all' && request.method === 'POST') {
      const rows = await sql`
        SELECT id, url FROM monitored_urls
        WHERE (user_id = ${currentUser.id} OR user_email = ${currentUser.email}) AND is_active = TRUE
      `;
      ctx.waitUntil(Promise.allSettled(rows.map(r => pingAndSaveUrl(sql, r.id, r.url))));
      return new Response(JSON.stringify({ success: true, message: 'Sweep started for your active targets!' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Router: GET /api/stats (User Isolated)
    if (url.pathname === '/api/stats' && request.method === 'GET') {
      try {
        const rows = await sql`
          SELECT status, is_active FROM monitored_urls
          WHERE user_id = ${currentUser.id} OR user_email = ${currentUser.email}
        `;
        const total = rows.length;
        const alive = rows.filter(r => r.is_active && r.status && r.status.startsWith('Active')).length;
        const waking = rows.filter(r => r.is_active && r.status && (r.status.includes('Waking') || r.status.includes('Redirect'))).length;
        const failed = rows.filter(r => r.is_active && r.status && (r.status.includes('Failed') || r.status.includes('Timeout') || r.status.includes('Unreachable'))).length;
        const paused = rows.filter(r => !r.is_active).length;

        return new Response(JSON.stringify({
          total,
          alive,
          waking,
          failed,
          paused,
          cron_schedule: 'Every 10 Minutes (Native Cloudflare Edge Cron)'
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response('404 Not Found', { status: 404, headers: corsHeaders });
  }
};

// -----------------------------------------------------------------------------
// Cloudflare Worker Embedded Dashboard HTML
// -----------------------------------------------------------------------------
function renderDashboardHtml() {
  // Serves the multi-user HTML dashboard
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Render 24/7 Keep-Alive Hub | Cloudflare Edge</title>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/lucide@latest"></script>
    <script src="https://accounts.google.com/gsi/client" async defer></script>
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
                        <span class="text-[10px] sm:text-xs px-1.5 sm:px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-400 font-semibold border border-orange-500/30">Edge Multi-User</span>
                    </h1>
                    <p class="hidden xs:block text-[11px] text-slate-400 truncate">Private Dashboard &bull; Auto-ping 10 min</p>
                </div>
            </div>

            <div class="flex items-center gap-2 sm:gap-3 shrink-0">
                <div id="auth-controls" class="hidden flex items-center gap-2 sm:gap-3">
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

                    <div class="flex items-center gap-2 pl-1 sm:pl-2 border-l border-slate-800">
                        <img id="user-avatar" src="" alt="Avatar" class="w-8 h-8 rounded-full border border-orange-500/50 object-cover shrink-0 hidden">
                        <div class="hidden md:block text-left min-w-0 max-w-[130px]">
                            <div id="user-name" class="text-xs font-bold text-white truncate">User</div>
                            <div id="user-email" class="text-[10px] text-slate-400 truncate">user@gmail.com</div>
                        </div>
                        <button onclick="handleSignOut()" title="Sign Out" class="p-1.5 sm:p-2 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-rose-950/40 border border-slate-800 transition cursor-pointer">
                            <i data-lucide="log-out" class="w-4 h-4"></i>
                        </button>
                    </div>
                </div>

                <div id="unauth-header-btn" class="flex items-center">
                    <button onclick="promptGoogleSignIn()" class="inline-flex items-center gap-2 px-3 sm:px-4 py-2 rounded-xl text-xs font-semibold bg-white text-slate-900 hover:bg-slate-100 shadow-md transition cursor-pointer">
                        <svg class="w-4 h-4" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
                        <span>Sign In</span>
                    </button>
                </div>
            </div>
        </div>
    </header>

    <main class="flex-1 max-w-7xl w-full mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-8">
        <section id="login-hero-view" class="max-w-3xl mx-auto my-8 sm:my-14 text-center space-y-6">
            <h2 class="text-3xl sm:text-5xl font-extrabold tracking-tight text-white leading-tight">
                Keep Your Free Render Deployments <br class="hidden sm:inline">
                <span class="bg-gradient-to-r from-orange-400 via-amber-300 to-emerald-400 bg-clip-text text-transparent">Awake 24 Hours / 7 Days</span>
            </h2>
            <p class="text-slate-300 text-sm sm:text-base max-w-2xl mx-auto leading-relaxed">
                Log in with your Google Account to manage your private list of Render apps.
            </p>
            <div class="glass-panel p-6 sm:p-8 rounded-2xl sm:rounded-3xl border border-slate-700/80 shadow-2xl max-w-md mx-auto space-y-5 mt-6">
                <h3 class="text-base font-bold text-white">Sign In to Your Dashboard</h3>
                <div class="flex justify-center pt-2">
                    <div id="g_id_signin_container"></div>
                </div>
            </div>
        </section>

        <div id="authenticated-dashboard" class="hidden space-y-4 sm:space-y-6">
            <section class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 sm:gap-4">
                <div class="glass-panel p-3.5 sm:p-5 rounded-xl sm:rounded-2xl relative overflow-hidden group">
                    <span class="text-[10px] sm:text-xs font-medium text-slate-400 uppercase tracking-wider block">Total</span>
                    <span id="metric-total" class="text-2xl sm:text-3xl font-extrabold text-white font-mono">0</span>
                </div>
                <div class="glass-panel p-3.5 sm:p-5 rounded-xl sm:rounded-2xl relative overflow-hidden group border-emerald-500/20">
                    <span class="text-[10px] sm:text-xs font-medium text-emerald-400 uppercase tracking-wider block">Awake</span>
                    <span id="metric-alive" class="text-2xl sm:text-3xl font-extrabold text-emerald-400 font-mono">0</span>
                </div>
                <div class="glass-panel p-3.5 sm:p-5 rounded-xl sm:rounded-2xl relative overflow-hidden group border-slate-700/60">
                    <span class="text-[10px] sm:text-xs font-medium text-amber-300 uppercase tracking-wider block">Paused</span>
                    <span id="metric-paused" class="text-2xl sm:text-3xl font-extrabold text-amber-300 font-mono">0</span>
                </div>
                <div class="glass-panel p-3.5 sm:p-5 rounded-xl sm:rounded-2xl relative overflow-hidden group border-amber-500/20">
                    <span class="text-[10px] sm:text-xs font-medium text-amber-400 uppercase tracking-wider block">Waking</span>
                    <span id="metric-waking" class="text-2xl sm:text-3xl font-extrabold text-amber-400 font-mono">0</span>
                </div>
                <div class="glass-panel p-3.5 sm:p-5 rounded-xl sm:rounded-2xl relative overflow-hidden group border-rose-500/20 col-span-2 sm:col-span-1">
                    <span class="text-[10px] sm:text-xs font-medium text-rose-400 uppercase tracking-wider block">Offline</span>
                    <span id="metric-failed" class="text-2xl sm:text-3xl font-extrabold text-rose-400 font-mono">0</span>
                </div>
            </section>

            <section class="glass-panel p-4 sm:p-6 rounded-xl sm:rounded-2xl shadow-xl">
                <form id="add-url-form" onsubmit="handleAddUrl(event)" class="grid grid-cols-1 md:grid-cols-12 gap-3 sm:gap-4 items-end">
                    <div class="md:col-span-4">
                        <label class="block text-xs font-medium text-slate-300 mb-1">Project Name</label>
                        <input type="text" id="project-name" required placeholder="e.g. Pharmacy POS Backend" class="w-full h-11 bg-slate-900 border border-slate-700 rounded-xl px-3 text-sm text-white">
                    </div>
                    <div class="md:col-span-6">
                        <label class="block text-xs font-medium text-slate-300 mb-1">Render URL</label>
                        <input type="text" id="target-url" required placeholder="https://my-backend.onrender.com/" class="w-full h-11 bg-slate-900 border border-slate-700 rounded-xl px-3 text-sm text-white font-mono">
                    </div>
                    <div class="md:col-span-2">
                        <button type="submit" id="btn-submit-url" class="w-full h-11 rounded-xl bg-orange-600 hover:bg-orange-500 font-semibold text-sm text-white">Monitor URL</button>
                    </div>
                </form>
            </section>

            <section class="glass-panel rounded-xl sm:rounded-2xl overflow-hidden">
                <div id="mobile-cards-container" class="block md:hidden p-3 space-y-3"></div>
                <div class="hidden md:block overflow-x-auto">
                    <table class="w-full text-left text-sm">
                        <thead class="bg-slate-900/70 border-b border-slate-800 text-xs font-semibold text-slate-400 uppercase">
                            <tr>
                                <th class="px-6 py-3.5">Project</th>
                                <th class="px-6 py-3.5">Target URL</th>
                                <th class="px-6 py-3.5">Live Status</th>
                                <th class="px-6 py-3.5">Latency</th>
                                <th class="px-6 py-3.5">Last Checked</th>
                                <th class="px-6 py-3.5 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody id="url-table-body" class="divide-y divide-slate-800/60"></tbody>
                    </table>
                </div>
                <div id="empty-state-view" class="hidden px-4 py-12 text-center text-slate-500">
                    <p class="text-xs text-slate-500">No Target URLs Registered yet in your account.</p>
                </div>
            </section>
        </div>
    </main>

    <div id="toast-container" class="fixed bottom-4 inset-x-3 sm:inset-x-auto sm:right-5 z-50 flex flex-col gap-2 pointer-events-none"></div>

    <script>
        const GOOGLE_CLIENT_ID = '` + GOOGLE_CLIENT_ID + `';
        let allUrls = [];
        let refreshTimer = null;
        let countdown = 15;
        let currentUser = null;
        let authToken = localStorage.getItem('keepalive_google_token') || null;

        window.onload = function () {
            lucide.createIcons();
            initGoogleAuth();
            if (authToken) restoreSession();
            else showLoggedOutUI();
        };

        function initGoogleAuth() {
            if (typeof google === 'undefined' || !google.accounts || !google.accounts.id) {
                setTimeout(initGoogleAuth, 300);
                return;
            }
            google.accounts.id.initialize({
                client_id: GOOGLE_CLIENT_ID,
                callback: handleGoogleCredentialResponse,
                auto_select: false,
            });
            renderGoogleSignInButton();
        }

        function renderGoogleSignInButton() {
            const container = document.getElementById('g_id_signin_container');
            if (container && typeof google !== 'undefined' && google.accounts && google.accounts.id) {
                google.accounts.id.renderButton(container, {
                    theme: 'outline',
                    size: 'large',
                    type: 'standard',
                    text: 'continue_with',
                    shape: 'pill',
                    width: 280
                });
            }
        }

        function promptGoogleSignIn() {
            if (typeof google !== 'undefined' && google.accounts && google.accounts.id) {
                google.accounts.id.prompt();
            }
        }

        async function handleGoogleCredentialResponse(response) {
            if (!response || !response.credential) return;
            authToken = response.credential;
            localStorage.setItem('keepalive_google_token', authToken);
            await restoreSession();
        }

        async function restoreSession() {
            if (!authToken) { showLoggedOutUI(); return; }
            try {
                const res = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + authToken } });
                if (!res.ok) throw new Error('Session expired');
                const data = await res.json();
                currentUser = data.user;
                showLoggedInUI(currentUser);
                fetchData();
                startCountdown();
            } catch (err) {
                authToken = null;
                currentUser = null;
                localStorage.removeItem('keepalive_google_token');
                showLoggedOutUI();
            }
        }

        function handleSignOut() {
            if (typeof google !== 'undefined' && google.accounts && google.accounts.id) {
                google.accounts.id.disableAutoSelect();
            }
            authToken = null;
            currentUser = null;
            localStorage.removeItem('keepalive_google_token');
            if (refreshTimer) clearInterval(refreshTimer);
            showLoggedOutUI();
        }

        function showLoggedInUI(user) {
            document.getElementById('login-hero-view').classList.add('hidden');
            document.getElementById('authenticated-dashboard').classList.remove('hidden');
            document.getElementById('auth-controls').classList.remove('hidden');
            document.getElementById('unauth-header-btn').classList.add('hidden');
            document.getElementById('user-name').innerText = user.name || 'User';
            document.getElementById('user-email').innerText = user.email || '';
            const avatarElem = document.getElementById('user-avatar');
            if (user.picture) {
                avatarElem.src = user.picture;
                avatarElem.classList.remove('hidden');
            }
            lucide.createIcons();
        }

        function showLoggedOutUI() {
            document.getElementById('login-hero-view').classList.remove('hidden');
            document.getElementById('authenticated-dashboard').classList.add('hidden');
            document.getElementById('auth-controls').classList.add('hidden');
            document.getElementById('unauth-header-btn').classList.remove('hidden');
            renderGoogleSignInButton();
            lucide.createIcons();
        }

        function getAuthHeaders() {
            return { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' };
        }

        async function fetchData(manual = false) {
            if (!authToken) return;
            try {
                const [urlsRes, statsRes] = await Promise.all([
                    fetch('/api/urls', { headers: getAuthHeaders() }),
                    fetch('/api/stats', { headers: getAuthHeaders() })
                ]);
                if (urlsRes.status === 401 || statsRes.status === 401) { handleSignOut(); return; }
                allUrls = await urlsRes.json();
                const stats = await statsRes.json();
                updateStats(stats);
                renderAll(allUrls);
                countdown = 15;
            } catch (err) {
                console.error(err);
            }
        }

        function startCountdown() {
            if (refreshTimer) clearInterval(refreshTimer);
            refreshTimer = setInterval(() => {
                if (!authToken) return;
                countdown--;
                const elem = document.getElementById('refresh-countdown');
                if (elem) elem.innerText = countdown + 's';
                if (countdown <= 0) { countdown = 15; fetchData(); }
            }, 1000);
        }

        function updateStats(stats) {
            document.getElementById('metric-total').innerText = stats.total || 0;
            document.getElementById('metric-alive').innerText = stats.alive || 0;
            document.getElementById('metric-paused').innerText = stats.paused || 0;
            document.getElementById('metric-waking').innerText = stats.waking || 0;
            document.getElementById('metric-failed').innerText = stats.failed || 0;
        }

        function formatRelativeTime(isoString) {
            if (!isoString) return 'Never checked';
            const diffSeconds = Math.floor((new Date() - new Date(isoString)) / 1000);
            if (diffSeconds < 60) return diffSeconds + 's ago';
            const diffMins = Math.floor(diffSeconds / 60);
            if (diffMins < 60) return diffMins + 'm ago';
            return Math.floor(diffMins / 60) + 'h ago';
        }

        function getStatusBadge(status, httpCode, isActive = true) {
            if (!isActive || status === 'Paused') {
                return '<span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-300 border border-amber-500/30">Paused</span>';
            }
            if (status.startsWith('Active')) {
                return '<span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">' + status + '</span>';
            }
            return '<span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-rose-500/15 text-rose-400 border border-rose-500/30">' + status + '</span>';
        }

        function renderAll(urls) {
            const emptyView = document.getElementById('empty-state-view');
            const tbody = document.getElementById('url-table-body');
            const mobileContainer = document.getElementById('mobile-cards-container');
            if (!urls || urls.length === 0) {
                emptyView.classList.remove('hidden');
                tbody.innerHTML = '';
                mobileContainer.innerHTML = '';
                return;
            }
            emptyView.classList.add('hidden');

            mobileContainer.innerHTML = urls.map(item => \`
                <div class="glass-panel p-4 rounded-xl space-y-2">
                    <div class="flex justify-between items-start">
                        <div>
                            <h3 class="font-bold text-sm text-white">\${escapeHtml(item.name)}</h3>
                            <span class="text-[10px] text-slate-400">\${formatRelativeTime(item.created_at)}</span>
                        </div>
                        \${getStatusBadge(item.status, item.http_code, item.is_active)}
                    </div>
                    <div class="font-mono text-xs text-orange-400 truncate">\${escapeHtml(item.url)}</div>
                    <div class="grid grid-cols-3 gap-1 pt-2">
                        <button onclick="toggleActive(\${item.id}, this)" class="h-8 rounded bg-slate-800 text-xs font-medium text-amber-300">\${item.is_active ? 'Pause' : 'Start'}</button>
                        <button onclick="triggerPing(\${item.id}, this)" class="h-8 rounded bg-orange-600/20 text-xs font-medium text-orange-300">Ping</button>
                        <button onclick="deleteUrl(\${item.id}, '\${escapeHtml(item.name)}')" class="h-8 rounded bg-rose-600/15 text-xs font-medium text-rose-300">Delete</button>
                    </div>
                </div>
            \`).join('');

            tbody.innerHTML = urls.map(item => \`
                <tr class="hover:bg-slate-900/50">
                    <td class="px-6 py-4 font-semibold text-white">\${escapeHtml(item.name)}</td>
                    <td class="px-6 py-4 font-mono text-xs text-orange-400 truncate max-w-xs">\${escapeHtml(item.url)}</td>
                    <td class="px-6 py-4">\${getStatusBadge(item.status, item.http_code, item.is_active)}</td>
                    <td class="px-6 py-4 text-xs font-mono text-emerald-400">\${item.response_time_ms ? item.response_time_ms + ' ms' : '--'}</td>
                    <td class="px-6 py-4 text-xs text-slate-400">\${formatRelativeTime(item.last_ping)}</td>
                    <td class="px-6 py-4 text-right space-x-1">
                        <button onclick="toggleActive(\${item.id}, this)" class="px-2 py-1 rounded bg-slate-800 text-xs text-amber-300">\${item.is_active ? 'Pause' : 'Start'}</button>
                        <button onclick="triggerPing(\${item.id}, this)" class="px-2 py-1 rounded bg-slate-800 text-xs text-orange-300">Ping</button>
                        <button onclick="deleteUrl(\${item.id}, '\${escapeHtml(item.name)}')" class="px-2 py-1 rounded bg-slate-800 text-xs text-rose-300">Delete</button>
                    </td>
                </tr>
            \`).join('');
            lucide.createIcons();
        }

        async function toggleActive(id, btn) {
            btn.disabled = true;
            try {
                const res = await fetch('/api/urls/' + id + '/toggle', { method: 'POST', headers: getAuthHeaders() });
                const data = await res.json();
                fetchData();
            } finally { btn.disabled = false; }
        }

        async function handleAddUrl(event) {
            event.preventDefault();
            const name = document.getElementById('project-name').value.trim();
            const url = document.getElementById('target-url').value.trim();
            try {
                const res = await fetch('/api/urls', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ name, url })
                });
                document.getElementById('project-name').value = '';
                document.getElementById('target-url').value = '';
                fetchData();
            } catch (err) { alert(err.message); }
        }

        async function triggerPing(id, btn) {
            btn.disabled = true;
            try {
                await fetch('/api/ping/' + id, { method: 'POST', headers: getAuthHeaders() });
                fetchData();
            } finally { btn.disabled = false; }
        }

        async function triggerPingAll() {
            await fetch('/api/ping-all', { method: 'POST', headers: getAuthHeaders() });
            setTimeout(fetchData, 2000);
        }

        async function deleteUrl(id, name) {
            if (!confirm('Stop monitoring ' + name + '?')) return;
            await fetch('/api/urls/' + id, { method: 'DELETE', headers: getAuthHeaders() });
            fetchData();
        }

        function escapeHtml(str) {
            if (!str) return '';
            return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
        }
    </script>
</body>
</html>`;
}
