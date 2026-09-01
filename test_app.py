import asyncio
import os
import sys
from dotenv import load_dotenv

load_dotenv()

# Test database connection & table creation
from app import engine, SessionLocal, Base, MonitoredURL, init_db, perform_http_ping

def run_tests():
    print("1. Testing Database Initialization on Neon PostgreSQL...")
    init_db()
    
    db = SessionLocal()
    try:
        # Check connection
        result = db.execute(Base.metadata.tables["monitored_urls"].select().limit(5)).fetchall()
        print(f"   [SUCCESS] Connected to Neon DB! Existing records count: {len(result)}")
        
        # Test HTTP Ping Engine
        print("\n2. Testing HTTP Ping Engine on public endpoint...")
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        ping_res = loop.run_until_complete(perform_http_ping("https://httpbin.org/status/200"))
        print(f"   [SUCCESS] Ping result: {ping_res}")
        assert ping_res["http_code"] == 200, "Expected HTTP 200"
        
        print("\n3. Testing Cold-Start status detection (502 / 503 simulation)...")
        ping_503 = loop.run_until_complete(perform_http_ping("https://httpbin.org/status/503"))
        print(f"   [SUCCESS] 503 classification: {ping_503['status']}")
        assert "Waking Up" in ping_503["status"], "Expected 'Waking Up' label for 503"

        print("\n4. Testing Timeout / Error Handling...")
        ping_err = loop.run_until_complete(perform_http_ping("https://invalid-non-existent-domain-12345.xyz"))
        print(f"   [SUCCESS] Error handled cleanly: {ping_err['status']}")
        
        print("\nAll Core Tests Passed Successfully!")
    finally:
        db.close()

if __name__ == "__main__":
    run_tests()
