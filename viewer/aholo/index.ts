import {
    createViewer,
    setViewerConfig,
    PerspectiveCamera,
    BackgroundMode,
    Vector3,
    Color,
    SplatLoader,
    SplatUtils,
    ToneMapping,
} from '@manycore/aholo-viewer';
import { CameraControl } from './camera-control.js';
import {createWalkingTools} from './walking-tools.js';
import {ResolutionBudget} from './performance.js';
import {validateViewerManifest} from './saved-walk.js';

// DOM Elements
const container = document.getElementById('viewer-container') as HTMLElement;
const loadingOverlay = document.getElementById('loading-overlay') as HTMLElement;
const loadingTitle = document.getElementById('loading-title') as HTMLElement;
const loadingSubtitle = document.getElementById('loading-subtitle') as HTMLElement;
const fileStatusDot = document.getElementById('file-status-dot') as HTMLElement;
const fileNameEl = document.getElementById('file-name') as HTMLElement;
const splatCountEl = document.getElementById('splat-count') as HTMLElement;
const statFps = document.getElementById('stat-fps') as HTMLElement;
const statMs = document.getElementById('stat-ms') as HTMLElement;
const btnUpload = document.getElementById('btn-upload') as HTMLButtonElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
const btnAutoRotate = document.getElementById('btn-auto-rotate') as HTMLButtonElement;
const btnSettings = document.getElementById('btn-settings') as HTMLButtonElement;
const btnCloseSidebar = document.getElementById('btn-close-sidebar') as HTMLButtonElement;
const sidebar = document.getElementById('sidebar') as HTMLElement;
const selectCoord = document.getElementById('select-coord') as HTMLSelectElement;
const selectCameraMode = document.getElementById('select-camera-mode') as HTMLSelectElement;
const rangeFov = document.getElementById('range-fov') as HTMLInputElement;
const valFov = document.getElementById('val-fov') as HTMLElement;
const rangeSpeed = document.getElementById('range-speed') as HTMLInputElement;
const valSpeed = document.getElementById('val-speed') as HTMLElement;
const colorBtns = document.querySelectorAll<HTMLButtonElement>('.color-btn');
const toggleSplatting = document.getElementById('toggle-splatting') as HTMLInputElement;
const togglePrecalculate = document.getElementById('toggle-precalculate') as HTMLInputElement;
const selectTone = document.getElementById('select-tone') as HTMLSelectElement;
const rangeExposure = document.getElementById('range-exposure') as HTMLInputElement;
const valExposure = document.getElementById('val-exposure') as HTMLElement;
const infoSplats = document.getElementById('info-splats') as HTMLElement;
const infoFormat = document.getElementById('info-format') as HTMLElement;
const infoSize = document.getElementById('info-size') as HTMLElement;
const dragOverlay = document.getElementById('drag-overlay') as HTMLElement;
const toastEl = document.getElementById('toast') as HTMLElement;

// State
let viewer: ReturnType<typeof createViewer>;
let camera: PerspectiveCamera;
let control: CameraControl;
let currentSplat: any = null;
let currentCentroid = new Vector3(0, 0, 0);
let currentBoundingDim = 2.0;
let needsRender = true;
let currentBgColor = new Color(0.043, 0.059, 0.09); // #0b0f17
let baseSpeed = 0.5;
let autoRotate = false;
let walkingTools: ReturnType<typeof createWalkingTools>;
const resolutionBudget = new ResolutionBudget();
let performanceMode = 'auto';
const motionSamples: number[] = [];
const submitSamples: number[] = [];
function applyResolution() {
    if (!viewer) return;
    // Aholo multiplies this setting by devicePixelRatio internally.
    const scale = performanceMode === 'native' ? window.devicePixelRatio || 1 :
        performanceMode === 'performance' ? .7 : performanceMode === 'auto' ? resolutionBudget.scale : 1;
    viewer.renderPixelRatio = scale / (window.devicePixelRatio || 1);
    const label = document.getElementById('resolution-status');
    if (label) label.textContent = `${Math.round(scale * 100)}% of CSS resolution`;
    needsRender = true;
}

function showToast(message: string, type: 'success' | 'error' = 'success') {
    toastEl.textContent = message;
    toastEl.className = `toast show ${type}`;
    setTimeout(() => {
        toastEl.className = 'toast';
    }, 3500);
}

function updateLoadingState(show: boolean, title = '', subtitle = '') {
    if (show) {
        loadingOverlay.classList.remove('hidden');
        if (title) loadingTitle.textContent = title;
        if (subtitle) loadingSubtitle.textContent = subtitle;
        fileStatusDot.className = 'file-status-dot loading';
    } else {
        loadingOverlay.classList.add('hidden');
        fileStatusDot.className = 'file-status-dot';
    }
}

function applyViewerPipeline() {
    if (!viewer) return;
    const toneMappingMap: Record<string, ToneMapping> = {
        linear: ToneMapping.Linear,
        reinhard: ToneMapping.Reinhard,
        neutral: ToneMapping.Neutral,
        aces: ToneMapping.ACES,
        acesFilmic: ToneMapping.ACESFilmic,
    };

    setViewerConfig(viewer, {
        pipeline: {
            Background: {
                background: {
                    active: BackgroundMode.BasicBackground,
                    basic: { color: currentBgColor, alpha: 1 },
                },
                ground: { enabled: false },
            },
            Splatting: {
                enabled: toggleSplatting.checked,
                pack: {
                    precalculateEnabled: togglePrecalculate.checked,
                },
                toneMapping: {
                    enabled: selectTone.value !== 'linear',
                    toneMapping: toneMappingMap[selectTone.value] ?? ToneMapping.Linear,
                    exposure: Number(rangeExposure.value),
                },
            },
            TAA: { enabled: false },
        },
    });
    needsRender = true;
}

function resetCameraView() {
    if (!camera || !control) return;
    walkingTools?.pause();
    const coord = selectCoord.value;
    const cx = currentCentroid.x;
    const cy = currentCentroid.y;
    const cz = currentCentroid.z;
    // Calibrated framing distance inside the room interior
    const dist = Math.max(2.0, currentBoundingDim * 0.38);

    switch (coord) {
        case 'aholo':
            // +Z Up
            camera.up.set(0, 0, 1);
            camera.position.set(cx, cy - dist * 0.9, cz + dist * 0.3);
            break;
        case 'opengl':
            // +Y Up
            camera.up.set(0, 1, 0);
            camera.position.set(cx, cy + dist * 0.25, cz + dist);
            break;
        case 'opencv':
        default:
            // -Y Up (standard Gaussian Splatting) - angled to face room interior
            camera.up.set(0, -1, 0);
            camera.position.set(cx + dist * 0.65, cy - dist * 0.2, cz + dist * 0.65);
            break;
    }

    camera.lookAt(new Vector3(cx, cy, cz));
    camera.far = Math.max(5000, dist * 30);
    camera.updateProjectionMatrix();

    control.setOrbitCenter({ x: cx, y: cy, z: cz });
    control.stop();
    needsRender = true;
}

// A room is tens of megabytes: show how much has arrived so a slow connection does not look frozen.
async function downloadWithProgress(response: Response, expected: number): Promise<ArrayBuffer> {
    const reader = response.body?.getReader();
    if (!reader) return response.arrayBuffer();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        loadingSubtitle.textContent = `Downloading room: ${(received / 1e6).toFixed(1)} of ${(expected / 1e6).toFixed(1)} MB`;
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    loadingSubtitle.textContent = 'Checking the room file...';
    return bytes.buffer;
}

async function loadSplatSource(source: string | File, displayName: string, fileSizeStr: string, pairing: any = null) {
    updateLoadingState(true, `Loading ${displayName}...`, 'Reading 3D Gaussian Splat data...');
    fileNameEl.textContent = displayName;
    infoSize.textContent = fileSizeStr;

    try {
        let input = source;
        if (typeof source === 'string' && pairing?.splatHash) {
            const response = await fetch(source);
            if (!response.ok) throw Error('Room visual file is unavailable.');
            const bytes = await downloadWithProgress(response, pairing.splatBytes);
            if (bytes.byteLength !== pairing.splatBytes) throw Error('Room visual file is incomplete.');
            const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
            if (digest !== pairing.splatHash) throw Error('Room visual file changed. Re-import the matching result.');
            input = new File([bytes], displayName);
        }
        let fileType = SplatLoader.SplatFileType.PLY;
        const nameLower = displayName.toLowerCase();
        if (nameLower.endsWith('.sog')) fileType = SplatLoader.SplatFileType.SOG;
        else if (nameLower.endsWith('.spz')) fileType = SplatLoader.SplatFileType.SPZ;
        else if (nameLower.endsWith('.splat')) fileType = SplatLoader.SplatFileType.SPLAT;
        else if (nameLower.endsWith('.ksplat')) fileType = SplatLoader.SplatFileType.KSPLAT;

        loadingSubtitle.textContent = 'Parsing splats with Web Worker...';
        const data = await SplatLoader.parseSplatData(
            fileType,
            input,
            SplatLoader.SplatPackType.Compressed,
        );

        loadingSubtitle.textContent = 'Allocating GPU geometry & shaders...';

        // Remove old splat if exists
        if (currentSplat) {
            viewer.getScene().remove(currentSplat);
            if (typeof currentSplat.freeAllGpuResourceOwned === 'function') {
                currentSplat.freeAllGpuResourceOwned();
            } else if (typeof currentSplat.freeGPU === 'function') {
                currentSplat.freeGPU();
            }
            currentSplat = null;
        }

        const splat = await SplatUtils.createSplat(data);
        viewer.getScene().add(splat);
        currentSplat = splat;
        walkingTools?.setSource(pairing || null);

        // Compute centroid & bounding box
        const count = data.counts;
        splatCountEl.textContent = `(${count.toLocaleString()} splats)`;
        infoSplats.textContent = count.toLocaleString();
        infoFormat.textContent = fileType === SplatLoader.SplatFileType.PLY ? 'PLY (3D Gaussian Splat)' : '3DGS Format';

        const centers = new Float32Array(count * 3);
        data.fillCenters(centers);

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let sumX = 0, sumY = 0, sumZ = 0;

        for (let i = 0; i < count; i++) {
            const x = centers[i * 3];
            const y = centers[i * 3 + 1];
            const z = centers[i * 3 + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            sumX += x; sumY += y; sumZ += z;
        }

        currentCentroid = new Vector3(sumX / count, sumY / count, sumZ / count);
        const sizeX = maxX - minX;
        const sizeY = maxY - minY;
        const sizeZ = maxZ - minZ;
        currentBoundingDim = Math.max(sizeX, sizeY, sizeZ) || 2.0;

        baseSpeed = Math.max(0.1, currentBoundingDim * 0.15);
        control.moveSpeed = baseSpeed * Number(rangeSpeed.value);

        resetCameraView();
        if (pairing?.initialView) {
            const v = pairing.initialView, p = v.position, r = v.rotation;
            if (p?.length === 3 && r?.length === 3 &&
                [...p, ...r.flat(), v.height, v.fy].every(Number.isFinite) && v.fy > 0) {
                camera.position.set(...p);
                // Turning happens around camera.up: the room's up keeps the horizon level; one frame's up is tilted.
                const up = v.up ?? [-r[0][1], -r[1][1], -r[2][1]];
                camera.up.set(up[0], up[1], up[2]);
                const target = {x:p[0]+r[0][2]*3, y:p[1]+r[1][2]*3, z:p[2]+r[2][2]*3};
                camera.lookAt(new Vector3(target.x, target.y, target.z));
                camera.fov = 2*Math.atan(v.height/(2*v.fy))*180/Math.PI;
                camera.updateProjectionMatrix();
                control.setOrbitCenter(target); control.stop();
            }
        }
        applyViewerPipeline();
        updateLoadingState(false);
        showToast(`Loaded ${displayName} (${count.toLocaleString()} splats)`, 'success');
    } catch (err: any) {
        console.error('Failed to load splat:', err);
        updateLoadingState(false);
        fileStatusDot.className = 'file-status-dot error';
        splatCountEl.textContent = '(Error)';
        showToast(err?.message || 'Failed to load point cloud', 'error');
    }
}

function setupViewer() {
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    viewer = createViewer('ply-viewer', container, { antialiasing: false });
    applyResolution();
    camera = new PerspectiveCamera(60, width / height, 0.05, 2000);
    viewer.setCamera(camera);

    control = new CameraControl(camera, container, {
        enabled: true,
        useOrbit: true,
        orbitMinDistance: 0.01,
        moveSpeed: baseSpeed,
        lookSpeed: 0.004,
        wheelSpeed: 0.006,
        panSpeed: 0.006,
    });

    applyViewerPipeline();

    // Resize handler
    const onResize = () => {
        const w = container.clientWidth || window.innerWidth;
        const h = container.clientHeight || window.innerHeight;
        if (w > 0 && h > 0) {
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            applyResolution();
            needsRender = true;
        }
    };
    window.addEventListener('resize', onResize);

    // Frame rendering & FPS loop
    let lastTime = performance.now();
    let frameCount = 0;
    let submissionMs = 0;
    let fpsTimer = performance.now();
    let previousActive = false;
    let frameIntervals: number[] = [];

    function renderLoop(now: number) {
        const interval = now - lastTime;
        const delta = Math.min(interval / 1000, 0.1);
        lastTime = now;

        if (autoRotate && !walkingTools?.isWalking() && control && !control.getState().interacting) {
            const angle = delta * 0.35;
            const x = camera.position.x - currentCentroid.x;
            const z = camera.position.z - currentCentroid.z;
            const cosA = Math.cos(angle);
            const sinA = Math.sin(angle);
            camera.position.x = currentCentroid.x + (x * cosA - z * sinA);
            camera.position.z = currentCentroid.z + (x * sinA + z * cosA);
            camera.lookAt(currentCentroid);
            needsRender = true;
        }

        const moved = control.update(delta);
        const walkingMoved = walkingTools?.tick(moved);
        const active = Boolean(moved || walkingMoved || autoRotate);
        if (active && previousActive && !document.hidden && interval > 0 && interval < 2000) {
            frameIntervals.push(interval);
            motionSamples.push(interval);
            if (motionSamples.length > 3600) motionSamples.shift();
        }
        if (performanceMode === 'auto' && resolutionBudget.sample(interval, active && previousActive && !document.hidden)) applyResolution();
        previousActive = active;
        if (moved || walkingMoved || autoRotate || needsRender) {
            const submitStart = performance.now();
            viewer.render();
            const submittedMs = performance.now() - submitStart;
            submissionMs += submittedMs;
            if (active && !document.hidden) {
                submitSamples.push(submittedMs);
                if (submitSamples.length > 3600) submitSamples.shift();
            }
            frameCount++;
            needsRender = false;
        }

        if (now - fpsTimer >= 500) {
            const fps = Math.round((frameCount * 1000) / (now - fpsTimer));
            statFps.textContent = String(fps);
            statMs.textContent = frameCount ? (submissionMs / frameCount).toFixed(1) + ' ms CPU' : 'idle';
            const pacing = document.getElementById('frame-pacing');
            if (pacing) {
                const sorted = frameIntervals.slice().sort((a,b)=>a-b);
                pacing.textContent = sorted.length ? `Motion p90: ${sorted[Math.floor((sorted.length-1)*.9)].toFixed(1)} ms (60 FPS budget: 16.7 ms)` : 'Move to measure frame pacing; idle is not low FPS.';
            }
            frameIntervals = [];
            submissionMs = 0;
            frameCount = 0;
            fpsTimer = now;
        }

        requestAnimationFrame(renderLoop);
    }

    viewer.requestRenderHandler = () => {
        needsRender = true;
    };

    requestAnimationFrame(renderLoop);
}

function setupUI() {
    document.getElementById('download-performance')?.addEventListener('click', () => {
        const summary = (samples: number[]) => {
            const sorted = samples.slice().sort((a,b)=>a-b);
            const mean = samples.reduce((a,b)=>a+b,0) / samples.length;
            return samples.length ? {samples:samples.length,meanMs:mean,
                p50Ms:sorted[Math.floor((sorted.length-1)*.5)],p90Ms:sorted[Math.floor((sorted.length-1)*.9)],
                p99Ms:sorted[Math.floor((sorted.length-1)*.99)],over33ms:samples.filter(x=>x>33.3).length} : null;
        };
        const report = {version:1,createdAt:new Date().toISOString(),viewer:'aholo',mode:performanceMode,
            viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},renderPixelRatio:viewer.renderPixelRatio,
            splats:infoSplats.textContent,motion:summary(motionSamples),cpuSubmission:summary(submitSamples),
            note:'Foreground moving-frame intervals; not GPU timer measurements. No capture images or file paths included.'};
        const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
        const link=document.createElement('a');link.href=url;link.download='namma-performance.json';link.click();
        setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
    document.getElementById('performance-mode')?.addEventListener('change', (event) => {
        performanceMode = (event.target as HTMLSelectElement).value;
        motionSamples.length=0;submitSamples.length=0;
        resolutionBudget.reset(); applyResolution();
    });
    // Open File button
    btnUpload.addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (file) {
            const sizeMb = (file.size / (1024 * 1024)).toFixed(1) + ' MB';
            loadSplatSource(file, file.name, sizeMb);
        }
        fileInput.value = '';
    });

    // Reset button
    btnReset.addEventListener('click', resetCameraView);

    // Auto rotate turntable button
    btnAutoRotate.addEventListener('click', () => {
        autoRotate = !autoRotate;
        if (autoRotate) {
            walkingTools?.pause();
            btnAutoRotate.classList.add('btn-primary');
            showToast('Turntable auto-rotation active', 'success');
        } else {
            btnAutoRotate.classList.remove('btn-primary');
            showToast('Turntable stopped', 'success');
        }
        needsRender = true;
    });

    // Sidebar toggle
    btnSettings.addEventListener('click', () => {
        sidebar.classList.toggle('hidden');
    });

    btnCloseSidebar.addEventListener('click', () => {
        sidebar.classList.add('hidden');
    });

    // Coordinate system change
    selectCoord.addEventListener('change', () => {
        resetCameraView();
    });

    // Camera mode change
    selectCameraMode.addEventListener('change', () => {
        const selectedMode = selectCameraMode.value;
        walkingTools?.pause();
        selectCameraMode.value = selectedMode;
        const isOrbit = selectCameraMode.value === 'orbit';
        control.setOptions({ useOrbit: isOrbit });
        needsRender = true;
    });

    // FOV slider
    rangeFov.addEventListener('input', () => {
        const fov = Number(rangeFov.value);
        valFov.textContent = `${fov}°`;
        camera.fov = fov;
        camera.updateProjectionMatrix();
        needsRender = true;
    });

    // Speed slider
    rangeSpeed.addEventListener('input', () => {
        const mult = Number(rangeSpeed.value);
        valSpeed.textContent = `${mult.toFixed(1)}x`;
        control.moveSpeed = baseSpeed * mult;
    });

    // Background color buttons
    colorBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            colorBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const hex = btn.dataset.color || '#0b0f17';
            // Parse hex to 0..1 RGB
            const r = parseInt(hex.slice(1, 3), 16) / 255;
            const g = parseInt(hex.slice(3, 5), 16) / 255;
            const b = parseInt(hex.slice(5, 7), 16) / 255;
            currentBgColor = new Color(r, g, b);
            applyViewerPipeline();
        });
    });

    // Pipeline toggles
    toggleSplatting.addEventListener('change', applyViewerPipeline);
    togglePrecalculate.addEventListener('change', applyViewerPipeline);
    selectTone.addEventListener('change', applyViewerPipeline);
    rangeExposure.addEventListener('input', () => {
        valExposure.textContent = Number(rangeExposure.value).toFixed(1);
        applyViewerPipeline();
    });

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
        if (e.key === 'r' || e.key === 'R') {
            resetCameraView();
        }
    });

    // Drag and Drop
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragDepth++;
        dragOverlay.classList.add('active');
    });

    window.addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    window.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragDepth--;
        if (dragDepth <= 0) {
            dragDepth = 0;
            dragOverlay.classList.remove('active');
        }
    });

    window.addEventListener('drop', (e) => {
        e.preventDefault();
        dragDepth = 0;
        dragOverlay.classList.remove('active');

        const file = e.dataTransfer?.files?.[0];
        if (file) {
            const sizeMb = (file.size / (1024 * 1024)).toFixed(1) + ' MB';
            loadSplatSource(file, file.name, sizeMb);
        }
    });
}

// Bootstrap
async function loadRoomManifest(url: URL) {
    if (url.origin !== location.origin) throw Error('Room manifest must be hosted with this viewer.');
    const response = await fetch(url);
    if (!response.ok) throw Error('Room manifest is unavailable.');
    const manifest = validateViewerManifest(await response.json());
    await loadSplatSource(new URL(manifest.splat.file, url).href, manifest.title + '.spz',
        (manifest.splat.bytes / 1024 / 1024).toFixed(1) + ' MB',
        {title: manifest.title, splatHash: manifest.splat.sha256, splatBytes: manifest.splat.bytes,
         collisionUrl: new URL(manifest.collision.file, url).href,
         collisionHash: manifest.collision.sha256, initialView: manifest.initialView,
         walkingSetup: manifest.walkingSetup});
}

async function init() {
    setupViewer();
    setupUI();
    walkingTools=createWalkingTools({viewer,camera,control,container,
        dirty:()=>{viewer.getScene().notifySceneChange();needsRender=true;},
        onWalkingStart:()=>{autoRotate=false;btnAutoRotate.classList.remove('btn-primary');}});

    // Load local point_cloud.ply
    updateLoadingState(false);
    fileNameEl.textContent = 'Choose a room file';
    splatCountEl.textContent = '';
    const portable = new URLSearchParams(location.search).get('manifest');
    if (portable) {
        const roomTools = document.querySelector('.namma-status a') as HTMLElement;
        if (roomTools) roomTools.hidden = true;
        sidebar.classList.add('hidden');
        try {
            await loadRoomManifest(new URL(portable, location.href));
            if (walkingTools.hasSavedSetup()) {
                const enter = document.createElement('button');
                enter.className = 'btn btn-primary'; enter.textContent = 'Enter room';
                enter.title = 'Start walking from the saved entrance';
                enter.onclick = () => walkingTools.resumeSaved();
                document.querySelector('.top-bar-right')?.prepend(enter);
            }
        }
        catch (error: any) { showToast(error.message, 'error'); }
        return;
    }
    if (import.meta.env.DEV) {
        const selected = new URLSearchParams(location.search).get('scene');
        const list = document.createElement('select');
        list.className = 'btn'; list.setAttribute('aria-label', 'Scene library');
        list.innerHTML = '<option value="">Scene library…</option>';
        document.querySelector('.top-bar-right')?.prepend(list);
        try {
            const response = await fetch('/__scenes');
            if (!response.ok) throw Error('Scene library is unavailable.');
            const scenes = await response.json();
            for (const item of scenes) {
                const option = document.createElement('option');
                option.value = item.id; option.textContent = item.title; list.append(option);
            }
            list.value = selected || '';
        } catch (error: any) { showToast(error.message, 'error'); }
        list.onchange = () => { if (list.value) location.href = '/aholo/?scene=' + encodeURIComponent(list.value); };
        if (selected) {
            try {
                const base = '/__scenes/' + encodeURIComponent(selected);
                await loadRoomManifest(new URL(base + '/scene.json', location.href));
            } catch (error: any) { showToast(error.message, 'error'); }
        } else if (!list.options.length) {
            showToast('No rooms imported yet. Import a trained result first (see viewer/README.md), or use Open File.', 'success');
        }
    }
}

init();
