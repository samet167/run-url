# ⚡ Cloudflare Worker Deployment Guide

> **Deploy Render 24/7 Keep-Alive Hub to Cloudflare Edge with Native 10-Minute Cron Triggers**

---

## 🌟 Why Cloudflare Workers is the BEST Choice:
1. **Native Cron Triggers (`*/10 * * * *`):** Cloudflare's edge network automatically triggers the worker every 10 minutes 24/7/365 — **Zero Cold Starts, Zero Sleep, 100% Free**.
2. **Neon DB Serverless Integration:** Direct SQL queries to Neon PostgreSQL via `@neondatabase/serverless`.
3. **High Performance Edge:** Sub-millisecond global latency across 300+ data centers.

---

## 🚀 2-Step Deployment to Cloudflare Workers

### Step 1: Install Dependencies
Open terminal and navigate into the `cloudflare` folder:
```bash
cd "run url/cloudflare"
npm install
```

### Step 2: Login & Deploy with Wrangler
```bash
# 1. Login to your free Cloudflare account (only needed once)
npx wrangler login

# 2. Deploy to Cloudflare Workers in 1 command!
npx wrangler deploy
```

---

## ⚙️ Environment Variables / Secrets
The Neon database connection string is already configured in `wrangler.toml`:
```toml
[vars]
DATABASE_URL = "postgresql://neondb_owner:npg_aKMVL6bok7gm@ep-floral-lab-aehhbt84-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
```

If you prefer to store it as an encrypted Cloudflare Secret:
```bash
npx wrangler secret put DATABASE_URL
```

---

## 🧪 Local Testing with Wrangler
You can run and test the Cloudflare Worker locally:
```bash
npx wrangler dev
```
Open `http://localhost:8787` in your browser!
