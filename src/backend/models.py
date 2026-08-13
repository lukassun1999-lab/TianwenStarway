from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field


class Stage(str, Enum):
    DUSTY = "dusty"
    REVEALED = "revealed"
    QUESTIONED = "questioned"
    CHOSEN = "chosen"
    MAPPED = "mapped"
    RESONATED = "resonated"
    AWAKENED = "awakened"


class StarProgress(BaseModel):
    star_id: str
    stage: Stage = Stage.DUSTY
    # 认知节点（可选增强，不再作为流程门槛）：已点亮的节点 id 集合
    lit_nodes: set[str] = Field(default_factory=set)
    # 触发抉择至少需要点亮多少节点（五步循环下无门槛，保留兼容）
    required_nodes: int = 2
    # 双极罗盘平衡度，-1 偏科学，0 平衡，1 偏文化（罗盘融合触发共鸣）
    fusion_balance: float = 0.0
    # 是否已觉醒
    awakened: bool = False
    # 保留旧字段以兼容
    science_responses: int = 0
    culture_responses: int = 0
    questions_asked: int = 0
    # 追问类型统计（fact/culture/compare → 次数），觉醒时展示
    question_dims: dict[str, int] = Field(default_factory=dict)


class Session(BaseModel):
    id: str
    state: str = "await_science"
    context: dict = {}
    history: list[dict] = []
    star_progress: dict[str, StarProgress] = {}
