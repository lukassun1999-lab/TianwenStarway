"""MiniMax 直连对话客户端"""
import asyncio
import httpx
import json
import re
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from config import MINIMAX_MODEL, MINIMAX_URL


class LLMError(Exception):
    """带用户可读提示的 LLM 调用失败。"""


# 配额/余额类业务错误码：重试无意义，应立即失败
_QUOTA_ERROR_CODES = {1008, 2056}

# 业务错误码 → 用户可读提示
_ERROR_CODE_MESSAGES = {
    1008: "AI 服务账户余额不足（1008），请前往 MiniMax 控制台充值后重试。",
    2056: "AI 服务用量额度已达上限（2056，Token Plan 套餐额度用尽）。套餐额度不会回落到钱包余额，请升级套餐、购买积分，或改用开放平台的按量计费 API key。",
}


# MiniMax 有时把错误码写在 message 文本末尾，如 "... 用量上限 ... (2056)"
_ERROR_CODE_IN_MESSAGE_RE = re.compile(r"[（(]\s*(\d{3,5})\s*[)）]")


def _extract_error_code(body: str):
    """从 MiniMax 响应体解析业务错误码。

    兼容三种形式（实测 2056 走的是第 3 种）：
    1. `base_resp.status_code`（如 1008）
    2. `error.code` / `code`
    3. 错误码嵌在 `error.message` 文本里，如 "...购买积分补充用量。 (2056)"
    """
    if not body:
        return None
    try:
        data = json.loads(body)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None

    code = (
        (data.get("base_resp") or {}).get("status_code")
        or (data.get("error") or {}).get("code")
        or data.get("code")
    )
    if code is not None:
        return code

    # 兜底：从 message 文本中提取括号内的错误码
    message = (data.get("error") or {}).get("message") or data.get("message") or ""
    match = _ERROR_CODE_IN_MESSAGE_RE.search(str(message))
    return int(match.group(1)) if match else None


def _is_quota_error(body: str) -> bool:
    """是否为配额/余额用尽类错误（重试无意义）。"""
    return _extract_error_code(body) in _QUOTA_ERROR_CODES


def _friendly_error(status_code: int = 0, body: str = "", network: bool = False) -> str:
    """把 MiniMax 错误码翻译成用户可读的中文提示。

    注意：MiniMax 会把配额/余额类错误也包在 HTTP 429 里（如 2056 Token Plan 额度上限），
    因此必须先解析响应体业务错误码，再退回按 HTTP 状态码判断，
    否则会把"额度用尽"误报成"请求过于频繁"。"""
    if network:
        return "无法连接 AI 服务，请检查网络后重试。"

    # 业务错误码优先：同一个 HTTP 状态码可能对应完全不同的原因
    err_code = _extract_error_code(body)
    if err_code in _ERROR_CODE_MESSAGES:
        return _ERROR_CODE_MESSAGES[err_code]

    if status_code == 401:
        return "AI 服务密钥无效（401），请检查 src/backend/.env 中的 LLM_API_KEY。"
    if status_code == 402:
        return "AI 服务账户余额不足（402），请前往 MiniMax 控制台充值后重试。"
    if status_code == 429:
        return "请求过于频繁（429），请稍等片刻再试。"

    return f"AI 服务暂时不可用（HTTP {status_code}），请稍后重试。"


def _extract_text_from_minimax(result: dict) -> str:
    """提取最终回答文本，两种端点的响应结构都兼容：

    Anthropic 兼容端点 → `content[]`，其中 `thinking` block 占 token 但不是答案，
    只收 `type == "text"` 的（MiniMax-M2.7 自 2026-08 起默认先输出一段 thinking）；
    OpenAI 兼容端点 → `choices[0].message.content`。
    都取不到就返回空串，由调用方决定重试还是报错。"""
    if not isinstance(result, dict):
        return ""
    blocks = result.get("content")
    if isinstance(blocks, list):
        return "".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text")
    choices = result.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        return (choices[0].get("message") or {}).get("content") or ""
    return ""


def _hit_token_limit(result: dict) -> bool:
    """输出是被 max_tokens 截断的（两种端点字段名不同）。"""
    if not isinstance(result, dict):
        return False
    if result.get("stop_reason") == "max_tokens":
        return True
    choices = result.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        return choices[0].get("finish_reason") == "length"
    return False


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
                    # 老端点会把配额类错误包成 HTTP 200 + choices:null，只在 base_resp 里露码；
                    # 不先判这一步，"额度用尽"会被当成"只有思考块"白重试三轮、还报错误原因。
                    err_code = _extract_error_code(resp.text)
                    if err_code in _ERROR_CODE_MESSAGES:
                        raise LLMError(_ERROR_CODE_MESSAGES[err_code])
                    # 只有 thinking 没 text：模型把预算耗在思考上
                    if _hit_token_limit(result):
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
                    last_error = _friendly_error(429, resp.text)
                    # 配额/余额用尽（2056/1008）重试无意义：立即失败，避免用户白等约 14 秒
                    if _is_quota_error(resp.text):
                        raise LLMError(last_error)
                    if attempt < max_retries - 1:
                        wait = (2 ** attempt) * 2  # 2, 4, 8 seconds
                        print(f"MiniMax 429, retrying in {wait}s (attempt {attempt+1}/{max_retries})")
                        await asyncio.sleep(wait)
                    continue
                last_error = _friendly_error(resp.status_code, resp.text)
                # 配额/余额用尽重试无意义，立即失败
                if _is_quota_error(resp.text):
                    raise LLMError(last_error)
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
