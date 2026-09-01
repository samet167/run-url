# ⚡ Render 24/7 Keep-Alive Hub

> **Automated Health Check & Cold-Start Prevention Hub for Render Free Tier Web Services**  
> Powered by **FastAPI**, **Neon PostgreSQL (Serverless)**, **APScheduler (Background Worker)**, and **HTTPX (Async)**.

---

## 🎯 Overview

Render's free-tier web services automatically spin down into a sleep state after **15 minutes of inactivity**, resulting in annoying **50+ second cold-start delays** for users.

**Render 24/7 Keep-Alive Hub** eliminates cold starts completely by executing lightweight, automated HTTP health checks every **10 minutes** (`*/10 * * * *`), keeping container memory warm and ready 24 hours a day, 7 days a week.

---

## 🏗️ Architecture & Tech Stack

```
                                  +---------------------------------------+
                                  |     Modern Dark Tailwind Dashboard     |
                                  |   (Auto-refreshing Single Page App)   |
                                  +-------------------+-------------------+
                                                      |
                                             REST API | (FastAPI)
                                                      v
+------------------------+        +---------------------------------------+
| APScheduler Worker     |        |              FastAPI App              |
| (Cron: */10 * * * *)   |------->| - Auto Database Table Migrations      |
+------------------------+        | - Connection Pooling (pool_pre_ping)  |
            |                     | - Error Interception & Classifications|
            |                     +-------------------+-------------------+
   Async HTTPX Ping                                   |
   (15s timeout)                                      | SQLAlchemy ORM
            |                                         v
            v                             +-----------------------+
+------------------------+                |  Neon PostgreSQL DB   |
| Render Free Web Apps   |                |  (Table: monitored_urls)|
| (Kept Awake 24/7)      |                +-----------------------+
+------------------------+
```

### Key Technical Features:
- **FastAPI + Uvicorn:** High performance asynchronous Python backend.
- **Neon PostgreSQL Integration:** SQLAlchemy 2.0 with connection pooling, `pool_pre_ping=True`, and `pool_recycle=300` to prevent stale connection errors on serverless poolers.
- **APScheduler Background Engine:** Autonomous `AsyncIOScheduler` executing ping cycles every 10 minutes without blocking the main event loop.
- **HTTPX Client with Error Interception:** 15-second strict timeout handling `200 OK`, `502/503/504 Bad Gateway (Waking Up)`, `4xx`, and connection timeouts safely.
- **Single Page Dashboard:** Dark-mode dashboard built with Tailwind CSS, Lucide icons, live latency badges, search filter, and 15-second auto-sync.
- **Self-Keep-Alive Ready:** Built-in `/api/health` endpoint allowing the hub itself to be kept awake 24/7.

---

## 🗄️ Database Schema (`monitored_urls`)

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `INTEGER` (PK, Auto-increment) | Unique record ID |
| `name` | `VARCHAR(255)` | Friendly project name |
| `url` | `VARCHAR(1024)` (Unique) | Target URL to ping |
| `status` | `VARCHAR(100)` | Latest status (`Active 200`, `Waking Up`, `Failed`) |
| `response_time_ms` | `INTEGER` (Nullable) | HTTP roundtrip latency in milliseconds |
| `http_code` | `INTEGER` (Nullable) | HTTP status code returned |
| `last_ping` | `DATETIME` (Nullable) | Timestamp of most recent health check |
| `created_at` | `DATETIME` | Timestamp when URL was registered |

---

## 🚀 Quick Start (Local Execution)

### 1. Prerequisites
- Python 3.9+ or Docker
- Active internet connection (for Neon PostgreSQL connectivity)

### 2. Clone / Setup Workspace
```bash
git clone <your-repo-url>
cd "run url"
```

### 3. Create & Activate Virtual Environment
```bash
python3 -m venv venv
source venv/bin/activate    # On Windows: venv\Scripts\activate
```

### 4. Install Dependencies
```bash
pip install -r requirements.txt
```

### 5. Configure Environment Variables
Copy `.env.example` to `.env` (the pre-configured Neon DB connection is already configured by default):
```bash
cp .env.example .env
```

### 6. Run the Application
```bash
python3 app.py
```
Or directly with Uvicorn:
```bash
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```

Open your browser and navigate to:  
👉 **`http://localhost:8000`**

---

## 📡 REST API Reference

| Method | Endpoint | Description | Payload Example |
| :--- | :--- | :--- | :--- |
| `GET` | `/` | Web Dashboard UI | - |
| `GET` | `/api/urls` | List all monitored targets | - |
| `POST` | `/api/urls` | Register a new target URL | `{"name": "My App", "url": "https://myapp.onrender.com/health"}` |
| `DELETE` | `/api/urls/{id}` | Delete a target URL | - |
| `POST` | `/api/ping/{id}` | Manually trigger a ping for a target | - |
| `POST` | `/api/ping-all` | Trigger a sweep ping across all targets | - |
| `GET` | `/api/stats` | Dashboard summary metrics | - |
| `GET` | `/api/health` | Health check endpoint for this hub | - |

---

## ☁️ Deployment on Render (Step-by-Step)

### Option A: 1-Click Blueprint (`render.yaml`)
1. Push this repository to GitHub or GitLab.
2. Go to [Render Dashboard](https://dashboard.render.com/) -> **New +** -> **Blueprint**.
3. Connect your repository. Render will automatically detect `render.yaml` and provision the Web Service.

### Option B: Manual Web Service Setup
1. In Render Dashboard, click **New +** -> **Web Service**.
2. Connect your Git repository.
3. Configure the following fields:
   - **Environment:** `Python`
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `uvicorn app:app --host 0.0.0.0 --port $PORT`
   - **Plan:** Free
4. Under **Environment Variables**, add:
   - `DATABASE_URL` = `postgresql://neondb_owner:npg_aKMVL6bok7gm@ep-floral-lab-aehhbt84-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require`
   - `PING_INTERVAL_MINUTES` = `10`
   - `HTTP_TIMEOUT_SECONDS` = `15`
5. Click **Deploy Web Service**.

### Option C: Docker Deployment
Render will also automatically detect the included `Dockerfile` if you select **Docker** as the runtime.

---

## 💡 Keeping this Hub Awake
To make sure this Hub itself stays awake 24/7 on the Render free tier:
1. Once deployed, copy your Hub's public health URL (e.g. `https://your-hub.onrender.com/api/health`).
2. Add that URL inside the dashboard itself as a monitored target!
3. (Optional) You can also add it to a free external monitor such as [cron-job.org](https://cron-job.org) or [UptimeRobot](https://uptimerobot.com) with a 10-minute check.

---

## 🛡️ License
MIT License. Built for developers running production workloads on free-tier cloud infrastructure.
