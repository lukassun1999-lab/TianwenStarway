"""OpenMAIC chat client - tries OpenMAIC first (optional), falls back to MiniMax"""
import asyncio
import httpx
import json
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from config import OPENMAIC_BASE_URL, OPENMAIC_CHAT_ENABLED, MINIMAX_MODEL

MINIMAX_URL = "https://api.minimaxi.com/anthropic/v1/messages"


class LLMError(Exception):
    """带用户可读提示的 LLM 调用失败。"""


_openmaic_available = True
_openmaic_fail_count = 0
_openmaic_max_fails = 3


def _friendly_error(status_code: int = 0, body: str = "", network: bool = False) -> str:
    """把 MiniMax 错误码翻译成用户可读的中文提示。"""
    if network:
        return "无法连接 AI 服务，请检查网络后重试。"
    if status_code == 401:
        return "AI 服务密钥无效（401），请检查 src/backend/.env 中的 LLM_API_KEY。"
    if status_code == 402:
        return "AI 服务账户余额不足（402），请前往 MiniMax 控制台充值后重试。"
    if status_code == 429:
        return "请求过于频繁（429），请稍等片刻再试。"

    # MiniMax 错误码在响应体 base_resp.status_code / error.code 中
    err_code = None
    if body:
        try:
            data = json.loads(body)
            err_code = (
                data.get("base_resp", {}).get("status_code")
                or data.get("error", {}).get("code")
                or data.get("code")
            )
        except Exception:
            pass
    if err_code == 1008:
        return "AI 服务账户余额不足（1008），请前往 MiniMax 控制台充值后重试。"
    if err_code == 2056:
        return "AI 服务 Token Plan 用量已达上限（2056），请等待额度重置或升级套餐。"

    return f"AI 服务暂时不可用（HTTP {status_code}），请稍后重试。"


async def call_openmaic_chat(messages, api_key, system_prompt, agent_id):
    """尝试 OpenMAIC /api/chat 编排对话；失败时返回 None 交给 MiniMax 直连。

    OPENMAIC_CHAT_ENABLED=0 时直接跳过（已知 /api/chat 存在 TypeError，跳过可
    省去一次无效调用和 5 秒等待）。
    """
    global _openmaic_available, _openmaic_fail_count
    if not OPENMAIC_CHAT_ENABLED or not OPENMAIC_BASE_URL or not _openmaic_available:
        return None

    url = f"{OPENMAIC_BASE_URL}/api/chat"
    headers = {"Content-Type": "application/json", "x-api-key": api_key}

    payload = {
        "messages": [
            {"role": "system", "content": system_prompt},
            *messages
        ],
        "storeState": {"prompt": system_prompt, "model": MINIMAX_MODEL},
        "config": {"agentIds": [agent_id]},
        "apiKey": api_key
    }

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code == 200:
                result = resp.json()
                text = _extract_text_from_openmaic(result)
                if text and len(text.strip()) > 20:
                    _openmaic_fail_count = 0
                    return text
    except Exception:
        pass

    _openmaic_fail_count += 1
    if _openmaic_fail_count >= _openmaic_max_fails:
        _openmaic_available = False
        async def _retry_later():
            await asyncio.sleep(60)
            global _openmaic_available, _openmaic_fail_count
            _openmaic_available = True
            _openmaic_fail_count = _openmaic_max_fails - 1
        asyncio.ensure_future(_retry_later())
    return None


def _extract_text_from_openmaic(result):
    """Extract text content from OpenMAIC response"""
    if isinstance(result, dict):
        content = result.get("content") or result.get("response") or result.get("text", "")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = []
            for c in content:
                if isinstance(c, dict):
                    parts.append(c.get("text", c.get("delta", {}).get("text", "")))
                else:
                    parts.append(str(c))
            return "".join(parts)
    if isinstance(result, str):
        return result
    return ""


def _extract_text_from_minimax(result: dict) -> str:
    """从 MiniMax Anthropic 兼容响应中提取 text。

    MiniMax-M2.7 自 2026-08 起默认输出 `thinking` blocks（占 token 但不是最终答案），
    此函数只收集 `type == "text"` 的 blocks；若全部是 thinking 则返回空字符串。"""
    blocks = result.get("content", []) if isinstance(result, dict) else []
    if not isinstance(blocks, list):
        return ""
    return "".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text")


async def call_minimax_direct(messages, api_key, system_prompt, max_tokens=4096):
    """直连 MiniMax，失败时抛出带用户可读提示的 LLMError。max_tokens 可调小以节省成本（如节点分类）。

    MiniMax-M2.7 自 2026-08 起默认返回 `thinking` block（占 token 但不是最终答案）。
    若响应只有 thinking 而无 text，会自动追加一轮让模型直接给最终答案（不消耗新 thinking 配额）。"""
    import time

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}"
    }

    def build_payload(msgs):
        return {
            "model": MINIMAX_MODEL,
            "messages": msgs,
            "max_tokens": max_tokens,
            "temperature": 0.5,
            "top_p": 0.9
        }

    full_messages = []
    if system_prompt:
        full_messages.append({"role": "system", "content": system_prompt})
    full_messages.extend(messages)

    max_retries = 3
    last_error = None

    for attempt in range(max_retries):
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(MINIMAX_URL, headers=headers, json=build_payload(full_messages))
                if resp.status_code == 200:
                    result = resp.json()
                    text = _extract_text_from_minimax(result)
                    if text:
                        return text
                    # 只有 thinking 没 text：模型把预算耗在思考上
                    if result.get("stop_reason") == "max_tokens":
                        # 追加"直接给最终答案"重新请求（不再产生新 thinking，直接输出 text）
                        retry_msgs = list(full_messages) + [
                            {"role": "assistant", "content": "[思考过程已结束]"},
                            {"role": "user", "content": "请直接给出最终答案，不再思考。"},
                        ]
                        resp2 = await client.post(MINIMAX_URL, headers=headers, json=build_payload(retry_msgs))
                        if resp2.status_code == 200:
                            result2 = resp2.json()
                            text2 = _extract_text_from_minimax(result2)
                            if text2:
                                return text2
                    last_error = "模型响应仅含思考块且追加请求失败"
                    if attempt < max_retries - 1:
                        await asyncio.sleep(2 ** attempt)
                    continue
                if resp.status_code in (401, 402, 403, 404):
                    # 账户/密钥类错误，重试无意义，立即失败
                    raise LLMError(_friendly_error(resp.status_code, resp.text))
                if resp.status_code == 429:
                    last_error = _friendly_error(429)
                    if attempt < max_retries - 1:
                        wait = (2 ** attempt) * 2  # 2, 4, 8 seconds
                        print(f"MiniMax 429, retrying in {wait}s (attempt {attempt+1}/{max_retries})")
                        await asyncio.sleep(wait)
                    continue
                last_error = _friendly_error(resp.status_code, resp.text)
                if attempt < max_retries - 1:
                    wait = (2 ** attempt)
                    print(f"MiniMax {resp.status_code}, retrying in {wait}s")
                    await asyncio.sleep(wait)
                continue
        except LLMError:
            raise
        except Exception as e:
            last_error = _friendly_error(network=True)
            if attempt < max_retries - 1:
                wait = (2 ** attempt)
                print(f"MiniMax network error: {e}, retrying in {wait}s")
                await asyncio.sleep(wait)
            continue

    raise LLMError(last_error or "AI 服务暂时不可用，请稍后重试。")
