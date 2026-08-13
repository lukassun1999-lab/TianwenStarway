import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';


// ==================== BV Color Index to RGB ====================
function bvToRgb(bv) {
  var t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  var x, y = 0;
  if (t >= 1667 && t <= 4000) { x = (-0.2661239e9)/(t*t*t) + (-0.234358e6)/(t*t) + (0.8776956e3)/t + 0.17991; }
  else if (t > 4000) { x = (-3.0258469e9)/(t*t*t) + (2.1070379e6)/(t*t) + (0.2226347e3)/t + 0.24039; }
  if (t >= 1667 && t <= 2222) { y = -1.1063814*x*x*x - 1.3481102*x*x + 2.18555832*x - 0.20219683; }
  else if (t > 2222 && t <= 4000) { y = -0.9549476*x*x*x - 1.37418593*x*x + 2.09137015*x - 0.16748867; }
  else if (t > 4000) { y = 3.081758*x*x*x - 5.8733867*x*x + 3.75112997*x - 0.37001483; }
  var Y = 1.0, X = y==0 ? 0 : (x*Y)/y, Z = y==0 ? 0 : ((1-x-y)*Y)/y;
  var r = 3.2406*X - 1.5372*Y - 0.4986*Z;
  var g = -0.9689*X + 1.8758*Y + 0.0415*Z;
  var b = 0.0557*X - 0.204*Y + 1.057*Z;
  var gm = 1/2.2;
  var R = r<=0.0031308 ? 12.92*r : 1.055*Math.pow(r,gm)-0.055;
  var G = g<=0.0031308 ? 12.92*g : 1.055*Math.pow(g,gm)-0.055;
  var B = b<=0.0031308 ? 12.92*b : 1.055*Math.pow(b,gm)-0.055;
  return [Math.max(0,Math.min(1,Math.round(R*255)/255)), Math.max(0,Math.min(1,Math.round(G*255)/255)), Math.max(0,Math.min(1,Math.round(B*255)/255))];
}

// ==================== Star Shaders ====================
const STAR_VERTEX_SHADER = `
attribute float size;
attribute vec3 color;
uniform bool attenuation;
uniform float starMin;
uniform float starMax;
varying float vSize;
varying float vMag;
varying vec3 vColor;
void main() {
  float ns = 1.0 - (size) / 6.5;
  vColor = color; vMag = size;
  vSize = clamp(starMax * ns, starMin, starMax);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = attenuation ? ((vSize * 1000.0) / 2.0) / -mv.z : vSize;
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w;
}`;

const STAR_FRAGMENT_SHADER = `
varying float vMag;
varying vec3 vColor;
uniform float starFadeDactor;
uniform float starMinBrightnes;
uniform vec3 uChannelTint;
void main() {
  float s = 1.0 - step(0.5, distance(gl_PointCoord, vec2(0.5)));
  if (s == 0.0 || vMag > starMinBrightnes) discard;
  float b = 1.0 - (vMag - starFadeDactor) / (6.5 - starFadeDactor);
  gl_FragColor = vec4(vColor * uChannelTint, b);
}`;

// ==================== Fog Shader ====================
const FOG_VERTEX_SHADER = `
varying vec3 vWorldPosition;
void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FOG_FRAGMENT_SHADER = `
uniform vec3 uAwakenedStars[32];
uniform int uAwakenedCount;
uniform float uFogRadius;
uniform float uBaseOpacity;
uniform vec3 uFogColor;
varying vec3 vWorldPosition;

void main() {
    float minDist = 100000.0;
    for (int i = 0; i < 32; i++) {
        if (i >= uAwakenedCount) break;
        float dist = distance(vWorldPosition, uAwakenedStars[i]);
        if (dist < minDist) minDist = dist;
    }

    float fog = uBaseOpacity;
    if (uAwakenedCount > 0) {
        float t = clamp(minDist / uFogRadius, 0.0, 1.0);
        // 让迷雾消退更平滑：使用平方曲线
        fog = uBaseOpacity * (t * t);
    }

    gl_FragColor = vec4(uFogColor, fog);
}`;

// ==================== 状态 ====================
const state = {
    sessionId: null,
    currentStar: null,
    currentStarId: null,
    currentStage: 0,
    channel: 'science',
    bipolarValue: 50,
    isLoading: false,
    stars: [],      // 真实恒星数据
    constellations: [],
    questionCount: 0,
    phase: 'welcome', // welcome, initial, questioning, decision, map, resonance, completed
    starCatalog: [],    // 恒星目录用于点击检测
    achievements: [],   // 已解锁成就
    fragments: [],      // 已收集星辰碎片
    awakenedCount: 0,   // 觉醒星辰计数
    awakenedStars: new Set(), // 已觉醒的 star_id 集合
    awakenedStarPositions: {}, // 已觉醒星的 3D 坐标，用于绘制星脉连线
    archives: {},           // 星辰档案库：{ star_id: { star_name, resonance, personal_note, question_stats, quiz, awakened_at } }
    litNodes: [],       // 当前星点亮的认知节点
    litNodeLabels: [],  // 当前星点亮节点的可读标签
    unlockedLegends: [], // 已解锁的星官传奇
    starProfiles: {},   // 星辰科学+文化双维度档案 (star_profiles.json)
    starPoetry: [],     // 星辰相关诗词 (star_poetry.json)
    showLabels: true,    // 显示标签开关
    isBalanced: false,  // 双极罗盘是否平衡
    anomalyLog: [],      // 星空异动记录
    fragments: [],       // 星空异动碎片（供觉醒前小测验出题）
    quiz: { questions: [], index: 0, score: 0, done: false }, // 星空小测验状态
    viewMode: '2d',      // 视图模式：'2d' 极投影星图（主视图）/ '3d' 沉浸星空 / 'observe' 地面观星
    viewHemisphere: 'north', // 2D 模式当前视角：north 北天极 / south 南天极
    chineseAsterisms: null, // 中国星官连线数据
    chapters: null,       // 五章书页导航数据
    dsos: null,           // 深空天体数据（Messier/NGC）
    channel: 'science'   // 当前频道：science 科学 / culture 星象
};

// ==================== 成就系统 ====================
const ACHIEVEMENTS = [
    { id: 'first_star', name: '初叩星门', desc: '觉醒第1颗星辰', condition: (s) => s.awakenedStars.size >= 1 },
    { id: 'ten_stars', name: '星海行者', desc: '觉醒10颗星辰', condition: (s) => s.awakenedStars.size >= 10 },
    { id: 'why_master', name: '为什么先生', desc: '累计追问10次', condition: (s) => s.questionCount >= 10 },
    { id: 'tgs_reader', name: '《天官书》读者', desc: '收集5枚星辰碎片', condition: (s) => s.fragments.length >= 5 },
    { id: 'beidou', name: '北斗的守望者', desc: '觉醒北斗七星', condition: (s) => checkBeidou(s) }
];

// MVP 中北斗七星作为一个整体星官 big_dipper，觉醒即解锁
function checkBeidou(s) {
    return s.awakenedStars.has('big_dipper');
}

function checkAchievements() {
    const newlyUnlocked = [];
    for (const ach of ACHIEVEMENTS) {
        if (!state.achievements.includes(ach.id) && ach.condition(state)) {
            state.achievements.push(ach.id);
            newlyUnlocked.push(ach);
        }
    }
    if (newlyUnlocked.length > 0) {
        showAchievementUnlock(newlyUnlocked[0]);
    }
}

// ==================== 星辰碎片系统 ====================
const FRAGMENTS = [
    { id: 'polaris_frag1', name: '北辰之辉', desc: '北极星的恒定光芒碎片', starId: 'polaris' },
    { id: 'polaris_frag2', name: '帝星印记', desc: '北辰居其所而众星共之', starId: 'polaris' },
    { id: 'betelgeuse_frag1', name: '参商之叹', desc: '人生不相见，动如参与商', starId: 'betelgeuse' },
    { id: 'betelgeuse_frag2', name: '红巨之心', desc: '参宿四的脉动余晖', starId: 'betelgeuse' },
    { id: 'betelgeuse_frag3', name: '衡石之威', desc: '参宿三星，直如衡石', starId: 'betelgeuse' },
    { id: 'betelgeuse_frag4', name: '虎贲之魂', desc: '白虎主杀伐，秋之肃杀', starId: 'betelgeuse' },
    { id: 'betelgeuse_frag5', name: '超新之兆', desc: '参宿四终将爆发的预言', starId: 'betelgeuse' },
    { id: 'sirius_frag1', name: '天狼之矢', desc: '会挽雕弓如满月', starId: 'sirius' },
    { id: 'sirius_frag2', name: '白矮之秘', desc: '天狼B的致密遗骸', starId: 'sirius' },
    { id: 'antares_frag1', name: '流火之兆', desc: '七月流火，九月授衣', starId: 'antares' },
    { id: 'antares_frag2', name: '心宿之光', desc: '商星的最后回响', starId: 'antares' },
];

const LEGENDS = [
    {
        id: 'baihu_cansu',
        name: '白虎七宿 · 参宿传奇',
        groupName: '参宿',
        starIds: ['betelgeuse'],
        requiredFragments: 5,
        icon: '🐅',
        content: `
            <p><strong>《史记·天官书》载：</strong>“参为白虎，三星直者，是为衡石。下有三星，兑，曰罚，为斩艾事。其外四星，左右肩股也。”</p>
            <p>古人仰望西方天空，将猎户座的主体想象成一只威猛的白虎，而参宿四正是它的前爪，参宿七则是它的后足。白虎主秋、主刑杀，也主丰收——秋天肃杀之后，才有来年的春耕。</p>
            <p><strong>从恒星演化看：</strong>参宿四是一颗红超巨星，它的表面如果放在太阳系中心，会吞没地球甚至越过木星轨道。未来某一天，它将以超新星爆发的形式结束生命，那一刻的亮度甚至可以媲美满月。</p>
            <p><strong>参宿三星</strong>（参宿一、二、三）排成一条直线，古人称它们为“衡石”，像天平上的砝码；而<strong>杜甫</strong>在《赠卫八处士》中写道：“人生不相见，动如参与商。”参宿与商星（心宿二）此起彼落，永不相见，于是成了人间离别的永恒隐喻。</p>
        `
    }
];

// ==================== 星空异动事件 ====================
const RANDOM_EVENTS = [
    {
        id: 'ancient_scroll',
        title: '古籍残卷现世',
        icon: '📜',
        desc: '守夜人，一卷被遗忘的星图残页从《开元占经》的夹缝中飘落。它记载着某颗沉睡星辰的秘密。',
        chance: 0.4,
        canTrigger: () => state.fragments.length < FRAGMENTS.length,
        effect: () => {
            const available = FRAGMENTS.filter(f => !state.fragments.includes(f.id));
            if (available.length === 0) return null;
            const fragment = available[Math.floor(Math.random() * available.length)];
            state.fragments.push(fragment.id);
            return { fragment };
        }
    },
    {
        id: 'star_pulse',
        title: '星脉共鸣异常',
        icon: '✨',
        desc: '你感知到星图中某处传来微弱的共鸣——也许是一颗已经觉醒的星正在向你诉说更多秘密。',
        chance: 0.25,
        canTrigger: () => state.awakenedStars.size >= 1,
        effect: () => {
            const ids = Array.from(state.awakenedStars);
            const starId = ids[Math.floor(Math.random() * ids.length)];
            const nameMap = { polaris: '北极星', big_dipper: '北斗七星', betelgeuse: '参宿四', antares: '心宿二', altair_vega: '牛郎织女', sirius: '天狼星', canopus: '老人星', arcturus: '大角星' };
            return { starId, starName: nameMap[starId] || starId };
        }
    }
];

function maybeTriggerRandomEvent(eventType = 'after_awaken') {
    for (const event of RANDOM_EVENTS) {
        if (!event.canTrigger()) continue;
        if (Math.random() > event.chance) continue;
        const result = event.effect();
        if (result) {
            showEventModal(event, result);
            return;
        }
    }
}

function showDsoInfo(dso) {
    const TYPE_NAMES = {
        galaxy: '星系', nebula: '发射星云', planetary: '行星状星云',
        open: '疏散星团', globular: '球状星团'
    };
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay overlay-top';
    overlay.innerHTML = `
        <div class="modal-card card-anomaly" role="dialog" aria-modal="true" aria-label="深空天体">
            <div class="modal-icon">🔭</div>
            <div class="modal-kicker kicker-science">深空天体</div>
            <div class="modal-title" style="color: var(--science-strong);">${dso.name}（${dso.id}）</div>
            <div class="modal-body">
                类型：${TYPE_NAMES[dso.type] || dso.type}<br>
                所属星座：${dso.const}<br>
                视星等：${dso.mag}
            </div>
            <div class="modal-actions">
                <button class="btn btn-science" onclick="this.closest('.modal-overlay').remove()">关闭</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
}

function showEventModal(event, result) {
    // 记录到星空异动日志
    const logEntry = {
        id: event.id,
        title: event.title,
        icon: event.icon,
        timestamp: Date.now(),
        details: result.fragment
            ? `获得碎片：${result.fragment.name}`
            : (result.starName ? `共鸣来源：${result.starName}` : '')
    };
    state.anomalyLog.push(logEntry);
    saveAnomalyLog();

    // 收集知识碎片（供觉醒前小测验出题）
    if (result.fragment) {
        state.fragments = state.fragments || [];
        if (!state.fragments.some(f => f.name === result.fragment.name)) {
            state.fragments.push(result.fragment);
        }
    }

    const countEl = document.getElementById('anomaly-count');
    if (countEl) countEl.textContent = state.anomalyLog.length;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay overlay-top';

    let rewardHtml = '';
    if (result.fragment) {
        rewardHtml = `
            <div class="reward-box reward-fragment">
                <div style="font-size: 2rem;">💎</div>
                <div style="color: var(--anomaly); font-weight: 600;">${result.fragment.name}</div>
                <div style="color: var(--text-dim); font-size: 0.9rem;">${result.fragment.desc}</div>
            </div>
        `;
    } else if (result.starName) {
        rewardHtml = `
            <div class="reward-box reward-star">
                异常共鸣来自：<strong>${result.starName}</strong>
            </div>
        `;
    }

    overlay.innerHTML = `
        <div class="modal-card card-anomaly" role="dialog" aria-modal="true" aria-label="星空异动">
            <div class="modal-icon">${event.icon}</div>
            <div class="modal-kicker kicker-science">星空异动</div>
            <div class="modal-title" style="color: var(--culture);">${event.title}</div>
            <div class="modal-body">${event.desc}</div>
            ${rewardHtml}
            <div class="modal-actions">
                <button id="event-close-btn" class="btn btn-science">继续守夜</button>
                <button id="event-log-btn" class="btn btn-culture">查看异动记录</button>
            </div>
        </div>
    `;
    overlay.querySelector('#event-close-btn').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#event-log-btn').addEventListener('click', () => {
        overlay.remove();
        showAnomalyLog();
    });
    document.body.appendChild(overlay);

    // 如果是碎片事件，触发传奇检查
    if (result.fragment) {
        setTimeout(() => checkLegendUnlocks(), 500);
    }
}

function saveAnomalyLog() {
    try {
        localStorage.setItem('tianwen_anomaly_log', JSON.stringify(state.anomalyLog));
    } catch (e) {
        console.warn('保存星空异动记录失败:', e);
    }
}

function loadAnomalyLog() {
    try {
        const saved = localStorage.getItem('tianwen_anomaly_log');
        if (saved) {
            state.anomalyLog = JSON.parse(saved);
        }
    } catch (e) {
        state.anomalyLog = [];
    }
}

function saveArchives() {
    try {
        localStorage.setItem('tianwen_archives', JSON.stringify(state.archives));
    } catch (e) {
        console.warn('保存星辰档案库失败:', e);
    }
}

function loadArchives() {
    try {
        const saved = localStorage.getItem('tianwen_archives');
        if (saved) {
            state.archives = JSON.parse(saved);
        }
    } catch (e) {
        state.archives = {};
    }
}

function showAnomalyLog() {
    const existing = document.getElementById('anomaly-log-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'anomaly-log-overlay';
    overlay.className = 'modal-overlay overlay-top';

    let itemsHtml = '';
    if (state.anomalyLog.length === 0) {
        itemsHtml = '<div class="anomaly-empty">暂无星空异动记录</div>';
    } else {
        const sorted = [...state.anomalyLog].sort((a, b) => b.timestamp - a.timestamp);
        for (const entry of sorted) {
            const date = new Date(entry.timestamp).toLocaleString('zh-CN');
            itemsHtml += `
                <div class="anomaly-item">
                    <div class="anomaly-icon">${entry.icon || '✨'}</div>
                    <div class="anomaly-info">
                        <div class="anomaly-title">${entry.title}</div>
                        <div class="anomaly-details">${entry.details || ''}</div>
                        <div class="anomaly-time">${date}</div>
                    </div>
                </div>
            `;
        }
    }

    overlay.innerHTML = `
        <div id="anomaly-log-panel" role="dialog" aria-modal="true" aria-label="星空异动记录">
            <h2>星空异动记录</h2>
            <div id="anomaly-list">${itemsHtml}</div>
            <button id="anomaly-log-close" class="btn btn-anomaly">关闭</button>
        </div>
    `;

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.id === 'anomaly-log-close') {
            overlay.classList.remove('visible');
            setTimeout(() => overlay.remove(), 300);
        }
    });

    document.body.appendChild(overlay);
}

function maybeDropFragment(starId) {
    if (!starId) return;
    const available = FRAGMENTS.filter(
        f => f.starId === starId && !state.fragments.includes(f.id)
    );
    if (available.length === 0) return;
    // 追问时50%概率掉落碎片
    if (Math.random() < 0.5) {
        const fragment = available[Math.floor(Math.random() * available.length)];
        state.fragments.push(fragment.id);
        showFragmentDrop(fragment);
        // 碎片收集后检查是否解锁星官传奇
        setTimeout(() => checkLegendUnlocks(), 2600);
    }
}

function checkLegendUnlocks() {
    for (const legend of LEGENDS) {
        if (state.unlockedLegends.includes(legend.id)) continue;
        // 按星官分组统计（完整版7.2：同一星官的碎片集中收集，如参宿碎片×5）
        const group = FRAGMENTS.filter(f => (legend.starIds || []).includes(f.starId));
        const required = group.length > 0 ? group.length : legend.requiredFragments;
        const collected = group.length > 0
            ? group.filter(f => state.fragments.includes(f.id)).length
            : state.fragments.length;
        if (collected >= required) {
            state.unlockedLegends.push(legend.id);
            setTimeout(() => showLegendUnlock(legend), 500);
        }
    }
}

function showLegendUnlock(legend) {
    const overlay = document.createElement('div');
    overlay.id = 'legend-unlock-overlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-card card-culture" role="dialog" aria-modal="true" aria-label="星官传奇解锁">
            <div class="modal-icon">${legend.icon}</div>
            <div class="modal-kicker kicker-culture">星官传奇解锁</div>
            <div class="modal-title" style="letter-spacing: 1px;">${legend.name}</div>
            <div class="modal-body text-left">${legend.content}</div>
            <div class="modal-actions">
                <button id="legend-close-btn" class="btn btn-culture">收入星图</button>
            </div>
        </div>
    `;
    overlay.querySelector('#legend-close-btn').addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
}

function showFragmentDrop(fragment) {
    // 分组进度提示：属于某星官传奇的碎片显示该组进度（如"参宿碎片 3/5"）
    const legend = LEGENDS.find(l => (l.starIds || []).includes(fragment.starId));
    let progressText;
    if (legend) {
        const group = FRAGMENTS.filter(f => legend.starIds.includes(f.starId));
        const n = group.filter(f => state.fragments.includes(f.id)).length;
        progressText = `${legend.groupName || '星官'}碎片 ${n}/${group.length} · 集齐解锁传奇`;
    } else {
        progressText = `已收集 ${state.fragments.length} 枚碎片`;
    }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay toast-overlay';
    overlay.innerHTML = `
        <div class="modal-card card-anomaly toast-card">
            <div class="modal-icon">💎</div>
            <div class="modal-kicker kicker-anomaly">星辰碎片</div>
            <div class="modal-title">${fragment.name}</div>
            <div class="modal-body">${fragment.desc}</div>
            <div style="color: rgba(180,140,255,0.55); font-size: 0.8rem; margin-top: 12px;">${progressText}</div>
        </div>
    `;
    overlay.onclick = () => overlay.remove();
    document.body.appendChild(overlay);
    setTimeout(() => overlay.remove(), 2500);
}

function showAchievementUnlock(achievement) {
    // 更新成就计数
    document.getElementById('achievement-count').textContent = state.achievements.length;

    // 非遮挡的右上角提示（不遮挡星辰启示录与后续操作）
    const toast = document.createElement('div');
    toast.className = 'achievement-toast';
    toast.innerHTML = `
        <span class="at-icon">🏆</span>
        <div class="at-body">
            <div class="at-title">成就解锁 · ${achievement.name}</div>
            <div class="at-desc">${achievement.desc}</div>
        </div>
    `;
    toast.onclick = () => toast.remove();
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
}

function showAchievementPanel() {
    const existing = document.getElementById('achievement-panel-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'achievement-panel-overlay';
    overlay.className = 'modal-overlay';

    let itemsHtml = '';
    for (const ach of ACHIEVEMENTS) {
        const isUnlocked = state.achievements.includes(ach.id);
        itemsHtml += `
            <div class="achievement-item ${isUnlocked ? 'unlocked' : 'locked'}">
                <div class="ach-icon">${isUnlocked ? '🏆' : '🔒'}</div>
                <div class="ach-info">
                    <div class="ach-name">${ach.name}</div>
                    <div class="ach-desc">${ach.desc}</div>
                </div>
                <div class="ach-status">${isUnlocked ? '已解锁' : '未解锁'}</div>
            </div>
        `;
    }

    // 星辰档案库（成就模块下方）
    const archiveIds = Object.keys(state.archives);
    let archiveHtml = '<h3 class="archive-lib-title">📚 星辰档案库</h3>';
    if (archiveIds.length === 0) {
        archiveHtml += '<p class="archive-lib-empty">还没有觉醒的星辰。完成一次星辰觉醒后，启示会收藏在这里。</p>';
    } else {
        archiveHtml += '<div class="archive-lib-list">';
        for (const sid of archiveIds) {
            const a = state.archives[sid] || {};
            archiveHtml += `
                <div class="archive-lib-item" data-star="${sid}" role="button" tabindex="0" aria-label="查看 ${a.star_name || sid} 的启示">
                    <span class="ali-name">✦ ${a.star_name || sid}</span>
                    <span class="ali-date">${(a.awakened_at || '').slice(0, 10)}</span>
                </div>
            `;
        }
        archiveHtml += '</div>';
    }

    overlay.innerHTML = `
        <div id="achievement-panel" role="dialog" aria-modal="true" aria-label="守夜人成就">
            <h2>守夜人成就</h2>
            ${itemsHtml}
            ${archiveHtml}
            <button id="achievement-panel-close" class="btn btn-science">关闭</button>
        </div>
    `;

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.id === 'achievement-panel-close') {
            overlay.classList.remove('visible');
            setTimeout(() => overlay.remove(), 300);
            return;
        }
        // 点击档案库中的星星：展开/收起启示详情
        const item = e.target.closest('.archive-lib-item');
        if (item) {
            const a = state.archives[item.dataset.star];
            if (!a) return;
            const existingDetail = item.querySelector('.archive-lib-detail');
            if (existingDetail) {
                existingDetail.remove();
                return;
            }
            const detail = document.createElement('div');
            detail.className = 'archive-lib-detail';
            const statsHtml = Object.entries(a.question_stats || {})
                .filter(([, v]) => v > 0)
                .map(([k, v]) => `${({ fact: '科学', culture: '文化', compare: '对比' })[k] || k}问题 ${v} 个`)
                .join('、');
            detail.innerHTML = `
                <p class="ald-resonance">${(a.resonance || '').replace(/\n/g, '<br>')}</p>
                <p class="ald-note">我的感悟：${(a.personal_note || '').replace(/\n/g, '<br>')}</p>
                ${statsHtml ? `<p class="ald-stats">这次旅程，你追问了 ${statsHtml}</p>` : ''}
                ${a.quiz ? `<p class="ald-quiz">星空小测验：答对 ${a.quiz.score}/${a.quiz.total}</p>` : ''}
            `;
            item.appendChild(detail);
        }
    });

    document.body.appendChild(overlay);
}

// ==================== Three.js 初始化 ====================
let scene, camera, renderer, composer;
let skyGroup; // 星空组（所有星体、连线、银河、倒影）
let starPoints, constellationLines;
let chineseAsterismLines = []; // 中国星官连线（星象频道）
let asterismMarkers = [];      // 单星星官标记
let raycaster, mouse;
let targetRotation = { x: 0, y: 0, z: 0 };
let currentRotation = { x: 0, y: 0, z: 0 };
let isDragging = false;
let previousMouse = { x: 0, y: 0 };

// 2D 极投影星图：HYG 星表半径为 200（实测 Polaris |v|=199.997），+Y 为北天极
const SKY_R = 200;
const R2D = 380;          // 2D 星图半径（场景单位）
const P2D_SCALE = R2D / SKY_R;
const P2D_FIT = 1.12;     // 星图外留白比例
let orthoCamera = null;   // 2D 模式正交相机
let equatorRing = null;   // 2D 模式天赤道参考环
let focus2DAnim = null;   // 2D 聚焦动画状态
let viewModeApplied = false; // 视图模式是否已真正应用到场景

// 星辰聚焦动画状态
let focusTarget = null;
let focusProgress = 0;
let focusStartPos = { x: 0, y: 0, z: 500 };
let focusDistance = 200; // 聚焦时相机距目标星的距离（可缩放）
let tunnelParticles = null;
let westernConstellationLines = [];
let starVeinLines = []; // 觉醒星脉连线
let fogMesh = null; // 认知迷雾球

// 初始化时获取星图数据
async function initStarData() {
    try {
        const [hygResp, constResp, profilesResp, poetryResp, asterismsResp, chaptersResp, dsosResp] = await Promise.all([
            fetch('data/hyg_stars_compact.json?v=20260813'),
            fetch('data/constellations_iau.json?v=20260813'),
            fetch('/api/star-profiles?v=20260813'),
            fetch('data/culture/star_poetry.json?v=20260813'),
            fetch('data/culture/chinese_asterisms.json?v=20260813'),
            fetch('data/chapters.json?v=20260813'),
            fetch('data/dsos.json?v=20260813')
        ]);
        const hygData = await hygResp.json();
        const constData = await constResp.json();
        state.starProfiles = await profilesResp.json();
        state.starPoetry = await poetryResp.json();
        state.chineseAsterisms = await asterismsResp.json();
        state.chapters = await chaptersResp.json();
        state.dsos = await dsosResp.json();
        console.log('Star profiles loaded:', Object.keys(state.starProfiles).length, 'profiles');

        // 建立英文 proper 名到中文名的映射，供星辰库显示中文名
        window._properToCn = {};
        for (const key of Object.keys(state.starProfiles)) {
            const profile = state.starProfiles[key];
            if (profile.name_en) {
                window._properToCn[profile.name_en.toLowerCase()] = profile.name_cn;
            }
        }
        console.log('Star poetry loaded:', state.starPoetry.length, 'poems');
        state.starCatalog = [];
        window._hygStarMap = new Map();
        window._hygData = hygData; // 保留原始星表，供 2D 投影重建几何
        for (let i = 0; i < hygData.count; i++) {
            state.starCatalog.push({
                id: 'hr' + hygData.hr[i],
                name_cn: hygData.proper[i] || ('HR ' + hygData.hr[i]),
                name_en: hygData.proper[i] || null,
                magnitude: hygData.mag[i], ci: hygData.ci[i], hr: hygData.hr[i],
                _x: hygData.px[i], _y: hygData.py[i], _z: hygData.pz[i],
            });
            window._hygStarMap.set(hygData.hr[i], {
                x: hygData.px[i], y: hygData.py[i], z: hygData.pz[i],
                mag: hygData.mag[i], ci: hygData.ci[i], hr: hygData.hr[i],
                proper: hygData.proper[i],
            });
        }
        state.constellations = constData;
        console.log('HYG stars loaded:', hygData.count);
        return { hyg: hygData, constellations: constData };
    } catch (e) {
        console.error('HYG load failed, fallback:', e);
        const resp = await fetch('/api/stars');
        const data = await resp.json();
        state.starCatalog = data.stars || [];
        state.constellations = data.constellations || [];
        return data;
    }
}
function populateStarCatalog() {
    const list = document.getElementById('catalog-list');
    const count = document.getElementById('catalog-count');
    if (!list) return;

    list.innerHTML = '';
    const stars = state.starCatalog;

    // 按亮度排序（星等小的在前）
    const sorted = [...stars].filter(s => s.magnitude < 4).sort((a, b) => (a.magnitude || 99) - (b.magnitude || 99));
    count.textContent = `(${sorted.length})`;

    sorted.forEach(star => {
        const tag = document.createElement('span');
        tag.className = 'catalog-star';
        // 优先使用 star_profiles 中的中文名
        const cnName = (window._properToCn && star.name_en)
            ? (window._properToCn[star.name_en.toLowerCase()] || star.name_cn)
            : star.name_cn;
        star.name_cn = cnName;
        tag.textContent = cnName;
        tag.title = `${star.name_en || ''} · 星等 ${star.magnitude || '?'}`;

        tag.addEventListener('click', () => {
            selectStar(star, tag);
        });

        list.appendChild(tag);
    });

    renderChapterNav();
}

/** 选中一颗星并开始探索（星辰库标签 / 五章书页按钮共用） */
function selectStar(star, triggerEl) {
    // 取消上次选中
    document.querySelectorAll('.catalog-star.selected, .chapter-star-btn.selected').forEach(s => s.classList.remove('selected'));
    if (triggerEl) triggerEl.classList.add('selected');

    // 设置搜索框并触发探索
    state.currentStar = star;
    showStarInfo(star);
    focusOnStar(star);
    const searchInput = document.getElementById('star-search');
    searchInput.value = star.name_cn;
    sendMessage(star.name_cn);
}

/** 渲染五章书页导航：每章 2-3 颗星对照学习（完备性来自结构） */
function renderChapterNav() {
    const nav = document.getElementById('chapter-nav');
    if (!nav) return;
    nav.innerHTML = '';
    const chapters = state.chapters;
    if (!chapters || !chapters.length) return;

    chapters.forEach(ch => {
        const card = document.createElement('div');
        card.className = 'chapter-card';
        card.dataset.chapterId = ch.id;

        // 章头（点击展开/收起）
        const head = document.createElement('div');
        head.className = 'chapter-head';
        head.innerHTML = `
            <span class="chapter-no">第${ch.no}章</span>
            <span class="chapter-title">${ch.title}</span>
            <span class="chapter-arrow">▼</span>
        `;
        head.addEventListener('click', () => card.classList.toggle('open'));

        // 章体：引文 + 对照要点 + 星按钮
        const body = document.createElement('div');
        body.className = 'chapter-body';
        const starsHtml = (ch.stars || [])
            .map(pid => {
                const profile = state.starProfiles[pid];
                if (!profile) return '';
                return `<button type="button" class="chapter-star-btn" data-star="${pid}">${profile.name_cn}</button>`;
            })
            .join('');
        body.innerHTML = `
            <div class="chapter-epigraph">${ch.epigraph || ''}</div>
            <div class="chapter-contrast">${ch.contrast || ''}</div>
            <div class="chapter-stars">${starsHtml}</div>
        `;
        // 星按钮点击 → 找到 catalog 中的对应星并探索
        body.querySelectorAll('.chapter-star-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const profile = state.starProfiles[btn.dataset.star];
                if (!profile) return;
                // 从星表中按英文名匹配
                const star = state.starCatalog.find(s => s.name_en && s.name_en.toLowerCase() === (profile.name_en || '').toLowerCase())
                    || state.starCatalog.find(s => s.name_cn === profile.name_cn);
                if (star) {
                    selectStar(star, btn);
                } else {
                    // 档案星未在星表中（如北斗七星整体）：直接用名称搜索
                    document.querySelectorAll('.chapter-star-btn.selected').forEach(s => s.classList.remove('selected'));
                    btn.classList.add('selected');
                    state.currentStar = null;
                    const searchInput = document.getElementById('star-search');
                    searchInput.value = profile.name_cn;
                    sendMessage(profile.name_cn);
                }
            });
        });

        card.appendChild(head);
        card.appendChild(body);
        nav.appendChild(card);
    });
}

async function initThree() {
    const container = document.getElementById('canvas-container');

    // WebGL 2.0 检测
    const testCanvas = document.createElement('canvas');
    const gl = testCanvas.getContext('webgl2');
    if (!gl) {
        const fallback = document.getElementById('webgl-fallback');
        if (fallback) fallback.style.display = 'flex';
        if (container) container.style.display = 'none';
        console.warn('WebGL 2.0 not supported — showing fallback');
        return;
    }

    const width = container.clientWidth;
    const height = container.clientHeight;

    // 场景
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a14);

    // 星空组（容纳所有天体的父节点，方便整体旋转和平移）
    skyGroup = new THREE.Group();
    scene.add(skyGroup);

    // 相机 - 俯瞰全天空球面
    camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 10000);
    camera.position.set(0, 0, 500);

    // 渲染器
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // 后期处理 - Bloom效果
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));

    const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(width, height),
        1.2, 0.4, 0.85
    );
    composer.addPass(bloomPass);

    // 光线投射
    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    // 先获取星图数据
    const starData = await initStarData();
    populateStarCatalog();

    // 创建天空穹顶星空（上半球）
    createStarField(starData.hyg || null);
    // 创建星官连线
    createConstellationLines();
    // 创建认知迷雾
    createFogMesh();
    // 创建闪烁星光
    createTwinkleStars();

    // 为前5亮星创建可见光光谱光球
    createBrightStarOrbs(state.starCatalog);

    // 事件监听
    setupEventListeners();

    // 恢复用户上次的视图模式（默认 2D 主视图）
    try {
        const saved = localStorage.getItem('tianwen_view_mode');
        if (['2d', '3d', 'observe'].includes(saved)) state.viewMode = saved;
    } catch (e) {}
    syncViewButtons();
    setViewMode(state.viewMode);

    // 开始动画循环
    animate();
}

function createStarField(hygData) {
    console.log('createStarField called, hygCount:', hygData ? hygData.count : 0);
    starPoints = new THREE.Points(build3DStarGeometry(hygData), starPoints ? starPoints.material : null);
    const mat = new THREE.ShaderMaterial({
        uniforms: { attenuation: {value:false}, starMin: {value:0.3}, starMax: {value:12.0}, starMinBrightnes: {value:6.5}, starFadeDactor: {value:-1.4}, uChannelTint: {value:new THREE.Vector3(0.95, 0.98, 1.15)} },
        vertexShader: STAR_VERTEX_SHADER, fragmentShader: STAR_FRAGMENT_SHADER,
        blending: THREE.AdditiveBlending, depthTest: false, transparent: true,
    });
    window._starShaderMaterial = mat;
    starPoints.material = mat;
    skyGroup.add(starPoints);
    state.stars = starPoints.geometry.attributes.position.array;
    console.log('Star points added to skyGroup, starPoints:', !!starPoints, 'geom.attributes.position.count:', starPoints.geometry.attributes.position.count);
}

/** 构建 3D 星场几何：近景装饰星 + HYG 真实星 + 远景装饰星 */
function build3DStarGeometry(hygData) {
    const hygCount = hygData ? hygData.count : 0;
    const nearCount = 150, farCount = 1200, totalCount = hygCount + nearCount + farCount;
    const positions = new Float32Array(totalCount * 3);
    const colors = new Float32Array(totalCount * 3);
    const sizes = new Float32Array(totalCount);
    let idx = 0;

    for (let i = 0; i < nearCount; i++) {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const r = 150 + Math.random() * 250;
        positions[idx*3]=r*Math.sin(phi)*Math.cos(theta);
        positions[idx*3+1]=r*Math.cos(phi);
        positions[idx*3+2]=-r*Math.sin(phi)*Math.sin(theta);
        colors[idx*3]=0.8+Math.random()*0.2; colors[idx*3+1]=0.8+Math.random()*0.2; colors[idx*3+2]=0.9+Math.random()*0.1;
        sizes[idx]=4+Math.random()*8;
        idx++;
    }

    if (hygCount > 0) {
        for (let i = 0; i < hygCount; i++) {
            positions[idx*3]=hygData.px[i]; positions[idx*3+1]=hygData.py[i]; positions[idx*3+2]=hygData.pz[i];
            const rgb = bvToRgb(hygData.ci[i] || 0.65);
            colors[idx*3]=rgb[0]; colors[idx*3+1]=rgb[1]; colors[idx*3+2]=rgb[2];
            sizes[idx]=hygData.mag[i];
            idx++;
        }
    }

    for (let i = 0; i < farCount; i++) {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const r = 850 + Math.random() * 100;
        positions[idx*3]=r*Math.sin(phi)*Math.cos(theta);
        positions[idx*3+1]=r*Math.cos(phi);
        positions[idx*3+2]=-r*Math.sin(phi)*Math.sin(theta);
        colors[idx*3]=0.6+Math.random()*0.4; colors[idx*3+1]=0.6+Math.random()*0.4; colors[idx*3+2]=0.7+Math.random()*0.3;
        sizes[idx]=Math.random()*1.2+0.3;
        idx++;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geom.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    return geom;
}
function createConstellationLines() {
    if (constellationLines && constellationLines.length > 0) {
        constellationLines.forEach(l => { skyGroup.remove(l); if(l.geometry)l.geometry.dispose(); if(l.material)l.material.dispose(); });
    }
    constellationLines = [];
    const constData = state.constellations, starMap = window._hygStarMap;
    if (!constData || !starMap) return;
    const mat = new THREE.LineBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthTest: false });
    for (const abbr of Object.keys(constData)) {
        const def = constData[abbr];
        if (!def.stars || def.stars.length < 2) continue;
        const pts = [];
        for (let i = 0; i < def.stars.length; i++) {
            const s = starMap.get(def.stars[i]);
            if (s) pts.push(new THREE.Vector3(s.x, s.y, s.z));
        }
        if (pts.length < 2) continue;
        const g = new THREE.BufferGeometry().setFromPoints(pts);
        const l = new THREE.Line(g, mat.clone());
        l.userData.constellationId = abbr;
        skyGroup.add(l); constellationLines.push(l);
    }
    console.log('Constellations:', constellationLines.length);
}
// ==================== 2D 极投影星图（主视图） ====================
// 北天极/南天极为中心的极投影：从极轴上方正交俯瞰，与现实中"认星"的方向感一致

/** HYG 单位球坐标（r=200）沿极轴正交投影到 2D 平面（y=0） */
function projectTo2D(px, py, pz) {
    return { x: px * P2D_SCALE, z: pz * P2D_SCALE };
}

/** 当前半球筛选：北天极视图显示 py>=0，南天极视图显示 py<=0 */
function _inHemisphere(py) {
    return state.viewHemisphere === 'south' ? py <= 0 : py >= 0;
}

/** 构建 2D 星场几何：当前半球的真实星投影到 y=0 平面（无装饰星） */
function build2DStarGeometry() {
    const hyg = window._hygData;
    const idxs = [];
    if (hyg) {
        for (let i = 0; i < hyg.count; i++) {
            if (_inHemisphere(hyg.py[i])) idxs.push(i);
        }
    }
    const n = idxs.length;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const sizes = new Float32Array(n);
    idxs.forEach((i, k) => {
        positions[k*3] = hyg.px[i] * P2D_SCALE;
        positions[k*3+1] = 0;
        positions[k*3+2] = hyg.pz[i] * P2D_SCALE;
        const rgb = bvToRgb(hyg.ci[i] || 0.65);
        colors[k*3]=rgb[0]; colors[k*3+1]=rgb[1]; colors[k*3+2]=rgb[2];
        sizes[k] = hyg.mag[i];
    });
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geom.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    return geom;
}

/** 重建 2D 星座连线（仅保留同半球的连线）+ 天赤道参考环 */
function rebuild2DConstellationLines() {
    if (constellationLines && constellationLines.length > 0) {
        constellationLines.forEach(l => { skyGroup.remove(l); if(l.geometry)l.geometry.dispose(); if(l.material)l.material.dispose(); });
    }
    constellationLines = [];
    const constData = state.constellations, starMap = window._hygStarMap;
    if (!constData || !starMap) return;
    const mat = new THREE.LineBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthTest: false });
    for (const abbr of Object.keys(constData)) {
        const def = constData[abbr];
        if (!def.stars || def.stars.length < 2) continue;
        const pts = [];
        let valid = true;
        for (let i = 0; i < def.stars.length; i++) {
            const s = starMap.get(def.stars[i]);
            if (!s || !_inHemisphere(s.y)) { valid = false; break; }
            const p = projectTo2D(s.x, s.y, s.z);
            pts.push(new THREE.Vector3(p.x, 0, p.z));
        }
        if (!valid || pts.length < 2) continue;
        const g = new THREE.BufferGeometry().setFromPoints(pts);
        const l = new THREE.Line(g, mat.clone());
        l.userData.constellationId = abbr;
        skyGroup.add(l); constellationLines.push(l);
    }
    // 天赤道参考环：帮助对应夜空方位
    if (equatorRing) { skyGroup.remove(equatorRing); equatorRing.geometry.dispose(); equatorRing.material.dispose(); equatorRing = null; }
    const ringPts = [];
    for (let i = 0; i <= 128; i++) {
        const a = (i / 128) * Math.PI * 2;
        ringPts.push(new THREE.Vector3(Math.cos(a) * R2D, 0.1, Math.sin(a) * R2D));
    }
    equatorRing = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(ringPts),
        new THREE.LineBasicMaterial({ color: 0x8ab8ff, transparent: true, opacity: 0.22, depthTest: false })
    );
    skyGroup.add(equatorRing);
}

/** 构建中国星官连线（按当前视图模式投影，成员星 >= 2 才连线） */
function buildChineseAsterismLines() {
    chineseAsterismLines.forEach(l => { skyGroup.remove(l); if(l.geometry)l.geometry.dispose(); if(l.material)l.material.dispose(); });
    chineseAsterismLines = [];
    const data = state.chineseAsterisms;
    const starMap = window._hygStarMap;
    if (!data || !starMap) return;

    const mode = state.viewMode;
    const mat = new THREE.LineBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0, depthTest: false, blending: THREE.AdditiveBlending });

    // 星 → 当前模式场景坐标（2D/今晚投影到 y=0 平面）
    const toScene = (s) => {
        if (mode === '2d') {
            if (!_inHemisphere(s.y)) return null;
            const p = projectTo2D(s.x, s.y, s.z);
            return new THREE.Vector3(p.x, 0, p.z);
        }
        return new THREE.Vector3(s.x, s.y, s.z);
    };

    for (const key of Object.keys(data)) {
        const def = data[key];
        if (!def.members || def.members.length < 2) continue; // 单星星官靠 D 标注呈现
        const pts = [];
        let valid = true;
        for (const hr of def.members) {
            const s = starMap.get(hr);
            if (!s) { valid = false; break; }
            const v = toScene(s);
            if (!v) { valid = false; break; }
            pts.push(v);
        }
        if (!valid || pts.length < 2) continue;
        const g = new THREE.BufferGeometry().setFromPoints(pts);
        const l = new THREE.Line(g, mat.clone());
        l.userData.asterismId = key;
        l.userData.asterismName = def.name;
        l.userData.region = def.region;
        skyGroup.add(l);
        chineseAsterismLines.push(l);
    }
}

/** 更新 2D 正交相机视口（含窗口尺寸变化），保证星图圆完整可见 */
function update2DCamera() {
    const container = document.getElementById('canvas-container');
    const width = container.clientWidth, height = container.clientHeight;
    if (!width || !height) return;
    const aspect = width / height;
    const half = R2D * P2D_FIT * Math.max(1, 1 / aspect);
    orthoCamera.left = -half * aspect;
    orthoCamera.right = half * aspect;
    orthoCamera.top = half;
    orthoCamera.bottom = -half;
    orthoCamera.updateProjectionMatrix();
}

/** 切换视图模式：'2d' 极投影星图（主视图）/ '3d' 沉浸星空 / 'observe' 地面观星 */
function setViewMode(mode) {
    if (!['2d', '3d', 'observe'].includes(mode)) return;
    if (mode === state.viewMode && viewModeApplied) { syncViewButtons(); return; }
    state.viewMode = mode;
    try { localStorage.setItem('tianwen_view_mode', mode); } catch (e) {}

    const container = document.getElementById('canvas-container');
    const width = container.clientWidth, height = container.clientHeight;

    if (mode === '3d') {
        // 透视相机：恢复 3D 沉浸视角
        camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 10000);
        camera.position.set(0, 0, 500);
        orthoCamera = null;
        _swapComposerCamera();
        if (starPoints) {
            const old = starPoints.geometry;
            starPoints.geometry = build3DStarGeometry(window._hygData);
            old.dispose();
        }
        createConstellationLines();
        buildChineseAsterismLines();
        if (equatorRing) { skyGroup.remove(equatorRing); equatorRing.geometry.dispose(); equatorRing.material.dispose(); equatorRing = null; }
        rebuildFog('3d');
        if (twinklePoints) twinklePoints.visible = true;
        starVeinLines.forEach(l => l.visible = true);
        if (!milkyWayPoints) createMilkyWay();
        milkyWayPoints.visible = true; // 3D 沉浸也带真实银河
        buildDsoMarkers();
        buildPlanetMarkers();
        focusTarget = null; focusProgress = 0;
        _clearObserveOverlays();
    } else if (mode === 'observe') {
        // 地面观星：透视相机位于天球球心，朝向由 (方位角, 仰角) 控制
        camera = new THREE.PerspectiveCamera(observeParams.fov, width / height, 0.1, 5000);
        camera.position.set(0, 0, 0);
        orthoCamera = null;
        _swapComposerCamera();
        if (starPoints) {
            const old = starPoints.geometry;
            starPoints.geometry = buildObserveStarGeometry();
            old.dispose();
        }
        createConstellationLines();
        buildChineseAsterismLines();
        if (equatorRing) { skyGroup.remove(equatorRing); equatorRing.geometry.dispose(); equatorRing.material.dispose(); equatorRing = null; }
        buildObserveHorizon();
        rebuildFog('observe');
        if (twinklePoints) twinklePoints.visible = false;
        clearMeteors();
        if (tunnelParticles) { scene.remove(tunnelParticles); tunnelParticles = null; }
        starVeinLines.forEach(l => l.visible = false);
        focusTarget = null; focusProgress = 0;
        const od = document.getElementById('observe-compass');
        if (od) od.style.display = 'block';
        buildObserveGround();
        buildObserveSkyGlow();
        if (!milkyWayPoints) createMilkyWay();
        milkyWayPoints.visible = true; // 观星夜空带银河
        buildDsoMarkers();
        buildPlanetMarkers();
    } else {
        // 2d 正交相机（主视图）
        const south = state.viewHemisphere === 'south';
        camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
        camera.position.set(0, south ? -400 : 400, 0);
        camera.up.set(0, 0, south ? -1 : 1);
        camera.lookAt(0, 0, 0);
        camera.zoom = 1;
        orthoCamera = camera;
        update2DCamera();
        _swapComposerCamera();

        if (starPoints) {
            const old = starPoints.geometry;
            starPoints.geometry = build2DStarGeometry();
            old.dispose();
        }
        rebuild2DConstellationLines();
        buildChineseAsterismLines();
        rebuildFog('2d');
        if (twinklePoints) twinklePoints.visible = false;
        clearMeteors();
        if (tunnelParticles) { scene.remove(tunnelParticles); tunnelParticles = null; }
        starVeinLines.forEach(l => l.visible = false);
        if (milkyWayPoints) milkyWayPoints.visible = false; // 2D 星图以清晰为准
        targetRotation.x = 0; targetRotation.z = 0; // 2D 只绕极轴旋转
        clearDsoMarkers();
        clearPlanetMarkers();
        _clearObserveOverlays();
    }

    const hb = document.getElementById('hemisphere-btn');
    if (hb) hb.style.display = mode === '2d' ? '' : 'none';
    const ob = document.getElementById('observe-btn');
    if (ob) ob.style.display = '';
    updateStageVisual();
    syncViewButtons();
    updateFogState();
    updateBipolarView();
    updateChannelView();
    viewModeApplied = true;
}

/** 清理观星模式的叠加层（地平圈/罗盘条/地面参照物/大气辉光） */
function _clearObserveOverlays() {
    if (observeHorizon) { skyGroup.remove(observeHorizon); observeHorizon.geometry.dispose(); observeHorizon.material.dispose(); observeHorizon = null; }
    if (observeGround) {
        skyGroup.remove(observeGround);
        observeGround.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
        observeGround = null;
    }
    if (observeSkyGlow) { skyGroup.remove(observeSkyGlow); observeSkyGlow.geometry.dispose(); observeSkyGlow.material.dispose(); observeSkyGlow = null; }
    const od = document.getElementById('observe-compass');
    if (od) od.style.display = 'none';
}

/** 相机对象更换后，同步 composer 的 RenderPass 相机引用 */
function _swapComposerCamera() {
    if (composer && composer.passes && composer.passes[0]) {
        composer.passes[0] = new RenderPass(scene, camera);
    }
}

/** 同步视图/半球按钮文案与状态 */
function syncViewButtons() {
    const btn = document.getElementById('view-toggle-btn');
    if (btn) {
        const is3d = state.viewMode === '3d';
        btn.textContent = is3d ? '🪐 2D星图' : '🌌 3D星空';
        btn.setAttribute('aria-pressed', String(is3d));
        btn.title = state.viewMode === 'observe' ? '返回二维星图' : '切换二维星图/三维星空';
    }
    const hb = document.getElementById('hemisphere-btn');
    if (hb) hb.textContent = state.viewHemisphere === 'south' ? '⬇ 南天极' : '⬆ 北天极';
    const ob = document.getElementById('observe-btn');
    if (ob) {
        ob.textContent = '🔭 地面观星';
        ob.classList.toggle('active', state.viewMode === 'observe');
    }
}

/** 切换南北天极视角（仅 2D 模式） */
function switchHemisphere() {
    state.viewHemisphere = state.viewHemisphere === 'north' ? 'south' : 'north';
    const south = state.viewHemisphere === 'south';
    if (orthoCamera) {
        orthoCamera.position.set(0, south ? -400 : 400, 0);
        orthoCamera.up.set(0, 0, south ? -1 : 1);
        orthoCamera.lookAt(0, 0, 0);
    }
    if (starPoints) {
        const old = starPoints.geometry;
        starPoints.geometry = build2DStarGeometry();
        old.dispose();
    }
    rebuild2DConstellationLines();
    buildChineseAsterismLines();
    updateStageVisual();
    syncViewButtons();
    updateFogState();
}

/** 2D 聚焦：把目标星转到屏幕上方并轻微放大（保持"上北下南"的方向感） */
function focus2D(star) {
    if (!star || star._x === undefined || !orthoCamera) return;
    // 星在极投影中的方位角 → 旋转 skyGroup 使其位于屏幕正上方
    let targetY = Math.atan2(-star._x, star._z);
    const diff = ((targetY - currentRotation.y + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    targetY = currentRotation.y + diff;
    targetRotation.y = targetY;
    focus2DAnim = {
        targetY,
        startY: currentRotation.y,
        startZoom: orthoCamera.zoom,
        startTime: Date.now(),
        duration: 800
    };
}

// 星官·宿名映射（星象频道标签标注：用古星官名，不用现代名/英文）
const ASTERISM_META = {
    Polaris: { name: '勾陈一', region: '紫微垣' },
    Sirius: { name: '天狼', region: '井宿' },
    Vega: { name: '织女', region: '牛宿' },
    Altair: { name: '河鼓二', region: '牛宿' },
    Betelgeuse: { name: '参宿四', region: '参宿' },
    Antares: { name: '心宿二', region: '心宿' },
    Arcturus: { name: '大角', region: '亢宿' }
};

function _toJulianDay(y, m, d, hours) {
    if (m <= 2) { y -= 1; m += 12; }
    const A = Math.floor(y / 100);
    const B = 2 - A + Math.floor(A / 4);
    return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5 + hours / 24;
}

function _gmstDeg(jd) {
    const T = (jd - 2451545.0) / 36525;
    const g = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - T * T * T / 38710000;
    return ((g % 360) + 360) % 360;
}

/**
 * 赤经/赤纬 → 地平坐标（弧度）。az 从北起顺时针（N=0, E=90, S=180, W=270）。
 */
function _altAzFromRaDec(ra, dec, lstDeg, latDeg) {
    const H = lstDeg * Math.PI / 180 - ra;
    const lat = latDeg * Math.PI / 180;
    const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(H);
    const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
    if (Math.cos(alt) < 1e-9) return { alt, az: 0 };
    const cosAz = (Math.sin(dec) - Math.sin(alt) * Math.sin(lat)) / (Math.cos(alt) * Math.cos(lat));
    let az = Math.acos(Math.max(-1, Math.min(1, cosAz)));
    if (Math.sin(H) > 0) az = 2 * Math.PI - az;
    return { alt, az };
}

/**
 * HYG 单位向量（r=200，+Y=北天极）→ 地平坐标。
 * 已验证：dec = asin(py/200)，RA = atan2(pz, -px)（与 Polaris/Sirius/Vega 等真值吻合）。
 */
function starAltAz(px, py, pz, lstDeg, latDeg) {
    const ra = Math.atan2(pz, -px);
    const dec = Math.asin(Math.max(-1, Math.min(1, py / SKY_R)));
    return _altAzFromRaDec(ra, dec, lstDeg, latDeg);
}

// ==================== 地面观星（纬度带场景，球心相机） ====================
// 从地球某地的地面视角观星：透视相机位于天球球心，朝向由 (方位角 az, 仰角 alt) 控制，
// 视场默认 60°（人眼视野）可调 30-80°，拖拽转动视角观察其他方向的天空。
// 观测者天顶 z=(cos lat, sin lat, 0)，北 n=(-sin lat, cos lat, 0)，东 e=(0,0,1)
// （已验证：赤道处北=北天极方向；北极处北=天顶）。

const OBSERVE_SITES = [
    { name: '哈尔滨 · 高纬北', lat: 45.8, lon: 126.5, desc: '北极星高挂头顶，南天几乎不可见' },
    { name: '上海 · 中纬北', lat: 31.2, lon: 121.5, desc: '经典北半球观星视角' },
    { name: '新加坡 · 赤道', lat: 1.35, lon: 103.8, desc: '南北天各露出一半' },
    { name: '悉尼 · 中纬南', lat: -33.9, lon: 151.2, desc: '南十字座高悬' },
    { name: '乌斯怀亚 · 高纬南', lat: -54.8, lon: -68.3, desc: '南天极在低空' }
];

let observeParams = { site: 1, lat: 31.2, lon: 121.5, fov: 60, az: 0, alt: 40 * Math.PI / 180 };
let _observeLstCache = 0;      // 当地恒星时（度）缓存
let observeHorizon = null;     // 地平圈
let observeGround = null;      // 地面参照物（草地/山/湖）
let observeFocusAnim = null;   // 转视角对准星动画

/** 观测者天顶/北/东方向（场景坐标，lat 弧度） */
function _observeAxes(latRad) {
    return {
        z: new THREE.Vector3(Math.cos(latRad), Math.sin(latRad), 0),
        n: new THREE.Vector3(-Math.sin(latRad), Math.cos(latRad), 0),
        e: new THREE.Vector3(0, 0, 1)
    };
}

/** (az, alt) 弧度 → 场景方向向量 */
function _observeDir(az, alt, latRad) {
    const { z, n, e } = _observeAxes(latRad);
    const dir = new THREE.Vector3(0, 0, 0);
    dir.addScaledVector(n, Math.cos(az) * Math.cos(alt));
    dir.addScaledVector(e, Math.sin(az) * Math.cos(alt));
    dir.addScaledVector(z, Math.sin(alt));
    return dir;
}

/** 观星模式当地恒星时（度）：当天日期 + 固定夜晚 21:00（观星场景恒为夜晚） */
function _observeLstDeg() {
    const now = new Date();
    const jd = _toJulianDay(now.getFullYear(), now.getMonth() + 1, now.getDate(), 21 - 8);
    return ((_gmstDeg(jd) + observeParams.lon) % 360 + 360) % 360;
}

/** 构建观星星场几何：地平以上（alt>0）的 HYG 球面星，3D 坐标 */
function buildObserveStarGeometry() {
    const hyg = window._hygData;
    _observeLstCache = _observeLstDeg();
    const visible = [];
    if (hyg) {
        for (let i = 0; i < hyg.count; i++) {
            const { alt } = starAltAz(hyg.px[i], hyg.py[i], hyg.pz[i], _observeLstCache, observeParams.lat);
            if (alt > 0) visible.push(i);
        }
    }
    state.observeVisible = new Set(visible);
    const n = visible.length;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const sizes = new Float32Array(n);
    visible.forEach((i, k) => {
        positions[k*3] = hyg.px[i];
        positions[k*3+1] = hyg.py[i];
        positions[k*3+2] = hyg.pz[i];
        const rgb = bvToRgb(hyg.ci[i] || 0.65);
        colors[k*3]=rgb[0]; colors[k*3+1]=rgb[1]; colors[k*3+2]=rgb[2];
        sizes[k] = hyg.mag[i];
    });
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geom.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    return geom;
}

/** 观星地平圈（过球心，法线为观测者天顶方向，半径略大于星面） */
function buildObserveHorizon() {
    if (observeHorizon) { skyGroup.remove(observeHorizon); observeHorizon.geometry.dispose(); observeHorizon.material.dispose(); observeHorizon = null; }
    const { n, e } = _observeAxes(observeParams.lat * Math.PI / 180);
    const R = 202;
    const pts = [];
    for (let i = 0; i <= 128; i++) {
        const a = (i / 128) * Math.PI * 2;
        const v = new THREE.Vector3().addScaledVector(n, Math.cos(a)).addScaledVector(e, Math.sin(a));
        pts.push(v.multiplyScalar(R));
    }
    observeHorizon = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x8ab8ff, transparent: true, opacity: 0.4, depthTest: false })
    );
    skyGroup.add(observeHorizon);
}

/** 观星大气辉光：天球背景壳（r=880），天顶深、地平线微亮，模拟大气散射 */
let observeSkyGlow = null;

function buildObserveSkyGlow() {
    if (observeSkyGlow) { skyGroup.remove(observeSkyGlow); observeSkyGlow.geometry.dispose(); observeSkyGlow.material.dispose(); observeSkyGlow = null; }
    const latRad = observeParams.lat * Math.PI / 180;
    const { z } = _observeAxes(latRad);
    // canvas 渐变：v=0（南极，被地面遮挡）深，v=0.5（地平线）微亮，v=1（天顶）深
    const canvas = document.createElement('canvas');
    canvas.width = 16; canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, 'rgb(6, 10, 18)');
    grad.addColorStop(0.48, 'rgb(6, 10, 18)');
    grad.addColorStop(0.52, 'rgb(28, 38, 58)'); // 地平线辉光
    grad.addColorStop(0.6, 'rgb(14, 20, 34)');
    grad.addColorStop(1, 'rgb(5, 8, 14)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 16, 256);
    const tex = new THREE.CanvasTexture(canvas);
    const glow = new THREE.Mesh(
        new THREE.SphereGeometry(880, 32, 32, 0, Math.PI * 2, 0, Math.PI),
        new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthTest: false, transparent: true, opacity: 0.85 })
    );
    glow.lookAt(z); // 球壳北极朝天顶（uv v=1 在天顶）
    skyGroup.add(glow);
    observeSkyGlow = glow;
}

/** 观星地面参照物：下半球地面（草原）+ 山形剪影 + 湖泊斑块。
 * 从球心看，地平线以下被地面填满，山/湖提供地表参照。 */
function buildObserveGround() {
    if (observeGround) {
        skyGroup.remove(observeGround);
        observeGround.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
        observeGround = null;
    }
    const latRad = observeParams.lat * Math.PI / 180;
    const { z } = _observeAxes(latRad);
    const group = new THREE.Group();

    // 1) 下半球地面：从球心看填满地平线以下视野（暗草原色）
    const groundMat = new THREE.MeshBasicMaterial({ color: 0x0a1410, side: THREE.BackSide, depthTest: false });
    const ground = new THREE.Mesh(new THREE.SphereGeometry(300, 48, 24, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), groundMat);
    ground.lookAt(z); // 半球开口朝天顶方向
    group.add(ground);

    // 2) 山形剪影：沿地平圈分布的山峰（从球心看呈现为远处山影）
    const mountainMat = new THREE.MeshBasicMaterial({ color: 0x030608, side: THREE.DoubleSide, depthTest: false });
    const peaks = [
        { a: 15, h: 14, w: 9 }, { a: 55, h: 9, w: 7 }, { a: 100, h: 17, w: 10 },
        { a: 150, h: 10, w: 7 }, { a: 205, h: 15, w: 9 }, { a: 255, h: 7, w: 6 }, { a: 305, h: 12, w: 8 }
    ];
    const upToZenith = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), z);
    peaks.forEach(pk => {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(pk.w, pk.h, 3), mountainMat);
        const dir = _observeDir(pk.a * Math.PI / 180, 1.2 * Math.PI / 180, latRad);
        cone.position.copy(dir.clone().multiplyScalar(300));
        cone.quaternion.copy(upToZenith); // 峰顶朝天顶
        group.add(cone);
    });

    // 3) 湖泊斑块：地面上的淡蓝反光椭圆
    const lakeMat = new THREE.MeshBasicMaterial({ color: 0x1c3d57, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthTest: false });
    const lake = new THREE.Mesh(new THREE.SphereGeometry(26, 20, 10), lakeMat);
    const lakeDir = _observeDir(135 * Math.PI / 180, -2.5 * Math.PI / 180, latRad);
    lake.position.copy(lakeDir.clone().multiplyScalar(298));
    lake.scale.set(1.4, 0.55, 0.18); // 压扁贴地
    group.add(lake);

    skyGroup.add(group);
    observeGround = group;
}

/** 更新观星方位指示（状态栏文案 + 屏幕底部固定罗盘条，随方位滚动） */
function updateObserveIndicators() {
    if (state.viewMode !== 'observe') return;
    const statusEl = document.getElementById('chat-status');
    if (statusEl) {
        const azDeg = ((observeParams.az * 180 / Math.PI) % 360 + 360) % 360;
        const altDeg = observeParams.alt * 180 / Math.PI;
        const dirName = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'][Math.round(azDeg / 45) % 8];
        statusEl.textContent = `🔭 ${OBSERVE_SITES[observeParams.site].name} · ${dirName} ${azDeg.toFixed(0)}° · 仰角 ${altDeg.toFixed(0)}° · 视场 ${observeParams.fov}°（拖动转动视角）`;
    }
    // HUD 罗盘条：屏幕底部固定，方位刻度随视角滚动（任何仰角都能定位方向）
    const compass = document.getElementById('observe-compass');
    if (!compass) return;
    const curAz = ((observeParams.az * 180 / Math.PI) % 360 + 360) % 360;
    compass.innerHTML = '';
    const dirLabels = { 0: '北 N', 90: '东 E', 180: '南 S', 270: '西 W' };
    for (let azd = Math.floor(curAz / 15) * 15 - 120; azd <= curAz + 120; azd += 15) {
        const label = dirLabels[((azd % 360) + 360) % 360];
        if (!label) continue; // 只显示四正
        const offset = azd - curAz;
        const x = 50 + offset * 0.4; // 中心=当前朝向，±120° 映射到罗盘条可见区
        if (x < 2 || x > 98) continue;
        const el = document.createElement('div');
        el.className = 'observe-direction' + (Math.abs(offset) < 8 ? ' observe-cur' : '');
        el.textContent = label;
        el.style.left = x + '%';
        compass.appendChild(el);
    }
}

/** 观星聚焦：把相机视角平滑转到目标星的 (方位角, 仰角) */
function focusObserve(star) {
    if (!star || star._x === undefined || state.viewMode !== 'observe') return;
    const { alt, az } = starAltAz(star._x, star._y, star._z, _observeLstCache, observeParams.lat);
    observeFocusAnim = {
        startAz: observeParams.az,
        startAlt: observeParams.alt,
        targetAz: az,
        targetAlt: Math.max(-5 * Math.PI / 180, Math.min(90 * Math.PI / 180, alt)),
        startTime: Date.now(),
        duration: 900
    };
}

function createTwinkleStars() {
    const count = 400;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    twinklePhases = new Float32Array(count);

    for (let i = 0; i < count; i++) {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const r = 800 + Math.random() * 100;
        positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = r * Math.cos(phi);
        positions[i * 3 + 2] = -r * Math.sin(phi) * Math.sin(theta);

        // 多彩闪烁星：偏蓝白、暖金、淡紫
        const colorType = Math.random();
        if (colorType < 0.35) {
            colors[i * 3] = 0.7; colors[i * 3 + 1] = 0.8; colors[i * 3 + 2] = 1;
        } else if (colorType < 0.6) {
            colors[i * 3] = 1; colors[i * 3 + 1] = 0.85; colors[i * 3 + 2] = 0.5;
        } else if (colorType < 0.8) {
            colors[i * 3] = 0.9; colors[i * 3 + 1] = 0.6; colors[i * 3 + 2] = 1;
        } else {
            colors[i * 3] = 1; colors[i * 3 + 1] = 0.7; colors[i * 3 + 2] = 0.7;
        }

        sizes[i] = Math.random() * 2 + 0.5;
        twinklePhases[i] = Math.random() * Math.PI * 2;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    const material = new THREE.PointsMaterial({
        size: 1.5,
        vertexColors: true,
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true
    });

    twinklePoints = new THREE.Points(geometry, material);
    skyGroup.add(twinklePoints);
}

// 星辰名称标签
let starLabels = [];
let labelContainer = null;

function initStarLabels() {
    labelContainer = document.createElement('div');
    labelContainer.id = 'star-labels';
    labelContainer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:5;';
    document.getElementById('canvas-container').appendChild(labelContainer);
}

function updateStarLabels() {
    if (!labelContainer || !camera) return;
    labelContainer.innerHTML = '';

    // 亮星标签
    const mode = state.viewMode;
    const is2d = mode === '2d';
    const isObserve = mode === 'observe';
    const isCulture = state.channel === 'culture';
    const bright = [...state.starCatalog]
        .filter(s => s._x !== undefined
            && (is2d ? _inHemisphere(s._y) : true)
            && (isObserve ? starAltAz(s._x, s._y, s._z, _observeLstCache, observeParams.lat).alt > 0 : true)
            && s.magnitude < 3.5
            && (!isCulture || ASTERISM_META[s.name_en])) // 星象频道只标古人命名的亮星
        .sort((a, b) => (a.magnitude || 99) - (b.magnitude || 99))
        .slice(0, 50);

    bright.forEach(star => {
        let wp;
        if (is2d) {
            const p = projectTo2D(star._x, star._y, star._z);
            wp = new THREE.Vector3(p.x, 0, p.z).applyEuler(new THREE.Euler(0, currentRotation.y, 0));
        } else {
            // 3D / 观星：直接使用球面坐标（观星相机在球心，自身转向）
            wp = new THREE.Vector3(star._x, star._y, star._z)
                .applyEuler(new THREE.Euler(currentRotation.x, currentRotation.y, currentRotation.z));
        }
        const projected = wp.clone().project(camera);
        if (projected.z > 1 || projected.z < 0) return;

        const rect = document.getElementById('canvas-container').getBoundingClientRect();
        const sx = (projected.x * 0.5 + 0.5) * rect.width;
        const sy = (-projected.y * 0.5 + 0.5) * rect.height;
        const dist = wp.length();
        const opacity = is2d ? 0.6 : Math.max(0.1, Math.min(0.7, 500 / dist));

        const label = document.createElement('div');
        label.className = 'star-label ' + (state.channel === 'culture' ? 'culture' : 'science');
        label.style.cssText = `
            position: absolute; left: ${sx}px; top: ${sy}px;
            font-size: ${11 + Math.min(star.magnitude || 0, 3) * 3}px;
            transform: translate(-50%, -50%); white-space: nowrap;
            pointer-events: none;
        `;
        label.textContent = star.name_cn;
        // 频道专属标注：科学=现代星名+星等；星象=古星官名+所属（纯中文，无英文）
        if (state.channel === 'culture') {
            const aster = ASTERISM_META[star.name_en];
            if (aster) {
                label.textContent = aster.name;
                const meta = document.createElement('span');
                meta.className = 'meta';
                meta.textContent = aster.region;
                label.appendChild(meta);
            }
        } else if (star.magnitude) {
            const meta = document.createElement('span');
            meta.className = 'meta';
            meta.textContent = `星等 ${star.magnitude.toFixed(1)}`;
            label.appendChild(meta);
        }
        labelContainer.appendChild(label);
    });

    // 星座名称标签（科学频道；星象频道用二十八宿划分，不显示西方星座）
    if (state.constellations && state.channel !== 'culture') {
        const constNames = {
            And: '仙女座', Ant: '唧筒座', Aps: '天燕座', Aql: '天鹰座', Aqr: '宝瓶座',
            Ara: '天坛座', Ari: '白羊座', Aur: '御夫座', Boo: '牧夫座', Cae: '雕具座',
            Cam: '鹿豹座', Cap: '摩羯座', Car: '船底座', Cas: '仙后座', Cen: '半人马座',
            Cep: '仙王座', Cet: '鲸鱼座', Cha: '蝘蜓座', Cir: '圆规座', CMa: '大犬座',
            CMi: '小犬座', Cnc: '巨蟹座', Col: '天鸽座', Com: '后发座', CrA: '南冕座',
            CrB: '北冕座', Crt: '巨爵座', Cru: '南十字座', Crv: '乌鸦座', CVn: '猎犬座',
            Cyg: '天鹅座', Del: '海豚座', Dor: '剑鱼座', Dra: '天龙座', Equ: '小马座',
            Eri: '波江座', For: '天炉座', Gem: '双子座', Gru: '天鹤座', Her: '武仙座',
            Hor: '时钟座', Hya: '长蛇座', Hyi: '水蛇座', Ind: '印第安座', Lac: '蝎虎座',
            Leo: '狮子座', Lep: '天兔座', Lib: '天秤座', LMi: '小狮座', Lup: '豺狼座',
            Lyn: '天猫座', Lyr: '天琴座', Men: '山案座', Mic: '显微镜座', Mon: '麒麟座',
            Mus: '苍蝇座', Nor: '矩尺座', Oct: '南极座', Oph: '蛇夫座', Ori: '猎户座',
            Pav: '孔雀座', Peg: '飞马座', Per: '英仙座', Phe: '凤凰座', Pic: '绘架座',
            PsA: '南鱼座', Psc: '双鱼座', Pup: '船尾座', Pyx: '罗盘座', Ret: '网罟座',
            Scl: '玉夫座', Sco: '天蝎座', Sct: '盾牌座', Ser: '巨蛇座', Sex: '六分仪座',
            Sge: '天箭座', Sgr: '人马座', Tau: '金牛座', Tel: '望远镜座', TrA: '南三角座',
            Tri: '三角座', Tuc: '杜鹃座', UMa: '大熊座', UMi: '小熊座', Vel: '船帆座',
            Vir: '室女座', Vol: '飞鱼座', Vul: '狐狸座'
        };
        const starMap = window._hygStarMap;
        Object.entries(state.constellations).forEach(function(entry) {
            var abbr = entry[0], def = entry[1];
            if (!def.stars) return;
            var cx = 0, cy = 0, cz = 0, cnt = 0;
            def.stars.forEach(function(hr) {
                var s = starMap ? starMap.get(hr) : null;
                if (s && s.x !== undefined
                    && (is2d ? _inHemisphere(s.y) : true)
                    && (isObserve ? starAltAz(s.x, s.y, s.z, _observeLstCache, observeParams.lat).alt > 0 : true)) {
                    cx += s.x; cy += s.y; cz += s.z; cnt++;
                }
            });
            if (cnt === 0) return;
            cx /= cnt; cy /= cnt; cz /= cnt;

            var wp2;
            if (is2d) {
                var p2 = projectTo2D(cx, cy, cz);
                wp2 = new THREE.Vector3(p2.x, 0, p2.z).applyEuler(new THREE.Euler(0, currentRotation.y, 0));
            } else {
                wp2 = new THREE.Vector3(cx, cy, cz)
                    .applyEuler(new THREE.Euler(currentRotation.x, currentRotation.y, currentRotation.z));
            }
            var proj2 = wp2.clone().project(camera);
            if (proj2.z > 1 || proj2.z < 0) return;

            var rect2 = document.getElementById('canvas-container').getBoundingClientRect();
            var sx2 = (proj2.x * 0.5 + 0.5) * rect2.width;
            var sy2 = (-proj2.y * 0.5 + 0.5) * rect2.height;
            var dist2 = wp2.length();
            var opacity2 = is2d ? 0.7 : Math.max(0.15, Math.min(0.85, 600 / dist2));

            var label2 = document.createElement('div');
            label2.style.cssText = 'position: absolute; left: ' + sx2 + 'px; top: ' + sy2 + 'px; ' +
                'color: rgba(255,215,0,' + opacity2 + '); ' +
                'font-size: ' + (12 + opacity2 * 5) + 'px; ' +
                'transform: translate(-50%, -50%); white-space: nowrap; ' +
                'text-shadow: 0 0 8px rgba(255,215,0,0.4); pointer-events: none;';
            label2.textContent = constNames[abbr] || abbr;
            labelContainer.appendChild(label2);
        });
    }

    // 二十八宿标签（星象频道专属：古人的天区划分）
    if (state.channel === 'culture' && state.chineseAsterisms && state.chineseAsterisms.lunar_mansions) {
        const starMap = window._hygStarMap;
        const rect = document.getElementById('canvas-container').getBoundingClientRect();
        state.chineseAsterisms.lunar_mansions.forEach(mansion => {
            const s = starMap.get(mansion.hr);
            if (!s) return;
            let wp;
            if (is2d) {
                if (!_inHemisphere(s.y)) return;
                const p = projectTo2D(s.x, s.y, s.z);
                wp = new THREE.Vector3(p.x, 0, p.z).applyEuler(new THREE.Euler(0, currentRotation.y, 0));
            } else if (isObserve) {
                const { alt } = starAltAz(s.x, s.y, s.z, _observeLstCache, observeParams.lat);
                if (alt <= 0) return;
                wp = new THREE.Vector3(s.x, s.y, s.z);
            } else {
                wp = new THREE.Vector3(s.x, s.y, s.z)
                    .applyEuler(new THREE.Euler(currentRotation.x, currentRotation.y, currentRotation.z));
            }
            const proj = wp.clone().project(camera);
            if (proj.z > 1 || proj.z < 0) return;
            const sx = (proj.x * 0.5 + 0.5) * rect.width;
            const sy = (-proj.y * 0.5 + 0.5) * rect.height;
            const ml = document.createElement('div');
            ml.className = 'mansion-label';
            ml.textContent = mansion.name;
            ml.style.left = sx + 'px';
            ml.style.top = sy + 'px';
            labelContainer.appendChild(ml);
        });
    }
}
// 流星系统
let meteors = [];

function spawnMeteor() {
    const skyR = 800;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1); // 全球面
    const sx = skyR * Math.sin(phi) * Math.cos(theta);
    const sy = skyR * Math.cos(phi);
    const sz = -skyR * Math.sin(phi) * Math.sin(theta);
    const len = 30 + Math.random() * 60;
    const pts = [new THREE.Vector3(sx, sy, sz), new THREE.Vector3(
        sx + (Math.random() - 0.5) * len,
        sy - Math.random() * len,
        sz + (Math.random() - 0.5) * len * 0.3
    )];
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const m = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending });
    const line = new THREE.Line(g, m);
    line.userData = { life: 1, decay: 0.008 + Math.random() * 0.025 };
    skyGroup.add(line);
    meteors.push(line);
}

function updateMeteors() {
    for (let i = meteors.length - 1; i >= 0; i--) {
        const m = meteors[i];
        m.userData.life -= m.userData.decay;
        m.material.opacity = m.userData.life;
        if (m.userData.life <= 0) { skyGroup.remove(m); m.geometry.dispose(); m.material.dispose(); meteors.splice(i, 1); }
    }
    // 2D 星图以清晰为准，不播流星
    if (Math.random() < 0.03 && state.viewMode === '3d') spawnMeteor();
}

/** 清空流星（切换 2D 视图时调用） */
function clearMeteors() {
    meteors.forEach(m => {
        skyGroup.remove(m);
        if (m.geometry) m.geometry.dispose();
        if (m.material) m.material.dispose();
    });
    meteors = [];
}

// 银河（已弃用，保留代码但不调用）
let milkyWayPoints = null;

/** 银道坐标 → 场景坐标（r 为半径）。已验证：银心(l=0,b=0)指向人马座，银道面与赤道倾角 60° */
function _galacticToScene(lDeg, bDeg, r) {
    const NGP_RA = 192.85948 * Math.PI / 180;
    const NGP_DEC = 27.12825 * Math.PI / 180;
    const L_OMEGA = 32.93192 * Math.PI / 180;
    const l = lDeg * Math.PI / 180;
    const b = bDeg * Math.PI / 180;
    const sinDec = Math.sin(b) * Math.sin(NGP_DEC) + Math.cos(b) * Math.cos(NGP_DEC) * Math.sin(l - L_OMEGA);
    const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
    const yG = Math.cos(b) * Math.cos(l - L_OMEGA);
    const xG = Math.sin(b) * Math.cos(NGP_DEC) - Math.cos(b) * Math.sin(NGP_DEC) * Math.sin(l - L_OMEGA);
    const ra = (Math.atan2(yG, xG) + NGP_RA) % (2 * Math.PI);
    // 场景坐标（与 HYG 约定一致：ra=atan2(pz,-px)，dec=asin(py/r)）
    const cd = Math.cos(dec);
    return new THREE.Vector3(-r * cd * Math.cos(ra), r * Math.sin(dec), r * cd * Math.sin(ra));
}

function createMilkyWay() {
    const count = 3500;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const skyRadius = 820;

    for (let i = 0; i < count; i++) {
        // 银道坐标：l 均匀，b 集中在银道面 ±12°（越靠近银道面越密）
        const l = Math.random() * 360;
        const b = (Math.random() - 0.5) * 24;
        // 银心方向（l≈0）更亮更密：越靠近银心亮度越高
        const towardCenter = Math.exp(-Math.min(Math.abs(l), 360 - Math.abs(l)) / 60);
        const r = skyRadius + (Math.random() - 0.5) * 80;
        const v = _galacticToScene(l, b, r);
        positions[i * 3] = v.x;
        positions[i * 3 + 1] = v.y;
        positions[i * 3 + 2] = v.z;

        const glow = 0.35 + 0.5 * towardCenter;
        colors[i * 3] = 0.5 * glow + Math.random() * 0.2;
        colors[i * 3 + 1] = 0.55 * glow + Math.random() * 0.2;
        colors[i * 3 + 2] = 0.75 * glow + Math.random() * 0.2;
        sizes[i] = Math.random() * 1.3 + 0.2;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
        size: 1.3,
        vertexColors: true,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
        depthTest: false
    });

    milkyWayPoints = new THREE.Points(geometry, material);
    skyGroup.add(milkyWayPoints);
}

// ==================== 深空天体（DSO） ====================
let dsoSprites = [];  // 深空天体标记（Sprite）

/** 生成 DSO 类型标记贴图（canvas 程序化示意图）：
 * galaxy 旋臂椭圆 / nebula 云斑 / planetary 圆环 / open 散点 / globular 密集星点 */
const DSO_TEXTURES = {};
function _dsoTexture(type, color) {
    if (DSO_TEXTURES[type]) return DSO_TEXTURES[type];
    const c = document.createElement('canvas');
    c.width = 96; c.height = 96;
    const ctx = c.getContext('2d');
    const rgba = color.match(/[\d.]+/g);
    const R = rgba[0], G = rgba[1], B = rgba[2];

    if (type === 'galaxy') {
        // 椭圆旋臂渐晕
        const g = ctx.createRadialGradient(48, 48, 4, 48, 48, 42);
        g.addColorStop(0, `rgba(${R}, ${G}, ${B}, 0.9)`);
        g.addColorStop(0.5, `rgba(${R}, ${G}, ${B}, 0.4)`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(48, 48, 42, 26, -0.3, 0, Math.PI * 2);
        ctx.fill();
        // 明亮核
        const core = ctx.createRadialGradient(48, 48, 0, 48, 48, 10);
        core.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
        core.addColorStop(1, `rgba(${R}, ${G}, ${B}, 0)`);
        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(48, 48, 10, 0, Math.PI * 2);
        ctx.fill();
    } else if (type === 'nebula') {
        // 不规则云斑
        for (let i = 0; i < 14; i++) {
            const x = 30 + Math.random() * 36, y = 30 + Math.random() * 36;
            const r = 8 + Math.random() * 16;
            const a = 0.12 + Math.random() * 0.25;
            const g = ctx.createRadialGradient(x, y, 1, x, y, r);
            g.addColorStop(0, `rgba(${R}, ${G}, ${B}, ${a})`);
            g.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
        }
        // 中心亮斑
        const core = ctx.createRadialGradient(48, 48, 0, 48, 48, 10);
        core.addColorStop(0, 'rgba(255, 255, 255, 0.85)');
        core.addColorStop(1, `rgba(${R}, ${G}, ${B}, 0)`);
        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(48, 48, 10, 0, Math.PI * 2);
        ctx.fill();
    } else if (type === 'planetary') {
        // 行星状星云：亮核 + 圆环
        const g = ctx.createRadialGradient(48, 48, 2, 48, 48, 24);
        g.addColorStop(0, `rgba(${R}, ${G}, ${B}, 0.9)`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(48, 48, 24, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(${R}, ${G}, ${B}, 0.8)`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(48, 48, 18, 0, Math.PI * 2);
        ctx.stroke();
    } else if (type === 'globular') {
        // 密集星点（球状星团）
        const g = ctx.createRadialGradient(48, 48, 1, 48, 48, 40);
        g.addColorStop(0, `rgba(${R}, ${G}, ${B}, 0.95)`);
        g.addColorStop(0.6, `rgba(${R}, ${G}, ${B}, 0.4)`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 96, 96);
        for (let i = 0; i < 40; i++) {
            const ang = Math.random() * Math.PI * 2;
            const rad = Math.sqrt(Math.random()) * 32;
            ctx.fillStyle = `rgba(255, 245, 220, ${0.5 + Math.random() * 0.5})`;
            ctx.beginPath();
            ctx.arc(48 + Math.cos(ang) * rad, 48 + Math.sin(ang) * rad, 1 + Math.random() * 1.5, 0, Math.PI * 2);
            ctx.fill();
        }
    } else {
        // open：稀疏散点
        for (let i = 0; i < 12; i++) {
            const ang = Math.random() * Math.PI * 2;
            const rad = Math.sqrt(Math.random()) * 30;
            ctx.fillStyle = `rgba(235, 245, 255, ${0.5 + Math.random() * 0.5})`;
            ctx.beginPath();
            ctx.arc(48 + Math.cos(ang) * rad, 48 + Math.sin(ang) * rad, 1.5 + Math.random() * 1.5, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    DSO_TEXTURES[type] = new THREE.CanvasTexture(c);
    return DSO_TEXTURES[type];
}

/** 构建深空天体标记（3D 球面坐标；观星模式过滤地平上；星象频道由 updateChannelView 控制隐藏） */
function buildDsoMarkers() {
    dsoSprites.forEach(s => { skyGroup.remove(s); });
    dsoSprites = [];
    if (!state.dsos || !state.dsos.length) return;
    const isObserve = state.viewMode === 'observe';
    const TYPE_COLORS = {
        galaxy: 'rgba(140, 190, 255, 0.9)',
        nebula: 'rgba(255, 140, 160, 0.9)',
        planetary: 'rgba(140, 255, 180, 0.9)',
        open: 'rgba(220, 240, 255, 0.9)',
        globular: 'rgba(255, 215, 120, 0.9)'
    };
    state.dsos.forEach(dso => {
        const ra = dso.ra * Math.PI / 180;
        const dec = dso.dec * Math.PI / 180;
        const unit = new THREE.Vector3(-Math.cos(dec) * Math.cos(ra), Math.sin(dec), Math.cos(dec) * Math.sin(ra));
        if (isObserve) {
            const { alt } = starAltAz(unit.x * 200, unit.y * 200, unit.z * 200, _observeLstCache, observeParams.lat);
            if (alt <= 0) return; // 地平以下不显示
        }
        const r = 210; // 略高于星面
        const pos = unit.clone().multiplyScalar(r);
        const mat = new THREE.SpriteMaterial({
            map: _dsoTexture(dso.type, TYPE_COLORS[dso.type] || 'rgba(255,255,255,0.9)'),
            transparent: true,
            opacity: 0.9,
            depthTest: false
        });
        const sprite = new THREE.Sprite(mat);
        sprite.position.copy(pos);
        // 大小按星等：亮的天体标记大些
        const scale = Math.max(6, Math.min(14, 11 - (dso.mag || 8)));
        sprite.scale.set(scale, scale, 1);
        sprite.userData.dso = dso;
        skyGroup.add(sprite);
        dsoSprites.push(sprite);
    });
}

/** 清理深空天体标记 */
function clearDsoMarkers() {
    dsoSprites.forEach(s => skyGroup.remove(s));
    dsoSprites = [];
}

// ==================== 行星实时位置（简化开普勒轨道，Meeus 第 25 章） ====================
// 已验证：2026-08 土星在双鱼座、木星在巨蟹/狮子边界、金星黄昏室女座，与天文常识吻合
const PLANET_ELEM = {
    "水星": { a: 0.38710, e: 0.20563, i: 7.005, O: 48.331, w: 77.456, L0: 252.251, Ld: 149472.6747, color: 'rgba(200, 205, 210, 0.95)', mag: 0.5 },
    "金星": { a: 0.72333, e: 0.00677, i: 3.395, O: 76.680, w: 131.564, L0: 181.980, Ld: 58517.8157, color: 'rgba(240, 230, 200, 0.95)', mag: -4.2 },
    "火星": { a: 1.52368, e: 0.09340, i: 1.850, O: 49.558, w: 336.060, L0: 355.433, Ld: 19140.2993, color: 'rgba(230, 120, 90, 0.95)', mag: -1.2 },
    "木星": { a: 5.20260, e: 0.04849, i: 1.303, O: 100.464, w: 14.331, L0: 34.351, Ld: 3034.9057, color: 'rgba(235, 200, 150, 0.95)', mag: -2.4 },
    "土星": { a: 9.55491, e: 0.05555, i: 2.489, O: 113.666, w: 93.057, L0: 50.077, Ld: 1222.1138, color: 'rgba(225, 205, 160, 0.95)', mag: 0.6 },
    "天王星": { a: 19.21845, e: 0.04630, i: 0.773, O: 74.006, w: 173.005, L0: 314.055, Ld: 428.4670, color: 'rgba(170, 220, 230, 0.95)', mag: 5.7 }
};
let planetSprites = [];  // 行星标记

/** 行星日心黄道坐标（AU） */
function _planetHelio(elem, T) {
    const L = (elem.L0 + elem.Ld * T) % 360 * Math.PI / 180;
    const w = elem.w * Math.PI / 180;
    const O = elem.O * Math.PI / 180;
    const i = elem.i * Math.PI / 180;
    const M = (L - w + Math.PI * 2) % (Math.PI * 2);
    let E = M;
    for (let k = 0; k < 8; k++) E = M + elem.e * Math.sin(E);
    const xv = elem.a * (Math.cos(E) - elem.e);
    const yv = elem.a * Math.sqrt(1 - elem.e * elem.e) * Math.sin(E);
    const om = w - O;
    const cO = Math.cos(O), sO = Math.sin(O), cw = Math.cos(om), sw = Math.sin(om), ci = Math.cos(i), si = Math.sin(i);
    return [
        (cO * cw - sO * sw * ci) * xv + (-cO * sw - sO * cw * ci) * yv,
        (sO * cw + cO * sw * ci) * xv + (-sO * sw + cO * cw * ci) * yv,
        (sw * si) * xv + (cw * si) * yv
    ];
}

/** 行星地心赤道坐标（RA/Dec 度 + 距地 AU） */
function _planetRaDec(elem, T) {
    const EARTH = { a: 1.0, e: 0.01671, i: 0.0, O: 0.0, w: 102.937, L0: 100.464, Ld: 35999.3729 };
    const [xh, yh, zh] = _planetHelio(elem, T);
    const [xe, ye, ze] = _planetHelio(EARTH, T);
    const xg = xh - xe, yg = yh - ye, zg = zh - ze;
    const lam = Math.atan2(yg, xg);
    const beta = Math.atan2(zg, Math.sqrt(xg * xg + yg * yg));
    const eps = 23.4393 * Math.PI / 180;
    const ra = (Math.atan2(Math.sin(lam) * Math.cos(eps) - Math.tan(beta) * Math.sin(eps), Math.cos(lam)) * 180 / Math.PI + 360) % 360;
    const dec = Math.asin(Math.sin(beta) * Math.cos(eps) + Math.cos(beta) * Math.sin(eps) * Math.sin(lam)) * 180 / Math.PI;
    return { ra, dec, dist: Math.sqrt(xg * xg + yg * yg + zg * zg) };
}

/** 土星环贴图（canvas） */
const SATURN_TEX = (function () {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.strokeStyle = 'rgba(215, 195, 150, 0.85)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(32, 32, 26, 8, -0.35, 0, Math.PI * 2);
    ctx.stroke();
    return new THREE.CanvasTexture(c);
})();

/** 构建行星标记（观星/3D 模式；地平上才显示；五行星古人可见，两频道都保留） */
function buildPlanetMarkers() {
    planetSprites.forEach(s => skyGroup.remove(s));
    planetSprites = [];
    const now = new Date();
    const jd = _toJulianDay(now.getFullYear(), now.getMonth() + 1, now.getDate(), 13); // 21:00 UTC+8
    const T = (jd - 2451545.0) / 36525;
    const isObserve = state.viewMode === 'observe';
    Object.entries(PLANET_ELEM).forEach(([name, elem]) => {
        const { ra, dec, dist } = _planetRaDec(elem, T);
        const raR = ra * Math.PI / 180, decR = dec * Math.PI / 180;
        const unit = new THREE.Vector3(-Math.cos(decR) * Math.cos(raR), Math.sin(decR), Math.cos(decR) * Math.sin(raR));
        if (isObserve) {
            const { alt } = starAltAz(unit.x * 200, unit.y * 200, unit.z * 200, _observeLstCache, observeParams.lat);
            if (alt <= 0) return; // 地平以下不显示
        }
        const pos = unit.clone().multiplyScalar(212); // 比 DSO 再高一点
        const map = name === '土星' ? SATURN_TEX : _dsoTexture('planet_' + name, elem.color);
        const mat = new THREE.SpriteMaterial({ map, transparent: true, depthTest: false });
        const sprite = new THREE.Sprite(mat);
        sprite.position.copy(pos);
        const scale = name === '木星' ? 12 : (name === '金星' || name === '火星' ? 10 : 8);
        sprite.scale.set(scale, scale, 1);
        sprite.userData.planet = { name, dist, mag: elem.mag };
        skyGroup.add(sprite);
        planetSprites.push(sprite);
    });
}

function clearPlanetMarkers() {
    planetSprites.forEach(s => skyGroup.remove(s));
    planetSprites = [];
}

/** 行星信息卡 */
function showPlanetInfo(p) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay overlay-top';
    overlay.innerHTML = `
        <div class="modal-card card-anomaly" role="dialog" aria-modal="true" aria-label="行星">
            <div class="modal-icon">🪐</div>
            <div class="modal-kicker kicker-science">行星（太阳系）</div>
            <div class="modal-title" style="color: var(--science-strong);">${p.name}</div>
            <div class="modal-body">
                距地距离：${p.dist.toFixed(2)} AU（${(p.dist * 1.496).toFixed(0)} 亿公里）<br>
                视星等：${p.mag}
            </div>
            <div class="modal-actions">
                <button class="btn btn-science" onclick="this.closest('.modal-overlay').remove()">关闭</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
}

// 湖泊及星光倒影
let lakePlane = null;
let reflectionPoints = null;

function createLakeAndReflection() {
    // 湖泊平面
    const lakeGeom = new THREE.PlaneGeometry(2000, 2000);
    const lakeMat = new THREE.MeshBasicMaterial({
        color: 0x0a1020,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide
    });
    lakePlane = new THREE.Mesh(lakeGeom, lakeMat);
    lakePlane.rotation.x = -Math.PI / 2;
    lakePlane.position.y = -400;
    scene.add(lakePlane);

    // 星光倒影：复制主星场翻转
    if (!starPoints) return;
    const srcGeom = starPoints.geometry;
    const posAttr = srcGeom.getAttribute('position');
    const colAttr = srcGeom.getAttribute('color');
    const count = Math.min(posAttr.count, 500);

    const refPositions = new Float32Array(count * 3);
    const refColors = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
        refPositions[i * 3] = posAttr.getX(i);
        refPositions[i * 3 + 1] = -400 - (posAttr.getY(i) + 400); // Flip below lake
        refPositions[i * 3 + 2] = posAttr.getZ(i);
        refColors[i * 3] = colAttr.getX(i) * 0.4;
        refColors[i * 3 + 1] = colAttr.getY(i) * 0.4;
        refColors[i * 3 + 2] = colAttr.getZ(i) * 0.4;
    }

    const refGeom = new THREE.BufferGeometry();
    refGeom.setAttribute('position', new THREE.BufferAttribute(refPositions, 3));
    refGeom.setAttribute('color', new THREE.BufferAttribute(refColors, 3));

    const refMat = new THREE.PointsMaterial({
        size: 1.5,
        vertexColors: true,
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true
    });

    reflectionPoints = new THREE.Points(refGeom, refMat);
    skyGroup.add(reflectionPoints);
}

// 前5亮星可见光光球
let brightStarOrbs = [];

function createBrightStarOrbs(starsData) {
    if (!starsData || starsData.length === 0) return;

    // 取所有亮星（星等<3），至少前20颗
    const sorted = [...starsData].sort((a, b) => (a.magnitude || 99) - (b.magnitude || 99));
    const bright = sorted.filter(s => (s.magnitude || 99) < 3);
    const targets = bright.length >= 10 ? bright : sorted.slice(0, 20);

    // 黑体辐射真实颜色映射
    const spectralColors = {
        'O': [0.61, 0.69, 1.0],    // 30000K+ 淡蓝
        'B': [0.67, 0.75, 1.0],    // 10000-30000K 蓝白
        'A': [0.78, 0.84, 1.0],    // 7500-10000K 白
        'F': [0.95, 0.93, 0.9],    // 6000-7500K 黄白
        'G': [1.0, 0.92, 0.72],    // 5000-6000K 黄 (太阳)
        'K': [1.0, 0.78, 0.45],    // 3500-5000K 橙
        'M': [1.0, 0.55, 0.3],     // 2400-3500K 红橙
    };

    targets.forEach(star => {
        if (!star._x) return;
        const spType = ((star.spectral || (star.ci < 0 ? 'B' : star.ci < 0.3 ? 'A' : star.ci < 0.5 ? 'F' : star.ci < 0.8 ? 'G' : star.ci < 1.4 ? 'K' : 'M'))[0]);
        const [cr, cg, cb] = spectralColors[spType] || [0.9, 0.9, 1.0];

        // 创建发光精灵
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');

        // 多层径向渐变模拟光球
        const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
        gradient.addColorStop(0, `rgba(${Math.floor(cr*255)},${Math.floor(cg*255)},${Math.floor(cb*255)},1)`);
        gradient.addColorStop(0.15, `rgba(${Math.floor(cr*255)},${Math.floor(cg*255)},${Math.floor(cb*255)},0.9)`);
        gradient.addColorStop(0.4, `rgba(${Math.floor(cr*200)},${Math.floor(cg*200)},${Math.floor(cb*255)},0.4)`);
        gradient.addColorStop(0.7, `rgba(${Math.floor(cr*100)},${Math.floor(cg*100)},${Math.floor(cb*200)},0.1)`);
        gradient.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 128, 128);

        const texture = new THREE.CanvasTexture(canvas);
        const spriteMat = new THREE.SpriteMaterial({
            map: texture,
            blending: THREE.AdditiveBlending,
            transparent: true,
            opacity: 0.85,
            depthWrite: false
        });
        const sprite = new THREE.Sprite(spriteMat);
        sprite.position.set(star._x, star._y, star._z);
        const scale = 15 + (2 - Math.min(star.magnitude || 2, 2)) * 10;
        sprite.scale.set(scale, scale, 1);
        sprite.userData = { starId: star.id, _origX: star._x, _origY: star._y, _origZ: star._z };

        skyGroup.add(sprite);
        brightStarOrbs.push(sprite);
    });
}

function setupEventListeners() {
    const container = document.getElementById('canvas-container');

    // 鼠标拖拽旋转
    container.addEventListener('mousedown', (e) => {
        isDragging = true;
        previousMouse = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('mouseup', () => {
        isDragging = false;
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        const deltaX = e.clientX - previousMouse.x;
        const deltaY = e.clientY - previousMouse.y;

        if (state.viewMode === 'observe') {
            // 地面观星：拖拽 = 转动视角（水平=方位角，垂直=仰角，像人转头看天）
            observeParams.az -= deltaX * 0.005;
            observeParams.alt -= deltaY * 0.005; // 向下拖 = 视线下移 = 仰角减小（看到地面）
            observeParams.alt = Math.max(-10 * Math.PI / 180, Math.min(90 * Math.PI / 180, observeParams.alt));
            observeFocusAnim = null;
        } else if (state.viewMode === '2d') {
            // 极投影图只绕极轴（Y）旋转：地图随手移动
            targetRotation.y -= deltaX * 0.004;
        } else {
            // 3D地球仪式旋转：水平拖拽绕Y轴，垂直拖拽绕X轴，对角拖拽带Z轴
            targetRotation.y += deltaX * 0.008;
            targetRotation.x += deltaY * 0.008;
            targetRotation.z += (deltaX * deltaY) * 0.00002;
        }

        previousMouse = { x: e.clientX, y: e.clientY };
    });

    // 滚轮缩放
    container.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (state.viewMode === 'observe') {
            // 视场调节（人眼视野 30-80°）
            observeParams.fov = Math.max(30, Math.min(80, observeParams.fov + (e.deltaY > 0 ? 2 : -2)));
            camera.fov = observeParams.fov;
            camera.updateProjectionMatrix();
            return;
        }
        if (state.viewMode !== '3d') {
            if (orthoCamera) {
                orthoCamera.zoom = Math.max(0.7, Math.min(4, orthoCamera.zoom + (e.deltaY > 0 ? -0.06 : 0.06)));
                orthoCamera.updateProjectionMatrix();
            }
            return;
        }
        if (focusTarget && focusProgress >= 1) {
            // 聚焦模式下：缩放相机与目标星的距离
            focusDistance += e.deltaY * 0.3;
            focusDistance = Math.max(50, Math.min(600, focusDistance));
        } else {
            camera.position.z += e.deltaY * 0.5;
            camera.position.z = Math.max(30, Math.min(3000, camera.position.z));
        }
    });

    // 点击选择星辰
    container.addEventListener('click', (e) => {
        if (isDragging) return;

        const rect = container.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(mouse, camera);
        // 行星优先命中（太阳系天体），其次深空天体（观星/3D 模式）
        if (planetSprites.length > 0) {
            const planetHits = raycaster.intersectObjects(planetSprites);
            if (planetHits.length > 0) {
                showPlanetInfo(planetHits[0].object.userData.planet);
                return;
            }
        }
        if (dsoSprites.length > 0) {
            const dsoHits = raycaster.intersectObjects(dsoSprites);
            if (dsoHits.length > 0) {
                const dso = dsoHits[0].object.userData.dso;
                showDsoInfo(dso);
                return;
            }
        }
        const intersects = raycaster.intersectObject(starPoints);

        if (intersects.length > 0) {
            const point = intersects[0].point.clone();
            // 将世界坐标交点转为本地坐标（抵消skyGroup旋转）
            const invMatrix = new THREE.Matrix4().makeRotationFromEuler(skyGroup.rotation).invert();
            point.applyMatrix4(invMatrix);

            // 查找最近的恒星（2D/今晚：投影平面距离；3D：空间距离）
            let nearestStar = null;
            let minDist = Infinity;
            const is2d = state.viewMode === '2d';

            for (let i = 0; i < state.starCatalog.length; i++) {
                const star = state.starCatalog[i];
                if (star._x === undefined) continue;
                if (is2d && !_inHemisphere(star._y)) continue;
                let dist;
                if (is2d) {
                    const p = projectTo2D(star._x, star._y, star._z);
                    const dx = point.x - p.x;
                    const dz = point.z - p.z;
                    dist = Math.sqrt(dx * dx + dz * dz);
                } else {
                    const dx = point.x - star._x;
                    const dy = point.y - star._y;
                    const dz = point.z - star._z;
                    dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
                }
                if (dist < minDist) {
                    minDist = dist;
                    nearestStar = star;
                }
            }

            console.log('click detect:', nearestStar?.name_cn, 'dist:', minDist?.toFixed(1));

            if (nearestStar && (is2d ? minDist < 20 : minDist < 50)) {
                console.log('选中星辰:', nearestStar.name_cn, nearestStar.name_en);
                // 记录当前星辰
                state.currentStar = nearestStar;
                // 显示星辰信息
                showStarInfo(nearestStar);
                // 聚焦动画 - 时光隧道效果
                focusOnStar(nearestStar);
                // 自动搜索该星辰
                const searchInput = document.getElementById('star-search');
                searchInput.value = nearestStar.name_cn;
                document.getElementById('send-btn').click();
            }
        }
    });

    // 频道切换（科学/星象：连线、色调、迷雾、横幅、导师高亮整体切换）
    document.querySelectorAll('.channel-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.channel-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.channel = btn.dataset.channel;
            // 频道切换时双极罗盘归位到对应端（科学=0 蓝 / 星象=100 金）
            state.bipolarValue = btn.dataset.channel === 'culture' ? 100 : 0;
            const slider = document.getElementById('bipolar-slider');
            if (slider) slider.value = state.bipolarValue;
            updateChannelView();
        });
    });

    // 双极调节杆
    document.getElementById('bipolar-slider').addEventListener('input', (e) => {
        state.bipolarValue = parseInt(e.target.value);
        updateBipolarView();
    });

    // 窗口大小变化
    window.addEventListener('resize', () => {
        const container = document.getElementById('canvas-container');
        const width = container.clientWidth;
        const height = container.clientHeight;

        if (state.viewMode === '3d' || state.viewMode === 'observe') {
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
        } else {
            update2DCamera();
        }
        renderer.setSize(width, height);
        composer.setSize(width, height);
    });

    // 2D/3D 视图切换（observe 模式下点击返回 2D 主视图）
    const viewToggleBtn = document.getElementById('view-toggle-btn');
    if (viewToggleBtn) {
        viewToggleBtn.addEventListener('click', () => {
            if (state.viewMode === 'observe') { setViewMode('2d'); return; }
            setViewMode(state.viewMode === '2d' ? '3d' : '2d');
        });
    }

    // 背景音乐开关
    const bgmToggleBtn = document.getElementById('bgm-toggle-btn');
    if (bgmToggleBtn) {
        bgmToggleBtn.addEventListener('click', toggleBgm);
        updateBgmButton();
    }

    // ---- 地面观星 ----
    const observeBtn = document.getElementById('observe-btn');
    const observeSettings = document.getElementById('observe-settings');
    if (observeBtn && observeSettings) {
        observeBtn.addEventListener('click', () => {
            if (state.viewMode !== 'observe') {
                setViewMode('observe');
            } else {
                observeSettings.style.display = 'block';
            }
        });
    }

    // 观星面板：填充场景下拉
    const observeSiteSel = document.getElementById('observe-site');
    if (observeSiteSel) {
        observeSiteSel.innerHTML = '';
        OBSERVE_SITES.forEach((s, i) => {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = s.name;
            observeSiteSel.appendChild(opt);
        });
        observeSiteSel.value = String(observeParams.site);
        const descEl = document.getElementById('observe-site-desc');
        if (descEl) descEl.textContent = OBSERVE_SITES[observeParams.site].desc;
        observeSiteSel.addEventListener('change', () => {
            const site = OBSERVE_SITES[parseInt(observeSiteSel.value, 10)];
            if (descEl) descEl.textContent = site.desc;
            const latInput = document.getElementById('observe-lat');
            if (latInput) {
                latInput.value = String(site.lat);
                const latVal = document.getElementById('observe-lat-val');
                if (latVal) latVal.textContent = `${site.lat.toFixed(1)}°`;
            }
        });
    }

    // 纬度 / 视场滑块联动显示
    const latInput = document.getElementById('observe-lat');
    if (latInput) {
        latInput.value = String(observeParams.lat);
        const latVal = document.getElementById('observe-lat-val');
        if (latVal) latVal.textContent = `${observeParams.lat.toFixed(1)}°`;
        latInput.addEventListener('input', () => {
            if (latVal) latVal.textContent = `${parseFloat(latInput.value).toFixed(1)}°`;
        });
    }
    const fovInput = document.getElementById('observe-fov');
    if (fovInput) {
        fovInput.value = String(observeParams.fov);
        const fovVal = document.getElementById('observe-fov-val');
        if (fovVal) fovVal.textContent = `${observeParams.fov}°`;
        fovInput.addEventListener('input', () => {
            if (fovVal) fovVal.textContent = `${fovInput.value}°`;
        });
    }

    // 应用观星设置：重建星场/地平圈/连线，进入或刷新观星模式
    const observeApply = document.getElementById('observe-apply');
    if (observeApply && observeSettings) {
        observeApply.addEventListener('click', () => {
            const siteIdx = parseInt(observeSiteSel.value, 10);
            const site = OBSERVE_SITES[siteIdx] || OBSERVE_SITES[1];
            observeParams.site = siteIdx;
            observeParams.lat = latInput ? parseFloat(latInput.value) : site.lat;
            observeParams.lon = site.lon;
            observeParams.fov = fovInput ? parseInt(fovInput.value, 10) : 60;
            observeParams.az = 0; // 切换场景重置视角朝北
            observeParams.alt = 40 * Math.PI / 180;
            observeFocusAnim = null;
            if (camera && state.viewMode === 'observe') {
                camera.fov = observeParams.fov;
                camera.updateProjectionMatrix();
            }
            observeSettings.style.display = 'none';
            if (state.viewMode === 'observe') {
                // 原地刷新：重建星场/地平圈/连线/地面
                _observeLstCache = _observeLstDeg();
                if (starPoints) {
                    const old = starPoints.geometry;
                    starPoints.geometry = buildObserveStarGeometry();
                    old.dispose();
                }
                createConstellationLines();
                buildChineseAsterismLines();
                buildObserveHorizon();
                buildObserveGround();
                updateFogState();
            } else {
                setViewMode('observe');
            }
        });
    }

    // 南北天极切换（仅 2D）
    const hemisphereBtn = document.getElementById('hemisphere-btn');
    if (hemisphereBtn) {
        hemisphereBtn.addEventListener('click', () => {
            if (state.viewMode === '2d') switchHemisphere();
        });
    }
}

function updateChannelView() {
    const isCulture = state.channel === 'culture';

    // 连线显隐：科学频道=IAU 星座蓝线；星象频道=中国星官金线
    constellationLines.forEach(line => {
        line.material.color.setHex(isCulture ? 0xffd700 : 0x4a9eff);
        line.material.opacity = isCulture ? 0 : 0.5;
    });
    chineseAsterismLines.forEach(line => {
        line.material.color.setHex(0xffd700);
        line.material.opacity = isCulture ? 0.65 : 0;
    });

    // 星点整体色调：科学冷白蓝 / 星象暖白金
    if (window._starShaderMaterial && window._starShaderMaterial.uniforms.uChannelTint) {
        window._starShaderMaterial.uniforms.uChannelTint.value.set(
            isCulture ? 1.12 : 0.95,
            isCulture ? 1.02 : 0.98,
            isCulture ? 0.85 : 1.15
        );
    }

    // 星象频道只保留古人可见的亮星（mag < 4.5），剔除现代望远镜才发现的大量暗星
    if (window._starShaderMaterial && window._starShaderMaterial.uniforms.starMinBrightnes) {
        window._starShaderMaterial.uniforms.starMinBrightnes.value = isCulture ? 4.5 : 6.5;
    }

    // 星象频道隐藏深空天体（古人无望远镜，看不到星云星系）
    dsoSprites.forEach(s => { s.visible = !isCulture; });

    // 认知迷雾颜色：科学深蓝 / 星象暗金
    if (fogMesh && fogMesh.material.uniforms.uFogColor) {
        fogMesh.material.uniforms.uFogColor.value.setHex(isCulture ? 0x17100a : 0x0a0e1c);
    }

    // 频道横幅
    const banner = document.getElementById('channel-banner');
    if (banner) {
        banner.textContent = isCulture ? '✦ 太史令 · 甘德的星象' : '✦ 科学官 · 开普勒的视角';
        banner.className = 'channel-banner ' + (isCulture ? 'culture' : 'science');
    }

    // 导师面板高亮（身份可视化）
    const sciPanel = document.querySelector('.science-panel');
    const culPanel = document.querySelector('.culture-panel');
    if (sciPanel) sciPanel.classList.toggle('channel-active', !isCulture);
    if (culPanel) culPanel.classList.toggle('channel-active', isCulture);
}

function updateBipolarView() {
    const t = state.bipolarValue / 100; // 0=纯科学蓝, 0.5=融合, 1=纯星象金
    const isBalanced = Math.abs(t - 0.5) < 0.08;

    // IAU 星座连线：蓝色，科学端（t 小）越明显
    constellationLines.forEach(line => {
        const opacity = Math.max(0, 0.5 - t * 0.5);
        line.material.color.setRGB(0.29, 0.62, 1);
        line.material.opacity = opacity;
    });

    // 中国星官连线：金色，星象端（t 大）越明显
    chineseAsterismLines.forEach(line => {
        const opacity = Math.max(0, 0.65 * t);
        line.material.color.setRGB(1, 0.84, 0);
        line.material.opacity = opacity;
    });

    // 双极标签发光反馈
    const scienceLabel = document.getElementById('bipolar-science-label');
    const cultureLabel = document.getElementById('bipolar-culture-label');
    const control = document.getElementById('bipolar-control');
    if (scienceLabel && cultureLabel && control) {
        scienceLabel.classList.toggle('active', t < 0.42);
        cultureLabel.classList.toggle('active', t > 0.58);
        scienceLabel.classList.toggle('balanced', isBalanced);
        cultureLabel.classList.toggle('balanced', isBalanced);
        control.classList.toggle('balanced', isBalanced);
    }

    // 平衡时给滑块thumb加一个金色辉光提示
    const slider = document.getElementById('bipolar-slider');
    if (slider) {
        slider.style.boxShadow = isBalanced
            ? '0 0 18px rgba(255, 215, 0, 0.9), inset 0 0 8px rgba(255, 215, 0, 0.5)'
            : 'none';
    }
}

// 闪烁星光层
let twinklePoints = null;
let twinklePhases = null;

function animate() {
    requestAnimationFrame(animate);

    // 3D：默认自动旋转（北半球：自东向西，绕北极星）；2D 星图固定便于对照夜空
    if (state.viewMode === '3d' && !isDragging) {
        targetRotation.y -= 0.002;  // 负Y=顺时针=东→西
        targetRotation.x += 0.0003;
        targetRotation.z += 0.0002;
    }

    // 平滑旋转（2D/观星聚焦动画期间直接控制 Y，跳过平滑插值）
    if (state.viewMode === '3d') {
        currentRotation.x += (targetRotation.x - currentRotation.x) * 0.05;
        currentRotation.z += (targetRotation.z - currentRotation.z) * 0.05;
    } else if (state.viewMode === 'observe') {
        // 地面观星：相机自身转向，旋转保持归零
        currentRotation.x = 0;
        currentRotation.y = 0;
        currentRotation.z = 0;
    } else {
        currentRotation.x = 0;
        currentRotation.z = 0;
    }
    if (!(state.viewMode !== '3d' && focus2DAnim)) {
        currentRotation.y += (targetRotation.y - currentRotation.y) * 0.05;
    }

    // 2D/今晚聚焦动画：2D 转星到屏幕上方 + 缩放；今晚仅缩放
    if (state.viewMode !== '3d' && focus2DAnim) {
        const a = focus2DAnim;
        const t = Math.min(1, (Date.now() - a.startTime) / a.duration);
        const ease = easeInOutCubic(t);
        currentRotation.y = a.startY + (a.targetY - a.startY) * ease;
        if (orthoCamera) {
            orthoCamera.zoom = a.startZoom + (1.5 - a.startZoom) * ease;
            orthoCamera.updateProjectionMatrix();
        }
        if (t >= 1) focus2DAnim = null;
    }

    // skyGroup 绕原点旋转（3D 三轴立体感 / 2D 仅绕极轴 / 今晚与观星固定）
    if (skyGroup) {
        if (state.viewMode === '3d') {
            skyGroup.rotation.set(currentRotation.x, currentRotation.y, currentRotation.z);
        } else if (state.viewMode === '2d') {
            skyGroup.rotation.set(0, currentRotation.y, 0);
        } else {
            skyGroup.rotation.set(0, 0, 0);
        }
    }

    // 地面观星：球心相机朝向 (方位角, 仰角)，聚焦动画平滑转动
    if (state.viewMode === 'observe') {
        if (observeFocusAnim) {
            const a = observeFocusAnim;
            const t = Math.min(1, (Date.now() - a.startTime) / a.duration);
            const ease = easeInOutCubic(t);
            observeParams.az = a.startAz + (a.targetAz - a.startAz) * ease;
            observeParams.alt = a.startAlt + (a.targetAlt - a.startAlt) * ease;
            if (t >= 1) observeFocusAnim = null;
        }
        const latRad = observeParams.lat * Math.PI / 180;
        const dir = _observeDir(observeParams.az, observeParams.alt, latRad);
        const { z } = _observeAxes(latRad);
        // 画面上方 = 观测者天顶方向（lat=0 且看向天顶时退化，用北天极兜底）
        camera.up.copy(Math.abs(z.dot(dir)) > 0.95 ? new THREE.Vector3(0, 1, 0) : z);
        camera.lookAt(dir.clone());
        updateObserveIndicators();
    }

    // 聚焦追踪：相机保持在目标星外侧，距离可滚轮缩放（仅 3D）
    if (state.viewMode === '3d' && focusTarget && focusProgress >= 1) {
        const wp = new THREE.Vector3(focusTarget._x, focusTarget._y, focusTarget._z)
            .applyEuler(new THREE.Euler(currentRotation.x, currentRotation.y, currentRotation.z));
        const dir = wp.clone().normalize();
        camera.position.copy(wp.clone().add(dir.multiplyScalar(-focusDistance)));
        camera.lookAt(wp);
    }

    // 时间相关动画
    const time = Date.now() * 0.001;

    // 闪烁星光效果
    if (twinklePoints && twinklePhases && twinklePoints.geometry.attributes.size) {
        const sizes = twinklePoints.geometry.attributes.size.array;
        for (let i = 0; i < sizes.length; i++) {
            const phase = twinklePhases[i] || 0;
            sizes[i] = Math.max(0, Math.sin(time * 3 + phase) * 1.5 + 1);
        }
        twinklePoints.geometry.attributes.size.needsUpdate = true;
    }

    // 根据阶段应用视觉效果
    applyStageAnimation(time);

    // 更新流星
    updateMeteors();

    // 更新星脉连线呼吸效果
    updateStarVeinLines(time);

    // 更新星辰名称标签（近处亮星显示名称）
    updateStarLabels();

    composer.render();
}

// ==================== 七阶段星体视觉（stageHalo） ====================
// 文档依据：初中版6.1 每阶段星体外观有明显变化
//   2初现=裂隙阴影环  3追问=脉冲光晕  6共鸣=蓝金双环脉冲  7觉醒=金色光环
// （4 抉择/5 映射 已合并到罗盘融合，主流程不再独立触发）
let stageHalo = null; // { group, stage, parts }

function _flatRing(innerR, outerR, color, opacity, dir, additive = true) {
    const ring = new THREE.Mesh(
        new THREE.RingGeometry(innerR, outerR, 48, 1),
        new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity,
            side: THREE.DoubleSide,
            depthWrite: false,
            blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
        })
    );
    // 环面法线对准星体方向，从外侧相机看呈正圆环
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    return ring;
}

function clearStageHalo() {
    if (!stageHalo) return;
    if (skyGroup) skyGroup.remove(stageHalo.group);
    stageHalo.group.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
    });
    stageHalo = null;
}

function updateStageVisual() {
    clearStageHalo();
    const star = state.currentStar;
    const stage = state.currentStage;
    if (!star || star._x === undefined || !skyGroup) return;
    if (stage < 2 || stage > 7) return;

    const group = new THREE.Group();
    // 2D：光环在投影平面（y=0）上，环面朝相机；3D/观星：环面朝星体方向
    if (state.viewMode === '2d') {
        const p = projectTo2D(star._x, star._y, star._z);
        group.position.set(p.x, 0, p.z);
    } else {
        group.position.set(star._x, star._y, star._z);
    }
    const dir = state.viewMode !== '3d'
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(star._x, star._y, star._z).normalize();
    const parts = {};

    if (stage === 2) {
        // 初现：裂隙状阴影环（暗紫破碎环，缓慢旋转）
        parts.ring = _flatRing(14, 24, 0x241433, 0.85, dir, false);
        group.add(parts.ring);
    } else if (stage === 3) {
        // 追问：脉冲光晕（科学蓝）
        parts.glow = _flatRing(10, 22, 0x4a9eff, 0.3, dir);
        group.add(parts.glow);
    } else if (stage === 6) {
        // 共鸣：蓝金双环脉冲（参数光环 + 星官环）
        parts.paramRing = new THREE.Mesh(
            new THREE.TorusGeometry(20, 0.9, 8, 48),
            new THREE.MeshBasicMaterial({ color: 0x4a9eff, transparent: true, opacity: 0.65, blending: THREE.AdditiveBlending, depthWrite: false })
        );
        parts.cultureRing = new THREE.Mesh(
            new THREE.TorusGeometry(27, 0.9, 8, 48),
            new THREE.MeshBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.65, blending: THREE.AdditiveBlending, depthWrite: false })
        );
        parts.paramRing.rotation.x = Math.PI / 3;
        parts.cultureRing.rotation.x = -Math.PI / 3;
        group.add(parts.paramRing, parts.cultureRing);
    } else if (stage === 7) {
        // 觉醒：金色光环
        parts.ring = _flatRing(12, 22, 0xffd700, 0.4, dir);
        group.add(parts.ring);
    }

    skyGroup.add(group);
    stageHalo = { group, stage, parts };
}

// 调试访问器（与 __testMode/__skipIntro 同级，供自动化验证读取阶段视觉状态）
window.__debugStage = () => ({
    stage: state.currentStage,
    phase: state.phase,
    hasHalo: !!stageHalo,
    haloParts: stageHalo ? Object.keys(stageHalo.parts) : [],
    awakenedCount: state.awakenedStars.size,
    fogCount: fogMesh ? fogMesh.material.uniforms.uAwakenedCount.value : -1
});

// 视图模式调试访问器（供自动化验证 2D/3D 切换状态）
window.__debugView = () => {
    const hyg = window._hygData;
    let polaris = null;
    if (hyg) {
        for (let i = 0; i < hyg.count; i++) {
            if (hyg.proper[i] === 'Polaris') { polaris = { px: hyg.px[i], py: hyg.py[i], pz: hyg.pz[i] }; break; }
        }
    }
    const p = polaris ? { x: polaris.px * (R2D / SKY_R), z: polaris.pz * (R2D / SKY_R) } : null;
    const hb = document.getElementById('hemisphere-btn');
    return {
        viewMode: state.viewMode,
        hemisphere: state.viewHemisphere,
        cameraType: camera ? (camera.isOrthographicCamera ? 'ortho' : 'perspective') : 'none',
        starCount: starPoints ? starPoints.geometry.attributes.position.count : 0,
        constellationLines: constellationLines ? constellationLines.length : 0,
        fogType: fogMesh ? fogMesh.geometry.type : 'none',
        fogRadius: fogMesh ? fogMesh.material.uniforms.uFogRadius.value : null,
        hasEquatorRing: !!equatorRing,
        hemisphereBtnVisible: !!hb && hb.style.display !== 'none',
        polarisProjected: p ? [p.x.toFixed(1), p.z.toFixed(1)] : null,
        channel: state.channel,
        bipolarValue: state.bipolarValue,
        iauOpacity: constellationLines.length ? constellationLines[0].material.opacity : -1,
        asterOpacity: chineseAsterismLines.length ? chineseAsterismLines[0].material.opacity : -1,
        asterLines: chineseAsterismLines.length,
        starTint: window._starShaderMaterial ? window._starShaderMaterial.uniforms.uChannelTint.value.toArray().map(v => Math.round(v * 100) / 100) : null,
        fogColor: fogMesh ? '#' + fogMesh.material.uniforms.uFogColor.value.getHexString() : 'none',
        observe: {
            az: Math.round(((observeParams.az * 180 / Math.PI) % 360 + 360) % 360),
            alt: Math.round(observeParams.alt * 180 / Math.PI),
            fov: observeParams.fov,
            site: OBSERVE_SITES[observeParams.site] ? OBSERVE_SITES[observeParams.site].name : '?',
            lat: Math.round(observeParams.lat * 10) / 10,
            lon: Math.round(observeParams.lon * 10) / 10,
            camPos: camera ? camera.position.toArray().map(v => Math.round(v * 10) / 10) : null,
            hasGround: !!observeGround,
            hasGlow: !!observeSkyGlow,
            milkyWayVisible: !!milkyWayPoints && milkyWayPoints.visible,
            dsoCount: dsoSprites.length,
            planetCount: planetSprites.length,
            dsoHiddenInCulture: dsoSprites.length > 0 && dsoSprites.every(s => !s.visible),
            starMinBrightnes: window._starShaderMaterial ? window._starShaderMaterial.uniforms.starMinBrightnes.value : null
        }
    };
};

// 调试访问器：任意 HR 星在当前观星/今晚视角下的地平坐标（供自动化验证）
window.__debugStarAltAz = (hr) => {
    const s = state.starCatalog.find(x => x.hr === hr);
    if (!s) return null;
    const lst = _observeLstCache;
    const lat = observeParams.lat;
    const { alt, az } = starAltAz(s._x, s._y, s._z, lst, lat);
    return { alt: Math.round(alt * 180 / Math.PI), az: Math.round(az * 180 / Math.PI) };
};

// 调试访问器：设置观星视角（度），供自动化测试
window.__debugSetObserve = (azDeg, altDeg) => {
    observeParams.az = azDeg * Math.PI / 180;
    observeParams.alt = altDeg * Math.PI / 180;
    observeFocusAnim = null;
};

// 调试访问器：DSO/行星标记状态
window.__debugDso = () => ({
    dsosLoaded: state.dsos ? state.dsos.length : null,
    dsoSprites: dsoSprites.length,
    planetSprites: planetSprites.length
});

function applyStageAnimation(time) {
    if (!starPoints || !starPoints.material) return;

    // 觉醒阶段：星点金色脉冲（shader uniform）
    if (state.currentStage === 7 && starPoints.material.uniforms) {
        starPoints.material.uniforms.starFadeDactor.value = -2.5;
    }

    // 七阶段星体光环动画
    if (!stageHalo) return;
    const { group, stage, parts } = stageHalo;
    const pulse = 1 + Math.sin(time * 2.2) * 0.12;

    if (stage === 2 && parts.ring) {
        parts.ring.rotation.z += 0.002;
        parts.ring.material.opacity = 0.7 + Math.sin(time * 1.5) * 0.15;
    } else if (stage === 3 && parts.glow) {
        parts.glow.scale.setScalar(pulse);
        parts.glow.material.opacity = 0.25 + Math.sin(time * 2.2) * 0.15;
    } else if (stage === 4 && parts.ring) {
        parts.ring.scale.setScalar(pulse);
        parts.ring.material.opacity = 0.35 + Math.sin(time * 2.5) * 0.15;
    } else if (stage === 5 && parts.shell) {
        parts.shell.rotation.y += 0.004;
        parts.shell.material.opacity = 0.11 + Math.sin(time * 1.8) * 0.05;
    } else if (stage === 6 && parts.paramRing && parts.cultureRing) {
        parts.paramRing.rotation.z += 0.006;
        parts.cultureRing.rotation.z -= 0.006;
        group.scale.setScalar(1 + Math.sin(time * 2) * 0.06);
        parts.paramRing.material.opacity = 0.5 + Math.sin(time * 2) * 0.15;
        parts.cultureRing.material.opacity = 0.5 + Math.cos(time * 2) * 0.15;
    } else if (stage === 7 && parts.ring) {
        parts.ring.scale.setScalar(pulse);
        parts.ring.material.opacity = 0.3 + Math.sin(time * 2.5) * 0.15;
    }
    // 注：全局 FogExp2 已移除（T011），迷雾由认知迷雾 fogMesh shader 统一负责
}

// ==================== 星辰聚焦动画 ====================
function focusOnStar(star) {
    if (!star || star._x === undefined) return;

    // 地面观星：转动视角对准该星（像人抬头看那颗星）
    if (state.viewMode === 'observe') {
        focusObserve(star);
        return;
    }

    // 平面视图：2D 转到屏幕上方 + 缩放；今晚星空仅缩放（方位固定）
    if (state.viewMode !== '3d') {
        if (!orthoCamera) return;
        if (state.viewMode === '2d') {
            focus2D(star);
        } else {
            focus2DAnim = {
                targetY: currentRotation.y,
                startY: currentRotation.y,
                startZoom: orthoCamera.zoom,
                startTime: Date.now(),
                duration: 600
            };
        }
        return;
    }

    focusTarget = star;
    focusProgress = 0;
    focusStartPos = { x: camera.position.x, y: camera.position.y, z: camera.position.z };

    // 创建时光隧道粒子效果
    createTunnelEffect();

    // 创建西方星座连线（蓝色）
    createWesternConstellationLines();

    // 聚焦动画
    animateFocus();
}

function createTunnelEffect() {
    // 移除旧的隧道粒子
    if (tunnelParticles) {
        scene.remove(tunnelParticles);
        tunnelParticles.geometry.dispose();
        tunnelParticles.material.dispose();
    }

    const particleCount = 500;
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);

    for (let i = 0; i < particleCount; i++) {
        // 从相机位置向外扩散
        positions[i * 3] = (Math.random() - 0.5) * 200;
        positions[i * 3 + 1] = (Math.random() - 0.5) * 200;
        positions[i * 3 + 2] = Math.random() * 1000;
        colors[i * 3] = 0.5 + Math.random() * 0.5;
        colors[i * 3 + 1] = 0.7 + Math.random() * 0.3;
        colors[i * 3 + 2] = 1;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
        size: 2,
        vertexColors: true,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending
    });

    tunnelParticles = new THREE.Points(geometry, material);
    scene.add(tunnelParticles);
}

function createWesternConstellationLines() {
    // 清除旧的西方连线
    westernConstellationLines.forEach(line => scene.remove(line));
    westernConstellationLines = [];

    // 西方星座定义（示例：北斗、大熊座等）
    const westernConstellations = [
        { name: 'Ursa Major', lines: [['dubhe', 'merak'], ['merak', 'phecda'], ['phecda', 'megrez'], ['megrez', 'alioth'], ['alioth', 'mizar'], ['mizar', 'alkaid']] },
        { name: 'Orion', lines: [['betelgeuse', 'bellatrix'], ['bellatrix', 'alnitak'], ['alnitak', 'alnilam'], ['alnilam', 'mintaka'], ['mintaka', 'rigel'], ['rigel', 'saiph'], ['betelgeuse', 'rigel']] }
    ];

    const linesMaterial = new THREE.LineBasicMaterial({
        color: 0x4a9eff, // 蓝色
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending
    });

    westernConstellations.forEach(constellation => {
        constellation.lines.forEach(line => {
            const star1 = state.starCatalog.find(s => s.id === line[0]);
            const star2 = state.starCatalog.find(s => s.id === line[1]);

            if (star1 && star2 && star1._x !== undefined && star2._x !== undefined) {
                const points = [
                    new THREE.Vector3(star1._x, star1._y, star1._z),
                    new THREE.Vector3(star2._x, star2._y, star2._z)
                ];
                const geometry = new THREE.BufferGeometry().setFromPoints(points);
                const lineObj = new THREE.Line(geometry, linesMaterial.clone());
                lineObj.userData.constellationId = constellation.name;
                skyGroup.add(lineObj);
                westernConstellationLines.push(lineObj);
            }
        });
    });
}

// ==================== 认知迷雾 ====================
/** 重建认知迷雾：3D 为包围球，2D 为平面遮罩（觉醒星周围雾散开） */
function rebuildFog(mode) {
    if (fogMesh) {
        skyGroup.remove(fogMesh);
        fogMesh.geometry.dispose();
        fogMesh.material.dispose();
        fogMesh = null;
    }

    const uniforms = {
        uAwakenedStars: { value: new Array(32).fill(new THREE.Vector3(0, 0, 0)) },
        uAwakenedCount: { value: 0 },
        uFogRadius: { value: mode === '2d' ? 55 : 350 },
        uBaseOpacity: { value: 0.8 }, // spec T012：初始迷雾浓度 0.8
        uFogColor: { value: new THREE.Color(0x0a0a14) }
    };

    if (mode === 'observe') {
        // 球心视角：雾壳紧贴星面（r=205），从球心看覆盖星点，觉醒星周围散开
        const geometry = new THREE.SphereGeometry(205, 48, 48);
        const material = new THREE.ShaderMaterial({
            vertexShader: FOG_VERTEX_SHADER,
            fragmentShader: FOG_FRAGMENT_SHADER,
            uniforms: Object.assign({}, uniforms, { uFogRadius: { value: 55 } }),
            transparent: true,
            depthTest: false,
            depthWrite: false,
            side: THREE.BackSide,
            blending: THREE.NormalBlending
        });
        fogMesh = new THREE.Mesh(geometry, material);
    } else if (mode === '2d') {
        // 平面遮罩：覆盖整张星图，略高于星点平面（y=6），面朝 +Y 相机
        const size = R2D * 2 * P2D_FIT;
        const geometry = new THREE.PlaneGeometry(size, size);
        geometry.rotateX(-Math.PI / 2);
        const material = new THREE.ShaderMaterial({
            vertexShader: FOG_VERTEX_SHADER,
            fragmentShader: FOG_FRAGMENT_SHADER,
            uniforms,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            blending: THREE.NormalBlending
        });
        fogMesh = new THREE.Mesh(geometry, material);
        fogMesh.position.y = 6;
    } else {
        const radius = 980; // 比星场稍大
        const geometry = new THREE.SphereGeometry(radius, 64, 64);
        const material = new THREE.ShaderMaterial({
            vertexShader: FOG_VERTEX_SHADER,
            fragmentShader: FOG_FRAGMENT_SHADER,
            uniforms,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            side: THREE.BackSide, // 从内部看
            blending: THREE.NormalBlending
        });
        fogMesh = new THREE.Mesh(geometry, material);
    }
    fogMesh.renderOrder = 10; // 在星场（renderOrder 0）之后渲染，迷雾才能覆盖星点
    skyGroup.add(fogMesh);
}

function createFogMesh() {
    rebuildFog(state.viewMode || '3d');
}

function updateFogState() {
    if (!fogMesh) {
        rebuildFog(state.viewMode || '3d');
    }
    if (!fogMesh) return;

    const isPlane = state.viewMode === '2d'; // 2D 平面投影模式用投影坐标
    const awakenedIds = Array.from(state.awakenedStars);
    const count = Math.min(awakenedIds.length, 32);
    const positions = new Array(32).fill(new THREE.Vector3(0, 0, 0));

    for (let i = 0; i < count; i++) {
        const pos = state.awakenedStarPositions[awakenedIds[i]];
        if (pos) {
            if (isPlane) {
                // 2D 平面模式：觉醒星投影到遮罩平面坐标
                const p = projectTo2D(pos.x, pos.y, pos.z);
                positions[i] = new THREE.Vector3(p.x, 6, p.z);
            } else {
                positions[i] = new THREE.Vector3(pos.x, pos.y, pos.z);
            }
        }
    }

    fogMesh.material.uniforms.uAwakenedStars.value = positions;
    fogMesh.material.uniforms.uAwakenedCount.value = count;
}

function animateFocus() {
    const duration = 2500;
    const startTime = Date.now();

    function step() {
        const elapsed = Date.now() - startTime;
        focusProgress = Math.min(1, elapsed / duration);

        if (focusTarget && focusProgress < 1) {
            const t = easeInOutCubic(focusProgress);
            // 计算目标星的世界坐标（考虑skyGroup旋转变换）
            const wp = new THREE.Vector3(focusTarget._x, focusTarget._y, focusTarget._z)
                .applyEuler(new THREE.Euler(currentRotation.x, currentRotation.y, currentRotation.z));
            // 相机终点：在目标星外侧80单位
            const dir = wp.clone().normalize();
            const endPos = wp.clone().add(dir.multiplyScalar(-200));

            camera.position.lerpVectors(
                new THREE.Vector3(focusStartPos.x, focusStartPos.y, focusStartPos.z),
                endPos,
                t
            );
            camera.lookAt(wp);
            camera.fov = 60 - t * 8;
            camera.updateProjectionMatrix();

            requestAnimationFrame(step);
        } else if (focusProgress >= 1) {
            camera.fov = 52;
            camera.updateProjectionMatrix();
        }
    }

    step();
}

function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ==================== 对话功能 ====================
const API_BASE = '/api';

// 打字机状态
let typewriterState = {
    currentCard: null,
    fullText: '',
    displayedText: '',
    charIndex: 0,
    speed: 30, // 每字符延迟(ms)
    isTyping: false,
    onComplete: null
};

// ==================== 语音朗读（MiniMax TTS） ====================
// 双导师用不同音色区分（均为年长音色）：开普勒=温润男声（严谨），甘德=有声书男声1（随和自然）
const MENTOR_VOICES = {
    science: 'Chinese (Mandarin)_Gentleman',
    culture: 'audiobook_male_1'
};

let ttsCtx = null;
let ttsSource = null;
let ttsSeq = 0; // 序号防竞态：切段/关闭后，迟到的音频不再播放

// 去掉 Markdown 符号，避免把 **、# 之类读出来
function cleanTtsText(text) {
    return String(text || '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_#>`~]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function ensureTtsContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!ttsCtx) ttsCtx = new AC();
    if (ttsCtx.state === 'suspended') ttsCtx.resume().catch(() => {});
    return ttsCtx;
}

// 浏览器自动播放策略：页面任意一次点击即解锁音频上下文，并开始背景音乐
document.addEventListener('pointerdown', () => { ensureTtsContext(); startBgm(); }, { once: true });

function stopTts() {
    ttsSeq++;
    if (ttsSource) {
        try { ttsSource.stop(); } catch (e) { /* 已停止 */ }
        ttsSource = null;
    }
    fadeBgmTo(BGM_VOLUME);
}

async function playTts(text, voiceId) {
    text = cleanTtsText(text);
    if (window.__testMode === true || !text) return;
    const ctx = ensureTtsContext();
    if (!ctx) return;
    const seq = ++ttsSeq;
    if (ttsSource) {
        try { ttsSource.stop(); } catch (e) { /* 已停止 */ }
        ttsSource = null;
    }
    try {
        const resp = await fetch(`${API_BASE}/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice_id: voiceId })
        });
        if (!resp.ok || seq !== ttsSeq) return;
        const data = await resp.json();
        if (!data.audio_base64 || seq !== ttsSeq) return;
        const bytes = Uint8Array.from(atob(data.audio_base64), c => c.charCodeAt(0));
        const buffer = await ctx.decodeAudioData(bytes.buffer);
        if (seq !== ttsSeq) return;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.onended = () => {
            if (ttsSource === source) {
                ttsSource = null;
                fadeBgmTo(BGM_VOLUME);
            }
        };
        source.start();
        ttsSource = source;
        fadeBgmTo(BGM_DUCK_VOLUME);
    } catch (e) {
        // 朗读是增强能力：失败不阻塞文字对话
    }
}

// ==================== 背景音乐 ====================
const BGM_SRC = 'assets/bgm.mp3';
const BGM_VOLUME = 0.3;       // 常态音量（轻柔，不盖过朗读）
const BGM_DUCK_VOLUME = 0.08; // 导师朗读时压低的音量
let bgmEl = null;
let bgmAvailable = true;      // false = 音频文件缺失/加载失败，隐藏开关
let bgmFadeTimer = null;

function isBgmEnabled() {
    return localStorage.getItem('tianwen_bgm_enabled') !== '0';
}

function getBgmEl() {
    if (!bgmEl) {
        bgmEl = new Audio(BGM_SRC);
        bgmEl.loop = true;
        bgmEl.volume = BGM_VOLUME;
        bgmEl.preload = 'auto';
    }
    return bgmEl;
}

function updateBgmButton() {
    const btn = document.getElementById('bgm-toggle-btn');
    if (!btn) return;
    if (!bgmAvailable) {
        btn.style.display = 'none';
        return;
    }
    btn.style.display = '';
    btn.textContent = isBgmEnabled() ? '🎵 音乐' : '🔇 静音';
    btn.setAttribute('aria-pressed', String(isBgmEnabled()));
}

/** 页面首次用户交互时启动 BGM（浏览器禁止交互前发声） */
function startBgm() {
    if (window.__testMode === true || !bgmAvailable) return;
    updateBgmButton();
    if (!isBgmEnabled()) return;
    getBgmEl().play().catch(() => {
        bgmAvailable = false;
        updateBgmButton();
    });
}

function toggleBgm() {
    const enable = !isBgmEnabled();
    localStorage.setItem('tianwen_bgm_enabled', enable ? '1' : '0');
    if (enable) {
        bgmAvailable = true;
        getBgmEl().play().catch(() => {
            bgmAvailable = false;
            updateBgmButton();
        });
    } else if (bgmEl) {
        bgmEl.pause();
    }
    updateBgmButton();
}

/** 音量平滑过渡（朗读开始压低 BGM，结束恢复） */
function fadeBgmTo(target, duration = 500) {
    if (!bgmEl) return;
    if (bgmFadeTimer) cancelAnimationFrame(bgmFadeTimer);
    const from = bgmEl.volume;
    const start = performance.now();
    function step(now) {
        const t = Math.min(1, (now - start) / duration);
        bgmEl.volume = from + (target - from) * t;
        bgmFadeTimer = t < 1 ? requestAnimationFrame(step) : null;
    }
    bgmFadeTimer = requestAnimationFrame(step);
}

// 调试访问器（与 __debugView 同样约定，测试/排查用）
window.__debugBgm = () => ({
    enabled: isBgmEnabled(),
    available: bgmAvailable,
    playing: bgmEl ? !bgmEl.paused : false,
    volume: bgmEl ? bgmEl.volume : null,
    duration: bgmEl && isFinite(bgmEl.duration) ? bgmEl.duration : null,
    src: BGM_SRC
});

// 初中版状态转换：后端 stage string -> 1-7
function stageToNumber(stageValue) {
    // 五步循环：选星 1 → 开场 2 → 追问 3 → 融合 4 → 启示录 5
    const map = {
        'dusty': 1,
        'revealed': 2,
        'questioned': 3,
        'chosen': 4,     // 旧阶段兼容 → 融合
        'mapped': 4,     // 旧阶段兼容 → 融合
        'resonated': 4,
        'awakened': 5
    };
    return map[stageValue] || 1;
}

function updateStageFromBackend(data) {
    const stageNum = stageToNumber(data.stage);
    state.currentStage = stageNum;
    state.currentStarId = data.star_id;
    state.litNodes = data.lit_nodes || [];

    // 节点点亮可见收获（第 5 条）：展示新点亮的节点标签，而非抽象数字
    const prevLabels = state.litNodeLabels || [];
    const nextLabels = data.lit_node_labels || [];
    state.litNodeLabels = nextLabels;
    const fresh = nextLabels.filter(l => !prevLabels.includes(l));
    fresh.forEach(label => showNodeToast('✨ 你已经知道：' + label));

    state.isBalanced = data.fusion_balance !== undefined ? Math.abs(data.fusion_balance) < 0.3 : false;

    const stageNames = ['选星', '双导师开场', '自由追问', '罗盘融合', '星辰启示录'];
    document.getElementById('stage-name').textContent = stageNames[stageNum - 1] || '等待探索';

    document.querySelectorAll('.stage-dot').forEach((dot, i) => {
        dot.classList.remove('active', 'awakened');
        if (i < stageNum) {
            dot.classList.add(i === 4 ? 'awakened' : 'active');
        }
    });

    // 更新节点进度
    const nodeProgress = document.getElementById('node-progress');
    if (nodeProgress) {
        const labelsHtml = state.litNodeLabels.length
            ? `<div style="margin-top:8px;color:rgba(255,215,0,0.8);font-size:0.8rem;">已点亮：${state.litNodeLabels.join(' · ')}</div>`
            : '';
        nodeProgress.innerHTML = `已点亮 <span>${state.litNodes.length}</span> / ${data.required_nodes || 2} 个认知节点${labelsHtml}`;
    }

    // 同步七阶段星体视觉（裂隙/光晕/路径色彩/隔膜/双环/金环）
    updateStageVisual();
}

// 根据节点点亮情况生成具体的解锁提示（初中版6.1：需点亮至少2个不同维度的节点）
function unlockHint(data) {
    const lit = (data.lit_nodes || []).length;
    const required = data.required_nodes || 2;
    const dims = data.dimensions_lit || [];
    if (lit < required) {
        return `继续追问以解锁更多探索方向（还需点亮 ${required - lit} 个认知节点）`;
    }
    if (dims.length < 2) {
        const missing = [];
        if (!dims.includes('culture')) missing.push('古人怎么看它');
        if (!dims.includes('fact')) missing.push('它的科学事实');
        if (!dims.includes('compare')) missing.push('中西对比');
        return `节点已点亮，再追问一个不同维度的问题（如：${missing.slice(0, 2).join(' / ')}）`;
    }
    return '继续追问以解锁更多探索方向';
}

async function sendMessage(content, starId = null, decision = null, action = 'initial') {
    if (state.isLoading) return;

    if (!starId) starId = state.currentStarId || (state.currentStar ? state.currentStar.id : null);
    if (!starId) {
        showError('请先选择一颗星辰');
        return;
    }

    state.isLoading = true;
    showLoading();

    try {
        const body = {
            content: content || '',
            model: 'minimax',
            action
        };

        if (state.sessionId) body.session_id = state.sessionId;
        body.star_id = starId;
        if (decision) body.decision = decision;

        let response;
        try {
            response = await fetch(`${API_BASE}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        } catch (networkError) {
            hideLoading();
            showError('连接服务器失败，请检查网络后重试');
            return;
        }

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.detail || `请求失败（HTTP ${response.status}）`);
        }
        if (data.detail) {
            throw new Error(data.detail);
        }

        state.sessionId = data.session_id;
        if (data.session_id) {
            localStorage.setItem('tianwen_session_id', data.session_id);
        }
        handleChatResponse(data);
    } catch (error) {
        hideLoading();
        showError(error.message || '请求失败，请稍后重试');
    }
}

function handleChatResponse(data) {
    hideLoading();
    updateStageFromBackend(data);

    const statusEl = document.getElementById('chat-status');
    const stage = data.stage;

    // 隐藏所有操作区域
    collapseQuestionInput();
    document.getElementById('awaken-input-area').classList.remove('visible');

    // 初始或追问回复：显示双导师对话（五步循环：无认知节点门槛，追问后即可拖罗盘融合）
    if (stage === 'revealed' || stage === 'questioned') {
        state.phase = stage === 'revealed' ? 'initial' : 'questioning';
        statusEl.textContent = data.message || (stage === 'revealed' ? '星辰已初现，你可以追问，也可以直接拖动罗盘让两位导师交融' : '追问已收到');
        // 维度软引导（第 2 条）：不足 2 维度时给温柔提示，不拦截
        if (data.soft_hint) {
            statusEl.textContent += ' · ' + data.soft_hint;
        }
        showOverlayDialogue(data.science_response, data.culture_response);
        showQuestionInput(data.suggested_questions || []);
        return;
    }

    // 共鸣阶段
    if (stage === 'resonated') {
        state.phase = 'resonance';
        statusEl.textContent = '星辰已共鸣。写下你的感悟，完成觉醒。';
        if (data.resonance) showResonance(data.resonance);
        document.getElementById('awaken-input-area').classList.add('visible');
        return;
    }

    // 觉醒阶段
    if (stage === 'awakened') {
        state.phase = 'completed';
        state.awakenedStars.add(data.star_id);

        // 记录觉醒星坐标，用于绘制星脉连线
        const starPos = resolveStarPosition(data.star_id);
        if (starPos) {
            state.awakenedStarPositions[data.star_id] = starPos;
            if (state.awakenedStars.size > 1) {
                createStarVeinLines(data.star_id);
            }
        }

        // 更新认知迷雾：以觉醒星为中心消退
        updateFogState();

        state.awakenedCount = state.awakenedStars.size;
        checkAchievements();

        // 觉醒后概率触发星空异动事件
        setTimeout(() => maybeTriggerRandomEvent('after_awaken'), 800);

        statusEl.textContent = data.message || '星辰已觉醒！';
        showFinalArchive(data);
        return;
    }
}

/** 根据 star_id 解析 3D 坐标：优先用当前选中星，否则在星表中查找 */
function resolveStarPosition(starId) {
    if (state.currentStar && state.currentStar._x !== undefined) {
        return {
            x: state.currentStar._x,
            y: state.currentStar._y,
            z: state.currentStar._z
        };
    }
    // 在星图目录中查找对应中文名/英文名
    const profileMap = {
        'polaris': ['北极星', 'Polaris'],
        'big_dipper': ['北斗七星', 'Big Dipper'],
        'betelgeuse': ['参宿四', 'Betelgeuse'],
        'antares': ['心宿二', 'Antares'],
        'altair_vega': ['牛郎星', 'Altair', '织女星', 'Vega'],
        'sirius': ['天狼星', 'Sirius'],
        'canopus': ['老人星', 'Canopus'],
        'arcturus': ['大角星', 'Arcturus']
    };
    const names = profileMap[starId] || [];
    const found = state.starCatalog.find(s =>
        names.includes(s.name_cn) || names.includes(s.name_en)
    );
    if (found && found._x !== undefined) {
        return { x: found._x, y: found._y, z: found._z };
    }
    return null;
}

/** 绘制新觉醒星与其他已觉醒星之间的金色星脉连线 */
function createStarVeinLines(newStarId) {
    const newPos = state.awakenedStarPositions[newStarId];
    if (!newPos || state.awakenedStars.size <= 1) return;

    const mat = new THREE.LineBasicMaterial({
        color: 0xffd700,
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending,
        depthTest: false
    });

    for (const otherId of state.awakenedStars) {
        if (otherId === newStarId) continue;
        const otherPos = state.awakenedStarPositions[otherId];
        if (!otherPos) continue;

        const pts = [
            new THREE.Vector3(newPos.x, newPos.y, newPos.z),
            new THREE.Vector3(otherPos.x, otherPos.y, otherPos.z)
        ];
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        const line = new THREE.Line(geom, mat.clone());
        line.userData = { isStarVein: true, baseOpacity: 0.6 };
        skyGroup.add(line);
        starVeinLines.push(line);
    }
}

/** 星脉连线呼吸脉冲动画 */
function updateStarVeinLines(time) {
    if (!starVeinLines.length) return;
    const t = time || Date.now() * 0.001;
    const pulse = 0.45 + Math.sin(t * 2) * 0.15; // 0.3 ~ 0.6
    starVeinLines.forEach(line => {
        const base = line.userData.baseOpacity || 0.6;
        line.material.opacity = base * pulse;
    });
}

/** 从后端加载持久化进度，恢复觉醒星、迷雾与星脉连线 */
async function loadPersistedProgress() {
    if (!state.sessionId) return;
    try {
        const resp = await fetch(`${API_BASE}/progress/${state.sessionId}`);
        if (!resp.ok) return;
        const data = await resp.json();
        const starProgress = data.star_progress || {};

        for (const [starId, progress] of Object.entries(starProgress)) {
            if (progress.stage === 'awakened' || progress.awakened) {
                state.awakenedStars.add(starId);
                const pos = resolveStarPosition(starId);
                if (pos) {
                    state.awakenedStarPositions[starId] = pos;
                }
            }
        }

        if (state.awakenedStars.size > 0) {
            updateFogState();
            // 重建所有觉醒星之间的星脉连线
            const ids = Array.from(state.awakenedStars);
            for (let i = 1; i < ids.length; i++) {
                createStarVeinLines(ids[i]);
            }
        }
    } catch (e) {
        console.error('loadPersistedProgress error:', e);
    }
}

function showQuestionInput(questions) {
    const area = document.getElementById('question-input-area');
    const toggleBtn = document.getElementById('question-toggle-btn');

    area.classList.add('expanded');
    toggleBtn.classList.remove('visible');

    const container = document.getElementById('suggested-questions');
    container.innerHTML = '';
    if (questions && questions.length) {
        // 推荐问题是"卡住时的兜底"（第 6 条），第一屏鼓励自由输入
        const tip = document.createElement('span');
        tip.className = 'suggested-tip';
        tip.textContent = '没想好问什么？试试：';
        container.appendChild(tip);
        questions.forEach(q => {
            const tag = document.createElement('span');
            tag.className = 'suggested-q';
            tag.textContent = q;
            tag.onclick = () => {
                document.getElementById('question-input').value = q;
                sendQuestion();
            };
            container.appendChild(tag);
        });
    }
}

/** 节点点亮收获 toast（右上角渐显渐隐） */
function showNodeToast(text) {
    const container = document.getElementById('canvas-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'node-toast';
    toast.textContent = text;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 500);
    }, 2800);
}

function collapseQuestionInput() {
    const area = document.getElementById('question-input-area');
    const toggleBtn = document.getElementById('question-toggle-btn');

    area.classList.remove('expanded');
    toggleBtn.classList.add('visible');
}

async function sendQuestion() {
    const input = document.getElementById('question-input');
    const content = input.value.trim();
    if (!content) return;

    // 档案预置答案：点开推荐问题时瞬时显示双导师答复（不走 LLM、不走网络、不弹全屏浮层）
    const profile = state.starProfiles[state.currentStarId];
    const preset = profile && profile.sample_answers && profile.sample_answers[content];
    if (preset && preset.science && preset.culture) {
        input.value = '';
        showMessages(preset.science, preset.culture);
        const statusEl = document.getElementById('chat-status');
        if (statusEl) statusEl.textContent = '追问已收到';
        // 不折叠输入区：推荐问题保持可见，支持连续点击
        return;
    }

    input.value = '';
    collapseQuestionInput();
    state.questionCount++;
    checkAchievements(); // 累计追问成就（故事框架3.3）
    maybeDropFragment(state.currentStarId);
    await sendMessage(content, null, null, 'question');
}

function showResonance(text) {
    text = text || '';
    // 融合总结是总结性话语：去除「追问：」标记，不显示追问
    text = extractFollowUp(text).text;
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'message-card resonance-card';
    card.innerHTML = `<div class="agent" style="color:var(--culture)">星辰共鸣</div><div class="content-wrapper"><div class="content">${text.replace(/\n/g, '<br>')}</div></div>`;
    container.appendChild(card);
}

function showFinalArchive(data) {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'message-card archive-card';

    // 保存档案到星辰档案库（含用户感悟），持久化到 localStorage
    // 融合总结是总结性话语，去除「追问：」标记后再保存与展示
    const resonanceClean = extractFollowUp(data.resonance || '').text;
    const starId = data.star_id || state.currentStarId;
    state.archives[starId] = {
        star_name: data.star_name || '',
        resonance: resonanceClean,
        personal_note: data.personal_note || '',
        question_stats: data.question_stats || {},
        quiz: state.quiz.done ? { score: state.quiz.score, total: state.quiz.questions.length } : null,
        awakened_at: new Date().toISOString(),
    };
    saveArchives();

    // 追问类型统计（第 7 条：觉醒时反馈"你问了 x 个科学问题…"）
    const stats = data.question_stats || {};
    const statNames = { fact: '科学', culture: '文化', compare: '对比' };
    const statParts = Object.entries(stats)
        .filter(([k, v]) => v > 0)
        .map(([k, v]) => `${statNames[k] || k}问题 ${v} 个`);
    const statsHtml = statParts.length
        ? `<p style="margin-top: 12px; color: var(--text-dim); font-size: 0.85rem;">这次旅程，你追问了 ${statParts.join('、')}</p>`
        : '';
    // 星空小测验成绩
    const quizScoreHtml = state.quiz.done
        ? `<p style="margin-top: 6px; color: var(--text-dim); font-size: 0.85rem;">星空小测验：答对 ${state.quiz.score}/${state.quiz.questions.length}</p>`
        : '';
    div.innerHTML = `
        <div class="archive-title">✧ 星辰启示录 ✧</div>
        <div class="content archive-body">
            <p><strong>${data.star_name || ''}</strong></p>
            <p style="color: rgba(255,215,0,0.8); font-style: italic;">${resonanceClean.replace(/\n/g, '<br>')}</p>
            <p style="margin-top: 15px; color: var(--text-dim);">我的感悟：${(data.personal_note || '').replace(/\n/g, '<br>')}</p>
            ${statsHtml}
            ${quizScoreHtml}
        </div>
        <div class="archive-actions">
            <button onclick="window.closeArchive()" class="btn btn-culture">关闭</button>
            <button onclick="window.continueExploring()" class="btn btn-science">继续探索</button>
        </div>
    `;
    container.appendChild(div);
}

// 将文本分割成段落
function splitParagraphs(text) {
    if (!text) return [''];
    // 按换行分割，每行作为一个段落
    const lines = text.split('\n').filter(l => l.trim());
    return lines.length > 0 ? lines : [text];
}

function showMessagesWithTypewriter(science, culture) {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';

    // 测试模式：跳过打字机与继续按钮，直接展示双导师消息并进入后续状态
    if (window.__testMode === true) {
        showMessages(science, culture);
        if (state.phase === 'decision') {
            document.getElementById('chat-status').textContent = '请拖动双极罗盘到中间位置';
        } else if (state.phase === 'initial' || state.phase === 'questioning') {
            document.getElementById('chat-status').textContent = '你可以继续追问，也可以从灵感卡中选择';
        }
        return;
    }

    const card = document.createElement('div');
    card.className = 'message-card';
    card.id = 'active-card';
    card.innerHTML = `
        <div class="agent" id="active-agent"></div>
        <div class="content-wrapper">
            <div class="content" id="active-content"></div>
        </div>
    `;
    container.appendChild(card);

    // 分割段落
    const scienceParagraphs = splitParagraphs(science);
    const cultureParagraphs = splitParagraphs(culture);
    let currentPhase = 'science';
    let currentParaIndex = 0;
    let paragraphs = scienceParagraphs;
    let isAnimating = false;

    function showNextParagraph() {
        if (isAnimating) return;
        isAnimating = true;

        if (currentParaIndex >= paragraphs.length) {
            // 所有人都说完后进入下一阶段
            if (currentPhase === 'science') {
                // 开普勒说完，轮到甘德
                currentPhase = 'culture';
                currentParaIndex = 0;
                paragraphs = cultureParagraphs;
                card.style.opacity = '0';
                setTimeout(() => {
                    document.getElementById('chat-status').textContent = '甘德正在解读...';
                    card.className = 'message-card culture';
                    document.getElementById('active-agent').textContent = '甘德';
                    card.style.opacity = '1';
                    isAnimating = false;
                    showNextParagraph();
                }, 400);
            } else {
                // After both agents speak, decide next step based on current phase
                card.style.opacity = '0';
                setTimeout(() => {
                    card.style.display = 'none';
                    if (state.phase === 'decision') {
                        document.getElementById('chat-status').textContent = '请拖动双极罗盘到中间位置';
                    } else if (state.phase === 'initial' || state.phase === 'questioning') {
                        document.getElementById('chat-status').textContent = '你可以继续追问，也可以从灵感卡中选择';
                    }
                }, 400);
            }
            return;
        }

        // 显示下一段
        const para = paragraphs[currentParaIndex];
        // 直接显示纯文字，不解析Markdown
        const parsedPara = para;
        card.style.opacity = '1';
        document.getElementById('active-content').innerHTML = '';

        typewriterState = {
            currentCard: currentPhase,
            fullText: parsedPara,
            displayedText: '',
            charIndex: 0,
            speed: (window.__testMode === true ? 0 : 15),
            isTyping: true,
            onComplete: () => {
                // 本段打完，显示"下一页"按钮
                showNextHint(() => {
                    currentParaIndex++;
                    isAnimating = false;
                    // 淡出当前段
                    card.style.opacity = '0';
                    setTimeout(() => {
                        showNextParagraph();
                    }, 300);
                });
            }
        };
        startTypewriter();
    }

    document.getElementById('chat-status').textContent = '开普勒正在解读...';
    card.style.display = 'flex';
    card.className = 'message-card science';
    document.getElementById('active-agent').textContent = '开普勒';
    showNextParagraph();
}

// ==================== 星图浮层对话系统 ====================

function showOverlayDialogue(scienceText, cultureText) {
    // 测试模式回退到旧面板
    if (window.__testMode === true) {
        showMessagesWithTypewriter(scienceText, cultureText);
        if (state.phase === 'decision') {
            document.getElementById('chat-status').textContent = '请拖动双极罗盘到中间位置';
        } else if (state.phase === 'initial' || state.phase === 'questioning') {
            document.getElementById('chat-status').textContent = '你可以继续追问，也可以从灵感卡中选择';
        }
        return;
    }

    // 清除旧浮层
    removeDialogueOverlay();

    const overlay = document.createElement('div');
    overlay.id = 'dialogue-overlay';

    const card = document.createElement('div');
    card.id = 'dialogue-card';
    card.innerHTML = `
        <div id="dialogue-agent"></div>
        <div id="dialogue-content"></div>
    `;
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // 点击背景关闭/跳过
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            if (typewriterState.isTyping) {
                skipTypewriter();
            } else {
                removeDialogueOverlay();
            }
        }
    });

    const scienceParagraphs = splitParagraphs(scienceText);
    const cultureParagraphs = splitParagraphs(cultureText);
    let currentPhase = 'science';
    let currentParaIndex = 0;
    let paragraphs = scienceParagraphs;
    let isAnimating = false;

    function showNextPara() {
        if (isAnimating) return;
        isAnimating = true;

        if (currentParaIndex >= paragraphs.length) {
            if (currentPhase === 'science') {
                currentPhase = 'culture';
                currentParaIndex = 0;
                paragraphs = cultureParagraphs;
                card.style.opacity = '0';
                setTimeout(() => {
                    document.getElementById('chat-status').textContent = '甘德正在解读...';
                    document.getElementById('dialogue-agent').textContent = '📜 甘德';
                    card.className = 'dialogue-card-culture';
                    card.style.opacity = '1';
                    isAnimating = false;
                    showNextPara();
                }, 400);
            } else {
                removeDialogueOverlay();
                // 浮层关闭后：在聊天区渲染完整答案 + 可点击的「追问」按钮（知识串联）
                showMessages(scienceText, cultureText);
                // 对话结束：区分「开场结束→引导提问」与「追问结束→引导收起追问框」
                const toggleBtn = document.getElementById('question-toggle-btn');
                if (state.phase === 'questioning') {
                    document.getElementById('chat-status').textContent = '答案已经浮现。收起追问框，看清整片星空';
                    const collapseBtn = document.getElementById('question-collapse-btn');
                    if (collapseBtn) {
                        setTimeout(() => {
                            showSpotlight(collapseBtn, '点击 ✕ 收起追问框，查看全貌', { place: 'below' });
                        }, 650);
                    }
                } else {
                    document.getElementById('chat-status').textContent = '守夜人学徒，你还有哪些问题要继续了解吗？';
                    if (toggleBtn) {
                        collapseQuestionInput();
                        setTimeout(() => {
                            showSpotlight(toggleBtn, '点击「💬 提问」向双导师发问', { place: 'above' });
                        }, 650);
                    }
                }
            }
            return;
        }

        const para = paragraphs[currentParaIndex];
        document.getElementById('dialogue-content').innerHTML = '';
        card.style.opacity = '1';

        // 独白配音：打字机开始的同时朗读本段
        playTts(para, MENTOR_VOICES[currentPhase]);

        // 打字开始就显示"继续"键（发光，点击跳过打字）
        const oldHint = document.getElementById('dialogue-next-hint');
        if (oldHint) oldHint.remove();
        const hint = document.createElement('div');
        hint.id = 'dialogue-next-hint';
        hint.className = 'skipping';
        hint.textContent = '跳过 ▸▸';
        hint.onclick = () => {
            if (typewriterState.isTyping) skipTypewriter();
        };
        card.appendChild(hint);

        typewriterState = {
            currentCard: currentPhase,
            fullText: para,
            displayedText: '',
            charIndex: 0,
            speed: 15,
            isTyping: true,
            contentElId: 'dialogue-content',
            onComplete: () => {
                // 打字完成：按钮变为"继续"态，点击进入下一段
                const done = document.getElementById('dialogue-next-hint');
                if (done) {
                    done.className = '';
                    done.textContent = '继续 →';
                    done.onclick = () => {
                        currentParaIndex++;
                        isAnimating = false;
                        card.style.opacity = '0';
                        setTimeout(() => showNextPara(), 300);
                    };
                }
            }
        };
        startTypewriter();
    }

    document.getElementById('chat-status').textContent = '开普勒正在解读...';
    card.className = 'dialogue-card-science';
    document.getElementById('dialogue-agent').textContent = '🔭 开普勒';
    showNextPara();
}

function removeDialogueOverlay() {
    stopTts();
    if (typewriterState.isTyping) {
        clearTimeout(typewriterState.timer);
        typewriterState.isTyping = false;
    }
    const overlay = document.getElementById('dialogue-overlay');
    if (overlay) {
        overlay.classList.add('fading');
        setTimeout(() => overlay.remove(), 400);
    }
}

/* ==================== 引导高亮（spotlight） ==================== */
// 周围变暗 + 目标发光 + 字幕箭头，引导用户点击目标元素
function showSpotlight(targetEl, tipText, opts = {}) {
    if (window.__testMode === true) return; // 测试模式不显示引导，避免干扰自动化断言
    hideSpotlight();
    if (!targetEl) return;
    const rect = targetEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const pad = opts.pad ?? 8;
    const hole = document.createElement('div');
    hole.className = 'spotlight-hole';
    hole.style.left = (rect.left - pad) + 'px';
    hole.style.top = (rect.top - pad) + 'px';
    hole.style.width = (rect.width + pad * 2) + 'px';
    hole.style.height = (rect.height + pad * 2) + 'px';
    document.body.appendChild(hole);

    let tip = null;
    if (tipText) {
        tip = document.createElement('div');
        tip.className = 'spotlight-tip ' + (opts.place === 'above' ? 'above' : 'below');
        tip.innerHTML = `<span class="spotlight-arrow"></span><span>${tipText}</span>`;
        document.body.appendChild(tip);
        const tipRect = tip.getBoundingClientRect();
        let left = rect.left + rect.width / 2 - tipRect.width / 2;
        left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
        tip.style.left = left + 'px';
        if (opts.place === 'above') {
            tip.style.top = (rect.top - tipRect.height - 16) + 'px';
        } else {
            tip.style.top = (rect.bottom + 16) + 'px';
        }
    }

    if (opts.autoHide !== false) {
        targetEl.addEventListener('click', hideSpotlight, { once: true });
    }
    return { hole, tip };
}

function hideSpotlight() {
    document.querySelectorAll('.spotlight-hole, .spotlight-tip').forEach(el => el.remove());
}

/* ==================== 追问引导（知识串联） ==================== */
// 从导师回答文本中提取「追问：xxx」标记，返回 { text, followUp }
function extractFollowUp(text) {
    if (!text) return { text: '', followUp: null };
    // 优先「追问：」标记（LLM 实时答案）
    const idx = text.indexOf('追问：');
    if (idx !== -1) {
        const followUp = text.slice(idx + 3).trim().replace(/[。！!？?]+$/, '');
        return { text: text.slice(0, idx).trim(), followUp };
    }
    // 兜底：正则提取结尾的追问句（预置答案）
    const m = text.match(/(?:想知道|想了解|想听听|要不要)[^。！!？?]*[吗么]?[？?]/);
    if (m) {
        const followUp = m[0].replace(/^要不要/, '想知道').trim();
        return { text: text.replace(m[0], '').trim(), followUp };
    }
    return { text, followUp: null };
}

// 渲染可点击的「追问」按钮，点击后自动以该问题发起新追问（串联知识）
function renderFollowUpButton(container, followUp) {
    if (!followUp) return;
    const btn = document.createElement('div');
    btn.className = 'follow-up-btn';
    btn.innerHTML = `<span class="fu-icon">🔗</span><span class="fu-text">追问：${followUp}</span>`;
    btn.title = '点击继续追问';
    btn.onclick = () => {
        hideSpotlight();
        const input = document.getElementById('question-input');
        const area = document.getElementById('question-input-area');
        if (input && area) {
            area.classList.add('expanded');
            input.value = followUp;
            sendQuestion();
        }
    };
    container.appendChild(btn);
}

function startTypewriter() {
    const contentElId = typewriterState.contentElId || 'active-content';
    const contentEl = document.getElementById(contentElId);
    if (!contentEl) return;

    function typeNext() {
        if (!typewriterState.isTyping) return;

        if (typewriterState.charIndex < typewriterState.fullText.length) {
            // 处理HTML标签 - 一次性添加标签内容
            const remaining = typewriterState.fullText.substring(typewriterState.charIndex);
            const tagMatch = remaining.match(/^<[^>]+>/);

            if (tagMatch) {
                typewriterState.displayedText += tagMatch[0];
                typewriterState.charIndex += tagMatch[0].length;
            } else {
                typewriterState.displayedText += remaining[0];
                typewriterState.charIndex++;
            }

            contentEl.innerHTML = typewriterState.displayedText + '<span class="cursor"></span>';
            typewriterState.timer = setTimeout(typeNext, typewriterState.speed);
        } else {
            // 打字完成
            contentEl.innerHTML = typewriterState.displayedText;
            typewriterState.isTyping = false;
            if (typewriterState.onComplete) {
                typewriterState.onComplete();
            }
        }
    }

    typeNext();
}

function skipTypewriter() {
    if (typewriterState.isTyping) {
        clearTimeout(typewriterState.timer);
        const contentElId = typewriterState.contentElId || 'active-content';
        const contentEl = document.getElementById(contentElId);
        if (contentEl) {
            contentEl.innerHTML = typewriterState.fullText;
        }
        typewriterState.isTyping = false;
        if (typewriterState.onComplete) {
            typewriterState.onComplete();
        }
    }
}

function showNextHint(callback) {
    const card = document.getElementById('active-card');
    if (!card) return;
    const hint = document.createElement('div');
    hint.className = 'next-hint';
    hint.textContent = '继续 →';
    hint.onclick = callback;
    card.appendChild(hint);
}

function showMessages(science, culture) {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';

    const sci = extractFollowUp(science);
    const cul = extractFollowUp(culture);

    const scienceDiv = document.createElement('div');
    scienceDiv.className = 'message-card science';
    scienceDiv.innerHTML = `<div class="agent">开普勒</div><div class="content-wrapper"><div class="content">${sci.text}</div></div>`;

    const cultureDiv = document.createElement('div');
    cultureDiv.className = 'message-card culture';
    cultureDiv.innerHTML = `<div class="agent">甘德</div><div class="content-wrapper"><div class="content">${cul.text}</div></div>`;

    container.appendChild(scienceDiv);
    container.appendChild(cultureDiv);

    // 追问按钮（优先甘德的追问，其次开普勒的）
    renderFollowUpButton(container, cul.followUp || sci.followUp);
}

function showFinalMessage(content) {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';

    const div = document.createElement('div');
    div.className = 'message-card archive-card';
    div.innerHTML = `
        <div class="archive-title">✧ 星辰启示录 ✧</div>
        <div class="content archive-body">${content.replace(/\n/g, '<br>')}</div>
        <div class="archive-actions">
            <button onclick="saveArchiveAndContinue()" class="btn btn-culture">保存档案</button>
            <button onclick="continueExploring()" class="btn btn-science">继续探索</button>
        </div>
        <div id="save-confirm" class="save-confirm-text" style="display: none;">✓ 启示录已保存到档案</div>
    `;

    container.appendChild(div);
}

window.closeArchive = function() {
    // 关闭启示录：回到星空视图，不重置全部状态，用户可继续观察星空或探索下一颗星
    const container = document.getElementById('chat-messages');
    container.innerHTML = `
        <div class="message-card culture" id="welcome-card">
            <div class="agent">太史令</div>
            <div class="content-wrapper">
                <div class="content">星辰已觉醒，抬头看看星空吧。输入下一颗星辰名称，继续您的探索之旅。</div>
            </div>
        </div>
    `;
    document.getElementById('chat-status').textContent = '星辰已觉醒 · 继续探索下一颗星';
    state.phase = 'welcome';
    state.currentStar = null;
    state.currentStarId = null;
};

window.saveArchiveAndContinue = function() {
    document.getElementById('save-confirm').style.display = 'block';
    // 更新觉醒计数
    if (state.currentStar) {
        state.awakenedCount++;
        state.currentStar = null;
    }
    checkAchievements();
};

window.continueExploring = function() {
    // 重置UI为初始状态
    const container = document.getElementById('chat-messages');
    container.innerHTML = `
        <div class="message-card culture" id="welcome-card">
            <div class="agent">甘德</div>
            <div class="content-wrapper">
                <div class="content">守夜人，请继续您的探索之旅。输入下一个星辰名称，我将为您讲述古人对它的解读。</div>
            </div>
        </div>
    `;
    document.getElementById('chat-status').textContent = '等待守夜人的指令...';

    // 重置望远镜视角
    focusTarget = null;
    focusProgress = 0;
    focusDistance = 200;
    clearStageHalo();
    camera.fov = 65;
    camera.updateProjectionMatrix();
    camera.position.set(0, 0, 500);
    camera.lookAt(0, 0, 0);
    targetRotation = { x: 0, y: 0, z: 0 };
    currentRotation = { x: 0, y: 0, z: 0 };

    state.phase = 'welcome';
    // 累计追问数不清零（故事框架3.3：追问成就按全程累计）
    state.currentStar = null;
    state.currentStarId = null;
    state.litNodes = [];
    state.currentStage = 0;
    state.isBalanced = false;
    collapseQuestionInput();
    document.getElementById('awaken-input-area').classList.remove('visible');
    const searchInput = document.getElementById('star-search');
    searchInput.value = '';
    searchInput.focus();
};

function showLoading() {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'message-card loading-card';
    loading.id = 'loading-msg';
    loading.innerHTML = '<div class="content loading-inline"><span class="spinner"></span>导师正在思考…</div>';
    container.appendChild(loading);
}

function hideLoading() {
    const loading = document.getElementById('loading-msg');
    if (loading) loading.remove();
    state.isLoading = false;
}

function showError(msg) {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'message-card error-card';
    div.innerHTML = `<div class="agent">错误</div><div class="content-wrapper"><div class="content">${msg}</div></div>`;
    container.appendChild(div);
    state.isLoading = false;
}

// ==================== 阶段更新 ====================
function updateStage(stage) {
    state.currentStage = stage;
    const stageNames = ['尘封', '初现', '追问', '抉择', '映射', '共鸣', '觉醒'];
    const name = stage >= 1 && stage <= 7 ? stageNames[stage - 1] : '等待探索';
    document.getElementById('stage-name').textContent = name;

    // 更新阶段指示器
    document.querySelectorAll('.stage-dot').forEach((dot, i) => {
        dot.classList.remove('active', 'awakened');
        if (i < stage) {
            dot.classList.add(i === 6 ? 'awakened' : 'active');
        }
    });
}

function showStarInfo(star) {
    const infoPanel = document.getElementById('star-info');
    if (!infoPanel) return;

    // 标题：星名 (英文名)
    const snEl = document.getElementById('star-name');
    if (snEl) snEl.textContent = star.name_cn + (star.name_en ? ' (' + star.name_en + ')' : '');

    // 查找匹配的星辰档案（按中文名匹配）
    const profile = findStarProfile(star.name_cn);

    // ── 科学面板 3 字段 ──
    // 字段1：名称
    const sciNameEl = document.getElementById('sci-name');
    if (sciNameEl) {
        sciNameEl.textContent = profile
            ? (profile.name_en || star.name_en || star.name_cn)
            : (star.name_en || star.name_cn);
    }

    // 字段2：光谱型 + 星等
    const sciSpecEl = document.getElementById('sci-spec');
    if (sciSpecEl) {
        const magStr = star.magnitude !== undefined ? '视星等 ' + Number(star.magnitude).toFixed(1) : '';
        const ciStr = star.ci !== undefined ? ' · CI ' + Number(star.ci).toFixed(2) : '';
        if (profile && profile.science && profile.science.data) {
            const d = profile.science.data;
            const brightness = d.brightness || magStr;
            const distance = d.distance || '';
            const color = d.color || '';
            sciSpecEl.textContent = [brightness, distance, color].filter(Boolean).join(' · ');
        } else {
            sciSpecEl.textContent = (magStr + ciStr) || '数据加载中...';
        }
    }

    // 字段3：一句话科普
    const sciNoteEl = document.getElementById('sci-note');
    if (sciNoteEl) {
        if (profile && profile.science) {
            sciNoteEl.textContent = profile.science.wow || profile.science.what || '';
        } else {
            // 回退：基于光谱型生成描述
            sciNoteEl.textContent = star.ci !== undefined
                ? (star.ci < 0.3 ? '高温蓝色恒星，表面温度超过 10,000 K' :
                   star.ci < 0.6 ? '白色恒星，类似天狼星' :
                   star.ci < 1.0 ? '黄色恒星，类似我们的太阳' :
                   star.ci < 1.5 ? '橙色恒星，表面温度较低' : '红色冷恒星，处于生命晚期')
                : '点击"发射探索"了解这颗星的故事';
        }
    }

    // ── 星象面板 3 字段 ──
    // 字段1：古名
    const culNameEl = document.getElementById('cul-name');
    if (culNameEl) {
        if (profile && profile.culture) {
            // 从 culture.what 提取古名（通常是第一句）
            const what = profile.culture.what || '';
            culNameEl.textContent = what.split('。')[0] || star.name_cn;
        } else {
            culNameEl.textContent = star.name_cn;
        }
    }

    // 字段2：所属星官
    const culAsterismEl = document.getElementById('cul-asterism');
    if (culAsterismEl) {
        if (profile && profile.culture && profile.culture.what) {
            // 尝试从 culture.what 中提取星官名（通常含"××星官"、"××宿"、"××垣"等）
            const what = profile.culture.what;
            const asterismMatch = what.match(/[^，。、]*?[宿垣座官宫][^，。、]{0,6}/);
            culAsterismEl.textContent = asterismMatch ? asterismMatch[0] : '星官待考';
        } else {
            // 回退：从 constellation 数据反查
            culAsterismEl.textContent = findConstellationForStar(star) || '星官待考';
        }
    }

    // 字段3：一句诗/典故
    const culPoetryEl = document.getElementById('cul-poetry');
    if (culPoetryEl) {
        const poetry = findPoetryForStar(star.name_cn);
        if (poetry) {
            culPoetryEl.textContent = '《' + poetry.title + '》' + poetry.content.substring(0, 30) + '…';
        } else if (profile && profile.culture && profile.culture.story) {
            culPoetryEl.textContent = profile.culture.story.substring(0, 50) + '…';
        } else {
            culPoetryEl.textContent = '「星汉灿烂，若出其里」——曹操《观沧海》';
        }
    }

    infoPanel.classList.add('visible');
}

/** 按中文名查找星辰档案 */
function findStarProfile(nameCn) {
    if (!state.starProfiles || !nameCn) return null;
    for (const key of Object.keys(state.starProfiles)) {
        if (state.starProfiles[key].name_cn === nameCn) {
            return state.starProfiles[key];
        }
    }
    // 模糊匹配（如"牛郎星"匹配"牛郎织女"）
    for (const key of Object.keys(state.starProfiles)) {
        const profileName = state.starProfiles[key].name_cn;
        if (profileName && (profileName.includes(nameCn) || nameCn.includes(profileName))) {
            return state.starProfiles[key];
        }
    }
    return null;
}

/** 从星官数据反查恒星所属星座（IAU） */
function findConstellationForStar(star) {
    if (!state.constellations || !star || !star.hr) return null;
    // constellations 格式：{ "And": { count, stars: [hr, ...] }, ... }
    for (const [abbr, con] of Object.entries(state.constellations)) {
        if (con.stars && con.stars.includes(star.hr)) {
            return abbr; // IAU 缩写即星座名
        }
    }
    return null;
}

/** 从诗词数据匹配星辰相关的诗句 */
function findPoetryForStar(nameCn) {
    if (!state.starPoetry || !nameCn) return null;
    for (const poem of state.starPoetry) {
        const starField = poem.star || '';
        if (starField.includes(nameCn) || nameCn.includes(starField)) {
            return poem;
        }
    }
    // 模糊匹配：检查诗句是否提及星名中的关键字
    const keywords = nameCn.replace(/[星宿座]/g, '').trim();
    for (const poem of state.starPoetry) {
        const starField = poem.star || '';
        if (keywords && starField && (starField.includes(keywords) || keywords.includes(starField))) {
            return poem;
        }
    }
    return null;
}

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', async () => {
    console.log('DOM loaded, initializing...');

    try {
        // 初始化 Three.js
        await initThree();
        initStarLabels();
        // 初始即覆盖认知迷雾（故事框架：星图初始大部分被迷雾笼罩）
        createFogMesh();
        updateFogState();
        console.log('Three.js initialized');
    } catch (e) {
        console.error('initThree error:', e);
    }

    // 加载持久化进度（觉醒星、迷雾状态）
    const savedSessionId = localStorage.getItem('tianwen_session_id');
    if (savedSessionId) {
        state.sessionId = savedSessionId;
    }
    loadPersistedProgress();

    // 加载星空异动记录
    loadAnomalyLog();
    loadArchives();
    const anomalyCountEl = document.getElementById('anomaly-count');
    if (anomalyCountEl) {
        anomalyCountEl.textContent = state.anomalyLog.length;
    }

    // 全景模式
    // 标签开关
    const labelToggleBtn = document.getElementById('label-toggle-btn');
    if (labelToggleBtn) {
        labelToggleBtn.addEventListener('click', () => {
            state.showLabels = !state.showLabels;
            if (labelToggleBtn) {
                labelToggleBtn.classList.toggle('off', !state.showLabels);
                labelToggleBtn.setAttribute('aria-pressed', state.showLabels ? 'true' : 'false');
            }
            if (labelContainer) {
                labelContainer.style.display = state.showLabels ? 'block' : 'none';
            }
        });
    }
    let panoramaMode = false;
    const panoramaBtn = document.getElementById('panorama-btn');
    if (panoramaBtn) {
        panoramaBtn.addEventListener('click', () => {
            panoramaMode = !panoramaMode;
            document.body.classList.toggle('panorama-mode', panoramaMode);
            panoramaBtn.textContent = panoramaMode ? '✕ 退出全景' : '🔭 全景';
            // 延迟resize让布局更新
            setTimeout(() => {
                window.dispatchEvent(new Event('resize'));
            }, 300);
        });
    }

    // 成就徽章点击打开成就面板
    const achievementBadge = document.getElementById('achievement-badge');
    if (achievementBadge) {
        achievementBadge.addEventListener('click', showAchievementPanel);
    }

    // 星空异动徽章点击打开异动记录
    const anomalyBadge = document.getElementById('anomaly-badge');
    if (anomalyBadge) {
        anomalyBadge.addEventListener('click', showAnomalyLog);
    }

    // 星辰库折叠切换
    const catalogToggle = document.getElementById('catalog-toggle');
    const starCatalogEl = document.getElementById('star-catalog');
    if (catalogToggle && starCatalogEl) {
        catalogToggle.addEventListener('click', () => {
            const isOpen = starCatalogEl.classList.toggle('open');
            catalogToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        });
    }

    // 移动端控制面板抽屉
    const drawerBtn = document.getElementById('panel-drawer-btn');
    if (drawerBtn) {
        drawerBtn.addEventListener('click', () => {
            const open = document.body.classList.toggle('panel-open');
            drawerBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
            drawerBtn.setAttribute('aria-label', open ? '关闭控制面板' : '打开控制面板');
            drawerBtn.textContent = open ? '✕' : '☰';
        });
        // 移动端发起探索后自动收起抽屉
        const sendBtnEl = document.getElementById('send-btn');
        if (sendBtnEl) {
            sendBtnEl.addEventListener('click', () => {
                if (window.innerWidth <= 900 && document.body.classList.contains('panel-open')) {
                    document.body.classList.remove('panel-open');
                    drawerBtn.setAttribute('aria-expanded', 'false');
                    drawerBtn.setAttribute('aria-label', '打开控制面板');
                    drawerBtn.textContent = '☰';
                }
            });
        }
    }

    // 新手引导 - 多步骤
    const introOverlay = document.getElementById('intro-overlay');
    let introStep = 0;
    const introSteps = document.querySelectorAll('.intro-step');
    const totalSteps = introSteps.length;

    function showIntroStep(n) {
        introSteps.forEach((s, i) => s.classList.toggle('active', i === n));
        document.querySelectorAll('.intro-dot').forEach((d, i) => d.classList.toggle('active', i === n));
        document.getElementById('intro-prev').style.display = n === 0 ? 'none' : 'inline-flex';
        document.getElementById('intro-next').style.display = n === totalSteps - 1 ? 'none' : 'inline-flex';
        document.getElementById('start-btn').style.display = n === totalSteps - 1 ? 'inline-flex' : 'none';
    }

    document.getElementById('intro-next').addEventListener('click', () => {
        if (introStep < totalSteps - 1) {
            introStep++;
            showIntroStep(introStep);
        }
    });

    document.getElementById('intro-prev').addEventListener('click', () => {
        if (introStep > 0) {
            introStep--;
            showIntroStep(introStep);
        }
    });

    const startBtn = document.getElementById('start-btn');
    if (startBtn) {
        startBtn.addEventListener('click', () => {
            introOverlay.classList.add('hidden');
            // 自动定位北极星并触发探索
            const polaris = state.starCatalog.find(s => s.name_en === 'Polaris' || s.hr === 424);
            if (polaris) {
                state.currentStar = polaris;
                showStarInfo(polaris);
                focusOnStar(polaris);
                const searchInput = document.getElementById('star-search');
                searchInput.value = '北极星';
                sendMessage('北极星', 'polaris', null, 'initial');
            }
        });
    }

    if (window.__skipIntro) {
        introOverlay.classList.add('hidden');
    } else {
        showIntroStep(0);
    }

    // 发送按钮
    function resolveStarIdByInput(input) {
        const map = {
            '北极星': 'polaris', 'polaris': 'polaris',
            '北斗七星': 'big_dipper', 'big dipper': 'big_dipper', '天上的勺子': 'big_dipper',
            '参宿四': 'betelgeuse', 'betelgeuse': 'betelgeuse', '猎户座': 'betelgeuse',
            '心宿二': 'antares', 'antares': 'antares', '天蝎座': 'antares',
            '牛郎织女': 'altair_vega', '牛郎星': 'altair_vega', '织女星': 'altair_vega',
            'altair': 'altair_vega', 'vega': 'altair_vega',
            '天狼星': 'sirius', 'sirius': 'sirius',
            '老人星': 'canopus', 'canopus': 'canopus', '南极老人': 'canopus',
            '大角星': 'arcturus', 'arcturus': 'arcturus'
        };
        const key = input.trim().toLowerCase();
        if (map[key]) return map[key];
        // 未知星：用输入名称生成ID，让 MiniMax 动态回答
        return 'star_' + key.replace(/\s+/g, '_').replace(/[^a-z0-9_一-鿿]/gi, '');
    }

    document.getElementById('send-btn').addEventListener('click', () => {
        const input = document.getElementById('star-search');
        const content = input.value.trim();
        if (!content) return;
        const starId = resolveStarIdByInput(content);
        state.currentStarId = starId;
        // 尝试在星表中找到对应星体，便于后续聚焦定位
        const found = state.starCatalog.find(s => {
            const names = [s.name_cn, s.name_en].filter(Boolean).map(n => n.toLowerCase());
            return names.includes(content.toLowerCase());
        });
        state.currentStar = found || null;
        // 阶段一"星辰显现"：搜索命中后聚焦星体并解锁档案面板（与目录点击/引导流程一致）
        if (found) {
            showStarInfo(found);
            focusOnStar(found);
        }
        sendMessage(content, starId, null, 'initial');
        input.value = '';
    });

    // 回车发送
    document.getElementById('star-search').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            document.getElementById('send-btn').click();
        }
    });

    // Question input
    const questionInput = document.getElementById('question-input');
    const questionSendBtn = document.getElementById('question-send-btn');
    if (questionInput && questionSendBtn) {
        questionSendBtn.addEventListener('click', sendQuestion);
        questionInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendQuestion();
        });
    }

    // Awaken save button
    const awakenSaveBtn = document.getElementById('awaken-save-btn');
    if (awakenSaveBtn) {
        awakenSaveBtn.addEventListener('click', () => {
            const note = document.getElementById('awaken-note').value.trim();
            sendMessage(note, state.currentStarId, null, 'awaken');
        });
    }

    // 提问折叠按钮（展开）
    const questionToggleBtn = document.getElementById('question-toggle-btn');
    if (questionToggleBtn) {
        questionToggleBtn.addEventListener('click', () => {
            const area = document.getElementById('question-input-area');
            area.classList.add('expanded');
            questionToggleBtn.classList.remove('visible', 'glow');
            document.getElementById('question-input').focus();
            hideSpotlight();
            // 引导：输入好奇，然后点击「提问」
            setTimeout(() => {
                showSpotlight(
                    document.getElementById('question-input-row'),
                    '输入你的好奇，然后点击「提问」',
                    { place: 'above', pad: 10 }
                );
            }, 350);
        });
    }

    // 收起按钮（在输入框内）
    const questionCollapseBtn = document.getElementById('question-collapse-btn');
    if (questionCollapseBtn) {
        questionCollapseBtn.addEventListener('click', () => {
            collapseQuestionInput();
            hideSpotlight();
            // 收起追问框后：若已追问过，引导拖动罗盘融合
            if (state.phase === 'questioning') {
                setTimeout(() => {
                    showSpotlight(
                        document.getElementById('bipolar-slider'),
                        '拖动罗盘到中间，让科学与星象交融',
                        { place: 'above', pad: 14 }
                    );
                }, 450);
            }
        });
    }

    // 双极罗盘（五步循环第 4 步：拖动交融，拖到中间松手触发融合总结）
    const bipolarSlider = document.getElementById('bipolar-slider');
    if (bipolarSlider) {
        bipolarSlider.addEventListener('input', (e) => {
            state.bipolarValue = parseInt(e.target.value);
            updateBipolarView();
            // 拖动时实时提示交融度（开场/追问阶段）
            if (state.phase === 'initial' || state.phase === 'questioning') {
                const statusEl = document.getElementById('chat-status');
                const balance = (parseInt(e.target.value) - 50) / 50;
                if (Math.abs(balance) < 0.3) {
                    statusEl.textContent = '👌 就在中间！松手让两位导师的话交融';
                } else {
                    statusEl.textContent = `拖动罗盘，让两位导师的话交融…（${balance < 0 ? '偏向科学' : '偏向星象'}）`;
                }
            }
        });
        bipolarSlider.addEventListener('change', () => {
            if (state.phase === 'initial' || state.phase === 'questioning') {
                const value = parseInt(bipolarSlider.value);
                const balance = (value - 50) / 50;
                sendBlend(balance);
            }
        });
    }

    // 初始化双极杆视觉状态（先罗盘后频道主题，确保频道主题最终生效）
    updateBipolarView();
    updateChannelView();
});

/**
 * 罗盘融合（五步循环第 4 步）：松手时发送 blend 动作。
 * 未平衡：后端返回"交融中"提示；平衡：返回融合总结（resonance）→ 显示总结 + 觉醒输入。
 */
async function sendBlend(balance) {
    if (state.isLoading) return;
    const starId = state.currentStarId;
    if (!starId) return;
    state.isLoading = true;
    try {
        const body = {
            action: 'blend',
            star_id: starId,
            content: '',
            model: 'minimax',
            fusion_balance: balance
        };
        if (state.sessionId) body.session_id = state.sessionId;
        let response;
        try {
            response = await fetch(`${API_BASE}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        } catch (networkError) {
            showError('连接服务器失败，请检查网络后重试');
            return;
        }
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || `请求失败（HTTP ${response.status}）`);
        if (data.detail) throw new Error(data.detail);
        state.sessionId = data.session_id;
        if (data.session_id) {
            localStorage.setItem('tianwen_session_id', data.session_id);
        }

        updateStageFromBackend(data);
        const statusEl = document.getElementById('chat-status');
        const awakenArea = document.getElementById('awaken-input-area');

        if (data.is_balanced && data.resonance) {
            // 融合达成：显示融合总结，先通过星空小测验再写感悟
            state.phase = 'resonance';
            if (statusEl) statusEl.textContent = '双导师的话在罗盘中央交融。先通过星空小测验，再写下你的感悟。';
            showResonance(data.resonance);
            if (awakenArea) awakenArea.classList.remove('visible');
            sendQuiz(starId);
        } else {
            // 交融中：提示继续拖动
            if (statusEl) statusEl.textContent = data.message || '继续拖动罗盘，让两位导师的话交融…';
        }
    } catch (error) {
        showError('罗盘融合失败：' + error.message);
    } finally {
        state.isLoading = false;
    }
}

/** 星空小测验：立即用本地预置题渲染（0 延迟），后台请求 LLM 动态出题成功后替换 */
async function sendQuiz(starId) {
    if (!starId) return;

    // 立即用本地预置题渲染（用户马上看到题目，不等待）
    const profile = state.starProfiles[starId];
    const preset = profile && Array.isArray(profile.quiz) && profile.quiz.length ? profile.quiz : null;
    if (preset) {
        state.quiz = { questions: preset, index: 0, score: 0, done: false, _preset: true, _started: false };
        showQuizPanel();
    }

    // 后台请求 LLM 动态出题（不阻塞预置题的显示）
    try {
        const body = {
            action: 'quiz',
            star_id: starId,
            content: '',
            model: 'minimax',
            fragments: state.fragments || [],
            force_llm: true
        };
        if (state.sessionId) body.session_id = state.sessionId;
        let response;
        try {
            response = await fetch(`${API_BASE}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        } catch (networkError) {
            return; // 网络失败：保持预置题
        }
        const data = await response.json();
        if (!response.ok || !data.quiz || !data.quiz.length) return; // 动态出题失败：保持预置题
        if (data.session_id) {
            state.sessionId = data.session_id;
            localStorage.setItem('tianwen_session_id', data.session_id);
        }
        // 仅当用户尚未开始作答时，才用动态题替换预置题
        if (state.quiz && state.quiz._preset && !state.quiz._started) {
            state.quiz = { questions: data.quiz, index: 0, score: 0, done: false };
            renderQuizQuestion();
        }
    } catch (error) {
        // 动态出题失败：静默保持预置题，不打扰用户
    }
}

function showQuizPanel() {
    const panel = document.getElementById('quiz-panel');
    if (panel) panel.style.display = 'block';
    renderQuizQuestion();
}

function renderQuizQuestion() {
    const q = state.quiz.questions[state.quiz.index];
    if (!q) { finishQuiz(); return; }
    document.getElementById('quiz-progress').textContent = `第 ${state.quiz.index + 1} / ${state.quiz.questions.length} 题`;
    document.getElementById('quiz-question').textContent = q.q;
    const explainEl = document.getElementById('quiz-explain');
    const nextBtn = document.getElementById('quiz-next-btn');
    const finishBtn = document.getElementById('quiz-finish-btn');
    explainEl.style.display = 'none';
    nextBtn.style.display = 'none';
    finishBtn.style.display = 'none';
    const optionsEl = document.getElementById('quiz-options');
    optionsEl.innerHTML = '';
    q.options.forEach((opt, i) => {
        const btn = document.createElement('button');
        btn.className = 'quiz-option';
        btn.textContent = opt;
        btn.addEventListener('click', () => answerQuiz(i, btn));
        optionsEl.appendChild(btn);
    });
}

function answerQuiz(choice, btnEl) {
    const q = state.quiz.questions[state.quiz.index];
    if (!q) return;
    state.quiz._started = true; // 用户已开始作答，动态题不再替换
    const optionsEl = document.getElementById('quiz-options');
    const explainEl = document.getElementById('quiz-explain');
    const nextBtn = document.getElementById('quiz-next-btn');
    const finishBtn = document.getElementById('quiz-finish-btn');

    if (choice === q.answer) {
        // 答对：锁定全部选项，得分，显示解析，短暂延迟后自动进入下一题
        [...optionsEl.children].forEach(b => { b.disabled = true; });
        state.quiz.score++;
        btnEl.classList.add('correct');
        explainEl.textContent = q.explain || '';
        explainEl.style.display = 'block';
        const isLast = state.quiz.index >= state.quiz.questions.length - 1;
        setTimeout(() => {
            if (isLast) {
                finishQuiz();
            } else {
                state.quiz.index++;
                renderQuizQuestion();
            }
        }, 1400);
    } else {
        // 答错：仅禁用该错误选项（允许重新选择），同时显示「下一题」可跳过
        btnEl.classList.add('wrong');
        btnEl.disabled = true;
        explainEl.textContent = '✗ 不对哦，再选选看？也可以直接进入下一题。';
        explainEl.style.display = 'block';
        const isLast = state.quiz.index >= state.quiz.questions.length - 1;
        if (isLast) {
            finishBtn.style.display = 'inline-block';
            finishBtn.onclick = finishQuiz;
        } else {
            nextBtn.style.display = 'inline-block';
            nextBtn.onclick = () => { state.quiz.index++; renderQuizQuestion(); };
        }
    }
}

function finishQuiz() {
    const panel = document.getElementById('quiz-panel');
    const statusEl = document.getElementById('chat-status');
    const awakenArea = document.getElementById('awaken-input-area');
    const score = state.quiz.score, total = state.quiz.questions.length;
    state.quiz.done = true;
    const head = panel.querySelector('.quiz-head');
    head.textContent = `✧ 测验完成：答对 ${score}/${total} ✧`;
    document.getElementById('quiz-progress').textContent =
        score === total ? '全对！你已经是守夜之星 ✨'
        : (score >= 2 ? '知识很扎实，继续保持！' : '错题是最好的复习，看了解析再感悟吧');
    document.getElementById('quiz-question').textContent = '';
    document.getElementById('quiz-options').innerHTML = '';
    document.getElementById('quiz-explain').style.display = 'none';
    document.getElementById('quiz-next-btn').style.display = 'none';
    document.getElementById('quiz-finish-btn').style.display = 'none';
    if (statusEl) statusEl.textContent = '测验完成。写下你的感悟，完成觉醒。';
    if (awakenArea) awakenArea.classList.add('visible');
}
