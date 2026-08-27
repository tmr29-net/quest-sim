import './style.css';
import * as THREE from 'three';
import { createClient } from '@supabase/supabase-js';

// --- Supabase クライアント設定 ---
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

let supabase: any = null;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (e) {
    console.error('Supabase initialization failed:', e);
  }
}

// ローカルデータ保存用フォールバック
const LOCAL_STORAGE_KEY = 'flood_sim_sessions';
const LOCAL_TRAJECTORY_KEY = 'flood_sim_trajectories';
const CUSTOM_MAP_KEY = 'flood_sim_custom_map_v2'; // バージョン変更して古いキャッシュと衝突しないようにする

function saveSessionLocally(session: any, trajectories: any[]) {
  const sessions = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '[]');
  sessions.push(session);
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(sessions));

  const allTrajectories = JSON.parse(localStorage.getItem(LOCAL_TRAJECTORY_KEY) || '{}');
  allTrajectories[session.id] = trajectories;
  localStorage.setItem(LOCAL_TRAJECTORY_KEY, JSON.stringify(allTrajectories));
}

function getLocalSessions() {
  return JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '[]');
}

function getLocalTrajectories(sessionId: string) {
  const all = JSON.parse(localStorage.getItem(LOCAL_TRAJECTORY_KEY) || '{}');
  return all[sessionId] || [];
}

// --- マップ定数 (500m x 500m) ---
const MAP_SIZE = 500;
const HALF_MAP = MAP_SIZE / 2;
const GRID_CELLS = 25;
const CELL_SIZE = MAP_SIZE / GRID_CELLS; // 1マス = 20m

// --- マップメーカー グリッド定義 ---
type CellType = 'grass' | 'road' | 'river' | 'building' | 'siteA' | 'siteB' | 'siteC' | 'siteD' | 'start';

let customMap: CellType[][] = [];

// デフォルトマップのロード (川や複数の高低差を持たせたリアルな町)
function initDefaultMap() {
  const map: CellType[][] = Array(GRID_CELLS).fill(null).map(() => Array(GRID_CELLS).fill('grass'));
  
  // 東側 (col: 22〜24) を川にする
  for (let r = 0; r < GRID_CELLS; r++) {
    for (let c = 22; c < GRID_CELLS; c++) {
      map[r][c] = 'river';
    }
  }

  // 西から東に流れる支流 (row: 13, col: 10〜21)
  for (let c = 10; c <= 21; c++) {
    map[13][c] = 'river';
  }

  // 主要道路の配置 (避難路として)
  for (let r = 0; r < GRID_CELLS; r++) {
    // 縦方向の幹線道路 (col 6, 12, 17)
    if (map[r][6] === 'grass') map[r][6] = 'road';
    if (map[r][12] === 'grass') map[r][12] = 'road';
    if (map[r][17] === 'grass') map[r][17] = 'road';
  }

  for (let c = 0; c < GRID_CELLS; c++) {
    // 横方向の幹線道路 (row 4, 10, 18)
    if (map[4][c] === 'grass') map[4][c] = 'road';
    if (map[10][c] === 'grass') map[10][c] = 'road';
    if (map[18][c] === 'grass') map[18][c] = 'road';
  }

  // 建物配置
  for (let r = 0; r < GRID_CELLS; r++) {
    for (let c = 0; c < GRID_CELLS; c++) {
      if (map[r][c] === 'grass') {
        const isHighGround = r < 7;
        const prob = isHighGround ? 0.15 : 0.35; // 高台は建物が少なく、低地は密集
        if (Math.random() < prob) {
          map[r][c] = 'building';
        }
      }
    }
  }

  // 避難所の初期位置
  map[19][15] = 'siteA'; // 低地 (小学校)
  map[9][9] = 'siteB';   // 中台 (公民館)
  map[2][3] = 'siteC';   // 高台 (北山公園)
  map[16][10] = 'siteD';  // 垂直避難ビル

  // 開始地点
  map[21][12] = 'start'; // 南の道路付近

  return map;
}

function loadCustomMap() {
  const saved = localStorage.getItem(CUSTOM_MAP_KEY);
  if (saved) {
    try {
      customMap = JSON.parse(saved);
      return;
    } catch (e) {
      console.error('Failed to parse custom map', e);
    }
  }
  customMap = initDefaultMap();
}

// グリッドセル座標を 3D空間の (X, Z) に変換
function gridTo3D(row: number, col: number) {
  // セルの中心座標を返す
  const z = (row + 0.5) * CELL_SIZE - HALF_MAP;
  const x = (col + 0.5) * CELL_SIZE - HALF_MAP;
  return { x, z };
}

// --- 避難所データ定義 ---
interface EvacuationSite {
  id: string;
  name: string;
  x: number;
  z: number;
  y: number; // 標高
  radius: number;
  color: number;
  safetyType: 'danger' | 'marginal' | 'safe' | 'vertical';
  description: string;
  heightOffset?: number;
}

let EVACUATION_SITES: EvacuationSite[] = [];

// --- 障害物（建物）定義 ---
interface Obstacle {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  groundY: number;
}

let BUILDINGS: Obstacle[] = [];

// --- グローバルステート ---
let currentSession: any = null;
let trajectoryData: any[] = [];
let isPlaying = false;
let gameTime = 0;
let maxGameTime = 300;
let waterLevel = 0.0; // ボクセルなので基準高さを 0.0 に変更
let waterStartSecond = 30;
let checkTimerInterval: any = null;
let logInterval: any = null;

// プレイヤー状態
const player = {
  x: 0,
  z: 220,
  y: 1.0,
  speed: 15.0, // 秒速15m (3D世界用、deltaTimeを考慮するのでちょうど良い走行スピード)
  radius: 1.2
};

// 操作入力
const keys = { w: false, a: false, s: false, d: false };
const joystick = { active: false, startX: 0, startY: 0, curX: 0, curY: 0 };

// Three.js 関連
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let playerMesh: THREE.Mesh;
let waterMesh: THREE.Mesh;
let siteMeshes: THREE.Group[] = [];
let clock: THREE.Clock;

// ボクセルインスタンス
let grassInstances: THREE.InstancedMesh | null = null;
let roadInstances: THREE.InstancedMesh | null = null;
let riverInstances: THREE.InstancedMesh | null = null;
let buildingInstances: THREE.InstancedMesh | null = null;
let siteDBuildingMesh: THREE.Mesh | null = null;

// マップのグリッドセルごとの標高を返す関数 (マイクラ風段差)
// 南側 row 18〜24 (低地) = 1.0m
// 中低地 row 11〜17 = 4.0m
// 中高台 row 6〜10 = 8.0m
// 北側高台 row 0〜5 = 12.0m
// ただし川(river)の場合は川底として標高 0.2m になる
function getVoxelHeight(row: number, type: CellType): number {
  if (type === 'river') {
    return 0.2; // 川底
  }

  // 標高の段階的ステップ (段差)
  if (row <= 5) {
    return 12.0; // 高台
  } else if (row <= 10) {
    return 8.0;  // 中高台
  } else if (row <= 17) {
    return 4.0;  // 中低地
  } else {
    return 1.0;  // 低地
  }
}

// 3D座標(X, Z)から対応するグリッドセル(row, col)を逆算して標高を求める
function getTerrainHeight(x: number, z: number): number {
  const col = Math.floor((x + HALF_MAP) / CELL_SIZE);
  const row = Math.floor((z + HALF_MAP) / CELL_SIZE);
  
  if (row >= 0 && row < GRID_CELLS && col >= 0 && col < GRID_CELLS) {
    const type = customMap[row]?.[col] || 'grass';
    return getVoxelHeight(row, type);
  }
  return 1.0;
}

// --- 初期化 ---
document.addEventListener('DOMContentLoaded', () => {
  loadCustomMap();
  setupUIEvents();
  setupMapMakerEvents();
  initThree();
  clock = new THREE.Clock();
  animate();
});

// --- UIイベント設定 ---
function setupUIEvents() {
  const startForm = document.getElementById('start-form') as HTMLFormElement;
  const screenStart = document.getElementById('screen-start')!;
  const screenGame = document.getElementById('screen-game')!;
  const screenResult = document.getElementById('screen-result')!;
  const screenAdmin = document.getElementById('screen-admin')!;
  const screenMapmaker = document.getElementById('screen-mapmaker')!;
  
  const inputHazard = document.getElementById('input-hazard') as HTMLInputElement;
  const hazardMapContainer = document.getElementById('hazard-map-container')!;
  
  const btnEvacuate = document.getElementById('btn-evacuate') as HTMLButtonElement;
  const btnGotoAdmin = document.getElementById('btn-goto-admin')!;
  const btnAdminClose = document.getElementById('btn-admin-close')!;
  const btnResultRestart = document.getElementById('btn-result-restart')!;
  const btnClearSelection = document.getElementById('btn-clear-selection')!;
  const filterHazard = document.getElementById('filter-hazard') as HTMLSelectElement;
  const btnGotoMapmaker = document.getElementById('btn-goto-mapmaker')!;

  inputHazard.addEventListener('change', () => {
    if (inputHazard.checked) {
      hazardMapContainer.classList.remove('hidden');
    } else {
      hazardMapContainer.classList.add('hidden');
    }
  });

  // シミュレーション開始
  startForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = (document.getElementById('input-name') as HTMLInputElement).value;
    const age = (document.getElementById('input-age') as HTMLSelectElement).value;
    const hasHazard = inputHazard.checked;
    const selectedMapType = (document.getElementById('select-map') as HTMLSelectElement).value;

    if (selectedMapType === 'custom') {
      const saved = localStorage.getItem(CUSTOM_MAP_KEY);
      customMap = saved ? JSON.parse(saved) : initDefaultMap();
    } else {
      customMap = initDefaultMap();
    }

    // 3D世界の構築
    rebuild3DWorld(customMap);

    currentSession = {
      id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2),
      created_at: new Date().toISOString(),
      age_group: age,
      name: name,
      has_hazard_map: hasHazard,
      selected_destination: '',
      status: 'playing',
      duration: 0
    };

    trajectoryData = [];
    gameTime = 0;
    waterLevel = 0.2; // 初期水位は川底の高さ

    screenStart.classList.add('hidden');
    screenGame.classList.remove('hidden');
    
    window.dispatchEvent(new Event('resize'));
    
    clock.getDelta(); // クロックをリセット
    startSimulation();
  });

  // 避難確定
  btnEvacuate.addEventListener('click', () => {
    const activeSite = getActiveEvacuationSite();
    if (activeSite) {
      endSimulation('evacuated', activeSite);
    }
  });

  // ページ遷移
  btnGotoAdmin.addEventListener('click', () => {
    screenStart.classList.add('hidden');
    screenAdmin.classList.remove('hidden');
    loadAdminSessions();
  });

  btnAdminClose.addEventListener('click', () => {
    screenAdmin.classList.add('hidden');
    screenStart.classList.remove('hidden');
  });

  btnResultRestart.addEventListener('click', () => {
    screenResult.classList.add('hidden');
    screenStart.classList.remove('hidden');
  });

  btnGotoMapmaker.addEventListener('click', () => {
    screenStart.classList.add('hidden');
    screenMapmaker.classList.remove('hidden');
    renderEditorGrid();
  });

  filterHazard.addEventListener('change', loadAdminSessions);
  btnClearSelection.addEventListener('click', () => {
    selectedSessionIds.clear();
    drawTrajectoriesOnMap();
    renderSessionList();
  });

  // キーボード
  window.addEventListener('keydown', (e) => {
    if (!isPlaying) return;
    if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') keys.w = true;
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keys.a = true;
    if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') keys.s = true;
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keys.d = true;
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') keys.w = false;
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keys.a = false;
    if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') keys.s = false;
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keys.d = false;
  });

  // ジョイスティック
  const joystickZone = document.getElementById('joystick-zone')!;
  const joystickHandle = document.getElementById('joystick-handle')!;

  joystickZone.addEventListener('touchstart', (e: TouchEvent) => {
    const touch = e.touches[0];
    const rect = joystickZone.getBoundingClientRect();
    joystick.active = true;
    joystick.startX = rect.left + rect.width / 2;
    joystick.startY = rect.top + rect.height / 2;
    updateJoystick(touch.clientX, touch.clientY);
  });

  window.addEventListener('touchmove', (e: TouchEvent) => {
    if (!joystick.active) return;
    const touch = e.touches[0];
    updateJoystick(touch.clientX, touch.clientY);
  }, { passive: false });

  window.addEventListener('touchend', () => {
    if (!joystick.active) return;
    joystick.active = false;
    joystickHandle.style.left = 'calc(50% - 1.5rem)';
    joystickHandle.style.top = 'calc(50% - 1.5rem)';
    keys.w = false;
    keys.s = false;
    keys.a = false;
    keys.d = false;
  });

  function updateJoystick(clientX: number, clientY: number) {
    const dx = clientX - joystick.startX;
    const dy = clientY - joystick.startY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const maxDist = 50;

    let angle = Math.atan2(dy, dx);
    let clampedX = dx;
    let clampedY = dy;

    if (dist > maxDist) {
      clampedX = Math.cos(angle) * maxDist;
      clampedY = Math.sin(angle) * maxDist;
    }

    joystickHandle.style.left = `calc(50% - 1.5rem + ${clampedX}px)`;
    joystickHandle.style.top = `calc(50% - 1.5rem + ${clampedY}px)`;

    const threshold = 15;
    keys.a = clampedX < -threshold;
    keys.d = clampedX > threshold;
    keys.w = clampedY < -threshold;
    keys.s = clampedY > threshold;
  }
}

// ==========================================
//        マップメーカー (エディタ) の処理
// ==========================================
let activeBrush: CellType = 'road';

function setupMapMakerEvents() {
  const btnClose = document.getElementById('btn-mapmaker-close')!;
  const btnReset = document.getElementById('btn-mapmaker-reset')!;
  const paletteButtons = document.querySelectorAll('.palette-btn');

  btnClose.addEventListener('click', () => {
    localStorage.setItem(CUSTOM_MAP_KEY, JSON.stringify(customMap));
    document.getElementById('screen-mapmaker')!.classList.add('hidden');
    document.getElementById('screen-start')!.classList.remove('hidden');
    (document.getElementById('select-map') as HTMLSelectElement).value = 'custom';
  });

  btnReset.addEventListener('click', () => {
    if (confirm('マップをすべて消去（草地に）しますか？')) {
      customMap = Array(GRID_CELLS).fill(null).map(() => Array(GRID_CELLS).fill('grass'));
      renderEditorGrid();
    }
  });

  paletteButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      paletteButtons.forEach(b => b.classList.remove('border-cyan-500', 'border-2'));
      paletteButtons.forEach(b => b.classList.add('border-slate-700'));
      
      btn.classList.remove('border-slate-700');
      btn.classList.add('border-cyan-500', 'border-2');
      
      activeBrush = btn.getAttribute('data-type') as CellType;
    });
  });
}

function renderEditorGrid() {
  const container = document.getElementById('editor-grid-container')!;
  container.innerHTML = '';

  for (let row = 0; row < GRID_CELLS; row++) {
    for (let col = 0; col < GRID_CELLS; col++) {
      const cell = document.createElement('div');
      const type = customMap[row][col];
      
      cell.className = `w-full aspect-square border border-slate-900 cursor-pointer transition select-none flex items-center justify-center text-[8px] font-bold ${getCellClass(type)}`;
      cell.setAttribute('data-row', row.toString());
      cell.setAttribute('data-col', col.toString());

      if (type === 'start') {
        cell.innerText = '始';
        cell.classList.add('text-slate-950');
      } else if (type === 'siteA') {
        cell.innerText = 'A';
        cell.classList.add('text-slate-950');
      } else if (type === 'siteB') {
        cell.innerText = 'B';
        cell.classList.add('text-slate-950');
      } else if (type === 'siteC') {
        cell.innerText = 'C';
        cell.classList.add('text-slate-950');
      } else if (type === 'siteD') {
        cell.innerText = 'D';
        cell.classList.add('text-slate-950');
      }

      const handlePaint = (e: MouseEvent) => {
        if (e.buttons === 1) {
          paintCell(row, col);
        }
      };

      cell.addEventListener('mousedown', (e) => {
        e.preventDefault();
        paintCell(row, col);
      });
      cell.addEventListener('mouseenter', handlePaint);

      container.appendChild(cell);
    }
  }
}

function getCellClass(type: CellType): string {
  switch (type) {
    case 'road': return 'bg-slate-500';
    case 'river': return 'bg-cyan-700'; // 川の色
    case 'building': return 'bg-slate-300';
    case 'siteA': return 'bg-red-500';
    case 'siteB': return 'bg-yellow-500';
    case 'siteC': return 'bg-emerald-500';
    case 'siteD': return 'bg-blue-500';
    case 'start': return 'bg-cyan-400 rounded-full';
    default: return 'bg-slate-950 hover:bg-slate-800'; // grass
  }
}

function paintCell(row: number, col: number) {
  const oldType = customMap[row][col];
  if (oldType === activeBrush) return;

  if (['siteA', 'siteB', 'siteC', 'siteD', 'start'].includes(activeBrush)) {
    for (let r = 0; r < GRID_CELLS; r++) {
      for (let c = 0; c < GRID_CELLS; c++) {
        if (customMap[r][c] === activeBrush) {
          customMap[r][c] = 'grass';
        }
      }
    }
  }

  customMap[row][col] = activeBrush;
  renderEditorGrid();
}


// ==========================================
//        Three.js 3D世界再構築 (ボクセル)
// ==========================================
function rebuild3DWorld(mapData: CellType[][]) {
  // 1. 古いオブジェクトを削除
  const removeInstance = (mesh: THREE.InstancedMesh | null) => {
    if (mesh) {
      scene.remove(mesh);
      mesh.dispose();
    }
  };
  removeInstance(grassInstances);
  removeInstance(roadInstances);
  removeInstance(riverInstances);
  removeInstance(buildingInstances);
  grassInstances = null;
  roadInstances = null;
  riverInstances = null;
  buildingInstances = null;

  if (siteDBuildingMesh) {
    scene.remove(siteDBuildingMesh);
    siteDBuildingMesh.geometry.dispose();
    if (Array.isArray(siteDBuildingMesh.material)) {
      siteDBuildingMesh.material.forEach(m => m.dispose());
    } else {
      siteDBuildingMesh.material.dispose();
    }
    siteDBuildingMesh = null;
  }

  siteMeshes.forEach(mesh => scene.remove(mesh));
  siteMeshes = [];

  // 2. マップデータからボクセル個数を集計
  BUILDINGS = [];
  EVACUATION_SITES = [];

  let grassCount = 0;
  let roadCount = 0;
  let riverCount = 0;
  let buildingCount = 0;

  for (let r = 0; r < GRID_CELLS; r++) {
    for (let c = 0; c < GRID_CELLS; c++) {
      const type = mapData[r][c];
      if (type === 'river') {
        riverCount++;
      } else if (type === 'road') {
        roadCount++;
      } else if (type === 'building') {
        buildingCount++;
        grassCount++; // 建物の土台となる地面ブロックも作る
      } else {
        grassCount++; // grass, start, siteA〜D の土台はすべて草地地面
      }
    }
  }

  // 3. インスタンス化されたボクセルの作成
  // 基本ブロックサイズ (20m x 20m)
  const blockGeom = new THREE.BoxGeometry(CELL_SIZE, 1, CELL_SIZE);
  // ピボットを下面中央に変更
  blockGeom.translate(0, 0.5, 0);

  const grassMat = new THREE.MeshStandardMaterial({ color: 0x3b7a57, roughness: 0.95, flatShading: true }); // 深緑
  const roadMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.9, flatShading: true }); // アスファルト
  const riverMat = new THREE.MeshStandardMaterial({ color: 0x1e3a8a, roughness: 0.5, flatShading: true }); // 川底の濃い青

  if (grassCount > 0) grassInstances = new THREE.InstancedMesh(blockGeom, grassMat, grassCount);
  if (roadCount > 0) roadInstances = new THREE.InstancedMesh(blockGeom, roadMat, roadCount);
  if (riverCount > 0) riverInstances = new THREE.InstancedMesh(blockGeom, riverMat, riverCount);

  if (grassInstances) { grassInstances.receiveShadow = true; scene.add(grassInstances); }
  if (roadInstances) { roadInstances.receiveShadow = true; scene.add(roadInstances); }
  if (riverInstances) { riverInstances.receiveShadow = true; scene.add(riverInstances); }

  // 建物ブロックの作成
  const buildingGeom = new THREE.BoxGeometry(CELL_SIZE - 4, 1, CELL_SIZE - 4); // 道路とはみ出しを防ぐため周囲2m空ける
  buildingGeom.translate(0, 0.5, 0);
  const buildingMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.7, flatShading: true }); // 白いビル

  if (buildingCount > 0) {
    buildingInstances = new THREE.InstancedMesh(buildingGeom, buildingMat, buildingCount);
    buildingInstances.castShadow = true;
    buildingInstances.receiveShadow = true;
    scene.add(buildingInstances);
  }

  // 4. マップ解析と配置
  let grassIdx = 0;
  let roadIdx = 0;
  let riverIdx = 0;
  let buildingIdx = 0;

  const dummy = new THREE.Object3D();

  for (let r = 0; r < GRID_CELLS; r++) {
    for (let c = 0; c < GRID_CELLS; c++) {
      const type = mapData[r][c];
      const pos3D = gridTo3D(r, c);
      const height = getVoxelHeight(r, type);

      // 地面ブロックの配置
      dummy.position.set(pos3D.x, 0, pos3D.z);
      dummy.scale.set(1, height, 1); // 標高の高さまで伸びるブロック
      dummy.updateMatrix();

      if (type === 'river') {
        if (riverInstances) {
          riverInstances.setMatrixAt(riverIdx++, dummy.matrix);
        }
      } else if (type === 'road') {
        if (roadInstances) {
          roadInstances.setMatrixAt(roadIdx++, dummy.matrix);
        }
      } else {
        // 草地、または建物や避難所の土台としての草地
        if (grassInstances) {
          grassInstances.setMatrixAt(grassIdx++, dummy.matrix);
        }
      }

      // オブジェクト個別の配置
      if (type === 'start') {
        player.x = pos3D.x;
        player.z = pos3D.z;
      } else if (type === 'building') {
        // 地面ブロックの上にビルを配置
        const bh = 15 + Math.random() * 25; // 建物の高さ
        dummy.position.set(pos3D.x, height, pos3D.z);
        dummy.scale.set(1, bh, 1);
        dummy.updateMatrix();
        if (buildingInstances) {
          buildingInstances.setMatrixAt(buildingIdx++, dummy.matrix);
        }

        BUILDINGS.push({
          x: pos3D.x,
          z: pos3D.z,
          w: CELL_SIZE - 4,
          d: CELL_SIZE - 4,
          h: bh,
          groundY: height
        });
      } else if (type === 'siteA') {
        EVACUATION_SITES.push({
          id: 'A',
          name: '避難所A (低地・中央小学校体育館)',
          x: pos3D.x,
          z: pos3D.z,
          y: height,
          radius: 12,
          color: 0xef4444,
          safetyType: 'danger',
          description: '川に近く標高が低いため、氾濫発生からまもなく水没します。'
        });
      } else if (type === 'siteB') {
        EVACUATION_SITES.push({
          id: 'B',
          name: '避難所B (中台・市民公民館)',
          x: pos3D.x,
          z: pos3D.z,
          y: height,
          radius: 12,
          color: 0xeab308,
          safetyType: 'marginal',
          description: '標高が中程度。床上浸水に達しますが、建物の2階以上に逃げることで生存可能です。'
        });
      } else if (type === 'siteC') {
        EVACUATION_SITES.push({
          id: 'C',
          name: '避難所C (高台・北山開拓公園)',
          x: pos3D.x,
          z: pos3D.z,
          y: height,
          radius: 15,
          color: 0x10b981,
          safetyType: 'safe',
          description: '北部高台。水害の影響を全く受けない最も安全な避難所です。'
        });
      } else if (type === 'siteD') {
        EVACUATION_SITES.push({
          id: 'D',
          name: '避難所D (堅牢ビル・緊急垂直避難先)',
          x: pos3D.x,
          z: pos3D.z,
          y: height,
          radius: 10,
          color: 0x3b82f6,
          safetyType: 'vertical',
          description: '低地ですが、ビルの4階以上の屋上に登ることで水害から生存できます。',
          heightOffset: 15.0
        });

        // 垂直避難用ビルメッシュ
        siteDBuildingMesh = new THREE.Mesh(
          new THREE.BoxGeometry(CELL_SIZE - 2, 15, CELL_SIZE - 2),
          new THREE.MeshStandardMaterial({ color: 0x829ab1, roughness: 0.5 })
        );
        siteDBuildingMesh.position.set(pos3D.x, height + 7.5, pos3D.z);
        siteDBuildingMesh.castShadow = true;
        siteDBuildingMesh.receiveShadow = true;
        scene.add(siteDBuildingMesh);
      }
    }
  }

  // プレイヤー初期位置
  player.y = getTerrainHeight(player.x, player.z);
  playerMesh.position.set(player.x, player.y + 1.3, player.z);

  // 避難所ポールの作成
  EVACUATION_SITES.forEach(site => {
    const group = new THREE.Group();
    group.position.set(site.x, site.y, site.z);

    const cylGeom = new THREE.CylinderGeometry(site.radius, site.radius, 10, 24, 1, true);
    const cylMat = new THREE.MeshBasicMaterial({
      color: site.color,
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide
    });
    const cylinder = new THREE.Mesh(cylGeom, cylMat);
    cylinder.position.y = 5;
    group.add(cylinder);

    const poleGeom = new THREE.CylinderGeometry(0.2, 0.2, 8);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0 });
    const pole = new THREE.Mesh(poleGeom, poleMat);
    pole.position.y = 4;
    group.add(pole);

    const flagGeom = new THREE.BoxGeometry(3.5, 1.8, 0.15);
    const flagMat = new THREE.MeshStandardMaterial({ color: site.color });
    const flag = new THREE.Mesh(flagGeom, flagMat);
    flag.position.y = 7.1;
    group.add(flag);

    scene.add(group);
    siteMeshes.push(group);
  });
}

// --- Three.js 初期化 ---
function initThree() {
  const container = document.getElementById('canvas-container')!;
  
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f172a);
  scene.fog = new THREE.FogExp2(0x0f172a, 0.005);

  const width = container.clientWidth || window.innerWidth;
  const height = container.clientHeight || window.innerHeight;
  camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 1000);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.75);
  dirLight.position.set(100, 250, 100);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  const d = 250;
  dirLight.shadow.camera.left = -d;
  dirLight.shadow.camera.right = d;
  dirLight.shadow.camera.top = d;
  dirLight.shadow.camera.bottom = -d;
  scene.add(dirLight);

  // プレイヤーキャラクター (ボクセル風カプセル)
  const playerGeom = new THREE.CapsuleGeometry(1.0, 1.8, 4, 8);
  const playerMat = new THREE.MeshStandardMaterial({ color: 0x06b6d4, roughness: 0.4 });
  playerMesh = new THREE.Mesh(playerGeom, playerMat);
  playerMesh.position.set(player.x, player.y + 1.3, player.z);
  playerMesh.castShadow = true;
  scene.add(playerMesh);

  // 川の氾濫用の水面 (半透明青)
  const waterGeom = new THREE.PlaneGeometry(MAP_SIZE * 1.5, MAP_SIZE * 1.5);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x2563eb,
    transparent: true,
    opacity: 0.65,
    roughness: 0.1,
    metalness: 0.7,
    side: THREE.DoubleSide
  });
  waterMesh = new THREE.Mesh(waterGeom, waterMat);
  waterMesh.rotateX(-Math.PI / 2);
  waterMesh.position.set(0, waterLevel, 0);
  scene.add(waterMesh);

  // 最初のロード時にデフォルトマップで初期化
  rebuild3DWorld(customMap);

  window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });
}

// --- 描画ループ ---
function animate() {
  requestAnimationFrame(animate);

  // deltaTimeの取得
  const deltaTime = clock.getDelta();

  if (isPlaying) {
    updatePlayerMovement(deltaTime);
    updateWater(deltaTime);
    updateUI();
  }

  if (playerMesh) {
    camera.position.x = playerMesh.position.x;
    camera.position.y = playerMesh.position.y + 24;
    camera.position.z = playerMesh.position.z + 32;
    camera.lookAt(new THREE.Vector3(playerMesh.position.x, playerMesh.position.y + 1, playerMesh.position.z - 4));
  }

  renderer.render(scene, camera);
}

// --- プレイヤー移動と衝突判定 (deltaTime準拠) ---
function updatePlayerMovement(deltaTime: number) {
  let dx = 0;
  let dz = 0;

  if (keys.w) dz -= 1;
  if (keys.s) dz += 1;
  if (keys.a) dx -= 1;
  if (keys.d) dx += 1;

  if (dx !== 0 || dz !== 0) {
    const len = Math.sqrt(dx * dx + dz * dz);
    let speed = player.speed;

    // 水深による移動速度減衰
    const depth = waterLevel - player.y;
    if (depth > 0) {
      if (depth > 1.2) {
        speed *= 0.15;
      } else if (depth > 0.5) {
        speed *= 0.4;
      } else {
        speed *= 0.7;
      }
    }

    // deltaTime を乗算して秒単位で正確な速度に標準化 (バケモンスピード防止)
    const moveX = (dx / len) * speed * deltaTime;
    const moveZ = (dz / len) * speed * deltaTime;

    const nextX = player.x + moveX;
    const nextZ = player.z + moveZ;

    const limit = HALF_MAP - 5;
    if (nextX > -limit && nextX < limit && nextZ > -limit && nextZ < limit) {
      
      let collision = false;
      const checkRadius = 25;
      
      for (const b of BUILDINGS) {
        if (Math.abs(nextX - b.x) > checkRadius || Math.abs(nextZ - b.z) > checkRadius) {
          continue;
        }

        const halfW = b.w / 2 + player.radius;
        const halfD = b.d / 2 + player.radius;
        if (Math.abs(nextX - b.x) < halfW && Math.abs(nextZ - b.z) < halfD) {
          collision = true;
          break;
        }
      }

      // siteD ビルとの衝突は避ける (垂直避難)
      const siteD = EVACUATION_SITES.find(s => s.id === 'D');
      if (siteD) {
        const halfWD = (CELL_SIZE - 2) / 2 + player.radius;
        if (Math.abs(nextX - siteD.x) < halfWD && Math.abs(nextZ - siteD.z) < halfWD) {
          collision = false;
        }
      }

      if (!collision) {
        player.x = nextX;
        player.z = nextZ;
      }
    }
  }

  // 標高Yの更新
  let targetY = getTerrainHeight(player.x, player.z);

  // siteD ビルでの垂直避難処理
  const siteD = EVACUATION_SITES.find(s => s.id === 'D');
  if (siteD) {
    const distToD = Math.sqrt((player.x - siteD.x) * (player.x - siteD.x) + (player.z - siteD.z) * (player.z - siteD.z));
    if (distToD < siteD.radius) {
      targetY = getTerrainHeight(siteD.x, siteD.z) + siteD.heightOffset!; 
    }
  }

  // 段差（マイクラ風）を登れるように接地処理
  player.y += (targetY - player.y) * 0.2;
  playerMesh.position.set(player.x, player.y + 0.9, player.z);
}

// --- 水位上昇システム (deltaTime準拠) ---
function updateWater(deltaTime: number) {
  if (gameTime >= waterStartSecond) {
    // 30秒後から徐々に上昇
    // 1秒間に約0.035m上昇 (5分間で約9.5m上昇)
    waterLevel += 0.035 * deltaTime;
  } else {
    waterLevel = 0.2;
  }

  waterMesh.position.y = waterLevel;

  // 溺死判定
  if (waterLevel > player.y + 1.8) {
    endSimulation('drowned');
  }
}

// --- UI更新 ---
function updateUI() {
  const heightDisp = document.getElementById('height-display')!;
  const locDisp = document.getElementById('location-display')!;
  
  heightDisp.innerText = `標高: ${player.y.toFixed(1)}m`;
  
  const activeSite = getActiveEvacuationSite();
  const btnEvacuate = document.getElementById('btn-evacuate') as HTMLButtonElement;

  if (activeSite) {
    locDisp.innerText = activeSite.name;
    locDisp.className = "text-sm font-bold text-cyan-400 animate-pulse";
    btnEvacuate.disabled = false;
    btnEvacuate.className = "bg-cyan-600 hover:bg-cyan-500 text-white font-black px-6 py-4 rounded-xl text-lg shadow-xl transition duration-200 select-none cursor-pointer";
  } else {
    locDisp.innerText = "市街地";
    locDisp.className = "text-sm font-bold text-slate-200";
    btnEvacuate.disabled = true;
    btnEvacuate.className = "bg-slate-700 text-slate-400 font-black px-6 py-4 rounded-xl text-lg shadow-xl cursor-not-allowed transition duration-200 select-none";
  }

  const warningTicker = document.getElementById('warning-ticker')!;
  if (gameTime >= waterStartSecond && gameTime < waterStartSecond + 15) {
    warningTicker.classList.remove('hidden');
  } else {
    warningTicker.classList.add('hidden');
  }
}

function getActiveEvacuationSite(): EvacuationSite | null {
  for (const site of EVACUATION_SITES) {
    const dx = player.x - site.x;
    const dz = player.z - site.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < site.radius) {
      return site;
    }
  }
  return null;
}

// --- シミュレーション開始 ---
function startSimulation() {
  isPlaying = true;
  
  checkTimerInterval = setInterval(() => {
    gameTime++;
    
    const remaining = Math.max(0, maxGameTime - gameTime);
    const m = Math.floor(remaining / 60).toString().padStart(2, '0');
    const s = (remaining % 60).toString().padStart(2, '0');
    document.getElementById('timer-display')!.innerText = `${m}:${s}`;

    const waterInfo = document.getElementById('water-info')!;
    if (gameTime < waterStartSecond) {
      waterInfo.innerText = `浸水開始まで ${waterStartSecond - gameTime} 秒`;
      waterInfo.className = "text-[10px] text-yellow-400 font-bold mt-1";
    } else {
      waterInfo.innerText = `予測水位: ${Math.max(0, waterLevel).toFixed(2)}m (津波氾濫中)`;
      waterInfo.className = "text-[10px] text-red-500 font-bold mt-1 animate-pulse";
    }

    if (gameTime >= maxGameTime) {
      endSimulation('timeout');
    }
  }, 1000);

  logInterval = setInterval(() => {
    trajectoryData.push({
      step_second: gameTime,
      pos_x: Number(player.x.toFixed(2)),
      pos_z: Number(player.z.toFixed(2)),
      pos_y: Number(player.y.toFixed(2)),
      water_level: Number(waterLevel.toFixed(2))
    });
  }, 1000);
}

// --- シミュレーション終了 ---
async function endSimulation(reason: 'evacuated' | 'drowned' | 'timeout', site: EvacuationSite | null = null) {
  isPlaying = false;
  clearInterval(checkTimerInterval);
  clearInterval(logInterval);

  let status: 'survived' | 'drowned' | 'timeout' = 'survived';
  let isSafe = false;
  let reasonText = '';

  if (reason === 'evacuated' && site) {
    currentSession.selected_destination = site.name;
    
    if (site.safetyType === 'danger') {
      status = 'drowned';
      isSafe = false;
      reasonText = `【避難失敗】${site.name}に避難しましたが、この場所は浸水深が深く、建物ごと水没してしまいました。ハザードマップで事前に浸水危険地域であることを確認しておく必要がありました。`;
    } else if (site.safetyType === 'marginal') {
      status = 'survived';
      isSafe = true;
      reasonText = `【避難完了 (軽微な浸水)】${site.name}に避難しました。床下から床上付近まで浸水しましたが、建物の2階以上に留まり生存できました。より安全な高台への避難も検討できたかもしれません。`;
    } else if (site.safetyType === 'safe') {
      status = 'survived';
      isSafe = true;
      reasonText = `【避難成功】安全な高台の${site.name}に避難完了しました！標高が十分に高いため、水害の影響を一切受けることなく生存できました。もっとも確実な行動です。`;
    } else if (site.safetyType === 'vertical') {
      status = 'survived';
      isSafe = true;
      reasonText = `【避難成功 (垂直避難)】近くの頑丈な${site.name}に避難しました。地上の標高は低いですが、4階以上の屋上に登ったことで、浸水から逃れることができました。避難所が遠い場合に非常に有効な行動です。`;
    }
  } else if (reason === 'drowned') {
    status = 'drowned';
    reasonText = '【避難失敗】水位の上昇に巻き込まれ、溺れてしまいました。水害が発生したら、できるだけ早く高台や安全な建物へ移動を開始しなければなりません。';
  } else if (reason === 'timeout') {
    status = 'timeout';
    reasonText = '【タイムアップ】避難を確定できないまま、タイムリミットの5分が経過してしまいました。早急に避難先を決めて行動する必要があります。';
  }

  currentSession.status = status;
  currentSession.duration = gameTime;

  document.getElementById('screen-game')!.classList.add('hidden');
  document.getElementById('screen-result')!.classList.remove('hidden');

  const iconContainer = document.getElementById('result-icon-container')!;
  const title = document.getElementById('result-title')!;
  const desc = document.getElementById('result-desc')!;

  if (isSafe && status === 'survived') {
    iconContainer.innerHTML = `<span class="inline-block p-4 bg-emerald-900/50 rounded-full text-emerald-400 text-5xl">🏆</span>`;
    title.innerText = '避難成功';
    title.className = 'text-3xl font-extrabold mb-2 text-emerald-400';
  } else {
    iconContainer.innerHTML = `<span class="inline-block p-4 bg-red-900/50 rounded-full text-red-400 text-5xl">💀</span>`;
    title.innerText = '避難失敗';
    title.className = 'text-3xl font-extrabold mb-2 text-red-400';
  }
  desc.innerText = reasonText;

  document.getElementById('res-name')!.innerText = currentSession.name;
  document.getElementById('res-dest')!.innerText = currentSession.selected_destination || '未避難';
  document.getElementById('res-time')!.innerText = `${Math.floor(gameTime / 60)}分 ${gameTime % 60}秒`;
  document.getElementById('res-status')!.innerText = status === 'survived' ? '生存' : (status === 'drowned' ? '死亡' : '時間切れ');

  await saveSessionData(currentSession, trajectoryData);
}

// データベース保存
async function saveSessionData(session: any, trajectories: any[]) {
  saveSessionLocally(session, trajectories);

  if (supabase) {
    try {
      const { error: sessionError } = await supabase
        .from('sessions')
        .insert({
          id: session.id,
          created_at: session.created_at,
          name: session.name,
          age_group: session.age_group,
          has_hazard_map: session.has_hazard_map,
          selected_destination: session.selected_destination,
          status: session.status,
          duration: session.duration
        });

      if (sessionError) throw sessionError;

      const formattedTrajectories = trajectories.map(t => ({
        session_id: session.id,
        step_second: t.step_second,
        pos_x: t.pos_x,
        pos_z: t.pos_z,
        pos_y: t.pos_y,
        water_level: t.water_level
      }));

      const chunkSize = 100;
      for (let i = 0; i < formattedTrajectories.length; i += chunkSize) {
        const chunk = formattedTrajectories.slice(i, i + chunkSize);
        const { error: trajError } = await supabase
          .from('trajectories')
          .insert(chunk);
        if (trajError) throw trajError;
      }
      console.log('Saved to Supabase');
    } catch (err) {
      console.error('Failed to save to Supabase:', err);
    }
  }
}

// --- 管理者ダッシュボード ---
let allSessions: any[] = [];
let selectedSessionIds = new Set<string>();

async function loadAdminSessions() {
  const filterVal = (document.getElementById('filter-hazard') as HTMLSelectElement).value;
  
  if (supabase) {
    try {
      let query = supabase.from('sessions').select('*').order('created_at', { ascending: false });
      const { data, error } = await query;
      if (error) throw error;
      allSessions = data || [];
    } catch (e) {
      allSessions = getLocalSessions();
    }
  } else {
    allSessions = getLocalSessions();
  }

  let filtered = allSessions;
  if (filterVal === 'map-yes') {
    filtered = allSessions.filter(s => s.has_hazard_map === true);
  } else if (filterVal === 'map-no') {
    filtered = allSessions.filter(s => s.has_hazard_map === false);
  }

  renderSessionList(filtered);
  drawTrajectoriesOnMap();
}

function renderSessionList(sessions: any[] = allSessions) {
  const container = document.getElementById('session-list')!;
  container.innerHTML = '';

  if (sessions.length === 0) {
    container.innerHTML = '<p class="text-xs text-slate-500 text-center p-4">データが存在しません。</p>';
    return;
  }

  sessions.forEach(s => {
    const isSelected = selectedSessionIds.has(s.id);
    const date = new Date(s.created_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    
    const card = document.createElement('div');
    card.className = `p-3 rounded-lg border text-xs cursor-pointer transition ${
      isSelected 
        ? 'bg-cyan-950/80 border-cyan-500 text-white' 
        : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700'
    }`;
    
    const mapBadge = s.has_hazard_map 
      ? '<span class="px-1.5 py-0.5 bg-emerald-900/60 text-emerald-400 rounded text-[9px] font-bold">マップ確認済</span>'
      : '<span class="px-1.5 py-0.5 bg-rose-900/60 text-rose-400 rounded text-[9px] font-bold">未確認</span>';
      
    const statusText = s.status === 'survived' 
      ? '<span class="text-emerald-400 font-bold">生存</span>' 
      : '<span class="text-red-400 font-bold">失敗</span>';

    card.innerHTML = `
      <div class="flex justify-between items-center mb-1">
        <span class="font-bold text-slate-200 text-sm">${s.name || '被験者'}</span>
        <span class="text-slate-500 text-[10px]">${date}</span>
      </div>
      <div class="flex flex-wrap gap-1.5 mb-2 mt-1">
        ${mapBadge}
        <span class="px-1.5 py-0.5 bg-slate-800 rounded text-[9px]">${s.age_group}</span>
        <span class="px-1.5 py-0.5 bg-slate-800 rounded text-[9px]">${s.selected_destination || '未避難'}</span>
      </div>
      <div class="flex justify-between items-center text-slate-400 text-[10px]">
        <span>時間: ${Math.floor(s.duration / 60)}分${s.duration % 60}秒</span>
        <span>ステータス: ${statusText}</span>
      </div>
    `;

    card.addEventListener('click', () => {
      if (selectedSessionIds.has(s.id)) {
        selectedSessionIds.delete(s.id);
      } else {
        selectedSessionIds.add(s.id);
      }
      renderSessionList(sessions);
      drawTrajectoriesOnMap();
    });

    container.appendChild(card);
  });
}

async function drawTrajectoriesOnMap() {
  const canvas = document.getElementById('map-canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;

  ctx.fillStyle = '#090d16';
  ctx.fillRect(0, 0, w, h);

  const cellW = w / GRID_CELLS;
  const cellH = h / GRID_CELLS;

  // 2D 解析ダッシュボードもボクセルグリッドに対応させて正確に描画
  for (let r = 0; r < GRID_CELLS; r++) {
    for (let c = 0; c < GRID_CELLS; c++) {
      const type = customMap[r][c];
      const height = getVoxelHeight(r, type);

      if (type === 'river') {
        ctx.fillStyle = '#1e3a8a'; // 川の色
      } else if (height < 2.0) {
        ctx.fillStyle = 'rgba(239, 68, 68, 0.15)'; // 低地 (浸水域赤)
      } else if (height < 5.0) {
        ctx.fillStyle = 'rgba(234, 179, 8, 0.12)'; // 中低地
      } else if (height < 9.0) {
        ctx.fillStyle = 'rgba(16, 185, 129, 0.08)'; // 中高台
      } else {
        ctx.fillStyle = 'rgba(16, 185, 129, 0.18)'; // 高台安全
      }
      ctx.fillRect(c * cellW, r * cellH, cellW, cellH);

      // グリッド線
      ctx.strokeStyle = 'rgba(255,255,255,0.015)';
      ctx.strokeRect(c * cellW, r * cellH, cellW, cellH);

      // 建物
      if (type === 'building') {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
        ctx.fillRect(c * cellW + 2, r * cellH + 2, cellW - 4, cellH - 4);
      }
    }
  }

  function toCanvasCoords(x: number, z: number) {
    const cx = ((x + HALF_MAP) / MAP_SIZE) * w;
    const cy = ((z + HALF_MAP) / MAP_SIZE) * h;
    return { x: cx, y: cy };
  }

  // 避難所の描画
  EVACUATION_SITES.forEach(site => {
    const p = toCanvasCoords(site.x, site.z);
    const radiusPx = (site.radius / MAP_SIZE) * w;
    
    ctx.beginPath();
    ctx.arc(p.x, p.y, radiusPx, 0, 2 * Math.PI);
    ctx.fillStyle = `rgba(${site.color === 0xef4444 ? '239,68,68' : site.color === 0xeab308 ? '234,179,8' : site.color === 0x10b981 ? '16,185,129' : '59,130,246'}, 0.3)`;
    ctx.fill();
    
    ctx.beginPath();
    ctx.arc(p.x, p.y, radiusPx, 0, 2 * Math.PI);
    ctx.strokeStyle = `#${site.color.toString(16).padStart(6, '0')}`;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(site.id, p.x, p.y + 3);
  });

  // スタート位置
  const startP = toCanvasCoords(player.x, player.z);
  ctx.beginPath();
  ctx.arc(startP.x, startP.y, 6, 0, 2 * Math.PI);
  ctx.fillStyle = '#06b6d4';
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '8px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('始', startP.x, startP.y + 3);

  // 軌跡描画
  const ids = Array.from(selectedSessionIds);
  for (const sessionId of ids) {
    let traj: any[] = [];
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('trajectories')
          .select('*')
          .eq('session_id', sessionId)
          .order('step_second', { ascending: true });
        if (error) throw error;
        traj = data || [];
      } catch (e) {
        traj = getLocalTrajectories(sessionId);
      }
    } else {
      traj = getLocalTrajectories(sessionId);
    }

    if (traj.length === 0) continue;

    ctx.beginPath();
    const startPt = toCanvasCoords(traj[0].pos_x, traj[0].pos_z);
    ctx.moveTo(startPt.x, startPt.y);

    for (let i = 1; i < traj.length; i++) {
      const pt = toCanvasCoords(traj[i].pos_x, traj[i].pos_z);
      ctx.lineTo(pt.x, pt.y);
    }

    const sessionMeta = allSessions.find(s => s.id === sessionId);
    const hasMap = sessionMeta ? sessionMeta.has_hazard_map : false;
    
    ctx.strokeStyle = hasMap ? '#22d3ee' : '#f97316'; 
    ctx.lineWidth = 3;
    ctx.stroke();

    const last = traj[traj.length - 1];
    const endPt = toCanvasCoords(last.pos_x, last.pos_z);
    ctx.beginPath();
    ctx.arc(endPt.x, endPt.y, 4, 0, 2 * Math.PI);
    ctx.fillStyle = hasMap ? '#22d3ee' : '#f97316';
    ctx.fill();
  }
}
