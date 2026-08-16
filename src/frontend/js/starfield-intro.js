/**
 * 开场星座穿越封面动画（替代上一版星空封面）
 * 来源：constellation.html —— 多彩星轨 + 星云 + 远景闪烁 + 五座星座（逐星连线触发）
 * 自动播放 10 秒后进入视频；用户点击可提前进入（拖拽旋转不算点击）。
 * 使用 index.html 中已配置的 importmap（three@0.160.0）。
 */
import * as THREE from 'three';

// 找到封面容器内的 canvas（项目 index.html 中位于 #cover-overlay 内）
const canvas = document.getElementById('cover-starfield');
const overlay = document.getElementById('cover-overlay');

// 测试模式：不初始化动画
if (canvas && overlay && window.__testMode === true) {
    overlay.style.display = 'none';
}

// 仅在 canvas 存在时启动（正常浏览器环境）
if (canvas && overlay && window.__testMode !== true) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x010209);
    const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 9000);
    camera.position.set(0, 0, 0);

    // ---------- 多彩调色板 ----------
    const PALETTE = [
        { c: [1.00, 1.00, 1.00], w: 36 }, { c: [0.62, 0.76, 1.00], w: 18 },
        { c: [0.45, 0.60, 1.00], w: 8 }, { c: [1.00, 0.86, 0.62], w: 14 },
        { c: [1.00, 0.68, 0.42], w: 7 }, { c: [1.00, 0.52, 0.52], w: 5 },
        { c: [0.72, 1.00, 0.86], w: 4 }, { c: [0.86, 0.68, 1.00], w: 5 },
        { c: [1.00, 0.68, 0.92], w: 3 },
    ];
    const PALETTE_TOTAL = PALETTE.reduce((s, p) => s + p.w, 0);
    function starColor() {
        let r = Math.random() * PALETTE_TOTAL;
        for (const p of PALETTE) { r -= p.w; if (r <= 0) return p.c; }
        return PALETTE[0].c;
    }

    // ---------- 共享星星着色器（透视大小 + 闪烁 + 整体透明度） ----------
    const starVert = /* glsl */`
        attribute float aPhase;
        attribute float aFreq;
        attribute float aSize;
        attribute vec3  aTint;
        uniform float uTime;
        uniform float uPixelRatio;
        varying float vAlpha;
        varying vec3  vTint;
        void main() {
            float tw  = sin(uTime * aFreq + aPhase);
            float tw2 = sin(uTime * aFreq * 0.41 + aPhase * 1.9);
            vAlpha = 0.45 + 0.55 * pow(0.5 + 0.5 * tw * (0.7 + 0.3 * tw2), 2.0);
            vTint  = aTint;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = aSize * uPixelRatio * (320.0 / -mv.z) * (0.85 + 0.3 * tw);
            gl_Position = projectionMatrix * mv;
        }`;
    const starFrag = /* glsl */`
        uniform float uOpacity;
        varying float vAlpha;
        varying vec3  vTint;
        void main() {
            vec2 d = gl_PointCoord - 0.5;
            float r = length(d);
            if (r > 0.5) discard;
            float glow = smoothstep(0.5, 0.0, r);
            glow *= glow;
            gl_FragColor = vec4(vTint, vAlpha * glow * uOpacity);
        }`;

    // =====================================================================
    //  一、星轨拖尾层（运动跟随相机速度）
    // =====================================================================
    const FIELD = { count: 2000, width: 900, height: 600, depth: 2200 };
    const streakGeo = new THREE.BufferGeometry();
    const sPos = new Float32Array(FIELD.count * 2 * 3);
    const sCol = new Float32Array(FIELD.count * 2 * 3);
    const starX = new Float32Array(FIELD.count);
    const starY = new Float32Array(FIELD.count);
    const starZ = new Float32Array(FIELD.count);
    const starCols = new Float32Array(FIELD.count * 3);

    for (let i = 0; i < FIELD.count; i++) {
        starX[i] = (Math.random() * 2 - 1) * FIELD.width;
        starY[i] = (Math.random() * 2 - 1) * FIELD.height;
        starZ[i] = -Math.random() * FIELD.depth;
        const c = starColor();
        sCol.set([...c, c[0] * 0.15, c[1] * 0.15, c[2] * 0.15], i * 6);
        starCols.set(c, i * 3);
    }
    streakGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
    streakGeo.setAttribute('color', new THREE.BufferAttribute(sCol, 3));
    const streaks = new THREE.LineSegments(streakGeo, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 1.0,
        blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    streaks.frustumCulled = false;
    scene.add(streaks);

    const headGeo = new THREE.BufferGeometry();
    const hPos = new Float32Array(FIELD.count * 3);
    const hCol = new Float32Array(FIELD.count * 3);
    hCol.set(starCols);
    headGeo.setAttribute('position', new THREE.BufferAttribute(hPos, 3));
    headGeo.setAttribute('color', new THREE.BufferAttribute(hCol, 3));
    const heads = new THREE.Points(headGeo, new THREE.PointsMaterial({
        vertexColors: true, size: 2.6, sizeAttenuation: false,
        transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    heads.frustumCulled = false;
    scene.add(heads);

    // =====================================================================
    //  二、星云层（8 团，跟随相机平移）
    // =====================================================================
    function makeNebulaTexture(inner, mid) {
        const size = 256;
        const cv = document.createElement('canvas');
        cv.width = cv.height = size;
        const ctx = cv.getContext('2d');
        const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        g.addColorStop(0.0, inner);
        g.addColorStop(0.35, mid);
        g.addColorStop(1.0, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        ctx.globalCompositeOperation = 'lighter';
        const g2 = ctx.createRadialGradient(size * 0.38, size * 0.6, 0, size * 0.38, size * 0.6, size * 0.45);
        g2.addColorStop(0.0, mid);
        g2.addColorStop(1.0, 'rgba(0,0,0,0)');
        ctx.fillStyle = g2;
        ctx.fillRect(0, 0, size, size);
        const tex = new THREE.CanvasTexture(cv);
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
    }
    const NEBULA_DEFS = [
        { inner: 'rgba(116, 76, 230, 0.80)', mid: 'rgba(76, 40, 175, 0.45)', scale: 5200, dir: [0.70, 0.50, -0.50] },
        { inner: 'rgba(56, 130, 250, 0.75)', mid: 'rgba(30, 76, 200, 0.42)', scale: 4600, dir: [-0.75, 0.55, -0.40] },
        { inner: 'rgba(225, 76, 165, 0.65)', mid: 'rgba(155, 40, 120, 0.36)', scale: 4000, dir: [0.80, -0.55, -0.30] },
        { inner: 'rgba(40, 200, 210, 0.60)', mid: 'rgba(26, 120, 155, 0.33)', scale: 3400, dir: [-0.70, -0.60, -0.45] },
        { inner: 'rgba(145, 80, 250, 0.62)', mid: 'rgba(88, 52, 195, 0.34)', scale: 3000, dir: [1.00, 0.05, 0.25] },
        { inner: 'rgba(245, 130, 76, 0.50)', mid: 'rgba(180, 76, 52, 0.28)', scale: 2600, dir: [-1.00, -0.10, 0.20] },
        { inner: 'rgba(70, 225, 140, 0.58)', mid: 'rgba(36, 150, 95, 0.32)', scale: 3600, dir: [0.10, 1.00, -0.15] },
        { inner: 'rgba(250, 205, 100, 0.55)', mid: 'rgba(200, 140, 55, 0.30)', scale: 3200, dir: [-0.05, -1.00, 0.10] },
    ];
    const nebulae = [];
    for (const def of NEBULA_DEFS) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({
            map: makeNebulaTexture(def.inner, def.mid),
            transparent: true, opacity: 0.9,
            blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        sp.userData.dir = new THREE.Vector3(...def.dir).normalize().multiplyScalar(4500);
        sp.scale.setScalar(def.scale);
        sp.material.rotation = Math.random() * Math.PI * 2;
        sp.userData.rotSpeed = (Math.random() - 0.5) * 0.01;
        scene.add(sp);
        nebulae.push(sp);
    }

    // =====================================================================
    //  三、远景闪烁星层（跟随相机平移）
    // =====================================================================
    const farMat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uPixelRatio: { value: renderer.getPixelRatio() }, uOpacity: { value: 0.8 } },
        vertexShader: starVert, fragmentShader: starFrag,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const farPts = (() => {
        const N = 1800;
        const pos = new Float32Array(N * 3), phase = new Float32Array(N),
            freq = new Float32Array(N), size = new Float32Array(N), tint = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
            pos.set([s * Math.cos(th) * 5000, s * Math.sin(th) * 5000, u * 5000], i * 3);
            phase[i] = Math.random() * Math.PI * 2;
            freq[i] = 0.4 + Math.random() * 2.2;
            size[i] = 25 + Math.random() * 50;
            tint.set(starColor(), i * 3);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
        g.setAttribute('aFreq', new THREE.BufferAttribute(freq, 1));
        g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
        g.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
        const p = new THREE.Points(g, farMat);
        p.frustumCulled = false;
        scene.add(p);
        return p;
    })();

    // =====================================================================
    //  四、星座（纵深分布 + 逐星座触发连线）—— 本次升级重点
    // =====================================================================
    const CONSTELLATIONS = [
        { name: '猎户座', en: 'ORION', depth: 750, off: [-220, 60], scale: 2.4,
            stars: [[-40, 70, 1.2], [45, 65, 1.0], [5, 98, 0.8], [-14, -6, 1.1], [6, 0, 1.25], [27, 6, 1.1], [-32, -78, 0.9], [36, -72, 1.35]],
            links: [[2, 0], [2, 1], [0, 3], [3, 4], [4, 5], [1, 5], [3, 6], [5, 7]] },
        { name: '小熊座', en: 'URSA MINOR', depth: 1350, off: [260, -40], scale: 2.0,
            stars: [[88, 58, 1.35], [56, 44, 0.8], [36, 26, 0.75], [12, 2, 0.9], [-24, -6, 1.0], [-14, -36, 0.95], [6, -28, 0.85]],
            links: [[0, 1], [1, 2], [2, 3], [3, 6], [6, 5], [5, 4], [4, 3]] },
        { name: '仙后座', en: 'CASSIOPEIA', depth: 1950, off: [-280, -120], scale: 2.2,
            stars: [[-84, 18, 1.0], [-42, -14, 1.1], [0, 16, 1.15], [42, -8, 1.0], [84, 22, 1.05]],
            links: [[0, 1], [1, 2], [2, 3], [3, 4]] },
        { name: '天鹅座', en: 'CYGNUS', depth: 2550, off: [200, 160], scale: 2.3,
            stars: [[0, 82, 1.2], [0, 4, 1.1], [0, -76, 0.95], [-74, 12, 1.0], [74, 6, 1.0], [24, -30, 0.7]],
            links: [[0, 1], [1, 2], [3, 1], [1, 4], [2, 5]] },
        { name: '狮子座', en: 'LEO', depth: 3150, off: [-60, -40], scale: 2.5,
            stars: [[-8, 30, 1.3], [6, 52, 0.85], [26, 68, 0.8], [46, 62, 0.9], [52, 44, 0.8], [30, 34, 0.75], [-58, 8, 1.0], [-88, 26, 0.9], [-70, -16, 0.95]],
            links: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [0, 6], [6, 7], [6, 8], [8, 7]] },
    ];
    const SPAN = 3400;
    const TRIGGER = 640;
    const SEG_DUR = 0.5;

    function makeGlowTexture() {
        const s = 64;
        const cv = document.createElement('canvas');
        cv.width = cv.height = s;
        const ctx = cv.getContext('2d');
        const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(0.35, 'rgba(180,205,255,0.55)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, s, s);
        return new THREE.CanvasTexture(cv);
    }
    const glowTex = makeGlowTexture();

    function makeLabelTexture(zh, en) {
        const w = 512, h = 160;
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(140,175,255,0.9)'; ctx.shadowBlur = 22;
        ctx.fillStyle = '#dce9ff';
        ctx.font = '600 62px "Microsoft YaHei", "PingFang SC", sans-serif';
        ctx.fillText(zh, w / 2, h * 0.36);
        ctx.shadowBlur = 12;
        ctx.fillStyle = 'rgba(165,195,255,0.85)';
        ctx.font = '500 30px "Segoe UI", sans-serif';
        if ('letterSpacing' in ctx) ctx.letterSpacing = '10px';
        ctx.fillText(en, w / 2, h * 0.74);
        const tex = new THREE.CanvasTexture(cv);
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
    }

    const constellations = [];
    for (const def of CONSTELLATIONS) {
        const group = new THREE.Group();
        group.position.set(def.off[0], def.off[1], -def.depth);
        group.scale.setScalar(def.scale);
        scene.add(group);

        const n = def.stars.length;
        const pos = new Float32Array(n * 3), phase = new Float32Array(n),
            freq = new Float32Array(n), size = new Float32Array(n), tint = new Float32Array(n * 3);
        let maxY = -Infinity;
        def.stars.forEach((s, i) => {
            pos.set([s[0], s[1], 0], i * 3);
            phase[i] = Math.random() * Math.PI * 2;
            freq[i] = 0.6 + Math.random() * 2.0;
            size[i] = 5 + s[2] * 7;
            tint.set(starColor(), i * 3);
            if (s[1] > maxY) maxY = s[1];
        });
        const sg = new THREE.BufferGeometry();
        sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        sg.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
        sg.setAttribute('aFreq', new THREE.BufferAttribute(freq, 1));
        sg.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
        sg.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
        const sm = new THREE.ShaderMaterial({
            uniforms: { uTime: { value: 0 }, uPixelRatio: { value: renderer.getPixelRatio() }, uOpacity: { value: 1 } },
            vertexShader: starVert, fragmentShader: starFrag,
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        });
        const pts = new THREE.Points(sg, sm);
        pts.frustumCulled = false;
        group.add(pts);

        const m = def.links.length;
        const lPos = new Float32Array(m * 2 * 3);
        const lg = new THREE.BufferGeometry();
        lg.setAttribute('position', new THREE.BufferAttribute(lPos, 3));
        const lm = new THREE.LineBasicMaterial({
            color: 0x8fb8ff, transparent: true, opacity: 0,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const lines = new THREE.LineSegments(lg, lm);
        lines.frustumCulled = false;
        group.add(lines);

        const tipMat = new THREE.SpriteMaterial({
            map: glowTex, color: 0xbfd6ff, transparent: true, opacity: 0,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const tip = new THREE.Sprite(tipMat);
        tip.scale.setScalar(14);
        group.add(tip);

        const labelMat = new THREE.SpriteMaterial({
            map: makeLabelTexture(def.name, def.en), transparent: true, opacity: 0,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const label = new THREE.Sprite(labelMat);
        label.scale.set(120, 37.5, 1);
        label.position.set(0, maxY + 46, 0);
        group.add(label);

        constellations.push({
            def, group, sm, lm, lg, lPos, tip, tipMat, labelMat,
            anim: { started: false, t: 0, done: false },
        });
    }

    // =====================================================================
    //  五、标题牌（相机相对坐标：飞来 → 停驻 → 淡出）
    // =====================================================================
    function makeTitleTexture() {
        const w = 1600, h = 800;
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const grad = ctx.createLinearGradient(0, h * 0.18, 0, h * 0.60);
        grad.addColorStop(0.0, '#f2f7ff');
        grad.addColorStop(0.6, '#a8c8ff');
        grad.addColorStop(1.0, '#7d9bff');
        ctx.font = '600 230px "Microsoft YaHei", "PingFang SC", sans-serif';
        if ('letterSpacing' in ctx) ctx.letterSpacing = '28px';
        ctx.shadowColor = 'rgba(130, 170, 255, 0.95)';
        ctx.shadowBlur = 70;
        ctx.fillStyle = grad;
        ctx.fillText('天问 · 星途', w / 2, h * 0.38);
        ctx.font = '500 82px "Segoe UI", "Microsoft YaHei", sans-serif';
        if ('letterSpacing' in ctx) ctx.letterSpacing = '26px';
        ctx.shadowBlur = 32;
        ctx.fillStyle = 'rgba(175, 205, 255, 0.9)';
        ctx.fillText('TIANWEN STARWAY', w / 2, h * 0.70);
        ctx.shadowBlur = 14;
        ctx.strokeStyle = 'rgba(145, 180, 255, 0.75)';
        ctx.lineWidth = 3;
        const line = (y) => { ctx.beginPath(); ctx.moveTo(w * 0.24, y); ctx.lineTo(w * 0.76, y); ctx.stroke(); };
        line(h * 0.15); line(h * 0.85);
        const tex = new THREE.CanvasTexture(cv);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        return tex;
    }
    const titleMat = new THREE.MeshBasicMaterial({
        map: makeTitleTexture(), transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const titleMesh = new THREE.Mesh(new THREE.PlaneGeometry(760, 380), titleMat);
    titleMesh.frustumCulled = false;
    scene.add(titleMesh);

    const titleAnim = { state: 'fly', t: 0, delay: 0.9, dur: 4.2, hold: 7, fade: 1.6 };
    function titleRestart() { titleAnim.state = 'fly'; titleAnim.t = -titleAnim.delay; }
    titleRestart();

    // ---------- 交互：拖拽环顾 + 滚轮推进/后退 + 空格暂停 + T 重播标题 ----------
    let speed = 90, speedTarget = 90, paused = false;
    let yaw = 0, pitch = 0, yawT = 0, pitchT = 0;
    let dragging = false, lastX = 0, lastY = 0, moved = false;
    // 标记本次按下是否发生了实质拖拽（用于区分"拖拽旋转"与"点击进入"）
    window.__starfieldDragged = false;

    canvas.addEventListener('pointerdown', e => { dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY; });
    window.addEventListener('pointerup', () => {
        dragging = false;
        window.__starfieldDragged = moved;
        // 短暂延迟后重置，避免误判随后的 click
        setTimeout(() => { window.__starfieldDragged = false; }, 400);
    });
    window.addEventListener('pointermove', e => {
        if (!dragging) return;
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
        yawT -= dx * 0.0018;
        pitchT -= dy * 0.0018;
        yawT = Math.max(-0.5, Math.min(0.5, yawT));
        pitchT = Math.max(-0.4, Math.min(0.4, pitchT));
        lastX = e.clientX; lastY = e.clientY;
    });
    window.addEventListener('wheel', e => {
        speedTarget = Math.max(-260, Math.min(700, speedTarget - e.deltaY * 0.5));
    }, { passive: true });
    window.addEventListener('keydown', function onKey(e) {
        if (e.code === 'Space') { paused = !paused; e.preventDefault(); }
        if (e.code === 'KeyT') titleRestart();
    });

    // ---------- 自适应 ----------
    function resize() {
        renderer.setSize(window.innerWidth, window.innerHeight, false);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    }
    window.addEventListener('resize', resize);
    resize();

    // ---------- 主循环 ----------
    const clock = new THREE.Clock();
    const _va = new THREE.Vector3(), _vb = new THREE.Vector3();
    let rafId = null;

    function animate() {
        rafId = requestAnimationFrame(animate);
        const dt = Math.min(clock.getDelta(), 0.05);
        const t = clock.elapsedTime;

        speed += (speedTarget - speed) * Math.min(1, dt * 2.5);
        const v = paused ? 0 : speed;
        camera.position.z -= v * dt;

        yaw += (yawT - yaw) * Math.min(1, dt * 6);
        pitch += (pitchT - pitch) * Math.min(1, dt * 6);
        camera.rotation.set(
            pitch + Math.sin(t * 0.31) * 0.010,
            yaw + Math.sin(t * 0.23) * 0.010,
            Math.sin(t * 0.17) * 0.008,
            'YXZ'
        );

        // --- 星轨拖尾：随相机速度反向流动，相对相机双向回收 ---
        const trail = Math.max(3, Math.abs(v) * 0.12);
        const tdir = v >= 0 ? 1 : -1;
        for (let i = 0; i < FIELD.count; i++) {
            starZ[i] += v * dt;
            if (starZ[i] > camera.position.z + 10) {              // 飞到身后 → 挪到前方远处
                starZ[i] = camera.position.z - FIELD.depth - Math.random() * 200;
                starX[i] = (Math.random() * 2 - 1) * FIELD.width;
                starY[i] = (Math.random() * 2 - 1) * FIELD.height;
            } else if (starZ[i] < camera.position.z - FIELD.depth - 300) {  // 倒退时前方耗尽 → 挪到身后
                starZ[i] = camera.position.z + Math.random() * 50;
                starX[i] = (Math.random() * 2 - 1) * FIELD.width;
                starY[i] = (Math.random() * 2 - 1) * FIELD.height;
            }
            const j = i * 6;
            sPos[j] = starX[i]; sPos[j + 1] = starY[i]; sPos[j + 2] = starZ[i];
            sPos[j + 3] = starX[i]; sPos[j + 4] = starY[i]; sPos[j + 5] = starZ[i] - trail * tdir;
            const k = i * 3;
            hPos[k] = starX[i]; hPos[k + 1] = starY[i]; hPos[k + 2] = starZ[i];
        }
        streakGeo.attributes.position.needsUpdate = true;
        headGeo.attributes.position.needsUpdate = true;

        // --- 星云 / 远景星层：跟随相机平移 ---
        for (const nb of nebulae) {
            nb.position.copy(camera.position).add(nb.userData.dir);
            nb.material.rotation += nb.userData.rotSpeed * dt;
        }
        farPts.position.copy(camera.position);
        farMat.uniforms.uTime.value = t;

        // --- 星座：触发 / 连线 / 回收 ---
        for (const c of constellations) {
            const dist = camera.position.z - c.group.position.z;
            const anim = c.anim;

            if (dist < -220) {
                c.group.position.z -= SPAN;
                anim.started = false; anim.done = false; anim.t = 0;
                c.lPos.fill(0);
                c.lg.attributes.position.needsUpdate = true;
                continue;
            }

            const vis = THREE.MathUtils.clamp((dist - 90) / 200, 0, 1);
            c.sm.uniforms.uTime.value = t;
            c.sm.uniforms.uOpacity.value = vis;

            if (!anim.started && dist < TRIGGER) anim.started = true;

            let lineAlpha = 0, tipAlpha = 0;
            if (anim.started && !anim.done) {
                anim.t += dt;
                const segFloat = anim.t / SEG_DUR;
                const segs = c.def.links;
                for (let i = 0; i < segs.length; i++) {
                    const p = THREE.MathUtils.clamp(segFloat - i, 0, 1);
                    if (p <= 0) break;
                    const a = c.def.stars[segs[i][0]], b = c.def.stars[segs[i][1]];
                    _va.set(a[0], a[1], 0);
                    _vb.set(b[0], b[1], 0).lerp(_va, 1 - p);
                    const j = i * 6;
                    c.lPos[j] = _va.x; c.lPos[j + 1] = _va.y; c.lPos[j + 2] = 0;
                    c.lPos[j + 3] = _vb.x; c.lPos[j + 4] = _vb.y; c.lPos[j + 5] = 0;
                    if (p < 1 && i === Math.floor(segFloat)) {
                        tipAlpha = 0.95;
                        c.tip.position.copy(_vb);
                    }
                }
                c.lg.attributes.position.needsUpdate = true;
                lineAlpha = Math.min(1, anim.t * 2.5);
                if (segFloat >= segs.length) anim.done = true;
            } else if (anim.done) {
                lineAlpha = 1;
            }

            c.lm.opacity = 0.85 * lineAlpha * vis;
            c.tipMat.opacity = tipAlpha * vis;
            const labelTarget = anim.done ? 0.9 : (anim.started ? 0.4 : 0);
            c.labelMat.opacity += (labelTarget * vis - c.labelMat.opacity) * Math.min(1, dt * 4);
        }

        // --- 标题牌：相机相对坐标，飞来 → 停驻呼吸 → 淡出 ---
        if (titleAnim.state !== 'hidden') {
            titleAnim.t += dt;
            const A = titleAnim;
            if (A.state === 'fly') {
                const k = Math.max(0, Math.min(1, A.t / A.dur));
                const e = 1 - Math.pow(1 - k, 3);
                const zRel = -2800 + (-950 + 2800) * e;      // 相对相机的深度
                titleMesh.position.set(0, 30 + Math.sin(t * 0.6) * 4, camera.position.z + zRel);
                titleMat.opacity = Math.min(1, k * 3) * 0.95;
                titleMesh.scale.setScalar(1);
                titleMesh.lookAt(camera.position);
                if (k >= 1) { A.state = 'hold'; A.t = 0; }
            } else if (A.state === 'hold') {
                const breathe = Math.sin(t * 1.6);
                titleMesh.position.set(0, 30 + Math.sin(t * 0.6) * 6, camera.position.z - 950);
                titleMesh.lookAt(camera.position);
                titleMat.opacity = 0.88 + breathe * 0.28;
                titleMesh.scale.setScalar(1 + breathe * 0.035);
                if (A.t > A.hold) { A.state = 'fade'; A.t = 0; }
            } else if (A.state === 'fade') {
                const k = Math.min(1, A.t / A.fade);
                titleMesh.position.set(0, 30 + Math.sin(t * 0.6) * 6, camera.position.z - 950);
                titleMesh.lookAt(camera.position);
                titleMat.opacity = 0.88 * (1 - k);
                if (k >= 1) { A.state = 'hidden'; titleMat.opacity = 0; }
            }
        }

        renderer.render(scene, camera);
    }
    animate();

    // 停止动画渲染（进入视频后释放性能）
    window.__stopStarfield = function () {
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
        renderer.dispose();
    };
}
