# 知识库检索模块（MVP阶段：简单关键词匹配）
import json
import os

KNOWLEDGE_BASE_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "culture")

def search_knowledge(keyword: str, limit: int = 3) -> list[dict]:
    """简单关键词搜索文化知识库"""
    results = []
    keyword_lower = keyword.lower()

    # 搜索诗词
    poetry_file = os.path.join(KNOWLEDGE_BASE_DIR, "star_poetry.json")
    if os.path.exists(poetry_file):
        try:
            with open(poetry_file, "r", encoding="utf-8") as f:
                poems = json.load(f)
                for poem in poems:
                    if keyword_lower in poem.get("content", "").lower() or keyword_lower in poem.get("title", "").lower():
                        results.append({"type": "poetry", "source": poem})
                        if len(results) >= limit:
                            return results
        except Exception:
            pass

    # 搜索天官书
    tianguan_file = os.path.join(KNOWLEDGE_BASE_DIR, "tian_guan_shu.json")
    if os.path.exists(tianguan_file):
        try:
            with open(tianguan_file, "r", encoding="utf-8") as f:
                entries = json.load(f)
                for entry in entries:
                    if keyword_lower in entry.get("text", "").lower() or keyword_lower in entry.get("star", "").lower():
                        results.append({"type": "tianguanshu", "source": entry})
                        if len(results) >= limit:
                            return results
        except Exception:
            pass

    # 搜索开元占经
    kaiyuan_file = os.path.join(KNOWLEDGE_BASE_DIR, "kai_yuan_zhan_jing.json")
    if os.path.exists(kaiyuan_file):
        try:
            with open(kaiyuan_file, "r", encoding="utf-8") as f:
                entries = json.load(f)
                for entry in entries:
                    if keyword_lower in entry.get("text", "").lower() or keyword_lower in entry.get("star", "").lower():
                        results.append({"type": "kaiyuanzhanjing", "source": entry})
                        if len(results) >= limit:
                            return results
        except Exception:
            pass

    return results