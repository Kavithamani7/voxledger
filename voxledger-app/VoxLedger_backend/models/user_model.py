from pydantic import BaseModel, Field
from typing import Optional


class UserRegisterRequest(BaseModel):
    name: str = Field(..., min_length=2, max_length=100)
    password: str = Field(..., min_length=4)


class UserResponse(BaseModel):
    id: int
    name: str
    created_at: str


class CheckUserResponse(BaseModel):
    registered: bool
    user_id: Optional[int] = None
    user_name: Optional[str] = None
    has_user: bool = False
    has_voice_profile: bool = False


class LoginRequest(BaseModel):
    user_id: int
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: int
    user_name: str
