from fastapi import APIRouter
from pydantic import BaseModel
import json
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

router = APIRouter()

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "data")


@router.get("/stars")
async def get_stars():
    """获取星图数据（恒星+星官）"""
    stars_file = os.path.join(DATA_DIR, "stars.json")
    constellations_file = os.path.join(DATA_DIR, "constellations.json")

    stars_data = []
    if os.path.exists(stars_file):
        try:
            with open(stars_file, "r", encoding="utf-8") as f:
                stars_data = json.load(f)
        except Exception:
            pass

    constellations_data = []
    if os.path.exists(constellations_file):
        try:
            with open(constellations_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict) and "constellations" in data:
                    constellations_data = data["constellations"]
                elif isinstance(data, list):
                    constellations_data = data
        except Exception:
            pass

    return {
        "stars": stars_data,
        "constellations": constellations_data
    }


@router.get("/star-profiles")
async def get_star_profiles():
    """获取星辰档案（单一数据源 src/data/star_profiles.json，前端据此渲染，避免双份 JSON 不同步）"""
    profiles_file = os.path.join(DATA_DIR, "star_profiles.json")
    profiles = {}
    if os.path.exists(profiles_file):
        try:
            with open(profiles_file, "r", encoding="utf-8") as f:
                profiles = json.load(f)
        except Exception:
            pass
    return profiles