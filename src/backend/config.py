import os
from dotenv import load_dotenv

load_dotenv()

OPENMAIC_BASE_URL = os.getenv("OPENMAIC_BASE_URL", "http://localhost:3000")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "minimax")
# OpenMAIC /api/chat 已知会报 TypeError，默认关闭编排对话，直连 MiniMax。
# 需要启用时在 .env 中设置 OPENMAIC_CHAT_ENABLED=1
OPENMAIC_CHAT_ENABLED = os.getenv("OPENMAIC_CHAT_ENABLED", "0") == "1"
MINIMAX_MODEL = os.getenv("MINIMAX_MODEL", "MiniMax-M2.7")
