# 知识库检索模块（MVP阶段：按星名与关键词的字符匹配）
import json
import os

KNOWLEDGE_BASE_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "culture")

# (文件名, 结果类型, 参与全文匹配的字段)
_SOURCES = [
    ("star_poetry.json", "poetry", ("title", "content")),
    ("tian_guan_shu.json", "tianguanshu", ("name", "text")),
    ("kai_yuan_zhan_jing.json", "kaiyuanzhanjing", ("name", "text")),
]


def _star_tokens(entry: dict) -> list[str]:
    """原典条目的 star 字段可能是 '参宿,商宿' 这样的多值，拆开后逐个比对。

    单字（如《旅夜书怀》只标了个'星'）会命中所有含'星'的检索词，必须丢弃。"""
    raw = str(entry.get("star") or "")
    return [t.strip() for t in raw.replace("，", ",").split(",") if len(t.strip()) >= 2]


def _matches(term: str, entry: dict, fulltext_fields: tuple[str, ...]) -> bool:
    # 星名双向匹配：检索词'织女星'命中条目'牛郎星,织女星'，'参宿四'也命中条目'参宿'
    for token in _star_tokens(entry):
        if token in term or term in token:
            return True
    return any(term in str(entry.get(field) or "") for field in fulltext_fields)


def search_knowledge(terms, limit: int = 3) -> list[dict]:
    """在诗词 / 天官书 / 开元占经中检索原典片段。

    terms 可以是单个字符串，也可以是多个检索词。原典条目以星名索引，
    整句用户提问几乎不可能是文言原文的子串，所以调用方必须带上当前星名，
    只传提问会让检索恒为空。"""
    if isinstance(terms, str):
        terms = [terms]
    # 过短的词（单字）会命中大量无关条目，无检索价值
    keywords = [t.strip().lower() for t in terms if t and len(t.strip()) >= 2]
    if not keywords:
        return []

    results: list[dict] = []
    seen: set[str] = set()
    for filename, kind, fields in _SOURCES:
        path = os.path.join(KNOWLEDGE_BASE_DIR, filename)
        if not os.path.exists(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                entries = json.load(f)
        except Exception:
            continue
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            fingerprint = json.dumps(entry, sort_keys=True, ensure_ascii=False)
            if fingerprint in seen:
                continue
            if any(_matches(kw, entry, fields) for kw in keywords):
                seen.add(fingerprint)
                results.append({"type": kind, "source": entry})
                if len(results) >= limit:
                    return results

    return results
