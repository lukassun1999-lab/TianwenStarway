# 《天问·星途》Tianwen Starway

> 同一片星空，两种问天的方式。

**《天问·星途》** 是一个面向初中生的 AI 驱动天文与人文探究平台。学生在可交互的 3D 星空中，跟随“科学官”开普勒与“太史令”甘德两位 AI 导师，从科学与中国古代星象文化两个视角认识星辰，最终完成单颗星的“觉醒”，生成属于自己的《星辰启示录》。

---

## 核心体验

- **真实星空**：基于 HYG 星表与 IAU 星座连线，使用 Three.js 渲染；叠加银道面银河、73 个深空天体、6 颗行星与大气辉光。
- **三种视角**：二维极投影星图（默认）、三维沉浸星空、地面观星（从地球某地仰望）。
- **双导师对话**：科学官讲解天体物理事实，太史令讲述古籍、诗词与神话，MiniMax 直连并行作答。
- **五步觉醒循环**：选星 → 双导师开场 → 自由追问 → 罗盘融合 → 小测验·觉醒。
- **认知节点驱动**：学生自由追问，点亮 fact/culture/compare 三类认知节点，无抉择门槛。
- **双极罗盘**：拖动滑块调和科学与文化视角，拖到中间自动触发“原来……”的融合总结。
- **星空小测验**：觉醒前 3 题（科学/文化/融合各一）验收，档案预置题 + AI 动态出题。
- **星辰启示录与档案库**：觉醒后生成启示录（融合总结 + 亲笔感悟 + 追问统计 + 测验成绩），集中收藏在档案库。
- **五章书页**：北辰之锚、银河两岸、参商不相见、最亮之星、春夜苍龙，结构化对照学习。
- **成就与碎片**：初叩星门、星海行者、为什么先生、《天官书》读者、北斗的守望者等称号，加星辰碎片与星空异动彩蛋。

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Python 3.12 + FastAPI + Uvicorn |
| 前端 | 原生 HTML/CSS/JS + Three.js（ES Modules，无构建） |
| AI | MiniMax 直连（对话 `MiniMax-M2.7`，TTS `speech-2.8-hd`） |
| 数据 | HYG 星表、IAU 星座连线、28 星宿、中国古代星官文献 |
| 测试 | pytest（状态机单测）+ Playwright（UI 端到端） |

---

## 目录结构

```
.
├── src/
│   ├── backend/                    # FastAPI 后端（8080）
│   │   ├── main.py
│   │   ├── routers/                # chat / stars / progress
│   │   ├── models.py               # 状态机与数据模型
│   │   ├── session.py              # 会话与进度存储（JSON 持久化）
│   │   ├── agents.py               # 双导师提示词
│   │   ├── openmaic_client.py      # MiniMax 直连调用
│   │   └── requirements.txt
│   ├── data/                       # 后端共享数据
│   │   ├── star_profiles.json      # 9 颗档案星（单一数据源）
│   │   ├── hyg_stars_compact.json
│   │   ├── constellations_iau.json
│   │   └── culture/
│   └── frontend/                   # 前端页面
│       ├── index.html              # 单页应用（内联设计系统）
│       ├── js/app.js
│       └── data/                   # 星表、档案、章节、深空天体
└── README.md
```

---

## 快速开始

### 1. 安装依赖

```bash
cd src/backend
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate    # macOS/Linux
pip install -r requirements.txt
```

### 2. 配置环境变量

复制 `src/backend/.env.example` 为 `src/backend/.env`，填入 MiniMax API Key：

```env
LLM_API_KEY=your_minimax_api_key
MINIMAX_MODEL=MiniMax-M2.7
```

> 对话与语音合成均走 MiniMax 直连，无需额外编排服务。

### 3. 启动服务

```bash
cd src/backend
python -m uvicorn main:app --host 0.0.0.0 --port 8080
```

### 4. 打开前端

浏览器访问：

```
http://localhost:8080
```

---

## 当前范围

- [x] 9 颗档案星：北极星、北斗七星、参宿四、心宿二、牛郎织女、天狼星、老人星、大角星、角宿一
- [x] 五章书页导航（北辰之锚 / 银河两岸 / 参商不相见 / 最亮之星 / 春夜苍龙）
- [x] 五步觉醒循环状态机与对话引擎
- [x] 认知节点匹配（关键词 + LLM 语义分类）
- [x] 双极罗盘融合交互
- [x] 星空小测验（预置 + 动态出题）
- [x] 星辰启示录与档案库
- [x] 成就系统、星辰碎片、星空异动
- [x] 三种视角（二维星图 / 三维星空 / 地面观星）+ 双频道（科学 / 二十八宿星象）

---

## 许可证

本项目为参赛作品，相关文档与代码仅供学习交流使用。
