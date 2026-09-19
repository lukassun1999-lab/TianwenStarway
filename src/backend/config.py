import os
from dotenv import load_dotenv

load_dotenv()

LLM_API_KEY = os.getenv("LLM_API_KEY", "")
MINIMAX_MODEL = os.getenv("MINIMAX_MODEL", "MiniMax-M2.7")

# 默认是 Coding Plan（Token Plan）的 Anthropic 兼容端点，配订阅密钥；
# 换成开放平台的按量计费 API key 时，把 MINIMAX_URL 指到 OpenAI 兼容端点即可，代码无需再改。
MINIMAX_URL = os.getenv("MINIMAX_URL", "https://api.minimaxi.com/anthropic/v1/messages")
