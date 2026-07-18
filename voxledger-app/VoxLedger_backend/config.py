from pydantic_settings import BaseSettings
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent


class Settings(BaseSettings):
    APP_NAME: str = "VoxLedger API"
    APP_VERSION: str = "11.0.0"
    DEBUG: bool = True

    # Database
    DATABASE_URL: str = f"sqlite:///{BASE_DIR}/database/voxledger.db"
    DATABASE_PATH: str = str(BASE_DIR / "database" / "voxledger.db")

    # Auth
    SECRET_KEY: str = "voxledger-secret-key-change-in-production"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7  # 7 days

    # Voice
    VOICE_SAMPLE_DIR: str = str(BASE_DIR / "database" / "voice_samples")

    # ── v11: Tuned similarity thresholds ──────────────────────────────────────
    # LOCK_VOICE_SIMILARITY_THRESHOLD: unlock threshold — balanced for reliability
    # Lowered slightly (0.82→0.80) to improve unlock success rate on browser mic
    # while still rejecting other voices and TV/background audio.
    LOCK_VOICE_SIMILARITY_THRESHOLD: float = 0.80

    # VOICE_SIMILARITY_THRESHOLD: general voice matching
    VOICE_SIMILARITY_THRESHOLD: float = 0.76

    # Max stored embeddings per user (name-phrase + wake-phrase + manual additions)
    MAX_VOICE_SAMPLES: int = 10

    # STT model — small gives best accuracy for names and finance terms
    WHISPER_MODEL: str = "small"

    # TTS
    TTS_LANGUAGE: str = "en"
    TTS_DIR: str = str(BASE_DIR / "database" / "tts_cache")
    TTS_SPEED: float = 1.35   # slightly slower than 1.4 — more natural speech rate

    # Currency
    CURRENCY_SYMBOL: str = "₹"
    CURRENCY_CODE: str = "INR"

    # Budget alert thresholds
    BUDGET_WARNING_PCT: float = 0.80   # 80% = warning
    BUDGET_CRITICAL_PCT: float = 0.95  # 95% = critical

    class Config:
        env_file = ".env"
        case_sensitive = True


settings = Settings()
