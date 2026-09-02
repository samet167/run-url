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
  async scheduled(event, env, ctx) {
    const sql = getSql(env);
    await ensureTable(sql);
    ctx.waitUntil(sweepAllUrls(sql));
  },

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

    // Router: POST /api/urls/:id/toggle
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
// Cloudflare Worker Embedded Responsive HTML (Dark/Light + Native Mobile Dock)
// -----------------------------------------------------------------------------
function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>KeepAlive Hub &bull; 24/7 Render Keep-Awake Engine</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
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
                    screens: { 'xs': '420px' },
                    boxShadow: {
                        'card-light': '0 4px 20px -2px rgba(0, 0, 0, 0.05), 0 2px 6px -1px rgba(0, 0, 0, 0.02)',
                        'card-dark': '0 10px 30px -10px rgba(0, 0, 0, 0.5), 0 0 1px 1px rgba(255, 255, 255, 0.05)',
                    }
                }
            }
        }
    </script>
    <style>
        * {
            transition: background-color 0.3s cubic-bezier(0.16, 1, 0.3, 1), 
                        border-color 0.3s cubic-bezier(0.16, 1, 0.3, 1), 
                        box-shadow 0.3s cubic-bezier(0.16, 1, 0.3, 1),
                        transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        .dark ::-webkit-scrollbar-track { background: #070a11; }
        .dark ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 9999px; }
        ::-webkit-scrollbar-track { background: #f1f5f9; }
        ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 9999px; }

        .theme-glass {
            background: rgba(255, 255, 255, 0.85);
            backdrop-filter: blur(24px);
            -webkit-backdrop-filter: blur(24px);
            border: 1px solid rgba(226, 232, 240, 0.85);
        }
        .dark .theme-glass {
            background: rgba(13, 19, 33, 0.78);
            backdrop-filter: blur(24px);
            -webkit-backdrop-filter: blur(24px);
            border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .theme-surface { background: #ffffff; border: 1px solid #e2e8f0; }
        .dark .theme-surface { background: #0d1321; border: 1px solid rgba(255, 255, 255, 0.07); }
        button, a, input { -webkit-tap-highlight-color: transparent; user-select: none; }

        @keyframes slideUpFade {
            from { opacity: 0; transform: translateY(12px) scale(0.98); }
            to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .animate-slide-up {
            animation: slideUpFade 0.45s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        .hover-lift {
            transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .hover-lift:hover {
            transform: translateY(-2px);
        }
    </style>
</head>
<body class="bg-slate-50 text-slate-800 dark:bg-[#070a11] dark:text-slate-100 min-h-screen font-sans antialiased selection:bg-orange-500 selection:text-white flex flex-col pb-20 md:pb-0">
    <div class="fixed top-0 left-1/2 -translate-x-1/2 w-full max-w-6xl h-96 bg-gradient-to-b from-orange-500/10 via-amber-500/5 to-transparent blur-3xl pointer-events-none -z-10 dark:from-orange-600/15 dark:via-emerald-600/5"></div>

    <header class="sticky top-0 z-40 border-b border-slate-200/80 dark:border-slate-800/80 bg-white/80 dark:bg-[#070a11]/85 backdrop-blur-xl">
        <div class="max-w-7xl mx-auto px-3.5 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-3">
            <div class="flex items-center gap-3 min-w-0">
                <div class="relative flex items-center justify-center w-10 h-10 rounded-2xl bg-gradient-to-br from-orange-500 to-amber-600 shadow-md shadow-orange-500/20 text-white font-bold shrink-0">
                    <i data-lucide="cloud-lightning" class="w-5 h-5 fill-current"></i>
                    <span class="absolute -top-0.5 -right-0.5 flex h-3 w-3">
                        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span class="relative inline-flex rounded-full h-3 w-3 bg-emerald-500 ring-2 ring-white dark:ring-slate-950"></span>
                    </span>
                </div>
                <div class="truncate">
                    <div class="flex items-center gap-1.5">
                        <span class="text-sm sm:text-base font-extrabold tracking-tight text-slate-900 dark:text-white">KeepAlive</span>
                        <span class="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-400 border border-orange-300/40 dark:border-orange-500/30">Edge</span>
                    </div>
                    <p class="hidden xs:block text-[11px] text-slate-500 dark:text-slate-400 truncate">Cloudflare Native 24/7 Engine</p>
                </div>
            </div>

            <div class="flex items-center gap-2 sm:gap-2.5 shrink-0">
                <button onclick="toggleTheme()" id="theme-toggle-btn" class="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-900 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-800 active:scale-95 cursor-pointer">
                    <i data-lucide="sun" class="w-4 h-4 hidden dark:block text-amber-400"></i>
                    <i data-lucide="moon" class="w-4 h-4 block dark:hidden text-slate-700"></i>
                </button>

                <div id="auth-controls" class="hidden flex items-center gap-2">
                    <button onclick="triggerPingAll()" id="btn-sweep-all" class="hidden sm:inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold bg-orange-600 hover:bg-orange-500 text-white shadow-md shadow-orange-600/20 active:scale-95 cursor-pointer">
                        <i data-lucide="activity" class="w-3.5 h-3.5"></i>
                        <span>Sweep All</span>
                    </button>
                    <button onclick="fetchData(true)" class="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-900 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 active:scale-95 cursor-pointer">
                        <i data-lucide="rotate-cw" id="refresh-icon" class="w-4 h-4"></i>
                    </button>
                    <div class="flex items-center gap-2 pl-1.5 border-l border-slate-200 dark:border-slate-800">
                        <img id="user-avatar" src="" alt="Avatar" class="w-8 h-8 rounded-full border-2 border-orange-500 object-cover shrink-0 hidden shadow-sm">
                        <div class="hidden lg:block text-left min-w-0 max-w-[120px]">
                            <div id="user-name" class="text-xs font-bold text-slate-800 dark:text-white truncate">User</div>
                            <div id="user-email" class="text-[10px] text-slate-500 dark:text-slate-400 truncate">user@gmail.com</div>
                        </div>
                        <button onclick="handleSignOut()" class="p-2 rounded-xl text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 border border-slate-200 dark:border-slate-800 active:scale-95 cursor-pointer">
                            <i data-lucide="log-out" class="w-4 h-4"></i>
                        </button>
                    </div>
                </div>

                <div id="unauth-header-btn" class="flex items-center">
                    <button onclick="promptGoogleSignIn()" class="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold bg-slate-900 hover:bg-slate-800 text-white dark:bg-white dark:text-slate-900 shadow-sm active:scale-95 cursor-pointer">
                        <svg class="w-4 h-4" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
                        <span>Sign In</span>
                    </button>
                </div>
            </div>
        </div>
    </header>

    <main class="flex-1 max-w-7xl w-full mx-auto px-3.5 sm:px-6 lg:px-8 py-4 sm:py-7">
        <section id="login-hero-view" class="max-w-3xl mx-auto my-6 sm:my-12 text-center space-y-6">
            <h2 class="text-3xl sm:text-5xl font-extrabold tracking-tight text-slate-900 dark:text-white leading-[1.15]">
                Prevent Cold Boots.<br>
                <span class="bg-gradient-to-r from-orange-600 via-amber-500 to-emerald-600 dark:from-orange-400 dark:via-amber-300 dark:to-emerald-400 bg-clip-text text-transparent">Keep Render 24/7 Awake.</span>
            </h2>
            <p class="text-slate-600 dark:text-slate-300 text-sm sm:text-base max-w-xl mx-auto">
                Connect your Google Account to manage your private list of Render apps.
            </p>
            <div class="theme-glass p-6 sm:p-8 rounded-3xl shadow-card-light dark:shadow-card-dark max-w-md mx-auto space-y-5 mt-6">
                <h3 class="text-base font-bold text-slate-900 dark:text-white">Sign In to Dashboard</h3>
                <div class="flex justify-center pt-2"><div id="g_id_signin_container"></div></div>
            </div>
        </section>

        <div id="authenticated-dashboard" class="hidden space-y-4 sm:space-y-6">
            <section class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 sm:gap-4">
                <div class="theme-surface p-4 rounded-2xl shadow-card-light dark:shadow-card-dark">
                    <span class="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider block">Total</span>
                    <span id="metric-total" class="text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white font-mono">0</span>
                </div>
                <div class="theme-surface p-4 rounded-2xl shadow-card-light dark:shadow-card-dark border-emerald-500/30">
                    <span class="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider block">Awake</span>
                    <span id="metric-alive" class="text-2xl sm:text-3xl font-extrabold text-emerald-600 dark:text-emerald-400 font-mono">0</span>
                </div>
                <div class="theme-surface p-4 rounded-2xl shadow-card-light dark:shadow-card-dark border-amber-500/30">
                    <span class="text-[11px] font-bold text-amber-600 dark:text-amber-300 uppercase tracking-wider block">Paused</span>
                    <span id="metric-paused" class="text-2xl sm:text-3xl font-extrabold text-amber-600 dark:text-amber-300 font-mono">0</span>
                </div>
                <div class="theme-surface p-4 rounded-2xl shadow-card-light dark:shadow-card-dark border-sky-500/30">
                    <span class="text-[11px] font-bold text-sky-600 dark:text-sky-400 uppercase tracking-wider block">Waking</span>
                    <span id="metric-waking" class="text-2xl sm:text-3xl font-extrabold text-sky-600 dark:text-sky-400 font-mono">0</span>
                </div>
                <div class="theme-surface p-4 rounded-2xl shadow-card-light dark:shadow-card-dark border-rose-500/30 col-span-2 sm:col-span-1">
                    <span class="text-[11px] font-bold text-rose-600 dark:text-rose-400 uppercase tracking-wider block">Offline</span>
                    <span id="metric-failed" class="text-2xl sm:text-3xl font-extrabold text-rose-600 dark:text-rose-400 font-mono">0</span>
                </div>
            </section>

            <section class="theme-surface p-4 sm:p-6 rounded-3xl shadow-card-light dark:shadow-card-dark">
                <form id="add-url-form" onsubmit="handleAddUrl(event)" class="grid grid-cols-1 md:grid-cols-12 gap-3 sm:gap-4 items-end">
                    <div class="md:col-span-4">
                        <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">App Name</label>
                        <input type="text" id="project-name" required placeholder="e.g. Pharmacy POS Backend" class="w-full h-11 bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700/80 rounded-2xl px-3.5 text-sm text-slate-900 dark:text-white">
                    </div>
                    <div class="md:col-span-6">
                        <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Render Service URL</label>
                        <input type="text" id="target-url" required placeholder="https://my-service.onrender.com/" class="w-full h-11 bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700/80 rounded-2xl px-3.5 text-sm font-mono text-slate-900 dark:text-white">
                    </div>
                    <div class="md:col-span-2">
                        <button type="submit" id="btn-submit-url" class="w-full h-11 rounded-2xl font-bold text-sm bg-gradient-to-r from-orange-600 to-amber-600 text-white active:scale-95 cursor-pointer">Add App</button>
                    </div>
                </form>
            </section>

            <section class="theme-surface rounded-3xl overflow-hidden shadow-card-light dark:shadow-card-dark">
                <div class="px-4 sm:px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                    <div class="flex items-center gap-2">
                        <i data-lucide="layers" class="w-4 h-4 text-orange-500"></i>
                        <h3 class="text-sm sm:text-base font-bold text-slate-900 dark:text-white">Managed Endpoints</h3>
                    </div>
                    <div class="w-full sm:w-64 relative">
                        <input type="text" id="filter-input" oninput="filterUrls()" placeholder="Search..." class="w-full h-9 bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-xl px-3 text-xs text-slate-900 dark:text-white">
                    </div>
                </div>

                <div id="mobile-cards-container" class="block md:hidden p-3 space-y-3"></div>
                <div class="hidden md:block overflow-x-auto">
                    <table class="w-full text-left text-sm">
                        <thead class="bg-slate-50 dark:bg-slate-900/60 border-b border-slate-200 dark:border-slate-800 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase">
                            <tr>
                                <th class="px-6 py-3.5">Deployment Name</th>
                                <th class="px-6 py-3.5">Target Endpoint</th>
                                <th class="px-6 py-3.5">Live Status</th>
                                <th class="px-6 py-3.5">Latency</th>
                                <th class="px-6 py-3.5">Last Sweep</th>
                                <th class="px-6 py-3.5 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody id="url-table-body" class="divide-y divide-slate-100 dark:divide-slate-800/60"></tbody>
                    </table>
                </div>
                <div id="empty-state-view" class="hidden px-4 py-12 text-center text-slate-500">
                    <p class="text-xs">No Render Apps Monitored yet.</p>
                </div>
            </section>
        </div>
    </main>

    <nav id="mobile-dock" class="fixed bottom-0 inset-x-0 z-40 md:hidden bg-white/95 dark:bg-[#070a11]/95 backdrop-blur-xl border-t border-slate-200 dark:border-slate-800 px-4 py-2 flex items-center justify-around shadow-2xl">
        <button onclick="window.scrollTo({top:0,behavior:'smooth'})" class="flex flex-col items-center gap-1 text-slate-600 dark:text-slate-400 active:scale-90"><i data-lucide="home" class="w-5 h-5"></i><span class="text-[10px] font-bold">Home</span></button>
        <button onclick="triggerPingAll()" class="flex flex-col items-center gap-1 text-slate-600 dark:text-slate-400 active:scale-90"><i data-lucide="zap" class="w-5 h-5"></i><span class="text-[10px] font-bold">Sweep</span></button>
        <button onclick="fetchData(true)" class="flex flex-col items-center gap-1 text-slate-600 dark:text-slate-400 active:scale-90"><i data-lucide="rotate-cw" class="w-5 h-5"></i><span class="text-[10px] font-bold">Sync</span></button>
        <button onclick="toggleTheme()" class="flex flex-col items-center gap-1 text-slate-600 dark:text-slate-400 active:scale-90"><i data-lucide="sun-moon" class="w-5 h-5"></i><span class="text-[10px] font-bold">Theme</span></button>
    </nav>

    <div id="toast-container" class="fixed bottom-16 sm:bottom-4 inset-x-3 sm:inset-x-auto sm:right-5 z-50 flex flex-col gap-2 pointer-events-none"></div>

    <script>
        const GOOGLE_CLIENT_ID = '` + GOOGLE_CLIENT_ID + `';
        let allUrls = [];
        let refreshTimer = null;
        let countdown = 15;
        let currentUser = null;
        let authToken = localStorage.getItem('keepalive_google_token') || null;

        function initTheme() {
            const saved = localStorage.getItem('keepalive_theme');
            if (saved === 'light') document.documentElement.classList.remove('dark');
            else document.documentElement.classList.add('dark');
        }

        function toggleTheme() {
            const isDark = document.documentElement.classList.toggle('dark');
            localStorage.setItem('keepalive_theme', isDark ? 'dark' : 'light');
        }

        window.onload = function () {
            initTheme();
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
            google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleGoogleCredentialResponse });
            renderGoogleSignInButton();
        }

        function renderGoogleSignInButton() {
            const container = document.getElementById('g_id_signin_container');
            if (container && typeof google !== 'undefined' && google.accounts && google.accounts.id) {
                google.accounts.id.renderButton(container, { theme: 'outline', size: 'large', shape: 'pill', width: 280 });
            }
        }

        function promptGoogleSignIn() {
            if (typeof google !== 'undefined' && google.accounts && google.accounts.id) google.accounts.id.prompt();
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
            } catch (err) {
                authToken = null;
                localStorage.removeItem('keepalive_google_token');
                showLoggedOutUI();
            }
        }

        function handleSignOut() {
            if (typeof google !== 'undefined' && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
            authToken = null;
            currentUser = null;
            localStorage.removeItem('keepalive_google_token');
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
            if (user.picture) { avatarElem.src = user.picture; avatarElem.classList.remove('hidden'); }
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
            } catch (err) { console.error(err); }
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
                return '<span class="px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300 border border-amber-300 dark:border-amber-500/30">Paused</span>';
            }
            if (status.startsWith('Active')) {
                return '<span class="px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-400 border border-emerald-300 dark:border-emerald-500/30">' + status + '</span>';
            }
            return '<span class="px-2.5 py-1 rounded-full text-[11px] font-bold bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-400 border border-rose-300 dark:border-rose-500/30">' + status + '</span>';
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
                <div class="theme-surface p-4 rounded-2xl border \${item.is_active ? 'border-slate-200 dark:border-slate-800' : 'border-amber-300 dark:border-amber-500/30'} space-y-3">
                    <div class="flex justify-between items-start">
                        <div>
                            <h4 class="font-extrabold text-sm text-slate-900 dark:text-white">\${escapeHtml(item.name)}</h4>
                            <span class="text-[10px] text-slate-500">\${formatRelativeTime(item.created_at)}</span>
                        </div>
                        \${getStatusBadge(item.status, item.http_code, item.is_active)}
                    </div>
                    <div class="font-mono text-xs text-orange-600 dark:text-orange-400 truncate bg-slate-50 dark:bg-slate-900 p-2.5 rounded-xl border border-slate-200 dark:border-slate-800">\${escapeHtml(item.url)}</div>
                    <div class="grid grid-cols-3 gap-1.5 pt-1">
                        <button onclick="toggleActive(\${item.id}, this)" class="h-9 rounded-xl bg-slate-100 dark:bg-slate-800 font-bold text-xs text-amber-700 dark:text-amber-300">\${item.is_active ? 'Pause' : 'Start'}</button>
                        <button onclick="triggerPing(\${item.id}, this)" class="h-9 rounded-xl bg-orange-50 dark:bg-orange-600/20 font-bold text-xs text-orange-700 dark:text-orange-300">Ping</button>
                        <button onclick="deleteUrl(\${item.id}, '\${escapeHtml(item.name)}')" class="h-9 rounded-xl bg-rose-50 dark:bg-rose-600/15 font-bold text-xs text-rose-700 dark:text-rose-300">Delete</button>
                    </div>
                </div>
            \`).join('');

            tbody.innerHTML = urls.map(item => \`
                <tr class="hover:bg-slate-50 dark:hover:bg-slate-900/50">
                    <td class="px-6 py-4 font-bold text-slate-900 dark:text-white">\${escapeHtml(item.name)}</td>
                    <td class="px-6 py-4 font-mono text-xs text-orange-600 dark:text-orange-400 truncate max-w-xs">\${escapeHtml(item.url)}</td>
                    <td class="px-6 py-4">\${getStatusBadge(item.status, item.http_code, item.is_active)}</td>
                    <td class="px-6 py-4 text-xs font-mono text-emerald-600 dark:text-emerald-400 font-bold">\${item.response_time_ms ? item.response_time_ms + ' ms' : '--'}</td>
                    <td class="px-6 py-4 text-xs text-slate-500">\${formatRelativeTime(item.last_ping)}</td>
                    <td class="px-6 py-4 text-right space-x-1.5">
                        <button onclick="toggleActive(\${item.id}, this)" class="px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-bold text-amber-700 dark:text-amber-300">\${item.is_active ? 'Pause' : 'Start'}</button>
                        <button onclick="triggerPing(\${item.id}, this)" class="px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-bold text-orange-700 dark:text-orange-300">Ping</button>
                        <button onclick="deleteUrl(\${item.id}, '\${escapeHtml(item.name)}')" class="px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-bold text-rose-700 dark:text-rose-300">Delete</button>
                    </td>
                </tr>
            \`).join('');
            lucide.createIcons();
        }

        async function toggleActive(id, btn) {
            btn.disabled = true;
            try {
                await fetch('/api/urls/' + id + '/toggle', { method: 'POST', headers: getAuthHeaders() });
                fetchData();
            } finally { btn.disabled = false; }
        }

        async function handleAddUrl(event) {
            event.preventDefault();
            const name = document.getElementById('project-name').value.trim();
            const url = document.getElementById('target-url').value.trim();
            try {
                await fetch('/api/urls', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ name, url }) });
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
            if (!confirm('Delete ' + name + '?')) return;
            await fetch('/api/urls/' + id, { method: 'DELETE', headers: getAuthHeaders() });
            fetchData();
        }

        function filterUrls() {
            const q = document.getElementById('filter-input').value.toLowerCase();
            renderAll(allUrls.filter(u => u.name.toLowerCase().includes(q) || u.url.toLowerCase().includes(q)));
        }

        function copyToClipboard(text) {
            navigator.clipboard.writeText(text);
        }

        function escapeHtml(str) {
            if (!str) return '';
            return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
        }
    </script>
</body>
</html>`;
}
