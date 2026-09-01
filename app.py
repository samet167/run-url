"""
Render 24/7 Keep-Alive Hub
Automated HTTP health check and cold-start prevention service for Render free-tier deployments.
Powered by FastAPI, SQLAlchemy (Neon PostgreSQL), APScheduler, and HTTPX.
"""

import os
import time
import logging
import asyncio
from datetime import datetime, timezone
from typing import List, Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Request, HTTPException, Depends, status
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, HttpUrl, field_validator
from sqlalchemy import (
    create_engine,
    Column,
    Integer,
    String,
    DateTime,
    Float,
    desc,
    text
)
from sqlalchemy.orm import declarative_base, sessionmaker, Session
# pyrefly: ignore [missing-import]
from apscheduler.schedulers.asyncio import AsyncIOScheduler
# pyrefly: ignore [missing-import]
from apscheduler.triggers.cron import CronTrigger

# Load environment variables
load_dotenv()

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("KeepAliveHub")

# Configuration
DEFAULT_DB_URL = "postgresql://neondb_owner:npg_aKMVL6bok7gm@ep-floral-lab-aehhbt84-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
DATABASE_URL = os.getenv("DATABASE_URL", DEFAULT_DB_URL)

# Normalize SQLAlchemy connection string for postgresql
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

PING_INTERVAL_MINUTES = int(os.getenv("PING_INTERVAL_MINUTES", "10"))
HTTP_TIMEOUT_SECONDS = float(os.getenv("HTTP_TIMEOUT_SECONDS", "15.0"))

# SQLAlchemy Engine & Session with Neon-friendly pooling settings
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,      # Automatically verify connection liveness
    pool_recycle=300,        # Recycle connections every 5 minutes to avoid Neon connection drop
    pool_size=10,
    max_overflow=20,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


# -----------------------------------------------------------------------------
# Database Models
# -----------------------------------------------------------------------------
class MonitoredURL(Base):
    __tablename__ = "monitored_urls"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    url = Column(String(1024), unique=True, nullable=False, index=True)
    status = Column(String(100), default="Pending Initial Ping")
    last_ping = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    response_time_ms = Column(Integer, nullable=True)
    http_code = Column(Integer, nullable=True)

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "url": self.url,
            "status": self.status,
            "last_ping": self.last_ping.isoformat() if self.last_ping else None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "response_time_ms": self.response_time_ms,
            "http_code": self.http_code,
        }


# Auto-create tables on import/startup
def init_db():
    try:
        Base.metadata.create_all(bind=engine)
        logger.info("Database schema verified and tables ensured.")
    except Exception as e:
        logger.error(f"Error initializing database schema: {e}")


# Dependency for DB sessions
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# -----------------------------------------------------------------------------
# Pydantic Schemas
# -----------------------------------------------------------------------------
class URLCreateRequest(BaseModel):
    name: str
    url: str

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Project name cannot be empty.")
        if len(v) > 255:
            raise ValueError("Project name cannot exceed 255 characters.")
        return v

    @field_validator("url")
    @classmethod
    def validate_url(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("URL cannot be empty.")
        # Auto-prefix https:// if missing
        if not v.startswith("http://") and not v.startswith("https://"):
            v = "https://" + v
        return v


class MonitoredURLResponse(BaseModel):
    id: int
    name: str
    url: str
    status: str
    last_ping: Optional[str]
    created_at: Optional[str]
    response_time_ms: Optional[int]
    http_code: Optional[int]


# -----------------------------------------------------------------------------
# Core Ping Engine
# -----------------------------------------------------------------------------
async def perform_http_ping(url_str: str) -> dict:
    """
    Executes an HTTP GET ping with strict 15-second timeout and user-agent header.
    Captures status code, response time, and classifies Render state.
    """
    headers = {
        "User-Agent": "Render-KeepAlive-Hub/1.0 (+https://render-keepalive-hub.onrender.com)",
        "Accept": "*/*",
        "Cache-Control": "no-cache",
    }
    start_time = time.perf_counter()
    try:
        async with httpx.AsyncClient(
            timeout=HTTP_TIMEOUT_SECONDS,
            follow_redirects=True,
            verify=False  # Avoid failing if target has self-signed cert in dev
        ) as client:
            response = await client.get(url_str, headers=headers)
            elapsed_ms = int((time.perf_counter() - start_time) * 1000)
            status_code = response.status_code

            # Classify status
            if 200 <= status_code < 300:
                status_label = f"Active {status_code}"
            elif status_code in (502, 503, 504):
                # Render free tier cold boot or gateway waking up
                status_label = f"Waking Up ({status_code})"
            elif 300 <= status_code < 400:
                status_label = f"Redirect ({status_code})"
            elif 400 <= status_code < 500:
                # 404/401/403 still means the server is UP and awake!
                status_label = f"Active ({status_code})"
            else:
                status_label = f"HTTP {status_code}"

            return {
                "status": status_label,
                "http_code": status_code,
                "response_time_ms": elapsed_ms,
                "error": None
            }

    except httpx.TimeoutException:
        elapsed_ms = int((time.perf_counter() - start_time) * 1000)
        return {
            "status": "Timeout (>15s)",
            "http_code": 408,
            "response_time_ms": elapsed_ms,
            "error": "Request timed out after 15 seconds"
        }
    except (httpx.ConnectError, httpx.NetworkError) as e:
        elapsed_ms = int((time.perf_counter() - start_time) * 1000)
        return {
            "status": "Unreachable / DNS Error",
            "http_code": 0,
            "response_time_ms": elapsed_ms,
            "error": str(e)
        }
    except Exception as e:
        elapsed_ms = int((time.perf_counter() - start_time) * 1000)
        return {
            "status": "Failed",
            "http_code": 0,
            "response_time_ms": elapsed_ms,
            "error": str(e)
        }


async def ping_single_url_db(url_id: int) -> Optional[dict]:
    """Pings a single URL by ID and saves the outcome in Neon PostgreSQL."""
    db = SessionLocal()
    try:
        record = db.query(MonitoredURL).filter(MonitoredURL.id == url_id).first()
        if not record:
            return None

        result = await perform_http_ping(record.url)
        record.status = result["status"]
        record.http_code = result["http_code"]
        record.response_time_ms = result["response_time_ms"]
        record.last_ping = datetime.now(timezone.utc)

        db.commit()
        db.refresh(record)
        return record.to_dict()
    except Exception as e:
        db.rollback()
        logger.error(f"Failed to update ping outcome for URL ID {url_id}: {e}")
        return None
    finally:
        db.close()


async def execute_scheduled_ping_cycle():
    """Scheduled task that iterates through all registered URLs and pings them concurrently."""
    logger.info("Executing scheduled Keep-Alive ping cycle...")
    db = SessionLocal()
    try:
        urls = db.query(MonitoredURL).all()
        if not urls:
            logger.info("No URLs registered for ping cycle.")
            return

        logger.info(f"Pinging {len(urls)} target URL(s)...")

        async def _ping_and_save(target_id: int, target_url: str):
            res = await perform_http_ping(target_url)
            # Create isolated db session for each record to prevent batch rollback
            item_db = SessionLocal()
            try:
                rec = item_db.query(MonitoredURL).filter(MonitoredURL.id == target_id).first()
                if rec:
                    rec.status = res["status"]
                    rec.http_code = res["http_code"]
                    rec.response_time_ms = res["response_time_ms"]
                    rec.last_ping = datetime.now(timezone.utc)
                    item_db.commit()
            except Exception as ex:
                item_db.rollback()
                logger.error(f"Error updating URL ID {target_id}: {ex}")
            finally:
                item_db.close()

        tasks = [_ping_and_save(u.id, u.url) for u in urls]
        await asyncio.gather(*tasks, return_exceptions=True)
        logger.info(f"Keep-Alive ping cycle finished successfully for {len(urls)} target(s).")
    except Exception as e:
        logger.error(f"Ping cycle error: {e}")
    finally:
        db.close()


# -----------------------------------------------------------------------------
# FastAPI App Initialization
# -----------------------------------------------------------------------------
scheduler = AsyncIOScheduler()

app = FastAPI(
    title="Render 24/7 Keep-Alive Hub",
    description="Automated health check and 24/7 keep-alive manager for Render deployments.",
    version="1.0.0"
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Template setup
templates = Jinja2Templates(directory="templates")


@app.on_event("startup")
async def on_startup():
    """Initializes DB schema, configures background scheduler, and runs initial ping."""
    init_db()

    # Schedule recurring ping every 10 minutes (*/10 * * * *)
    scheduler.add_job(
        execute_scheduled_ping_cycle,
        CronTrigger(minute=f"*/{PING_INTERVAL_MINUTES}"),
        id="render_keep_alive_cycle",
        name="Render Keep-Alive 10-Min Cycle",
        replace_existing=True
    )
    scheduler.start()
    logger.info(f"APScheduler started: Ping cycle set to run every {PING_INTERVAL_MINUTES} minutes.")

    # Trigger a soft initial ping in the background after 3 seconds so the dashboard gets immediate data
    async def delayed_initial_ping():
        await asyncio.sleep(3)
        await execute_scheduled_ping_cycle()

    asyncio.create_task(delayed_initial_ping())


@app.on_event("shutdown")
async def on_shutdown():
    """Gracefully shuts down scheduler."""
    if scheduler.running:
        scheduler.shutdown()
        logger.info("APScheduler stopped.")


# -----------------------------------------------------------------------------
# Web & API Endpoints
# -----------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def serve_dashboard(request: Request, db: Session = Depends(get_db)):
    """Serves the Single Page Dashboard."""
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "ping_interval": PING_INTERVAL_MINUTES
        }
    )


@app.get("/api/urls", response_model=List[MonitoredURLResponse])
async def list_monitored_urls(db: Session = Depends(get_db)):
    """Returns JSON array of all stored URLs ordered by ID descending."""
    urls = db.query(MonitoredURL).order_by(desc(MonitoredURL.id)).all()
    return [u.to_dict() for u in urls]


@app.post("/api/urls", status_code=status.HTTP_201_CREATED)
async def create_monitored_url(payload: URLCreateRequest, db: Session = Depends(get_db)):
    """Inserts a new target URL into NeonDB and triggers an immediate ping."""
    # Check for existing duplicate URL
    existing = db.query(MonitoredURL).filter(MonitoredURL.url == payload.url).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"URL '{payload.url}' is already being monitored as '{existing.name}'."
        )

    new_item = MonitoredURL(
        name=payload.name,
        url=payload.url,
        status="Waking Up...",
        created_at=datetime.now(timezone.utc)
    )
    db.add(new_item)
    db.commit()
    db.refresh(new_item)

    # Perform immediate ping in background so user immediately sees live status
    asyncio.create_task(ping_single_url_db(new_item.id))

    return {
        "success": True,
        "message": f"Successfully added '{new_item.name}'. Initial health check triggered.",
        "data": new_item.to_dict()
    }


@app.delete("/api/urls/{url_id}")
async def delete_monitored_url(url_id: int, db: Session = Depends(get_db)):
    """Removes a target URL from NeonDB."""
    record = db.query(MonitoredURL).filter(MonitoredURL.id == url_id).first()
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Target URL not found.")

    url_name = record.name
    db.delete(record)
    db.commit()
    return {"success": True, "message": f"Deleted '{url_name}' from monitoring."}


@app.post("/api/ping/{url_id}")
async def trigger_manual_ping(url_id: int):
    """Instantly triggers a manual ping to a specific target URL and returns updated state."""
    updated = await ping_single_url_db(url_id)
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Target URL not found.")
    return {"success": True, "data": updated}


@app.post("/api/ping-all")
async def trigger_ping_all():
    """Triggers an immediate sweep ping across all registered target URLs."""
    asyncio.create_task(execute_scheduled_ping_cycle())
    return {"success": True, "message": "Manual ping cycle initiated for all monitored targets."}


@app.get("/api/stats")
async def get_monitoring_stats(db: Session = Depends(get_db)):
    """Returns real-time dashboard metrics (Alive, Waking Up, Offline, Total)."""
    urls = db.query(MonitoredURL).all()
    total = len(urls)
    alive = sum(1 for u in urls if u.status and u.status.startswith("Active"))
    waking = sum(1 for u in urls if u.status and ("Waking" in u.status or "Redirect" in u.status))
    failed = sum(1 for u in urls if u.status and ("Failed" in u.status or "Timeout" in u.status or "Unreachable" in u.status))

    # Next scheduled run
    next_run = None
    job = scheduler.get_job("render_keep_alive_cycle")
    if job and job.next_run_time:
        next_run = job.next_run_time.isoformat()

    return {
        "total": total,
        "alive": alive,
        "waking": waking,
        "failed": failed,
        "next_run": next_run,
        "ping_interval_minutes": PING_INTERVAL_MINUTES
    }


@app.get("/api/health")
async def health_check(db: Session = Depends(get_db)):
    """
    Self-health check endpoint.
    Users can register THIS endpoint on external cron or self-monitor to keep this Hub alive!
    """
    db_ok = False
    try:
        db.execute(text("SELECT 1"))
        db_ok = True
    except Exception as e:
        logger.error(f"Health check DB ping failed: {e}")

    return {
        "status": "ok" if db_ok else "degraded",
        "service": "Render 24/7 Keep-Alive Hub",
        "database_connected": db_ok,
        "scheduler_running": scheduler.running,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }


# -----------------------------------------------------------------------------
# Local Dev Entrypoint
# -----------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8000"))
    host = os.getenv("HOST", "0.0.0.0")
    print(f"\n🚀 Launching Render 24/7 Keep-Alive Hub on http://localhost:{port}\n")
    uvicorn.run("app:app", host=host, port=port, reload=True)
