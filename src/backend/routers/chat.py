from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, Literal
import json
import asyncio
import sys
import os
import re
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from session import store
from openmaic_client import call_openmaic_chat, call_minimax_direct, LLMError
from agents import (
    SCIENCE_OFFICER_PROMPT_JUNIOR,
    GRAND_HISTORIAN_PROMPT_JUNIOR,
    AGENT_ID_SCIENCE,
    AGENT_ID_CULTURE,
)
from knowledge_base import search_knowledge
import config
from models import Stage

router = APIRouter()

# 自言自语过滤安全网
_SELF_TALK_PREFIX_RE = re.compile(
    r'^('
    r'哦[，,].*?[。！!？?]'
    r'|嗯[，,].*?[。！!？?]'
    r'|那[我么].*?(?:回答|说|讲|解释).*?[。！!？?]'
    r'|让[我你].*?(?:想想|思考|组织|试).*?[。！!？?]'
    r'|好的[，,].*?[。！!？?]'
    r'|这样的话[，,].*?[。！!？?]'
    r'|明白了[，,].*?[。！!？?]'
    r')\s*'
)


# 追问答案运行时缓存（key: star_id -> {question_text -> {science, culture}}）
# 推荐问题点开走档案预置（sample_answers），但用户即兴追问走此缓存——首次走 LLM 后填入，跨 session 复用
_QUESTION_CACHE: dict[str, dict[str, dict[str, str]]] = {}


def _clean_self_talk(text: str) -> str:
    """去除 LLM 回答中偶尔出现的自言自语前缀句。"""
    if not text:
        return text

    cleaned = text.strip()

    # 去掉开头的自言自语前缀句（最多去掉一句）
    cleaned = _SELF_TALK_PREFIX_RE.sub('', cleaned, count=1).strip()

    return cleaned if cleaned else text.strip()

# 加载星辰专属档案
PROFILES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "data")
_profiles_cache = None


def _load_profiles():
    global _profiles_cache
    if _profiles_cache is None:
        profile_file = os.path.join(PROFILES_DIR, "star_profiles.json")
        try:
            with open(profile_file, "r", encoding="utf-8") as f:
                _profiles_cache = json.load(f)
        except Exception:
            _profiles_cache = {}
    return _profiles_cache


def _get_profile(star_id: str) -> Optional[dict]:
    profiles = _load_profiles()
    return profiles.get(star_id)


def _get_star_context(star_id: str) -> tuple[Optional[str], Optional[str], Optional[dict]]:
    """返回科学档案文本、文化档案文本、完整档案字典"""
    profile = _get_profile(star_id)
    if not profile:
        return None, None, None

    sci = profile.get("science", {})
    cul = profile.get("culture", {})

    science_ctx = f"""【{profile.get('name_cn', star_id)}·科学档案】
它是什么：{sci.get('what', '')}
为什么重要：{sci.get('why', '')}
令人惊叹的事实：{sci.get('wow', '')}
基础数据：{json.dumps(sci.get('data', {}), ensure_ascii=False)}
"""

    culture_ctx = f"""【{profile.get('name_cn', star_id)}·文化档案】
古人怎么叫它：{cul.get('what', '')}
古籍故事：{cul.get('story', '')}
相关诗词：{cul.get('poetry', '')}
神话传说：{cul.get('myth', '')}
"""

    return science_ctx, culture_ctx, profile


def _lit_dimensions(profile: Optional[dict], lit_nodes) -> list:
    """返回已点亮节点覆盖的不同维度列表（fact/culture/compare）"""
    if not profile:
        return []
    dim_map = {n.get("id"): n.get("dimension") for n in profile.get("cognitive_nodes", [])}
    dims = []
    for nid in lit_nodes:
        d = dim_map.get(nid)
        if d and d not in dims:
            dims.append(d)
    return dims


def _can_choose(sp, profile: Optional[dict]) -> bool:
    """抉择门槛（初中版6.1）：点亮节点数达标，且覆盖至少 2 个不同维度。
    无档案星（required_nodes=0）直接放行。"""
    if len(sp.lit_nodes) < sp.required_nodes:
        return False
    if sp.required_nodes == 0:
        return True
    return len(_lit_dimensions(profile, sp.lit_nodes)) >= 2


def _match_cognitive_nodes(question: str, profile: dict) -> list[str]:
    """根据学生问题命中认知节点，使用带权评分减少误匹配"""
    nodes = profile.get("cognitive_nodes", [])
    if not nodes:
        return []

    q = question.lower()
    lit = []
    scored = []  # (node_id, score, dimension)

    # 维度关键词及权重（作为补充，权重较低）
    dimension_weights = {
        "fact": {
            "怎么知道": 1.5, "多远": 1.0, "多亮": 1.0, "温度": 1.0,
            "颜色": 0.5, "大小": 0.5, "科学": 1.0, "物理": 1.0, "数据": 1.0,
            "是什么": 0.5, "恒星": 0.5, "演化": 1.0, "光谱": 1.0, "光年": 1.0,
        },
        "culture": {
            "古诗": 1.0, "诗词": 1.0, "古人": 1.5, "古代": 0.5, "文化": 1.0,
            "故事": 0.5, "神话": 1.0, "传说": 0.5, "象征": 1.0, "天官书": 1.5,
            "史记": 1.0, "诗经": 1.0, "杜甫": 1.0, "李白": 1.0, "开元占经": 1.5,
        },
        "compare": {
            "不一样": 1.0, "为什么不同": 1.5, "对比": 1.0, "比较": 1.0,
            "西方": 0.5, "中国": 0.5, "中西方": 1.0, "同名": 1.0,
            "差异": 1.0, "区别": 1.0, "不同": 0.5,
        }
    }

    for node in nodes:
        node_id = node.get("id")
        keywords = node.get("keywords", [])
        dimension = node.get("dimension", "")
        score = 0.0

        # 节点专属关键词匹配（高权重）
        for kw in keywords:
            if kw.lower() in q:
                score += 2.0

        # 维度关键词匹配（低权重，作为补充）
        dim_weights = dimension_weights.get(dimension, {})
        for kw, weight in dim_weights.items():
            if kw in q:
                score += weight

        scored.append((node_id, score, dimension))
        if score >= 2.0:
            lit.append(node_id)

    # 跨维度兜底（第 1 条）：每个有明确维度倾向的维度点亮其最高分节点。
    # 如"北极星以后还是北极星吗"同时含"科学"与"古人/永恒"倾向 → 点亮两个维度。
    best_by_dimension = {}
    for node_id, score, dimension in scored:
        if score >= 1.0 and (dimension not in best_by_dimension or score > best_by_dimension[dimension][1]):
            best_by_dimension[dimension] = (node_id, score)
    for node_id, _ in best_by_dimension.values():
        if node_id not in lit:
            lit.append(node_id)

    return lit


async def _match_cognitive_nodes_llm(question: str, profile: dict, api_key: str) -> list[str]:
    """用 LLM 做语义节点分类（第 3 条）：学生问"它会不会变"也能命中"演化"类节点。
    跨维度问题可同时命中多个节点；失败时返回空列表，由关键词匹配兜底。"""
    nodes = profile.get("cognitive_nodes", [])
    if not nodes:
        return []

    node_desc = "\n".join(
        f"- {n['id']}（维度：{n['dimension']}，含义：{n.get('label', '')}）"
        for n in nodes
    )
    prompt = f"""你是认知分类器。学生问了一个关于恒星的问题，请判断它命中下面哪些认知节点。
认知节点：
{node_desc}
学生问题：{question}

规则：
1. 语义匹配优先：学生不会用术语（如"它会不会变"→命中"未来如何变化"类节点，"古人为什么这样想"→命中文化类节点）；
2. 跨维度问题可以同时命中多个节点（如既问科学又问文化）；
3. 都没有命中就返回空数组。
只输出 JSON 字符串数组，如 ["fact_age","culture_emperor"]，不要任何其他文字。"""

    try:
        result = await call_minimax_direct(
            [{"role": "user", "content": prompt}],
            api_key,
            "你是认知分类器，只输出 JSON 数组。",
            max_tokens=64,  # 分类输出很短，控制成本
        )
        ids = json.loads(result.strip())
        valid = [i for i in ids if any(n["id"] == i for n in nodes)]
        return valid
    except Exception:
        return []


def _build_agent_prompt(profile: dict, agent_type: Literal["science", "culture"]) -> str:
    """根据档案构建初中版 Agent 提示词"""
    if agent_type == "science":
        base = SCIENCE_OFFICER_PROMPT_JUNIOR
        focus = profile.get("science", {}).get("wow", "")
        what = profile.get("science", {}).get("what", "")
        tension = profile.get("tension", "")
    else:
        base = GRAND_HISTORIAN_PROMPT_JUNIOR
        focus = profile.get("culture", {}).get("story", "")
        what = profile.get("culture", {}).get("what", "")
        tension = profile.get("tension", "")

    return f"""{base}

当前星辰：{profile.get('name_cn', '')}（{profile.get('name_en', '')}）
核心张力：{tension}
{'科学焦点' if agent_type == 'science' else '文化焦点'}：{what}
{('令人惊叹的事实：' + focus) if focus else ''}

回答时请：
1. 控制在 120 字左右，但更注重表达清晰自然；
2. 用初中生能懂的比喻或生活例子；
3. 不要堆砌公式和专业术语；
4. 专注于{'科学角度' if agent_type == 'science' else '文化角度'}，不越界；
5. 直接给出最终回答，不要写出内心独白、思考过程、自言自语；
6. 结尾另起一行，用固定格式给出一个能勾起好奇、可延伸新知识的追问问题：先写「追问：」三个字，再写具体问题（例如「追问：想知道它为什么掉不下来吗？」）。问题要具体、能自然引出下一个知识点，不要用"你觉得呢"这类空洞问题。"""


def _generate_suggested_questions(star_id: str, lit_nodes: set[str]) -> list[str]:
    """根据未点亮的节点生成推荐问题"""
    profile = _get_profile(star_id)
    if not profile:
        return ["这颗星有什么特别之处？", "古人怎么看这颗星？"]

    nodes = profile.get("cognitive_nodes", [])
    samples = profile.get("sample_questions", [])

    # 优先推荐未点亮节点对应的问题
    questions = []
    for node in nodes:
        if node.get("id") not in lit_nodes:
            # 找到这个节点相关的 sample question
            node_kw = node.get("keywords", [])
            for q in samples:
                if any(kw in q for kw in node_kw):
                    questions.append(q)
                    break

    # 补充通用问题（推荐问题只给 1-2 个，作为"卡住时的兜底"，第一屏鼓励自由输入）
    if len(questions) < 2:
        for q in samples:
            if q not in questions:
                questions.append(q)
            if len(questions) >= 2:
                break

    return questions[:2]


async def _call_agent(messages, system_prompt, agent_id, api_key, model):
    """优先通过 OpenMAIC 编排对话，失败时回退到 MiniMax"""
    result = await call_openmaic_chat(messages, api_key, system_prompt, agent_id)
    if result:
        return result
    return await call_minimax_direct(messages, api_key, system_prompt)


# ==================== API Models ====================

class ChatRequest(BaseModel):
    content: str = ""
    session_id: Optional[str] = None
    star_id: Optional[str] = None
    api_key: Optional[str] = None
    model: str = "minimax"
    # blend：罗盘融合（主流程）；quiz：觉醒前小测验出题
    action: Literal["initial", "question", "awaken", "blend", "quiz"] = "initial"
    decision: Optional[Literal["science", "history", "compare"]] = None
    fusion_balance: Optional[float] = None
    fragments: Optional[list] = None  # 星空异动碎片（name+desc），供 quiz 出题参考
    force_llm: Optional[bool] = False  # 强制 LLM 动态出题（跳过预置优先，用于动态性恢复）


# ==================== Helpers ====================

STAGE_NAMES = {
    Stage.DUSTY: "尘封",
    Stage.REVEALED: "初现",
    Stage.QUESTIONED: "追问",
    Stage.CHOSEN: "抉择",
    Stage.MAPPED: "映射",
    Stage.RESONATED: "共鸣",
    Stage.AWAKENED: "觉醒",
}


def _get_transition_text(
    stage: Stage,
    star_id: str,
    profile: Optional[dict],
    *,
    nodes_lit: bool = False,
    balanced: Optional[bool] = None,
    already_mapped: bool = False,
    side: str = "",
) -> str:
    """返回阶段切换时的故事化过渡文本"""
    star_name = (profile.get("name_cn", star_id) if profile else star_id.replace('star_', '').replace('_', ' '))
    tension = profile.get("tension", "") if profile else ""
    # 截断张力文本用于嵌入
    tension_snippet = tension[:40] + "……" if len(tension) > 40 else tension

    if stage == Stage.REVEALED:
        return f"在{star_name}的光芒中，你听到了两个声音——一个来自望远镜深处，一个来自古籍的纸页。"

    if stage == Stage.QUESTIONED:
        if nodes_lit:
            return f"一道认知的裂缝在黑暗中亮起。{star_name}的秘密，正在向你敞开。"
        return "你的追问像一颗石子投入星湖，涟漪正在扩散……"

    if stage == Stage.CHOSEN:
        return f"你选择了道路。{star_name}的张力——{tension_snippet}——现在等待你的调和。"

    if stage == Stage.MAPPED:
        if already_mapped:
            return "双极罗盘已记录。"
        if balanced:
            return f"科学与星象的视线交汇于一点。{star_name}的完整轮廓，第一次在你眼前显现。"
        return f"罗盘偏向{side}一侧。再靠近中间一些，让两个世界的目光相遇。"

    if stage == Stage.RESONATED:
        return f"{star_name}的脉动与你的心跳同频。写下你的感悟，完成最后的觉醒。"

    if stage == Stage.AWAKENED:
        return f"{star_name}已觉醒。它不再是天幕上的一个光点，而是你灵魂中的一条星脉。"

    return ""


def _progress_response(session, star_id: str, sp) -> dict:
    """构造包含进度的统一响应"""
    profile = _get_profile(star_id)
    lit_nodes = list(sp.lit_nodes)
    suggested = _generate_suggested_questions(star_id, sp.lit_nodes)

    # 构建已点亮节点的可读标签
    lit_node_labels = []
    if profile:
        node_map = {node.get("id"): node.get("label", "") for node in profile.get("cognitive_nodes", [])}
        lit_node_labels = [node_map.get(nid, "") for nid in lit_nodes if node_map.get(nid)]

    return {
        "session_id": session.id,
        "star_id": star_id,
        "stage": sp.stage.value,
        "stage_name": STAGE_NAMES.get(sp.stage, sp.stage.value),
        "lit_nodes": lit_nodes,
        "lit_node_labels": lit_node_labels,
        "required_nodes": sp.required_nodes,
        "dimensions_lit": _lit_dimensions(profile, sp.lit_nodes),
        "can_choose": _can_choose(sp, profile),
        "fusion_balance": sp.fusion_balance,
        "awakened": sp.awakened,
        "suggested_questions": suggested,
        "star_name": ((profile.get("name_cn", star_id) if profile else star_id.replace('star_', '').replace('_', ' ')).replace('star_', '').replace('_', ' ')),
    }


# ==================== 分动作处理器 ====================

async def _chat_initial(req, session, sp, profile, star_id, science_prompt, culture_prompt, api_key):
    """initial：开场白（尘封 -> 初现），双导师并行介绍。"""
    # 已融合/觉醒的星重新开场：重置为初现，避免返回无 resonance 的 resonated 态
    if sp.stage in (Stage.DUSTY, Stage.RESONATED, Stage.AWAKENED):
        sp.stage = Stage.REVEALED

    # 无档案星：跳过认知节点要求，直接可进入抉择
    if not profile:
        sp.required_nodes = 0

    star_display = profile.get('name_cn', star_id) if profile else star_id.replace('star_', '').replace('_', ' ')
    opening_question = f"请为初中生介绍{star_display}。科学官讲它是什么、为什么重要；太史令讲古人怎么看它。"
    messages = [{"role": "user", "content": opening_question}]

    science_task = _call_agent(messages, science_prompt, AGENT_ID_SCIENCE, api_key, req.model)
    culture_task = _call_agent(messages, culture_prompt, AGENT_ID_CULTURE, api_key, req.model)
    science_result, culture_result = await asyncio.gather(science_task, culture_task)
    science_result = _clean_self_talk(science_result)
    culture_result = _clean_self_talk(culture_result)

    session.context["science_response"] = science_result
    session.context["culture_response"] = culture_result
    sp.science_responses += 1
    sp.culture_responses += 1

    resp = _progress_response(session, star_id, sp)
    resp.update({
        "science_response": science_result,
        "culture_response": culture_result,
        "message": _get_transition_text(Stage.REVEALED, star_id, profile),
    })
    store.save(session.id)
    return resp


async def _chat_question(req, session, sp, profile, star_id, science_prompt, culture_prompt, api_key):
    """question：追问，命中认知节点，双导师并行回答。
    认知分类与双导师回答并行执行，避免串行等待叠加延迟（此前分类串行导致单次追问达 55s）。"""
    if sp.stage in [Stage.DUSTY, Stage.REVEALED]:
        sp.stage = Stage.QUESTIONED

    user_question = req.content.strip() if req.content else "请继续讲讲这颗星"
    session.history.append({"role": "user", "content": user_question})
    sp.questions_asked += 1

    cached = _QUESTION_CACHE.get(star_id, {}).get(user_question)
    messages = [{"role": "user", "content": user_question}]
    new_nodes = []

    if cached:
        # 缓存命中：跳过 LLM，节点匹配用关键词兜底
        science_result = cached["science"]
        culture_result = cached["culture"]
        if profile:
            new_nodes = _match_cognitive_nodes(user_question, profile)
    else:
        science_task = _call_agent(messages, science_prompt, AGENT_ID_SCIENCE, api_key, req.model)
        culture_task = _call_agent(messages, culture_prompt, AGENT_ID_CULTURE, api_key, req.model)
        if profile:
            # 认知分类与双导师回答并行，降低延迟
            classify_task = _match_cognitive_nodes_llm(user_question, profile, api_key)
            science_result, culture_result, new_nodes = await asyncio.gather(
                science_task, culture_task, classify_task
            )
            if not new_nodes:
                new_nodes = _match_cognitive_nodes(user_question, profile)
        else:
            science_result, culture_result = await asyncio.gather(science_task, culture_task)
        science_result = _clean_self_talk(science_result)
        culture_result = _clean_self_talk(culture_result)
        # 写入运行时缓存（跨 session 复用）
        _QUESTION_CACHE.setdefault(star_id, {})[user_question] = {
            "science": science_result,
            "culture": culture_result,
        }

    # 认知节点统计（含追问类型维度统计）
    if profile:
        for n in new_nodes:
            sp.lit_nodes.add(n)
        dim_of = {n.get("id"): n.get("dimension") for n in profile.get("cognitive_nodes", [])}
        for nid in new_nodes:
            dim = dim_of.get(nid)
            if dim:
                sp.question_dims[dim] = sp.question_dims.get(dim, 0) + 1

    session.context["science_response"] = science_result
    session.context["culture_response"] = culture_result

    resp = _progress_response(session, star_id, sp)
    # 维度软引导（第 2 条）：不足 2 维度时不拦截，只给温柔提示
    soft_hint = ""
    if profile:
        dims = _lit_dimensions(profile, sp.lit_nodes)
        if len(dims) < 2:
            missing_hints = {
                "culture": "你还没听过太史令甘德的文化视角哦，要不要问问\"古人怎么看这颗星\"？",
                "fact": "科学官还有好多奇妙的知识等着你，比如\"它离我们有多远\"？",
                "compare": "想听听科学官和太史令对同一颗星的\"分歧\"吗？",
            }
            for d in ("culture", "fact", "compare"):
                if d not in dims and d in missing_hints:
                    soft_hint = missing_hints[d]
                    break
    resp.update({
        "science_response": science_result,
        "culture_response": culture_result,
        "decision_required": False,  # 五步循环：无抉择门槛，直接可拖罗盘融合
        "soft_hint": soft_hint,
        "message": _get_transition_text(Stage.QUESTIONED, star_id, profile, nodes_lit=bool(new_nodes)),
    })
    store.save(session.id)
    return resp


async def _chat_blend(req, session, sp, profile, star_id, science_prompt, culture_prompt, api_key):
    """blend：罗盘融合（五步循环第 4 步）。
    拖动罗盘：|balance| >= 0.3 时只记录偏向，双导师的话"交融中"；
    拖到中间（|balance| < 0.3）自动触发融合总结 → RESONATED。
    抉择/映射/共鸣合并到这一动作中。
    """
    balance = max(-1.0, min(1.0, req.fusion_balance if req.fusion_balance is not None else sp.fusion_balance))
    sp.fusion_balance = balance
    is_balanced = abs(balance) < 0.3

    resp = _progress_response(session, star_id, sp)
    resp.update({
        "science_response": "",
        "culture_response": "",
        "is_balanced": is_balanced,
        "fusion_balance": balance,
    })

    # 已在融合之后：罗盘只调节显示，不重复生成融合总结
    if sp.stage in (Stage.RESONATED, Stage.AWAKENED):
        resp["message"] = "双导师的对话已交融，可以写感悟啦。"
        store.save(session.id)
        return resp

    if not is_balanced:
        side = "星象" if balance > 0 else "科学"
        resp["message"] = f"罗盘偏向{side}：两位导师的话正在靠近，继续拖向中间…"
        store.save(session.id)
        return resp

    # 平衡：自动触发融合总结（科学 + 星象交融）
    if sp.stage in (Stage.DUSTY, Stage.REVEALED, Stage.QUESTIONED, Stage.CHOSEN, Stage.MAPPED):
        sp.stage = Stage.RESONATED
    star_name = (profile.get("name_cn", star_id) if profile else star_id.replace('star_', '').replace('_', ' '))

    # 优先用档案预置的融合总结（高质量手写总结性话语，跳过 LLM 提速，共鸣即时出现）
    resonance_text = profile.get("resonance", "") if profile else ""
    if resonance_text and len(resonance_text.strip()) > 30:
        merged_result = resonance_text.strip()
    else:
        blend_prompt = f"""你是科学官开普勒和太史令甘德的合体。刚才两位导师一起为初中生介绍了{star_name}。
现在他们的对话在罗盘中央交融，请写一段 100 字以内的融合总结：
1. 先化用科学官讲的一个科学事实；
2. 再化用太史令讲的一段星象文化；
3. 最后用一句"原来……"把两者连成对初中生的启发。
语言优美、初中生能懂，不要分段。
注意：这是对这颗星的总结性话语，不要以问题、追问或引导继续提问结尾。"""

        messages = [{"role": "user", "content": blend_prompt}]
        merged_result = _clean_self_talk(await _call_agent(messages, science_prompt, AGENT_ID_SCIENCE, api_key, req.model))

    resp["resonance"] = merged_result
    resp["stage"] = sp.stage.value
    resp["message"] = "双导师的话在罗盘中央交融，共鸣达成 ✦"
    store.save(session.id)
    return resp


async def _chat_quiz(req, session, sp, profile, star_id, science_prompt, culture_prompt, api_key):
    """quiz：觉醒前小测验出题。优先用档案预置题（跳过 LLM 提速）；无预置时 LLM 动态出题。"""
    fragments = req.fragments or []

    # 非强制 LLM 时，优先用档案预置题（质量稳定、即时返回，避免 LLM 出题延迟）
    if not req.force_llm:
        preset = (profile or {}).get("quiz", [])[:3]
        if preset:
            return {"session_id": session.id, "star_id": star_id, "quiz": preset, "preset": True}

    if profile:
        sci = profile.get("science", {})
        cul = profile.get("culture", {})
        star_desc = (
            f"星名：{profile.get('name_cn', star_id)}\n"
            f"科学事实：{sci.get('what', '')} {sci.get('why', '')} {sci.get('wow', '')}\n"
            f"文化内涵：{cul.get('what', '')} {cul.get('story', '')} {cul.get('poetry', '')}\n"
            f"核心张力：{profile.get('tension', '')}"
        )
    else:
        star_desc = f"星名：{star_id}（未建档的星辰）"

    frag_desc = "（无）"
    if fragments:
        frag_lines = []
        for f in fragments[:8]:
            if isinstance(f, dict):
                frag_lines.append(f"- {f.get('name', '')}：{f.get('desc', '')}")
            else:
                frag_lines.append(f"- {f}")
        frag_desc = "\n".join(frag_lines)

    prompt = f"""你是初中天文出题老师。请基于以下内容出 3 道选择题，检验学生对刚学知识的理解。
{star_desc}
学生探索中获得的异动碎片（可作为考点或干扰项素材）：
{frag_desc}

要求：
1. 第 1 题考科学事实，第 2 题考星象文化，第 3 题考"科学×文化"的跨视角融合（如两种说法是否矛盾、迁移应用）；
2. 每题 3 个选项（选项要简短，干扰项要像真的但不能正确）；
3. 标注正确答案下标（0/1/2）和 100 字以内的解析（解析用初中生能懂的话把知识点再讲一遍）；
4. 题干贴合这颗星刚讲过的内容，不要问档案之外的冷知识。
只输出 JSON，格式：{{"quiz":[{{"type":"science|culture|blend","q":"题干","options":["A","B","C"],"answer":0,"explain":"解析"}}]}}，不要任何其他文字。"""

    try:
        result = await call_minimax_direct(
            [{"role": "user", "content": prompt}],
            api_key,
            "你是初中天文出题老师，只输出 JSON。",
            max_tokens=600,
        )
        data = json.loads(result.strip())
        quiz = data.get("quiz", [])[:3]
        # 校验结构
        valid = []
        for item in quiz:
            if (isinstance(item, dict) and item.get("q") and isinstance(item.get("options"), list)
                    and len(item.get("options", [])) == 3 and isinstance(item.get("answer"), int)
                    and 0 <= item.get("answer", -1) <= 2 and item.get("explain")):
                valid.append(item)
        if valid:
            return {"session_id": session.id, "star_id": star_id, "quiz": valid, "preset": False}
    except Exception:
        pass

    # 兜底：档案预置题
    preset = (profile or {}).get("quiz", [])[:3]
    return {"session_id": session.id, "star_id": star_id, "quiz": preset, "preset": True}


async def _chat_awaken(req, session, sp, profile, star_id, science_prompt, culture_prompt, api_key):
    """awaken：觉醒，记录学生感悟（不调用 LLM）。"""
    if sp.stage == Stage.RESONATED:
        sp.stage = Stage.AWAKENED
        sp.awakened = True

    personal_note = req.content.strip() if req.content else ""

    resp = _progress_response(session, star_id, sp)
    resp.update({
        "science_response": "",
        "culture_response": "",
        "resonance": profile.get("resonance", "") if profile else "",
        "personal_note": personal_note,
        "question_stats": dict(sp.question_dims),  # 追问类型统计（觉醒时展示）
        "message": _get_transition_text(Stage.AWAKENED, star_id, profile),
    })
    store.save(session.id)
    return resp


# ==================== Main Chat Endpoint ====================

@router.post("/chat")
async def chat(req: ChatRequest):
    session = store.get(req.session_id) if req.session_id else None
    if not session:
        session = store.create()

    api_key = req.api_key if req.api_key else config.LLM_API_KEY
    star_id = req.star_id

    if not star_id:
        return {
            "session_id": session.id,
            "science_response": "请先在星图中选择一颗星辰，我再为你讲述它的故事。",
            "culture_response": "守夜人，你需要先选定一颗星。",
        }

    sp = store.get_or_create_star_progress(session, star_id)
    profile = _get_profile(star_id)

    science_ctx, culture_ctx, _ = _get_star_context(star_id)

    # 注入知识库上下文（仅文化）
    kb_results = search_knowledge(req.content) if req.content else []
    kb_context = ""
    if kb_results:
        kb_context = "\n[提供的参考古籍文献]：\n"
        for r in kb_results:
            source = r.get("source", {})
            text = source.get("text") or source.get("content") or str(source)
            kb_context += f"- {text[:60]}...\n"

    # 构建提示词
    if profile:
        science_prompt = _build_agent_prompt(profile, "science")
        culture_prompt = _build_agent_prompt(profile, "culture") + kb_context
    else:
        science_prompt = SCIENCE_OFFICER_PROMPT_JUNIOR
        culture_prompt = GRAND_HISTORIAN_PROMPT_JUNIOR + kb_context

    if science_ctx:
        science_prompt += f"\n\n星辰专属档案（融入回答，不要直接念）：\n{science_ctx}"
    if culture_ctx:
        culture_prompt += f"\n\n星辰专属档案（融入回答，不要直接念）：\n{culture_ctx}"

    handlers = {
        "initial": _chat_initial,
        "question": _chat_question,
        "awaken": _chat_awaken,
        "blend": _chat_blend,
        "quiz": _chat_quiz,
    }
    handler = handlers.get(req.action)
    if not handler:
        # 默认 fallback
        return _progress_response(session, star_id, sp)

    try:
        return await handler(req, session, sp, profile, star_id, science_prompt, culture_prompt, api_key)
    except LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))
