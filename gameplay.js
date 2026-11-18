const BASE_COMPONENTS = ['Transform', 'Mesh Renderer'];
const GAME_COMPONENTS = ['Rigidbody', 'Player Controller', 'Collectible', 'Goal', 'Hazard', 'Box Collider', 'Sphere Collider', 'Mesh Collider'];

export function installGameplay(api) {
  const { THREE, camera, renderer, scene, objects } = api;
  const gameHud = document.querySelector('#gameHud');
  const gameEnd = document.querySelector('#gameEnd');
  const touchControls = document.querySelector('#touchControls');
  const keys = new Set();
  const bodySnapshots = new Map();
  const rigidVelocities = new Map();
  let player = null;
  let spawn = null;
  let velocityY = 0;
  let onGround = false;
  let lives = 3;
  let collected = new Set();
  let coinObjects = [];
  let ended = false;
  let editorView = null;
  let lastHit = 0;
  let gridSnapshot = [];

  const has = (object, component) => (object?.userData?.components || []).includes(component);
  const hasCollider = object => ['Box Collider', 'Sphere Collider', 'Mesh Collider'].some(name => has(object, name));
  const meshObjects = () => [...objects.values()].filter(object => object.isMesh);
  const isTrigger = object => has(object, 'Collectible') || has(object, 'Goal') || has(object, 'Hazard') || ['Coin', 'Goal', 'Hazard'].includes(object.userData.type);
  const boxFor = object => new THREE.Box3().setFromObject(object);
  const gameTab = document.querySelector('#gameViewTab');
  const sceneTab = document.querySelector('#sceneTab');
  const consoleBody = document.querySelector('#consoleBody');
  const consoleTabs = [...document.querySelectorAll('.console-tab')];
  let cachedConsoleHtml = consoleBody.innerHTML;

  function showProjectPanel() {
    cachedConsoleHtml = consoleBody.innerHTML;
    consoleBody.dataset.view = 'project';
    consoleBody.innerHTML = '<div class="project-list"><div class="project-list-title">シーン内オブジェクト <span></span></div><div class="project-list-items"></div></div>';
    const entries = consoleBody.querySelector('.project-list-items');
    const visibleObjects = [...objects.values()];
    consoleBody.querySelector('.project-list-title span').textContent = `${visibleObjects.length} 個`;
    for (const object of visibleObjects) {
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'project-entry';
      const glyph = document.createElement('span'); glyph.className = 'object-icon';
      glyph.textContent = api.definitions[object.userData.type]?.glyph || '☼';
      const name = document.createElement('span'); name.textContent = object.name;
      const kind = document.createElement('small'); kind.textContent = object.userData.type;
      row.append(glyph, name, kind);
      row.onclick = () => { if (api.playing) return; api.select(object); row.focus(); };
      entries.append(row);
    }
  }

  function showConsolePanel() {
    consoleBody.dataset.view = 'console';
    consoleBody.innerHTML = cachedConsoleHtml;
    for (const row of api.drainConsoleLogs()) consoleBody.prepend(row);
  }

  consoleTabs[0].onclick = () => {
    consoleTabs.forEach(tab => tab.classList.remove('selected'));
    consoleTabs[0].classList.add('selected'); showConsolePanel();
  };
  consoleTabs[1].onclick = () => {
    consoleTabs.forEach(tab => tab.classList.remove('selected'));
    consoleTabs[1].classList.add('selected'); showProjectPanel();
  };

  function setTab(isGame) {
    gameTab.classList.toggle('active', isGame);
    sceneTab.classList.toggle('active', !isGame);
    document.querySelector('#viewportName').textContent = isGame ? 'ゲームビュー' : 'シーンビュー';
    document.querySelector('.workspace').classList.toggle('game-running', isGame);
  }

  function updateHUD() {
    document.querySelector('#coinCount').textContent = `${collected.size} / ${coinObjects.length}`;
    document.querySelector('#lifeCount').textContent = String(lives);
  }

  function message(title, detail, icon = '✦') {
    document.querySelector('#gameEndTitle').textContent = title;
    document.querySelector('#gameEndMessage').textContent = detail;
    document.querySelector('#gameEndIcon').textContent = icon;
    gameEnd.hidden = false;
    ended = true;
  }

  function closeMessage() { gameEnd.hidden = true; ended = false; }

  function saveRuntimeState() {
    bodySnapshots.clear();
    for (const object of meshObjects()) {
      bodySnapshots.set(object, {
        position: object.position.clone(),
        rotation: object.rotation.clone(),
        visible: object.visible,
      });
    }
  }

  function restoreRuntimeState() {
    for (const [object, snapshot] of bodySnapshots) {
      if (!objects.has(object.name)) continue;
      object.position.copy(snapshot.position);
      object.rotation.copy(snapshot.rotation);
      object.visible = snapshot.visible;
    }
    rigidVelocities.clear();
    api.persist();
  }

  function findPlayer() {
    return meshObjects().find(object => has(object, 'Player Controller')) || null;
  }

  function setEditorCamera() {
    if (!editorView) return;
    camera.position.copy(editorView.position);
    camera.quaternion.copy(editorView.quaternion);
    camera.updateMatrixWorld();
    editorView = null;
  }

  function start() {
    player = findPlayer();
    if (!player) {
      api.toast('Player Controller がありません。＋から Player を追加するか、ゲームテンプレートを読み込んでください。');
      api.addLog('再生できません: Player Controller を持つオブジェクトが必要です。', 'warn');
      return;
    }
    saveRuntimeState();
    spawn = player.position.clone();
    velocityY = 0;
    onGround = false;
    lives = 3;
    ended = false;
    collected = new Set();
    coinObjects = meshObjects().filter(object => has(object, 'Collectible') || object.userData.type === 'Coin');
    for (const coin of coinObjects) coin.visible = true;
    updateHUD();
    editorView = { position: camera.position.clone(), quaternion: camera.quaternion.clone() };
    gameHud.hidden = false;
    gameEnd.hidden = true;
    touchControls.hidden = !('ontouchstart' in window || navigator.maxTouchPoints > 0);
    gridSnapshot = scene.children.filter(child => child.isGridHelper).map(child => ({ child, visible: child.visible }));
    gridSnapshot.forEach(item => { item.child.visible = false; });
    api.playing = true;
    setTab(true);
    document.querySelector('#playButton').classList.add('running');
    document.querySelector('#playLabel').textContent = '停止';
    document.querySelector('#modeLabel').textContent = '再生中';
    document.querySelector('#viewHint').textContent = '';
    renderer.domElement.focus({ preventScroll: true });
    api.addLog('ゲームを開始しました。WASD / 矢印キーで移動、Space でジャンプ。', 'success');
  }

  function stop() {
    if (!api.playing) return;
    api.playing = false;
    keys.clear();
    restoreRuntimeState();
    setEditorCamera();
    gameHud.hidden = true;
    gameEnd.hidden = true;
    touchControls.hidden = true;
    gridSnapshot.forEach(item => { item.child.visible = item.visible; });
    document.querySelector('#playButton').classList.remove('running');
    document.querySelector('#playLabel').textContent = '再生';
    document.querySelector('#modeLabel').textContent = '編集モード';
    document.querySelector('#viewHint').textContent = 'ドラッグで視点を回転 ・ ホイールでズーム';
    setTab(false);
    api.addLog('ゲームを停止しました。編集状態に戻りました。', 'info');
  }

  function restartRound() {
    if (!player || !spawn) return;
    player.position.copy(spawn);
    velocityY = 0;
    onGround = false;
    lives = 3;
    collected.clear();
    coinObjects.forEach(coin => { coin.visible = true; });
    updateHUD();
    closeMessage();
    renderer.domElement.focus({ preventScroll: true });
  }

  function overlapsXZ(x, z, radius, box) {
    return x + radius > box.min.x && x - radius < box.max.x && z + radius > box.min.z && z - radius < box.max.z;
  }

  function resetPlayerAfterHit(now) {
    if (now - lastHit < 0.75) return;
    lastHit = now;
    lives -= 1;
    player.position.copy(spawn);
    velocityY = 0;
    onGround = false;
    updateHUD();
    if (lives <= 0) message('ゲームオーバー', 'もう一度遊んで、ゴールを目指そう。', '↻');
  }

  function updatePlayer(dt, now) {
    if (!player || ended) return;
    const left = keys.has('a') || keys.has('A') || keys.has('ArrowLeft');
    const right = keys.has('d') || keys.has('D') || keys.has('ArrowRight');
    const forward = keys.has('w') || keys.has('W') || keys.has('ArrowUp');
    const back = keys.has('s') || keys.has('S') || keys.has('ArrowDown');
    let dx = Number(right) - Number(left);
    let dz = Number(back) - Number(forward);
    const length = Math.hypot(dx, dz);
    if (length > 0) { dx /= length; dz /= length; }

    const box = boxFor(player);
    const halfHeight = (box.max.y - box.min.y) / 2;
    const radius = Math.max(0.2, Math.min(player.scale.x, player.scale.z) * 0.34);
    const oldBottom = player.position.y - halfHeight;
    const solids = meshObjects().filter(object => object !== player && hasCollider(object) && !isTrigger(object));

    const oldX = player.position.x;
    const oldZ = player.position.z;
    const nextX = oldX + dx * 4.8 * dt;
    const nextZ = oldZ + dz * 4.8 * dt;
    let resolvedX = nextX;
    let resolvedZ = nextZ;
    for (const solid of solids) {
      const bounds = boxFor(solid);
      const head = player.position.y + halfHeight;
      if (head <= bounds.min.y || oldBottom >= bounds.max.y - 0.02) continue;
      if (overlapsXZ(nextX, oldZ, radius, bounds)) resolvedX = oldX;
      if (overlapsXZ(resolvedX, nextZ, radius, bounds)) resolvedZ = oldZ;
    }
    player.position.x = resolvedX;
    player.position.z = resolvedZ;

    const jump = keys.has(' ') || keys.has('Space') || keys.has('Spacebar');
    if (jump && onGround) { velocityY = 7.2; onGround = false; }
    velocityY -= 18 * dt;
    player.position.y += velocityY * dt;
    onGround = false;

    let landingY = 0; // The editor floor is an infinite beginner-friendly ground plane.
    for (const solid of solids) {
      const bounds = boxFor(solid);
      if (overlapsXZ(player.position.x, player.position.z, radius, bounds) && bounds.max.y <= oldBottom + 0.12 && bounds.max.y > landingY) landingY = bounds.max.y;
    }
    const newBottom = player.position.y - halfHeight;
    if (newBottom <= landingY && velocityY <= 0) {
      player.position.y = landingY + halfHeight;
      velocityY = 0;
      onGround = true;
    }
    if (player.position.y < -8) resetPlayerAfterHit(now);
    if (length > 0.05) player.rotation.y = Math.atan2(dx, dz) + Math.PI;

    for (const coin of coinObjects) {
      if (!coin.visible || collected.has(coin)) continue;
      coin.rotation.y += dt * 2.4;
      if (player.position.distanceTo(coin.position) < 0.95) {
        collected.add(coin);
        coin.visible = false;
        updateHUD();
        api.addLog(`コインを取得しました (${collected.size}/${coinObjects.length})`, 'success');
      }
    }
    for (const hazard of meshObjects().filter(object => has(object, 'Hazard') || object.userData.type === 'Hazard')) {
      if (player.position.distanceTo(hazard.position) < 0.9) resetPlayerAfterHit(now);
    }
    for (const goal of meshObjects().filter(object => has(object, 'Goal') || object.userData.type === 'Goal')) {
      if (player.position.distanceTo(goal.position) < 1.25) {
        if (collected.size === coinObjects.length) message('クリア！', 'コインを全部集めてゴールしました。');
        else if (now - lastHit > 1.2) { lastHit = now; api.toast(`あと ${coinObjects.length - collected.size} 枚集めよう`); }
      }
    }
    camera.position.set(player.position.x, player.position.y + 3.5, player.position.z + 7.2);
    camera.lookAt(player.position.x, player.position.y + 0.45, player.position.z);
  }

  function updateRigidbodies(dt) {
    for (const object of meshObjects()) {
      if (object === player || !has(object, 'Rigidbody') || has(object, 'Player Controller') || isTrigger(object)) continue;
      if (!rigidVelocities.has(object)) rigidVelocities.set(object, 0);
      let speed = rigidVelocities.get(object) - 18 * dt;
      const bounds = boxFor(object);
      let floorY = 0;
      for (const other of meshObjects()) {
        if (other === object || !hasCollider(other) || has(other, 'Rigidbody') || isTrigger(other)) continue;
        const otherBox = boxFor(other);
        if (overlapsXZ(object.position.x, object.position.z, 0.1, otherBox) && otherBox.max.y <= bounds.min.y + 0.12) floorY = Math.max(floorY, otherBox.max.y);
      }
      const halfHeight = (bounds.max.y - bounds.min.y) / 2;
      object.position.y += speed * dt;
      if (object.position.y - halfHeight < floorY && speed < 0) { object.position.y = floorY + halfHeight; speed = 0; }
      rigidVelocities.set(object, speed);
    }
  }

  function update(dt) {
    if (!api.playing) return;
    const now = performance.now() / 1000;
    updatePlayer(dt, now);
    updateRigidbodies(dt);
  }

  function createStarterGame(silent = false) {
    if (!silent && meshObjects().length && !confirm('現在のシーンをコイン集めゲームのテンプレートに置き換えますか？')) return;
    if (!silent) api.recordHistory();
    api.clearUserObjects();
    const ground = api.makeObject('Ground', 'Ground', { position: [0, -0.2, 0], scale: [1.2, 1, 1.2] });
    const hero = api.makeObject('Player', 'Player', { position: [-5, 0.75, -4], scale: [1, 1.05, 1] });
    hero.material.color.setHex(0x568dff);
    const coinPositions = [[-3, 0.72, -2], [-1.5, 0.72, 1], [0.5, 0.72, -1], [2.2, 0.72, 2], [4, 0.72, -1.5]];
    coinPositions.forEach((position, index) => {
      const coin = api.makeObject('Coin', `Coin ${index + 1}`, { position, rotation: [Math.PI / 2, 0, 0], scale: [1, 1, 1] });
      coin.material.color.setHex(0xffca5f);
    });
    const goal = api.makeObject('Goal', 'Goal', { position: [5, 0.45, -0.4], scale: [1.3, 1, 1.3] });
    goal.material.color.setHex(0x62d69b);
    const step = api.makeObject('Platform', 'Platform 1', { position: [0, 0.48, 0], scale: [1, 1, 1] });
    step.material.color.setHex(0x8591a6);
    // Keep the platform away from the spawn so it serves as a simple jump target.
    api.select(hero);
    api.persist();
    api.rebuild();
    if (!silent) api.addLog('ゲームテンプレートを作成しました。再生してコインを集めましょう。', 'success');
  }

  function componentState(object, component, enabled) {
    api.recordHistory();
    const components = new Set(object.userData.components || BASE_COMPONENTS);
    if (enabled) components.add(component); else components.delete(component);
    if (component === 'Player Controller' && enabled) {
      components.add('Rigidbody');
      if (object.userData.type === 'Cube') object.userData.type = 'Player';
    }
    object.userData.components = [...components];
    api.persist(); api.renderInspector();
  }

  function decorateInspector(object) {
    const button = document.querySelector('#addComponent');
    if (!button) return;
    button.textContent = '＋ コンポーネントを追加';
    button.onclick = () => {
      document.querySelector('.component-picker')?.remove();
      const picker = document.createElement('div');
      picker.className = 'component-picker';
      picker.innerHTML = '<b>追加するコンポーネント</b>' + GAME_COMPONENTS.filter(name => !has(object, name)).map(name => `<button type="button" data-component="${name}">${name}</button>`).join('');
      button.after(picker);
      picker.querySelectorAll('button').forEach(item => item.onclick = () => {
        componentState(object, item.dataset.component, true);
        api.addLog(`${item.dataset.component} を ${object.name} に追加しました。`, 'success');
      });
      if (!picker.querySelector('button')) picker.insertAdjacentHTML('beforeend', '<small>追加できるコンポーネントはありません。</small>');
    };

    const section = document.createElement('section');
    section.className = 'component behavior-component';
    section.innerHTML = '<div class="component-head"><span class="component-glyph">⌘</span> ゲーム動作</div><div class="component-desc">コンポーネントを付けると、再生中に動作します。</div>';
    const options = ['Rigidbody', 'Player Controller', 'Collectible', 'Goal', 'Hazard', 'Box Collider'];
    for (const name of options) {
      const row = document.createElement('label');
      row.className = 'component-option';
      const check = document.createElement('input');
      check.type = 'checkbox'; check.checked = has(object, name);
      check.onchange = () => componentState(object, name, check.checked);
      const copy = document.createElement('span');
      copy.innerHTML = `<b>${name}</b><small>${({
        Rigidbody: '重力を受けて落下します',
        'Player Controller': 'WASD / 矢印キーで移動できます',
        Collectible: 'プレイヤーが触れると取得されます',
        Goal: '触れるとゲームをクリアします',
        Hazard: '触れるとライフを失います',
        'Box Collider': '床や壁との当たり判定を有効にします',
      })[name]}</small>`;
      row.append(check, copy); section.append(row);
    }
    button.after(section);
  }

  document.querySelector('#playButton').onclick = () => api.playing ? stop() : start();
  gameTab.onclick = () => { if (!api.playing) start(); };
  sceneTab.onclick = () => { if (api.playing) stop(); else setTab(false); };
  document.querySelector('#starterGameButton').onclick = () => createStarterGame(false);
  document.querySelector('#restartGameButton').onclick = restartRound;
  const resetButton = document.querySelector('#resetButton');
  const resetScene = resetButton.onclick;
  resetButton.onclick = event => { if (api.playing) stop(); resetScene?.(event); };

  document.querySelectorAll('[data-game-key]').forEach(button => {
    const key = button.dataset.gameKey;
    button.addEventListener('pointerdown', event => { event.preventDefault(); keys.add(key); button.setPointerCapture(event.pointerId); });
    const release = () => keys.delete(key);
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);
  });
  document.addEventListener('keydown', event => {
    if (!api.playing || event.target.closest('input,button,textarea,select') && event.target !== document.body) return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(event.key)) event.preventDefault();
    keys.add(event.key);
  });
  document.addEventListener('keyup', event => keys.delete(event.key));
  window.addEventListener('blur', () => keys.clear());

  document.querySelector('#downloadProjectButton').onclick = () => {
    const blob = new Blob([JSON.stringify(api.exportScene(), null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    const objectUrl = URL.createObjectURL(blob);
    link.href = objectUrl; link.download = 'my-unity-scene.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    api.addLog('シーンを JSON ファイルに保存しました。', 'success');
  };
  document.querySelector('#loadProjectButton').onclick = () => document.querySelector('#loadProjectInput').click();
  document.querySelector('#shareGameButton').onclick = async () => {
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(api.exportScene()))));
    const url = new URL(location.href); url.hash = `scene=${encoded}`;
    try { await navigator.clipboard.writeText(url.href); api.toast('ゲームを共有するリンクをコピーしました'); }
    catch { window.prompt('このリンクをコピーして共有してください', url.href); }
  };
  document.querySelector('#loadProjectInput').onchange = async event => {
    const file = event.target.files?.[0]; if (!file) return;
    try { api.importScene(JSON.parse(await file.text())); api.toast('シーンを読み込みました'); }
    catch { api.toast('このファイルをシーンとして読み込めませんでした'); }
    event.target.value = '';
  };
  if (location.hash.startsWith('#scene=')) {
    try {
      const data = JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(7)))));
      api.importScene(data);
      history.replaceState(null, '', location.pathname + location.search);
      api.addLog('共有されたシーンを読み込みました。', 'success');
    } catch { api.toast('共有リンクのシーンデータを読み込めませんでした'); }
  }

  if (!localStorage.getItem('unity-playground-scene') && !location.hash.startsWith('#scene=')) createStarterGame(true);

  return { update, decorateInspector, createStarterGame };
}
