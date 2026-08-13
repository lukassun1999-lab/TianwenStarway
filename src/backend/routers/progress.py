from fastapi import APIRouter
from pydantic import BaseModel
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from session import store

router = APIRouter()


class ProgressUpdate(BaseModel):
    star_id: str
    stage: str


@router.get("/progress/{session_id}")
async def get_progress(session_id: str):
    """获取探索进度"""
    session = store.get(session_id)
    if not session:
        return {"star_progress": {}}

    return {
        "star_progress": {
            star_id: progress.model_dump()
            for star_id, progress in session.star_progress.items()
        }
    }