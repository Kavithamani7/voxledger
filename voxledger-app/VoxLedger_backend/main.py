"""
VoxLedger Backend – FastAPI entry point
Run with: uvicorn main:app --reload --port 8000
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager

from config import settings
from database import init_db

# Import all routers
from routes.auth_routes import router as auth_router
from routes.transaction_routes import router as transaction_router
from routes.budget_routes import router as budget_router
from routes.notification_routes import router as notification_router
from routes.voice_routes import router as voice_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialise database tables and pre-load ML models on startup."""
    init_db()
    # Pre-load Whisper in background so first voice command is fast
    import threading
    from services.whisper_service import preload_model
    from config import settings
    threading.Thread(target=preload_model, args=(settings.WHISPER_MODEL,), daemon=True).start()
    print(f"🚀  {settings.APP_NAME} v{settings.APP_VERSION} started.")
    yield
    print("🛑  Shutting down.")


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="Voice-First Personal Finance Assistant – Backend API",
    lifespan=lifespan,
)

# ── CORS (allow the Vite frontend on port 5173 and any localhost) ─────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(auth_router)                          # /check-user, /register, /verify-voice, ...
app.include_router(transaction_router)                   # /transactions/...
app.include_router(budget_router)                        # /budget/...
app.include_router(notification_router)                  # /notifications/...
app.include_router(voice_router, prefix="/voice")        # /voice/voice-command, /voice/tts, ...


# ── Health check ──────────────────────────────────────────────────────────────
@app.get("/", tags=["Health"])
def root():
    return {
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "status": "running",
        "docs": "/docs",
    }


@app.get("/health", tags=["Health"])
def health():
    return {"status": "ok"}
