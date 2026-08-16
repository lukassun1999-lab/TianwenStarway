from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
import httpx
import sys
import os as _os

sys.path.insert(0, _os.path.dirname(__file__))

from routers import chat, stars, progress
from config import OPENMAIC_BASE_URL, LLM_API_KEY


@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动时检测 OpenMAIC 编排层连接状态"""
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{OPENMAIC_BASE_URL}/api/health")
        if resp.status_code == 200:
            print(f"[OK] OpenMAIC 编排层已连接 ({OPENMAIC_BASE_URL})")
        else:
            print(f"[WARN] OpenMAIC 响应异常 ({OPENMAIC_BASE_URL})，将使用 MiniMax 直连")
    except Exception:
        print(f"[WARN] OpenMAIC 未响应 ({OPENMAIC_BASE_URL})，将使用 MiniMax 直连")
    yield


app = FastAPI(title="Tianwen Starway API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080", "http://127.0.0.1:8080"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def cache_control(request, call_next):
    """HTML/JS/CSS 禁缓存（改动即时生效）；星表等静态数据 JSON 长缓存（前端用 ?v= 版本号失效）"""
    response = await call_next(request)
    path = request.url.path
    if (
        path in ("/", "/frontend", "/frontend/")
        or path.endswith((".html", ".js", ".css"))
        or (path.startswith("/api/") or path.startswith("/health"))
    ):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    elif path.startswith(("/data/", "/frontend/data/")) and path.endswith(".json"):
        response.headers["Cache-Control"] = "public, max-age=604800, immutable"
    return response

app.include_router(chat.router, prefix="/api")
app.include_router(stars.router, prefix="/api")
app.include_router(progress.router, prefix="/api")

# Serve frontend static files and data
_SRC_DIR = _os.path.join(_os.path.dirname(_os.path.dirname(__file__)))
app.mount("/frontend", StaticFiles(directory=_os.path.join(_SRC_DIR, "frontend"), html=True), name="frontend")
app.mount("/data", StaticFiles(directory=_os.path.join(_SRC_DIR, "data")), name="data")


@app.get("/")
async def root():
    return RedirectResponse(url="/frontend/index.html")


@app.get("/health")
async def health():
    return {"status": "ok"}


# MiniMax speech-2.8-hd 可用音色白名单（双导师用不同音色区分）
TTS_VOICE_WHITELIST = {
    "Chinese (Mandarin)_Gentleman",      # 温润男声（开普勒·严谨）
    "audiobook_male_1",                  # 有声书男声1（甘德·随和自然）
    "Chinese (Mandarin)_Radio_Host",
    "male-qn-jingying",
    "female-yujie",
    "female-shaonv",
    "Chinese (Mandarin)_News_Anchor",
    "Chinese (Mandarin)_Warm_Girl",
}


@app.post("/api/tts")
async def text_to_speech(request: Request):
    body = await request.json()
    text = body.get("text", "")
    if not text:
        raise HTTPException(status_code=400, detail="缺少 text 参数")
    voice_id = body.get("voice_id", "female-yujie")
    if voice_id not in TTS_VOICE_WHITELIST:
        voice_id = "female-yujie"

    api_key = LLM_API_KEY
    if not api_key:
        raise HTTPException(status_code=502, detail="未配置 LLM_API_KEY，无法调用语音合成")

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                "https://api.minimaxi.com/v1/t2a_v2",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json; charset=utf-8"
                },
                json={
                    "model": "speech-2.8-hd",
                    "text": text[:500],
                    "stream": False,
                    "output_format": "hex",
                    "voice_setting": {
                        "voice_id": voice_id,
                        "speed": 1.0,
                        "vol": 1,
                        "pitch": 0
                    },
                    "audio_setting": {
                        "sample_rate": 32000,
                        "bitrate": 128000,
                        "format": "mp3",
                        "channel": 1
                    }
                }
            )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="语音合成服务响应超时，请稍后重试")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"语音合成服务异常: {str(e)[:100]}")

    data = resp.json()
    hex_audio = data.get("data", {}).get("audio", "")
    if not hex_audio:
        err_code = data.get("base_resp", {}).get("status_code")
        raise HTTPException(
            status_code=502,
            detail=f"语音合成失败（{'额度/密钥错误 ' + str(err_code) if err_code else f'HTTP {resp.status_code}'}），请检查配置后重试",
        )

    import binascii, base64
    audio_bytes = binascii.unhexlify(hex_audio.strip())
    return {"audio_base64": base64.b64encode(audio_bytes).decode()}