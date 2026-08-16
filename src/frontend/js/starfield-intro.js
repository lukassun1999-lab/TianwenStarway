/**
 * 开场星空封面动画（替代静态封面图）
 * 自动播放 10 秒后进入视频；用户点击可提前进入。
 * 使用 index.html 中已配置的 importmap（three@0.160.0）。
 */
import * as THREE from 'three';

// 找到封面容器内的 canvas
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
    scene.background = new THREE.Color(0x010208);
    const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 6000);
    camera.position.set(0, 0, 0);

    // ---------- 近处星星：线段拖尾 ----------
    const FIELD = { count: 2200, width: 900, height: 600, depth: 2200 };
    let speed = 260;
    let speedTarget = 260;
    let paused = false;

    const streakGeo = new THREE.BufferGeometry();
    const sPos = new Float32Array(FIELD.count * 2 * 3);
    const sCol = new Float32Array(FIELD.count * 2 * 3);
    const starX = new Float32Array(FIELD.count);
    const starY = new Float32Array(FIELD.count);
    const starZ = new Float32Array(FIELD.count);

    const PALETTE = [
        { c: [1.00, 1.00, 1.00], w: 34 },
        { c: [0.62, 0.76, 1.00], w: 16 },
        { c: [0.45, 0.60, 1.00], w: 8 },
        { c: [1.00, 0.86, 0.62], w: 12 },
        { c: [1.00, 0.68, 0.42], w: 7 },
        { c: [1.00, 0.52, 0.52], w: 6 },
        { c: [0.72, 1.00, 0.86], w: 5 },
        { c: [0.86, 0.68, 1.00], w: 6 },
        { c: [1.00, 0.68, 0.92], w: 4 },
        { c: [0.62, 1.00, 1.00], w: 2 },
    ];
    const PALETTE_TOTAL = PALETTE.reduce((s, p) => s + p.w, 0);
    function starColor() {
        let r = Math.random() * PALETTE_TOTAL;
        for (const p of PALETTE) { r -= p.w; if (r <= 0) return p.c; }
        return PALETTE[0].c;
    }
    function resetStar(i, randomZ = true) {
        starX[i] = (Math.random() * 2 - 1) * FIELD.width;
        starY[i] = (Math.random() * 2 - 1) * FIELD.height;
        starZ[i] = randomZ ? -Math.random() * FIELD.depth : -FIELD.depth - Math.random() * 200;
    }
    const starCols = new Float32Array(FIELD.count * 3);
    for (let i = 0; i < FIELD.count; i++) {
        resetStar(i);
        const c = starColor();
        sCol.set([...c, c[0] * 0.15, c[1] * 0.15, c[2] * 0.15], i * 6);
        starCols.set(c, i * 3);
    }
    streakGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
    streakGeo.setAttribute('color', new THREE.BufferAttribute(sCol, 3));
    const streaks = new THREE.LineSegments(
        streakGeo,
        new THREE.LineBasicMaterial({
            vertexColors: true, transparent: true, opacity: 1.0,
            blending: THREE.AdditiveBlending, depthWrite: false,
        })
    );
    streaks.frustumCulled = false;
    scene.add(streaks);

    // 近处星星头部点光斑
    const headGeo = new THREE.BufferGeometry();
    const hPos = new Float32Array(FIELD.count * 3);
    const hCol = new Float32Array(FIELD.count * 3);
    hCol.set(starCols);
    headGeo.setAttribute('position', new THREE.BufferAttribute(hPos, 3));
    headGeo.setAttribute('color', new THREE.BufferAttribute(hCol, 3));
    const headMat = new THREE.PointsMaterial({
        vertexColors: true, size: 2.6, sizeAttenuation: false,
        transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const heads = new THREE.Points(headGeo, headMat);
    heads.frustumCulled = false;
    scene.add(heads);

    // ---------- 远处星空：闪烁 ----------
    const FAR = { count: 3200, radius: 4200 };
    const farGeo = new THREE.BufferGeometry();
    const fPos = new Float32Array(FAR.count * 3);
    const fPhase = new Float32Array(FAR.count);
    const fFreq = new Float32Array(FAR.count);
    const fSize = new Float32Array(FAR.count);
    const fTint = new Float32Array(FAR.count * 3);
    for (let i = 0; i < FAR.count; i++) {
        const u = Math.random() * 2 - 1;
        const th = Math.random() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        fPos.set([s * Math.cos(th) * FAR.radius, s * Math.sin(th) * FAR.radius, u * FAR.radius], i * 3);
        fPhase[i] = Math.random() * Math.PI * 2;
        fFreq[i] = 0.4 + Math.random() * 2.4;
        fSize[i] = 1.2 + Math.random() * Math.random() * 3.2;
        const c = starColor();
        fTint.set(c, i * 3);
    }
    farGeo.setAttribute('position', new THREE.BufferAttribute(fPos, 3));
    farGeo.setAttribute('aPhase', new THREE.BufferAttribute(fPhase, 1));
    farGeo.setAttribute('aFreq', new THREE.BufferAttribute(fFreq, 1));
    farGeo.setAttribute('aSize', new THREE.BufferAttribute(fSize, 1));
    farGeo.setAttribute('aTint', new THREE.BufferAttribute(fTint, 3));
    const farMat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uPixelRatio: { value: renderer.getPixelRatio() } },
        vertexShader: `
            attribute float aPhase;
            attribute float aFreq;
            attribute float aSize;
            attribute vec3  aTint;
            uniform float uTime;
            uniform float uPixelRatio;
            varying float vAlpha;
            varying vec3  vTint;
            void main() {
              float tw = sin(uTime * aFreq + aPhase);
              float tw2 = sin(uTime * aFreq * 0.37 + aPhase * 1.7);
              vAlpha = 0.25 + 0.75 * pow(0.5 + 0.5 * tw * (0.7 + 0.3 * tw2), 2.0);
              vTint = aTint;
              vec4 mv = modelViewMatrix * vec4(position, 1.0);
              gl_PointSize = aSize * uPixelRatio * (0.8 + 0.4 * tw);
              gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: `
            varying float vAlpha;
            varying vec3  vTint;
            void main() {
              vec2 d = gl_PointCoord - 0.5;
              float r = length(d);
              if (r > 0.5) discard;
              float glow = smoothstep(0.5, 0.0, r);
              glow *= glow;
              gl_FragColor = vec4(vTint, vAlpha * glow);
            }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const farStars = new THREE.Points(farGeo, farMat);
    farStars.frustumCulled = false;
    scene.add(farStars);

    // ---------- 星云背景 ----------
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
    NEBULA_DEFS.forEach((def) => {
        const mat = new THREE.SpriteMaterial({
            map: makeNebulaTexture(def.inner, def.mid),
            transparent: true, opacity: 0.9,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const sp = new THREE.Sprite(mat);
        sp.position.copy(new THREE.Vector3(...def.dir).normalize().multiplyScalar(4500));
        sp.scale.setScalar(def.scale);
        sp.material.rotation = Math.random() * Math.PI * 2;
        sp.userData.rotSpeed = (Math.random() - 0.5) * 0.01;
        scene.add(sp);
        nebulae.push(sp);
    });

    // ---------- 标题牌 ----------
    function makeTitleTexture() {
        const w = 1600, h = 800;
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
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
        map: makeTitleTexture(),
        transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const titleMesh = new THREE.Mesh(new THREE.PlaneGeometry(760, 380), titleMat);
    titleMesh.frustumCulled = false;
    scene.add(titleMesh);

    const titleAnim = {
        t: 0, delay: 0.9, dur: 4.2,
        from: new THREE.Vector3(0, 20, -2800),
        to: new THREE.Vector3(0, 30, -950),
    };
    function titleRestart() { titleAnim.t = -titleAnim.delay; }
    titleRestart();

    // ---------- 交互：拖拽旋转 + 滚轮调速 ----------
    let yaw = 0, pitch = 0, yawT = 0, pitchT = 0;
    let dragging = false, lastX = 0, lastY = 0, moved = false;
    // 标记本次按下是否发生了实质拖拽（用于区分"拖拽旋转"与"点击进入"）
    window.__starfieldDragged = false;
    canvas.addEventListener('pointerdown', e => {
        dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY;
    });
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
        yawT -= dx * 0.0022;
        pitchT -= dy * 0.0022;
        pitchT = Math.max(-1.2, Math.min(1.2, pitchT));
        lastX = e.clientX; lastY = e.clientY;
    });
    window.addEventListener('wheel', e => {
        speedTarget = Math.max(0, Math.min(1200, speedTarget - e.deltaY * 0.4));
    }, { passive: true });
    window.addEventListener('keydown', function onKey(e) {
        if (e.code === 'Space') { paused = !paused; e.preventDefault(); }
        if (e.code === 'KeyT') titleRestart();
    });

    // ---------- 自适应 ----------
    function resize() {
        const w = window.innerWidth, h = window.innerHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    window.addEventListener('resize', resize);
    resize();

    // ---------- 主循环 ----------
    const clock = new THREE.Clock();
    let rafId = null;
    function animate() {
        rafId = requestAnimationFrame(animate);
        const dt = Math.min(clock.getDelta(), 0.05);
        const t = clock.elapsedTime;
        speed += (speedTarget - speed) * Math.min(1, dt * 3);
        const v = paused ? 0 : speed;
        yaw += (yawT - yaw) * Math.min(1, dt * 6);
        pitch += (pitchT - pitch) * Math.min(1, dt * 6);
        camera.rotation.set(
            pitch + Math.sin(t * 0.31) * 0.012,
            yaw + Math.sin(t * 0.23) * 0.012,
            Math.sin(t * 0.17) * 0.01,
            'YXZ'
        );
        const trail = Math.max(3, v * 0.09);
        for (let i = 0; i < FIELD.count; i++) {
            starZ[i] += v * dt;
            if (starZ[i] > 10) resetStar(i, false);
            const j = i * 6;
            sPos[j] = starX[i]; sPos[j + 1] = starY[i]; sPos[j + 2] = starZ[i];
            sPos[j + 3] = starX[i]; sPos[j + 4] = starY[i]; sPos[j + 5] = starZ[i] - trail;
            const k = i * 3;
            hPos[k] = starX[i]; hPos[k + 1] = starY[i]; hPos[k + 2] = starZ[i];
        }
        streakGeo.attributes.position.needsUpdate = true;
        headGeo.attributes.position.needsUpdate = true;
        farMat.uniforms.uTime.value = t;
        for (const n of nebulae) n.material.rotation += n.userData.rotSpeed * dt;

        if (titleAnim.t < titleAnim.dur) {
            titleAnim.t += dt;
            const k = Math.max(0, Math.min(1, titleAnim.t / titleAnim.dur));
            const e = 1 - Math.pow(1 - k, 3);
            titleMesh.position.lerpVectors(titleAnim.from, titleAnim.to, e);
            titleMat.opacity = Math.min(1, k * 3) * 0.95;
            titleMesh.scale.setScalar(1);
            titleMesh.lookAt(camera.position);
        } else {
            titleMesh.position.set(titleAnim.to.x, titleAnim.to.y + Math.sin(t * 0.6) * 6, titleAnim.to.z);
            titleMesh.lookAt(camera.position);
            const breathe = Math.sin(t * 1.6);
            titleMat.opacity = 0.88 + breathe * 0.28;
            titleMesh.scale.setScalar(1 + breathe * 0.035);
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
