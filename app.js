import * as THREE from 'three';
import { installGameplay } from './gameplay.js';

// ── WebGL サポートチェック (P1-#1) ──────────────────────────────────────
const testCanvas = document.createElement('canvas');
if (!testCanvas.getContext('webgl2') && !testCanvas.getContext('webgl')) {
  document.querySelector('#viewport').innerHTML =
    '<div style="color:#e57373;padding:32px;font-size:14px;line-height:1.8">' +
    '⚠️ WebGL はこのブラウザでサポートされていません。<br>' +
    'Chrome / Firefox / Safari の最新版をお試しください。</div>';
  throw new Error('WebGL not supported');
}

// ── DOM refs ────────────────────────────────────────────────────────────
const viewport     = document.querySelector('#viewport');
const list         = document.querySelector('#objectList');
const inspector    = document.querySelector('#inspectorContent');
const consoleBody  = document.querySelector('#consoleBody');
const deferredConsoleLogs = [];

// ── Renderer ────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
renderer.outputColorSpace  = THREE.SRGBColorSpace;
renderer.setClearColor(0x171a23);
viewport.appendChild(renderer.domElement);
renderer.domElement.tabIndex = 0;
renderer.domElement.setAttribute('aria-label', '3Dシーンビュー。再生中はWASDとスペースキーで操作します');

// ── Scene / Camera ──────────────────────────────────────────────────────
const scene  = new THREE.Scene();
scene.background = new THREE.Color(0x171a23);
scene.fog        = new THREE.Fog(0x171a23, 20, 42);

const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100);
let yaw = 0.72, pitch = 0.48, distance = 13;
let target   = new THREE.Vector3(0, 1, 0);
let selected = null, playing = false, showGrid = true, tool = 'select', drag = null;
let gameplaySystem = null;

// ── Lights / Grid / Floor ───────────────────────────────────────────────
scene.add(new THREE.HemisphereLight(0xc5d4ff, 0x414451, 2.0));
const keyLight = new THREE.DirectionalLight(0xffedcf, 3.2);
keyLight.position.set(-4, 8, 5);
keyLight.castShadow = true;
scene.add(keyLight);

const grid  = new THREE.GridHelper(20, 20, 0x454b5a, 0x303540);
grid.position.y = -0.012;
scene.add(grid);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ color: 0x20242e, roughness: 0.95 })
);
floor.rotation.x  = -Math.PI / 2;
floor.position.y  = -0.025;
floor.receiveShadow = true;
scene.add(floor);

// ── Object registry ─────────────────────────────────────────────────────
const objects = new Map();
let serial = 1;
const undoHistory = [];
const redoHistory = [];
let applyingHistory = false;

const definitions = {
  Cube:     { geometry: () => new THREE.BoxGeometry(1, 1, 1),              color: 0x8e77d7, glyph: '◧' },
  Sphere:   { geometry: () => new THREE.SphereGeometry(0.58, 32, 20),      color: 0x65b8c4, glyph: '●' },
  Capsule:  { geometry: () => new THREE.CapsuleGeometry(0.35, 0.75, 8, 16),color: 0xd68c6c, glyph: '⬭' },
  Cylinder: { geometry: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 32), color: 0x72ad83, glyph: '◉' },
  Plane:    { geometry: () => new THREE.BoxGeometry(2, 0.08, 2),            color: 0x88a4bf, glyph: '▱' },
  Player:   { geometry: () => new THREE.CapsuleGeometry(0.34, 0.72, 8, 16), color: 0x5389fa, glyph: '♟' },
  Platform: { geometry: () => new THREE.BoxGeometry(3, 0.35, 3),             color: 0x778399, glyph: '▰' },
  Ground:   { geometry: () => new THREE.BoxGeometry(12, 0.35, 12),           color: 0x596477, glyph: '▰' },
  Coin:     { geometry: () => new THREE.CylinderGeometry(0.32, 0.32, 0.12, 24), color: 0xf3c45e, glyph: '◉' },
  Goal:     { geometry: () => new THREE.CylinderGeometry(0.58, 0.58, 0.16, 32), color: 0x62d69b, glyph: '⚑' },
  Hazard:   { geometry: () => new THREE.ConeGeometry(0.5, 0.8, 6),          color: 0xef6679, glyph: '▲' },
};

// ── Helpers ─────────────────────────────────────────────────────────────
function makeObject(type, name, props = {}) {
  const d    = definitions[type] || definitions.Cube;
  const mesh = new THREE.Mesh(
    d.geometry(),
    new THREE.MeshStandardMaterial({ color: props.color || d.color, roughness: 0.62, metalness: 0.05 })
  );
  mesh.name = name;
  mesh.castShadow    = true;
  mesh.receiveShadow = true;
  mesh.position.set(...(props.position || [0, 0.5, 0]));
  mesh.rotation.set(...(props.rotation || [0, 0, 0]));
  mesh.scale.set(...(props.scale || [1, 1, 1]));
  const defaults = {
    Player: ['Transform', 'Mesh Renderer', 'Capsule Collider', 'Rigidbody', 'Player Controller'],
    Coin: ['Transform', 'Mesh Renderer', 'Sphere Collider', 'Collectible'],
    Goal: ['Transform', 'Mesh Renderer', 'Box Collider', 'Goal'],
    Hazard: ['Transform', 'Mesh Renderer', 'Box Collider', 'Hazard'],
    Platform: ['Transform', 'Mesh Renderer', 'Box Collider'],
    Ground: ['Transform', 'Mesh Renderer', 'Box Collider'],
  };
  mesh.userData = { type, colliderType: ['Sphere', 'Coin'].includes(type) ? 'Sphere' : 'Box', components: defaults[type] || ['Transform', 'Mesh Renderer', 'Box Collider'] };
  scene.add(mesh);
  objects.set(name, mesh);
  return mesh;
}

/** WebGL リソースを含めてオブジェクトを完全破棄 (P1-#3) */
function disposeObject(obj) {
  scene.remove(obj);
  if (obj.geometry) obj.geometry.dispose();
  if (obj.material) {
    if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
    else obj.material.dispose();
  }
}

function addLog(message, kind = 'info') {
  const row = document.createElement('div');
  row.className = 'log-row';
  // P4-#17: <span> を使用し datetime 問題を回避。表示用時刻は ISO で付与。
  const now = new Date();
  row.innerHTML = `<span class="log-icon ${kind}">${kind === 'success' ? '✓' : kind === 'warn' ? '!' : 'i'}</span><span></span><span class="log-time">${now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</span>`;
  row.children[1].textContent = message;
  if (consoleBody.dataset.view === 'project') { deferredConsoleLogs.unshift(row); return; }
  consoleBody.prepend(row);
}

function persist() {
  try {
    localStorage.setItem('unity-playground-scene', JSON.stringify(
      [...objects.values()]
        .filter(o => o.isMesh)
        .map(o => ({
          name:     o.name,
          type:     o.userData.type,
          position: o.position.toArray(),
          rotation: o.rotation.toArray().slice(0, 3),
          scale:    o.scale.toArray(),
          color:    o.material.color.getHex(),
          components: o.userData.components || [],
          colliderType: o.userData.colliderType || 'Box',
        }))
    ));
  } catch {}
}

// ── Hierarchy rebuild ───────────────────────────────────────────────────
function rebuild() {
  list.innerHTML = '';
  for (const o of objects.values()) {
    const row = document.createElement('div');
    row.className  = 'object-row' + (o === selected ? ' selected' : '');
    // P3-#12: キーボード操作対応
    row.tabIndex   = 0;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', o === selected ? 'true' : 'false');
    row.innerHTML  = `<span class="object-icon">${definitions[o.userData.type]?.glyph || '☼'}</span><span></span>`;
    row.children[1].textContent = o.name;
    row.onclick    = () => select(o);
    row.onkeydown  = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(o); } };
    list.append(row);
  }
  renderInspector();
}

function sceneSnapshot() {
  return JSON.stringify([...objects.values()].filter(o => o.isMesh).map(o => ({
    name:o.name,type:o.userData.type,position:o.position.toArray(),rotation:o.rotation.toArray().slice(0,3),scale:o.scale.toArray(),
    color:o.material.color.getHex(),components:o.userData.components||[],colliderType:o.userData.colliderType||'Box',
  })));
}

function updateHistoryButtons() {
  const undoButton = document.querySelector('#undoButton');
  const redoButton = document.querySelector('#redoButton');
  undoButton.disabled = undoHistory.length === 0;
  redoButton.disabled = redoHistory.length === 0;
  undoButton.style.opacity = undoButton.disabled ? '0.35' : '1';
  redoButton.style.opacity = redoButton.disabled ? '0.35' : '1';
  undoButton.style.cursor = undoButton.disabled ? 'not-allowed' : 'pointer';
  redoButton.style.cursor = redoButton.disabled ? 'not-allowed' : 'pointer';
}

function recordHistory() {
  if (applyingHistory) return;
  const current = sceneSnapshot();
  if (undoHistory[undoHistory.length - 1] !== current) undoHistory.push(current);
  if (undoHistory.length > 40) undoHistory.shift();
  redoHistory.length = 0;
  updateHistoryButtons();
}

function applySceneSnapshot(snapshot) {
  const data = JSON.parse(snapshot);
  for (const [name, object] of [...objects]) {
    if (!object.isMesh) continue;
    disposeObject(object); objects.delete(name);
  }
  for (const item of data) {
    if (!definitions[item.type]) continue;
    const object = makeObject(item.type, item.name, item);
    if (Number.isFinite(item.color)) object.material.color.setHex(item.color);
    if (Array.isArray(item.components)) object.userData.components = item.components;
    if (['Box', 'Sphere', 'Mesh'].includes(item.colliderType)) object.userData.colliderType = item.colliderType;
  }
  let maxNum = 0;
  for (const name of objects.keys()) { const match = name.match(/(\d+)$/); if (match) maxNum = Math.max(maxNum, Number(match[1])); }
  serial = maxNum + 1;
  selected = [...objects.values()].find(object => object.isMesh) || null;
  rebuild(); persist();
}

function stepHistory(source, destination) {
  if (!source.length) return;
  destination.push(sceneSnapshot());
  const snapshot = source.pop();
  applyingHistory = true;
  try { applySceneSnapshot(snapshot); } finally { applyingHistory = false; }
  updateHistoryButtons();
  addLog(destination === redoHistory ? '操作を元に戻しました。' : '操作をやり直しました。', 'info');
}

function select(obj) { selected = obj; rebuild(); }

function deleteObject(object = selected) {
  if (!object?.isMesh || !objects.has(object.name)) return;
  recordHistory();
  objects.delete(object.name);
  disposeObject(object);
  if (selected === object) selected = [...objects.values()].find(item => item.isMesh) || null;
  persist(); rebuild();
  addLog(`${object.name} をシーンから削除しました。`, 'info');
}

// ── Inspector ───────────────────────────────────────────────────────────
/** P2-#4: group/axis を data 属性で明示 */
function inputAxis(label, value, group, axisIndex) {
  const id = `axis-${group}-${axisIndex}`;
  return `<div class="axis-field">` +
    `<label for="${id}">${label}</label>` +
    `<input id="${id}" type="number" step="0.1" value="${Number(value.toFixed(2))}" data-group="${group}" data-axis="${axisIndex}" />` +
    `</div>`;
}

function renderInspector() {
  if (!selected) {
    inspector.innerHTML = '<div class="component-desc">シーンからオブジェクトを選択すると、設定が表示されます。</div>';
    return;
  }
  const o = selected;
  if (!o.isMesh) {
    const safeName = o.name.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    inspector.innerHTML = `<div class="object-heading"><div class="object-big-icon">${o.userData.type === 'Light' ? '☼' : '◉'}</div><input class="object-name-input" value="${safeName}" aria-label="オブジェクト名"></div><section class="component"><div class="component-head"><span class="component-glyph">⊞</span> Transform</div><div class="component-body"><div class="transform-row"><span>位置</span>${inputAxis('X', o.position.x, 0, 0)}${inputAxis('Y', o.position.y, 0, 1)}${inputAxis('Z', o.position.z, 0, 2)}</div><div class="transform-row"><span>回転</span>${inputAxis('X', THREE.MathUtils.radToDeg(o.rotation.x), 1, 0)}${inputAxis('Y', THREE.MathUtils.radToDeg(o.rotation.y), 1, 1)}${inputAxis('Z', THREE.MathUtils.radToDeg(o.rotation.z), 1, 2)}</div></div></section><div class="component-desc">${o.userData.type === 'Light' ? 'シーンを照らす Point Light です。' : 'ゲームビューではプレイヤーを追いかけるカメラを使用します。'}</div>`;
    inspector.querySelector('.object-name-input').onchange = event => {
      const name = event.target.value.trim().slice(0, 64) || o.name;
      if (name !== o.name && !objects.has(name)) { objects.delete(o.name); o.name = name; objects.set(name, o); rebuild(); }
      persist();
    };
    inspector.querySelectorAll('input[data-group]').forEach(input => input.onchange = () => {
      const value = Number(input.value) || 0, group = Number(input.dataset.group), axis = Number(input.dataset.axis);
      if (group === 0) o.position.setComponent(axis, value);
      else o.rotation.setComponent(axis, THREE.MathUtils.degToRad(value));
    });
    return;
  }
  const safeName = o.name.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const colorHex = `#${o.material.color.getHexString()}`;
  inspector.innerHTML =
    `<div class="object-heading">` +
      `<div class="object-big-icon">${definitions[o.userData.type]?.glyph || '☼'}</div>` +
      `<input class="object-name-input" value="${safeName}" aria-label="オブジェクト名">` +
      `<button class="delete-object" id="deleteObject" type="button" title="オブジェクトを削除" aria-label="オブジェクトを削除">⌫</button>` +
      `<input class="active-check" type="checkbox" checked title="有効" aria-label="有効">` +
    `</div>` +
    `<section class="component">` +
      `<div class="component-head"><span class="component-toggle">⌄</span><span class="component-glyph">⊞</span> Transform</div>` +
      `<div class="component-body">` +
        `<div class="transform-row"><span>位置</span>${inputAxis('X', o.position.x, 0, 0)}${inputAxis('Y', o.position.y, 0, 1)}${inputAxis('Z', o.position.z, 0, 2)}</div>` +
        `<div class="transform-row"><span>回転</span>${inputAxis('X', THREE.MathUtils.radToDeg(o.rotation.x), 1, 0)}${inputAxis('Y', THREE.MathUtils.radToDeg(o.rotation.y), 1, 1)}${inputAxis('Z', THREE.MathUtils.radToDeg(o.rotation.z), 1, 2)}</div>` +
        `<div class="transform-row"><span>サイズ</span>${inputAxis('X', o.scale.x, 2, 0)}${inputAxis('Y', o.scale.y, 2, 1)}${inputAxis('Z', o.scale.z, 2, 2)}</div>` +
      `</div>` +
    `</section>` +
    `<section class="component">` +
      `<div class="component-head"><span class="component-toggle">⌄</span><span class="component-glyph">◈</span> Mesh Renderer</div>` +
      `<div class="component-desc material-row">マテリアル <span style="color:#c2afff">● Default Material</span><input class="material-color" type="color" value="${colorHex}" aria-label="マテリアルの色"></div>` +
    `</section>` +
    `<section class="component">` +
      `<div class="component-head"><span class="component-toggle">⌄</span><span class="component-glyph">◉</span> Collider</div>` +
      `<div class="component-desc">物理的な当たり判定を設定します。</div>` +
      `<div class="choice-row"><button class="choice${(o.userData.colliderType || 'Box') === 'Box' ? ' active' : ''}">Box</button><button class="choice${o.userData.colliderType === 'Sphere' ? ' active' : ''}">Sphere</button><button class="choice${o.userData.colliderType === 'Mesh' ? ' active' : ''}">Mesh</button></div>` +
    `</section>` +
    `<button class="add-component" id="addComponent">＋ コンポーネントを追加</button>` +
    `<div class="component-desc" style="padding:11px 3px">💡 Transform の値を変更して、オブジェクトの形や場所を変えてみましょう。</div>`;

  // P2-#8: リネーム重複チェック
  inspector.querySelector('.object-name-input').onchange = e => {
    const old     = o.name;
    const newName = e.target.value.trim().slice(0, 64) || old;
    if (newName === old) return;
    if (objects.has(newName)) {
      e.target.value = old;
      toast('その名前はすでに使われています');
      return;
    }
    recordHistory();
    objects.delete(old);
    o.name = newName;
    objects.set(newName, o);
    rebuild();
    persist();
  };

  // P2-#4: data 属性から group/axis を読み取る
  inspector.querySelectorAll('input[data-group]').forEach(input => {
    input.onchange = () => {
      recordHistory();
      const v     = Number(input.value) || 0;
      const group = Number(input.dataset.group);
      const axis  = Number(input.dataset.axis);
      if (group === 0) o.position.setComponent(axis, v);
      else if (group === 1) o.rotation.setComponent(axis, THREE.MathUtils.degToRad(v));
      else o.scale.setComponent(axis, Math.max(0.05, v));
      persist();
    };
  });

  inspector.querySelectorAll('.choice').forEach(b => b.onclick = () => {
    recordHistory();
    inspector.querySelectorAll('.choice').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const colliderName = `${b.textContent} Collider`;
    o.userData.components = (o.userData.components || []).filter(name => !name.endsWith(' Collider'));
    o.userData.components.push(colliderName);
    o.userData.colliderType = b.textContent;
    persist();
  });
  const colorInput = inspector.querySelector('.material-color');
  colorInput.onfocus = recordHistory;
  colorInput.oninput = () => { o.material.color.set(colorInput.value); };
  colorInput.onchange = persist;
  inspector.querySelector('#deleteObject').onclick = () => deleteObject(o);
  inspector.querySelector('#addComponent').onclick = () => {
    addLog('コンポーネントの追加は学習用サンプルで順次追加されます。', 'warn');
    toast('コンポーネントの説明を確認してみましょう');
  };
  if (gameplaySystem) gameplaySystem.decorateInspector(o);
}

// ── Toast ────────────────────────────────────────────────────────────────
function toast(text) {
  const t = document.querySelector('#toast');
  t.textContent = text;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1900);
}

// ── Add object ───────────────────────────────────────────────────────────
function add(type) {
  recordHistory();
  const name = `${type}${serial++}`;
  const o    = makeObject(type, name, { position: [(Math.random() - 0.5) * 2, 0.5, (Math.random() - 0.5) * 2] });
  select(o);
  persist();
  addLog(`${name} をシーンに追加しました。`, 'success');
}

// ── Camera helpers ────────────────────────────────────────────────────────
function updateCamera() {
  const cp = Math.cos(pitch);
  camera.position.set(
    target.x + distance * cp * Math.sin(yaw),
    target.y + distance * Math.sin(pitch),
    target.z + distance * cp * Math.cos(yaw)
  );
  camera.lookAt(target);
}

function resize() {
  const r = viewport.getBoundingClientRect();
  if (r.width && r.height) {
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / r.height;
    camera.updateProjectionMatrix();
  }
}
new ResizeObserver(resize).observe(viewport);
resize();
updateCamera();

// ── Render loop ──────────────────────────────────────────────────────────
// P2-#9: 再生中は全メッシュをゆっくり回転
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  if (playing && gameplaySystem) gameplaySystem.update(Math.min(0.05, (now - animate.previousTime) / 1000 || 0));
  animate.previousTime = now;
  renderer.render(scene, camera);
}
animate.previousTime = performance.now();
animate();

// ── Scene restore ────────────────────────────────────────────────────────
let restored = false;
try {
  const saved = JSON.parse(localStorage.getItem('unity-playground-scene') || 'null');
  if (Array.isArray(saved) && saved.length) {
    for (const p of saved) {
      const o = makeObject(p.type, p.name, p);
      if (p.color) o.material.color.setHex(p.color);
      if (Array.isArray(p.components)) o.userData.components = p.components;
      if (['Box', 'Sphere', 'Mesh'].includes(p.colliderType)) o.userData.colliderType = p.colliderType;
    }
    // P2-#7: 最大サフィックスから serial を算出
    let maxNum = 0;
    for (const name of objects.keys()) {
      const m = name.match(/(\d+)$/);
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    }
    serial  = maxNum + 1;
    restored = true;
  }
} catch {}

if (!restored) {
  const c = makeObject('Cube', 'Cube', { position: [0, 0.5, 0] });
  c.material.color.setHex(0x8f78d5);
  selected = c;
  const l = new THREE.PointLight(0xffd69b, 18, 8);
  l.position.set(2, 3, 1);
  l.name     = 'Point Light';
  l.userData = { type: 'Light', components: ['Transform', 'Light'] }; // P1-#3 fix
  scene.add(l);
  objects.set(l.name, l);
  const cam = new THREE.Object3D();
  cam.name     = 'Main Camera';
  cam.userData = { type: 'Camera', components: ['Transform', 'Camera'] }; // P1-#3 fix
  cam.position.set(0, 2, -6);
  scene.add(cam);
  objects.set(cam.name, cam);
}

if (restored) {
  const l = new THREE.PointLight(0xffd69b, 18, 8);
  l.position.set(2, 3, 1); l.name = 'Point Light'; l.userData = { type: 'Light' };
  scene.add(l); objects.set(l.name, l);
  const cam = new THREE.Object3D();
  cam.name = 'Main Camera'; cam.userData = { type: 'Camera' }; cam.position.set(0, 2, -6);
  scene.add(cam); objects.set(cam.name, cam);
  if (!selected) selected = [...objects.values()].find(o => o.isMesh) || null;
}

rebuild();
// P4-#18: 初期ログを JS から出力
addLog('プレイグラウンドへようこそ！オブジェクトを追加して、シーンを作ってみましょう。');

// ── Add popover ───────────────────────────────────────────────────────────
document.querySelector('#addMenu').onclick = e => {
  let menu = document.querySelector('.add-popover');
  if (menu) { menu.remove(); return; }
  menu = document.createElement('div');
  menu.className = 'add-popover';
  menu.innerHTML =
    '<b>オブジェクトを作成</b>' +
    ['Cube', 'Sphere', 'Capsule', 'Cylinder', 'Plane', 'Player', 'Platform', 'Ground', 'Coin', 'Goal', 'Hazard']
      .map(t => `<button data-type="${t}">${definitions[t].glyph}　${t}</button>`)
      .join('');

  // P2-#6: ボタンの位置から動的に計算
  const btn  = document.querySelector('#addMenu');
  const rect = btn.getBoundingClientRect();
  const hier = document.querySelector('.hierarchy').getBoundingClientRect();
  Object.assign(menu.style, {
    position:     'fixed',
    left:         `${rect.left}px`,
    top:          `${rect.bottom + 4}px`,
    zIndex:       '999',
    background:   '#242731',
    border:       '1px solid #414552',
    borderRadius: '7px',
    padding:      '9px',
    width:        '165px',
    boxShadow:    '0 10px 25px #0008',
  });
  menu.querySelector('b').style.cssText = 'display:block;color:#858b99;font-size:10px;padding:4px 7px 8px';
  menu.querySelectorAll('button').forEach(b => {
    b.style.cssText = 'display:block;width:100%;text-align:left;border:0;background:none;color:#d5d6df;padding:7px;border-radius:4px;cursor:pointer';
    b.onmouseenter = () => b.style.background = '#393247';
    b.onmouseleave = () => b.style.background = 'none';
    b.onclick = () => { add(b.dataset.type); menu.remove(); };
  });
  document.body.append(menu);

  // P2-#5: 外クリックで閉じる
  setTimeout(() => {
    document.addEventListener('pointerdown', () => menu.remove(), { capture: true, once: true });
  }, 0);
};

// ── Tool buttons ──────────────────────────────────────────────────────────
document.querySelectorAll('.tool[data-tool]').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tool[data-tool]').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  tool = b.dataset.tool;
  toast(({ select: '選択ツール', move: 'シーン内でドラッグして移動', rotate: '回転ツールを選択しました', scale: 'サイズはインスペクターで変更できます' })[tool]);
});

// ── Play / Stop ───────────────────────────────────────────────────────────
document.querySelector('#playButton').onclick = () => {
  playing = !playing;
  document.querySelector('#playButton').classList.toggle('running', playing);
  document.querySelector('#playLabel').textContent  = playing ? '停止' : '再生';
  document.querySelector('#modeLabel').textContent  = playing ? '再生中' : '編集モード';
  document.querySelector('#viewHint').textContent   = playing ? 'ゲームを実行中です ・ 停止して編集に戻る' : 'ドラッグで視点を回転 ・ ホイールでズーム';
  addLog(playing ? 'ゲームを再生しました。全オブジェクトがゆっくり回転します。' : 'ゲームを停止しました。', 'success');
};

// ── Grid / Focus ──────────────────────────────────────────────────────────
document.querySelector('#gridToggle').onclick = e => {
  showGrid = !showGrid;
  grid.visible = showGrid;
  e.currentTarget.style.color = showGrid ? '#b39aff' : '';
};
let topViewState = null;
document.querySelector('#viewModeButton').onclick = e => {
  if (playing) return;
  if (topViewState) {
    yaw = topViewState.yaw; pitch = topViewState.pitch; topViewState = null;
    e.currentTarget.innerHTML = '<span>◉</span> 3D';
    toast('3D シーンビューに戻しました');
  } else {
    topViewState = { yaw, pitch }; yaw = 0; pitch = Math.PI / 2 - 0.001;
    e.currentTarget.innerHTML = '<span>▦</span> 2D';
    toast('上から見たシーンビューに切り替えました');
  }
  updateCamera();
};
document.querySelector('#focusButton').onclick = () => {
  if (selected) { target.copy(selected.position); distance = 6; updateCamera(); }
};

// ── Undo / Redo ──────────────────────────────────────────────────────────
document.querySelector('#undoButton').onclick = () => stepHistory(undoHistory, redoHistory);
document.querySelector('#redoButton').onclick = () => stepHistory(redoHistory, undoHistory);
updateHistoryButtons();

// ── Reset ─────────────────────────────────────────────────────────────────
document.querySelector('#resetButton').onclick = () => {
  if (!confirm('シーンを初期状態に戻しますか？')) return;
  recordHistory();
  // P1-#3: GPU リソースを dispose してからクリア
  objects.forEach(o => disposeObject(o));
  objects.clear();
  localStorage.removeItem('unity-playground-scene');
  serial   = 1;
  selected = makeObject('Cube', 'Cube', { position: [0, 0.5, 0] });
  const l  = new THREE.PointLight(0xffd69b, 18, 8);
  l.position.set(2, 3, 1);
  l.name     = 'Point Light';
  l.userData = { type: 'Light', components: ['Transform', 'Light'] };
  scene.add(l);
  objects.set(l.name, l);
  const cam = new THREE.Object3D();
  cam.name = 'Main Camera'; cam.userData = { type: 'Camera' }; cam.position.set(0, 2, -6);
  scene.add(cam); objects.set(cam.name, cam);
  rebuild();
  persist();
  addLog('シーンを初期状態に戻しました。');
};

// ── Console / Help ────────────────────────────────────────────────────────
document.querySelector('#clearConsole').onclick = () => { if (consoleBody.dataset.view !== 'project') consoleBody.innerHTML = ''; };
document.querySelector('#helpButton').onclick   = () => document.querySelector('#helpDialog').showModal();
document.querySelector('#closeHelp').onclick    = () => document.querySelector('#helpDialog').close();

// ── Keyboard shortcuts ────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); document.querySelector('#playButton').click(); }
  const editingText = e.target instanceof HTMLElement && e.target.matches('input,textarea,select,[contenteditable="true"]');
  if ((e.ctrlKey || e.metaKey) && !editingText && !playing && e.key.toLowerCase() === 'z') { e.preventDefault(); stepHistory(e.shiftKey ? redoHistory : undoHistory, e.shiftKey ? undoHistory : redoHistory); }
  if ((e.ctrlKey || e.metaKey) && !editingText && !playing && e.key.toLowerCase() === 'y') { e.preventDefault(); stepHistory(redoHistory, undoHistory); }
  if (!editingText && !playing && e.key === 'Delete') { e.preventDefault(); deleteObject(); }
  if (e.key === 'Escape') document.querySelector('#helpDialog').close();
});

// ── Raycaster / Pointer ───────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const pointer   = new THREE.Vector2();
let pointerDown = null;

renderer.domElement.addEventListener('pointerdown', e => {
  if (playing) return;
  pointerDown = { x: e.clientX, y: e.clientY, button: e.button, hit: false };
  if (e.button === 0) {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects([...objects.values()].filter(o => o.isMesh));
    pointerDown.hit = hits.length > 0;
    if (hits.length) {
      select(hits[0].object);
      if (tool === 'move' && !playing) {
        recordHistory();
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -selected.position.y);
        const p     = new THREE.Vector3();
        raycaster.ray.intersectPlane(plane, p);
        drag = { object: selected, mode: 'move', offset: selected.position.clone().sub(p), plane };
      } else if ((tool === 'rotate' || tool === 'scale') && !playing) {
        recordHistory();
        drag = { object: selected, mode: tool, startX: e.clientX, startY: e.clientY, rotation: selected.rotation.clone(), scale: selected.scale.clone() };
      }
    }
  }
});

renderer.domElement.addEventListener('pointermove', e => {
  if (playing) return;
  if (!pointerDown) return;
  const dx = e.clientX - pointerDown.x;
  const dy = e.clientY - pointerDown.y;
  if (drag?.mode === 'move') {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const p = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(drag.plane, p)) {
      drag.object.position.x = p.x + drag.offset.x;
      drag.object.position.z = p.z + drag.offset.z;
    }
  } else if (drag?.mode === 'rotate') {
    drag.object.rotation.x = drag.rotation.x - (e.clientY - drag.startY) * 0.01;
    drag.object.rotation.y = drag.rotation.y + (e.clientX - drag.startX) * 0.01;
  } else if (drag?.mode === 'scale') {
    const factor = Math.max(0.05, 1 - (e.clientY - drag.startY) * 0.01);
    drag.object.scale.set(drag.scale.x * factor, drag.scale.y * factor, drag.scale.z * factor);
  } else if (pointerDown.button === 2 || e.shiftKey || (pointerDown.button === 0 && !pointerDown.hit)) {
    yaw   -= dx * 0.006;
    pitch  = Math.max(-0.15, Math.min(1.35, pitch + dy * 0.006));
    updateCamera();
  }
  pointerDown = { x: e.clientX, y: e.clientY, button: pointerDown.button, hit: pointerDown.hit };
});

renderer.domElement.addEventListener('pointerup', () => {
  if (drag) { persist(); renderInspector(); }
  drag = null;
  pointerDown = null;
});
renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
renderer.domElement.addEventListener('wheel', e => {
  if (playing) return;
  distance = Math.max(3, Math.min(24, distance + e.deltaY * 0.008));
  updateCamera();
}, { passive: true });
renderer.domElement.addEventListener('pointerdown', e => {
  if (e.button === 0 && !drag) renderer.domElement.setPointerCapture(e.pointerId);
});

const playgroundApi = {
  THREE, scene, camera, renderer, objects, definitions,
  makeObject, add, select, deleteObject, persist, rebuild, renderInspector, addLog, toast, recordHistory,
  drainConsoleLogs() { return deferredConsoleLogs.splice(0); },
  get playing() { return playing; },
  set playing(value) { playing = value; },
  clearUserObjects() {
    for (const [name, obj] of [...objects]) {
      if (!obj.isMesh) continue;
      disposeObject(obj); objects.delete(name);
    }
    selected = null; serial = 1;
  },
  importScene(data) {
    if (!Array.isArray(data) || data.length > 500) throw new Error('シーンデータが正しくありません');
    recordHistory();
    this.clearUserObjects();
    for (const item of data) {
      if (!definitions[item.type] || typeof item.name !== 'string') continue;
      const safeName = item.name.slice(0, 64).replace(/[<>\"'`]/g, '');
      const obj = makeObject(item.type, safeName || item.type, item);
      if (Number.isFinite(item.color)) obj.material.color.setHex(item.color);
      if (Array.isArray(item.components)) obj.userData.components = item.components;
      if (['Box', 'Sphere', 'Mesh'].includes(item.colliderType)) obj.userData.colliderType = item.colliderType;
    }
    selected = [...objects.values()].find(o => o.isMesh) || null;
    rebuild(); persist();
  },
  exportScene() {
    return [...objects.values()].filter(o => o.isMesh).map(o => ({
      name:o.name,type:o.userData.type,position:o.position.toArray(),rotation:o.rotation.toArray().slice(0,3),scale:o.scale.toArray(),
      color:o.material.color.getHex(),components:o.userData.components||[],colliderType:o.userData.colliderType||'Box',
    }));
  },
};
gameplaySystem = installGameplay(playgroundApi);
rebuild();
