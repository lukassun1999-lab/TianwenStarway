import uuid
import time
import json
import os
import logging
from typing import Optional
import sys
import pathlib

sys.path.insert(0, os.path.dirname(__file__))

from models import Session, StarProgress, Stage

logger = logging.getLogger("tianwen.session")

SESSIONS_DIR = pathlib.Path(os.path.dirname(__file__)) / "data" / "sessions"
SESSIONS_DIR.mkdir(parents=True, exist_ok=True)


def _session_path(session_id: str) -> pathlib.Path:
    return SESSIONS_DIR / f"{session_id}.json"


def _serialize_session(session: Session) -> dict:
    """将会话序列化为可 JSON 化的字典"""
    data = session.model_dump(mode="json")
    data["__version__"] = 1
    return data


def _deserialize_session(data: dict) -> Optional[Session]:
    """从字典反序列化会话"""
    try:
        # 兼容： lit_nodes 在 JSON 中是 list，Pydantic 会自动转为 set
        return Session.model_validate(data)
    except Exception:
        return None


class SessionStore:
    def __init__(self):
        self._sessions: dict[str, Session] = {}
        self._created_at: dict[str, float] = {}
        self._ttl_seconds = 1800  # 30-minute session TTL
        self._load_existing()

    def _load_existing(self):
        """启动时加载未过期的持久化会话"""
        now = time.time()
        for path in SESSIONS_DIR.glob("*.json"):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                created_at = data.get("__created_at__", os.path.getmtime(path))
                if now - created_at > self._ttl_seconds:
                    # 过期则删除文件
                    try:
                        path.unlink()
                    except Exception:
                        pass
                    continue
                session = _deserialize_session(data)
                if session:
                    self._sessions[session.id] = session
                    self._created_at[session.id] = created_at
            except Exception as e:
                # 损坏的文件直接跳过
                logger.warning("跳过损坏的会话文件 %s: %s", path.name, e)

    def save(self, session_id: str):
        """将会话写入磁盘"""
        session = self._sessions.get(session_id)
        if not session:
            return
        data = _serialize_session(session)
        data["__created_at__"] = self._created_at.get(session_id, time.time())
        try:
            with open(_session_path(session_id), "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.error("会话 %s 保存失败: %s", session_id, e)

    def _cleanup_expired(self):
        """Remove sessions older than TTL"""
        now = time.time()
        expired = [
            sid for sid, ts in self._created_at.items()
            if now - ts > self._ttl_seconds
        ]
        for sid in expired:
            self._sessions.pop(sid, None)
            self._created_at.pop(sid, None)
            try:
                path = _session_path(sid)
                if path.exists():
                    path.unlink()
            except Exception:
                pass

    def create(self) -> Session:
        self._cleanup_expired()
        s = Session(id=uuid.uuid4().hex)
        self._sessions[s.id] = s
        self._created_at[s.id] = time.time()
        self.save(s.id)
        return s

    def get(self, id: str) -> Optional[Session]:
        self._cleanup_expired()
        s = self._sessions.get(id)
        if s:
            self._created_at[id] = time.time()  # refresh on access
            self.save(id)
        return s

    def update(self, id: str, **kwargs) -> Optional[Session]:
        s = self._sessions.get(id)
        if s:
            for k, v in kwargs.items():
                setattr(s, k, v)
            self.save(id)
        return s

    def get_or_create_star_progress(self, session: Session, star_id: str) -> StarProgress:
        if star_id not in session.star_progress:
            session.star_progress[star_id] = StarProgress(star_id=star_id)
            self.save(session.id)
        return session.star_progress[star_id]


store = SessionStore()
