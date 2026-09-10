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

// ローカルストレージキー
const LOCAL_STORAGE_KEY = 'flood_sim_sessions_v8';
const LOCAL_TRAJECTORY_KEY = 'flood_sim_trajectories_v8';
const CUSTOM_MAP_KEY = 'flood_sim_voxel_map_v8';
const SHELTER_LIST_KEY = 'flood_sim_shelters_v8';
const WATER_LEVEL_KEY = 'flood_sim_max_water_level_v1';

// ==========================================
//           ボクセル定数 & 定義
// ==========================================
export const VOXEL_SIZE = 0.5; // 1ブロック = 0.5m
export const MAP_GRID_X = 600; // 300m (広島・深川エリア実寸大モデル)
export const MAP_GRID_Z = 600; // 300m
export const MAP_GRID_Y = 50;  // 25m高

export const MAX_REACH_DISTANCE = 16.0; // ブロック操作限界距離 (16m)

export const BLOCK = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  ASPHALT: 4,
  WOOD: 5,
  CONCRETE: 6,
  BRICK: 7,
  GLASS: 8,
  WATER: 9,
  SHELTER: 10,
  SPAWN: 11,
  BARRIER: 12
} as const;

export type BlockType = typeof BLOCK[keyof typeof BLOCK];

const BLOCK_CONFIGS: Record<number, { name: string; color: number; transparent?: boolean; opacity?: number; roughness?: number; invisibleInGame?: boolean }> = {
  [BLOCK.GRASS]: { name: '草地 (Grass)', color: 0x4d8a39, roughness: 0.9 },
  [BLOCK.DIRT]: { name: '土 (Dirt)', color: 0x865935, roughness: 0.95 },
  [BLOCK.STONE]: { name: '石 (Stone)', color: 0x7b8288, roughness: 0.8 },
  [BLOCK.ASPHALT]: { name: '道路 (Asphalt)', color: 0x2d3748, roughness: 0.9 },
  [BLOCK.WOOD]: { name: '木材 (Wood)', color: 0x9c6b3e, roughness: 0.8 },
  [BLOCK.CONCRETE]: { name: 'ビル壁 (Concrete)', color: 0xe2e8f0, roughness: 0.6 },
  [BLOCK.BRICK]: { name: 'レンガ (Brick)', color: 0xa84232, roughness: 0.85 },
  [BLOCK.GLASS]: { name: 'ガラス (Glass)', color: 0xbae6fd, transparent: true, opacity: 0.45, roughness: 0.2 },
  [BLOCK.WATER]: { name: '水路 (Water)', color: 0x2563eb, transparent: true, opacity: 0.65, roughness: 0.1 },
  [BLOCK.SHELTER]: { name: '避難所 (Shelter)', color: 0xf43f5e, roughness: 0.4 },
  [BLOCK.SPAWN]: { name: '開始地点 (Spawn)', color: 0x06b6d4, roughness: 0.4 },
  [BLOCK.BARRIER]: { name: 'バリア (見えない壁)', color: 0xf43f5e, transparent: true, opacity: 0.35, roughness: 0.1, invisibleInGame: true }
};

export interface ShelterInfo {
  id: string;
  name: string;
  gridX: number;
  gridY: number;
  gridZ: number;
  notes?: string;
}

let voxelMap = new Uint8Array(MAP_GRID_X * MAP_GRID_Y * MAP_GRID_Z);
let shelters: ShelterInfo[] = [];
let spawnPoint = { gridX: 300, gridY: 6, gridZ: 370 };

function getVoxelIndex(x: number, y: number, z: number): number {
  if (x < 0 || x >= MAP_GRID_X || y < 0 || y >= MAP_GRID_Y || z < 0 || z >= MAP_GRID_Z) return -1;
  return y * (MAP_GRID_X * MAP_GRID_Z) + z * MAP_GRID_X + x;
}

export function getVoxel(x: number, y: number, z: number): BlockType {
  const idx = getVoxelIndex(x, y, z);
  if (idx === -1) return BLOCK.AIR;
  return voxelMap[idx] as BlockType;
}

export function setVoxel(x: number, y: number, z: number, type: BlockType): void {
  const idx = getVoxelIndex(x, y, z);
  if (idx !== -1) {
    voxelMap[idx] = type;
  }
}

// ==========================================
//  広島・深川エリア (300m×300m) 精密モデル生成
// ==========================================
function buildDefaultMap() {
  voxelMap.fill(BLOCK.AIR);
  shelters = [];

  // 道路・河川マスク (建築物が道路や川にはみ出さないよう追跡)
  const isRoadOrRiver = new Uint8Array(MAP_GRID_X * MAP_GRID_Z);

  // 1. 地形・高低差・河川・堤防の生成
  for (let x = 0; x < MAP_GRID_X; x++) {
    // 三篠川の中央流路カーブ (緩やかなS字カーブ)
    const riverCenterZ = 240 + Math.sin(x * 0.009) * 28 + (x / 600) * 15;

    for (let z = 0; z < MAP_GRID_Z; z++) {
      let groundHeight = 5; // 低地ベース標高 2.5m

      // 北側丘陵 (藤和ハイタウン・パインビレッジ高台)
      if (z < 180) {
        const northProgress = Math.max(0, (180 - z) / 180);
        groundHeight = Math.floor(6 + northProgress * 30 + Math.sin(x * 0.04) * 2);
      }
      // 南側高台 (下深川南部の丘陵住宅地)
      else if (z > 430) {
        const southProgress = Math.max(0, (z - 430) / 170);
        groundHeight = Math.floor(6 + southProgress * 34 + Math.cos(x * 0.035) * 3);
      } else {
        // 中央低地氾濫平野 (Z: 180 ~ 430)
        groundHeight = 5 + Math.floor(Math.sin(x * 0.03 + z * 0.02) * 1);
      }

      // 三篠川 流路の掘り込み (水面 Y=2: 標高1.0m)
      const riverHalfWidth = 22;
      const dz = z - riverCenterZ;
      if (Math.abs(dz) <= riverHalfWidth) {
        groundHeight = 2; // 水面
        isRoadOrRiver[z * MAP_GRID_X + x] = 2; // 川
      } else if (Math.abs(dz) <= riverHalfWidth + 6) {
        // 堤防法面 & 堤防天端 (標高4.0m = Y:8)
        groundHeight = 8;
        isRoadOrRiver[z * MAP_GRID_X + x] = 2; // 堤防法面・川沿い
      }

      // ボクセル充填
      for (let y = 0; y <= groundHeight; y++) {
        if (Math.abs(dz) <= riverHalfWidth && y >= 2) {
          setVoxel(x, y, z, BLOCK.WATER);
        } else if (y === groundHeight) {
          setVoxel(x, y, z, BLOCK.GRASS);
        } else if (y >= groundHeight - 2) {
          setVoxel(x, y, z, BLOCK.DIRT);
        } else {
          setVoxel(x, y, z, BLOCK.STONE);
        }
      }

      // 川の転落防止用バリア
      if (Math.abs(dz) === riverHalfWidth + 1) {
        setVoxel(x, groundHeight + 1, z, BLOCK.BARRIER);
        setVoxel(x, groundHeight + 2, z, BLOCK.BARRIER);
      }
    }
  }

  // 2. 道路網の整備 (地表にアスファルトを敷設し、建築禁止マスクを記録)
  const layRoadSegment = (x1: number, z1: number, x2: number, z2: number, width: number) => {
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(z2 - z1)) * 2;
    for (let i = 0; i <= steps; i++) {
      const t = steps > 0 ? i / steps : 0;
      const cx = Math.round(x1 + (x2 - x1) * t);
      const cz = Math.round(z1 + (z2 - z1) * t);

      for (let dx = -Math.floor(width / 2); dx <= Math.floor(width / 2); dx++) {
        for (let dz = -Math.floor(width / 2); dz <= Math.floor(width / 2); dz++) {
          const rx = cx + dx;
          const rz = cz + dz;
          if (rx < 0 || rx >= MAP_GRID_X || rz < 0 || rz >= MAP_GRID_Z) continue;

          // 川の水域には直接道路を置かない（橋部分以外）
          if (isRoadOrRiver[rz * MAP_GRID_X + rx] === 2 && (rx < 318 || rx > 332)) {
            continue;
          }

          isRoadOrRiver[rz * MAP_GRID_X + rx] = 1; // 道路

          for (let y = MAP_GRID_Y - 1; y >= 0; y--) {
            const b = getVoxel(rx, y, rz);
            if (b === BLOCK.GRASS || b === BLOCK.DIRT || b === BLOCK.STONE) {
              setVoxel(rx, y, rz, BLOCK.ASPHALT);
              break;
            }
          }
        }
      }
    }
  };

  // 曲線道路描画ヘルパー (ベジェ風またはウェイポイント列)
  const layCurvedRoad = (points: [number, number][], width: number) => {
    for (let i = 0; i < points.length - 1; i++) {
      layRoadSegment(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], width);
    }
  };

  // ① 堤防沿い幹線道路 (北岸 & 南岸: 川のカーブに自然に沿って走る)
  for (let x = 0; x < MAP_GRID_X; x++) {
    const riverCenterZ = 240 + Math.sin(x * 0.009) * 28 + (x / 600) * 15;
    // 北岸堤防上道路
    const northBankZ = Math.round(riverCenterZ - 28);
    for (let w = -2; w <= 2; w++) {
      const rz = northBankZ + w;
      if (rz >= 0 && rz < MAP_GRID_Z) {
        isRoadOrRiver[rz * MAP_GRID_X + x] = 1;
        for (let y = MAP_GRID_Y - 1; y >= 0; y--) {
          const b = getVoxel(x, y, rz);
          if (b === BLOCK.GRASS || b === BLOCK.DIRT || b === BLOCK.STONE) {
            setVoxel(x, y, rz, BLOCK.ASPHALT);
            break;
          }
        }
      }
    }
    // 南岸堤防上道路
    const southBankZ = Math.round(riverCenterZ + 28);
    for (let w = -2; w <= 2; w++) {
      const rz = southBankZ + w;
      if (rz >= 0 && rz < MAP_GRID_Z) {
        isRoadOrRiver[rz * MAP_GRID_X + x] = 1;
        for (let y = MAP_GRID_Y - 1; y >= 0; y--) {
          const b = getVoxel(x, y, rz);
          if (b === BLOCK.GRASS || b === BLOCK.DIRT || b === BLOCK.STONE) {
            setVoxel(x, y, rz, BLOCK.ASPHALT);
            break;
          }
        }
      }
    }
  }

  // ② 主要幹線道路網 (広島・深川の実際の湾曲・傾斜道路を再現)
  // 西側県道ルート (山裾を縫う幹線)
  layCurvedRoad([[70, 20], [80, 100], [90, 200], [105, 300], [115, 450], [120, 580]], 6);

  // 中央大橋ルート (国道・主要連絡橋へのアプローチ)
  layCurvedRoad([[330, 20], [328, 120], [325, 200], [325, 280], [320, 380], [310, 480], [305, 580]], 7);

  // 東側駅前連絡ルート
  layCurvedRoad([[500, 20], [495, 140], [485, 260], [470, 340], [460, 460], [450, 580]], 5);

  // 北部高台アクセス道 (藤和ハイタウン・パインビレッジ前)
  layCurvedRoad([[20, 80], [120, 85], [240, 95], [360, 90], [480, 100], [580, 105]], 5);
  layCurvedRoad([[30, 140], [150, 145], [280, 150], [420, 145], [570, 150]], 4);

  // 南部市街地メイン通り
  layCurvedRoad([[20, 310], [140, 315], [270, 320], [400, 315], [580, 325]], 6);
  layCurvedRoad([[20, 365], [160, 360], [300, 365], [440, 360], [580, 365]], 5);
  layCurvedRoad([[20, 420], [180, 425], [320, 415], [460, 425], [580, 420]], 5);

  // 南部高台住宅地連絡道 & 山手道
  layCurvedRoad([[20, 480], [150, 475], [300, 485], [450, 475], [580, 485]], 5);
  layCurvedRoad([[20, 545], [160, 540], [310, 550], [460, 540], [580, 545]], 4);

  // 生活道路・路地 (格子を崩した自然な住宅街の小道)
  layCurvedRoad([[180, 20], [185, 180]], 3);
  layCurvedRoad([[250, 20], [245, 180]], 3);
  layCurvedRoad([[410, 20], [415, 180]], 3);

  layCurvedRoad([[60, 270], [65, 430]], 3);
  layCurvedRoad([[190, 270], [185, 430]], 4);
  layCurvedRoad([[250, 270], [255, 430]], 3);
  layCurvedRoad([[380, 270], [375, 430]], 4);
  layCurvedRoad([[520, 270], [525, 430]], 3);

  layCurvedRoad([[80, 430], [85, 570]], 3);
  layCurvedRoad([[220, 430], [215, 570]], 3);
  layCurvedRoad([[390, 430], [395, 570]], 3);
  layCurvedRoad([[510, 430], [505, 570]], 3);

  // 3. 深川大橋 (中央南北大橋 X:322~328, Z:200~285)
  for (let x = 322; x <= 328; x++) {
    for (let z = 205; z <= 275; z++) {
      isRoadOrRiver[z * MAP_GRID_X + x] = 1;
      setVoxel(x, 9, z, BLOCK.CONCRETE);
      setVoxel(x, 10, z, BLOCK.ASPHALT);
      if (x === 322 || x === 328) {
        setVoxel(x, 11, z, BLOCK.WOOD); // 欄干
      }
    }
  }

  // 4. JR芸備線 線路・盛土 (南側を東西に斜めに走る X:0,Z:375 -> X:599,Z:310)
  for (let x = 0; x < MAP_GRID_X; x++) {
    const trackZ = Math.round(375 - (x / 600) * 70);
    for (let w = -2; w <= 2; w++) {
      const tz = trackZ + w;
      if (tz >= 0 && tz < MAP_GRID_Z) {
        isRoadOrRiver[tz * MAP_GRID_X + x] = 1; // 鉄道敷地マスク
        for (let y = MAP_GRID_Y - 1; y >= 0; y--) {
          const b = getVoxel(x, y, tz);
          if (b !== BLOCK.AIR) {
            setVoxel(x, y + 1, tz, BLOCK.STONE);   // バラスト軌道盛土
            if (w === 0) setVoxel(x, y + 2, tz, BLOCK.WOOD); // 枕木・レール
            break;
          }
        }
      }
    }
  }

  // 5. 建築物生成ヘルパー (道路・河川・他建築物への干渉を完全防止 & 土地の水平基礎造成)
  const canPlaceBuilding = (bx: number, bz: number, bw: number, bd: number, margin = 1): boolean => {
    if (bx - margin < 2 || bx + bw + margin >= MAP_GRID_X - 2 || bz - margin < 2 || bz + bd + margin >= MAP_GRID_Z - 2) {
      return false;
    }
    for (let x = bx - margin; x < bx + bw + margin; x++) {
      for (let z = bz - margin; z < bz + bd + margin; z++) {
        if (isRoadOrRiver[z * MAP_GRID_X + x] !== 0) {
          return false; // 道路や川、既存建築と重なる
        }
      }
    }
    return true;
  };

  const buildStructure = (
    bx: number, 
    bz: number, 
    bw: number, 
    bd: number, 
    bh: number, 
    wallType: BlockType, 
    style: 'standard' | 'pitched_roof' | 'glass_office' | 'apartment' = 'standard'
  ) => {
    if (!canPlaceBuilding(bx, bz, bw, bd, 1)) return false;

    // 敷地内の最高地表高さを取得して基礎造成 (傾斜地でも埋まらないようにする)
    let maxY = 1;
    for (let x = bx; x < bx + bw; x++) {
      for (let z = bz; z < bz + bd; z++) {
        for (let y = MAP_GRID_Y - 1; y >= 0; y--) {
          const b = getVoxel(x, y, z);
          if (b !== BLOCK.AIR && b !== BLOCK.WATER && b !== BLOCK.BARRIER) {
            if (y > maxY) maxY = y;
            break;
          }
        }
      }
    }

    const baseY = maxY + 1;

    // 1. 基礎（土台）の均し
    for (let x = bx; x < bx + bw; x++) {
      for (let z = bz; z < bz + bd; z++) {
        isRoadOrRiver[z * MAP_GRID_X + x] = 3; // 建築済みマスク
        for (let y = 0; y < baseY; y++) {
          if (getVoxel(x, y, z) === BLOCK.AIR) {
            setVoxel(x, y, z, BLOCK.STONE);
          }
        }
      }
    }

    // 2. 建物の躯体構築
    for (let x = bx; x < bx + bw; x++) {
      for (let z = bz; z < bz + bd; z++) {
        for (let y = baseY; y < baseY + bh; y++) {
          const isEdge = (x === bx || x === bx + bw - 1 || z === bz || z === bz + bd - 1);
          const isCorner = ((x === bx || x === bx + bw - 1) && (z === bz || z === bz + bd - 1));
          const relY = y - baseY;
          const isFloor = (relY % 4 === 0 || relY === bh - 1);

          if (style === 'glass_office') {
            if (isFloor) setVoxel(x, y, z, BLOCK.CONCRETE);
            else if (isCorner) setVoxel(x, y, z, BLOCK.CONCRETE);
            else if (isEdge) setVoxel(x, y, z, BLOCK.GLASS);
          } else if (style === 'apartment') {
            if (isFloor) setVoxel(x, y, z, BLOCK.CONCRETE);
            else if (isEdge && relY % 4 === 2 && (x % 3 === 0 || z % 3 === 0)) setVoxel(x, y, z, BLOCK.GLASS);
            else if (isEdge) setVoxel(x, y, z, wallType);
          } else {
            // standard
            if (isFloor) setVoxel(x, y, z, BLOCK.CONCRETE);
            else if (isEdge && relY % 3 === 1 && (x % 2 === 0 || z % 2 === 0)) setVoxel(x, y, z, BLOCK.GLASS);
            else if (isEdge) setVoxel(x, y, z, wallType);
          }
        }

        // 三角屋根（傾斜屋根）オプション
        if (style === 'pitched_roof') {
          const roofCenterZ = bz + Math.floor(bd / 2);
          const distToCenter = Math.abs(z - roofCenterZ);
          const roofHeight = Math.max(0, Math.floor(bd / 2) - distToCenter);
          for (let ry = 0; ry <= roofHeight; ry++) {
            setVoxel(x, baseY + bh + ry, z, BLOCK.BRICK);
          }
        }
      }
    }

    // 敷地の周囲に小さな庭・植樹を確率で配置
    if (bw >= 10 && bd >= 10 && style !== 'glass_office') {
      const treeX = bx - 1;
      const treeZ = bz - 1;
      if (treeX > 2 && treeZ > 2 && isRoadOrRiver[treeZ * MAP_GRID_X + treeX] === 0) {
        setVoxel(treeX, baseY, treeZ, BLOCK.WOOD);
        setVoxel(treeX, baseY + 1, treeZ, BLOCK.WOOD);
        setVoxel(treeX, baseY + 2, treeZ, BLOCK.GRASS);
      }
    }

    return true;
  };

  // 6. ランドマーク建築の精密配置
  // ① 藤和ハイタウン深川 (北西高台の大規模マンション群)
  buildStructure(55, 45, 26, 20, 18, BLOCK.CONCRETE, 'apartment');
  buildStructure(90, 40, 24, 18, 16, BLOCK.CONCRETE, 'apartment');
  buildStructure(125, 45, 22, 18, 14, BLOCK.CONCRETE, 'apartment');

  // ② パインビレッジ (北東高台の住宅団地)
  buildStructure(345, 45, 28, 22, 16, BLOCK.CONCRETE, 'apartment');
  buildStructure(385, 40, 24, 18, 14, BLOCK.CONCRETE, 'apartment');

  // ③ デュオ下深川駅前 & 駅舎 (南東側 JR線沿い)
  buildStructure(465, 335, 24, 18, 16, BLOCK.CONCRETE, 'glass_office');
  buildStructure(435, 345, 18, 12, 6, BLOCK.BRICK, 'standard'); // 駅舎

  // ④ 避難施設候補の学校・公共施設・ビル
  buildStructure(150, 375, 30, 20, 10, BLOCK.BRICK, 'standard'); // 深川小学校風 校舎・体育館
  buildStructure(335, 335, 20, 18, 22, BLOCK.CONCRETE, 'glass_office'); // 防災高層ビル

  // 7. 自然で有機的な街並み生成 (街区ごとに区画割りし、道路沿いに建物をランダムな間隔と多様なサイズで配置)
  // 擬似乱数 (シード付きで常に一貫したリアルな街並み)
  let seed = 12345;
  const pseudoRandom = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };

  const placeOrganicZone = (
    minX: number, maxX: number, 
    minZ: number, maxZ: number, 
    density: number,
    types: ('house_wood' | 'house_brick' | 'modern' | 'commercial')[]
  ) => {
    for (let x = minX; x < maxX; x += 14 + Math.floor(pseudoRandom() * 10)) {
      for (let z = minZ; z < maxZ; z += 14 + Math.floor(pseudoRandom() * 10)) {
        if (pseudoRandom() > density) continue;

        const bw = 8 + Math.floor(pseudoRandom() * 7);  // 4m〜7.5m 幅
        const bd = 8 + Math.floor(pseudoRandom() * 7);  // 4m〜7.5m 奥行
        const typeChoice = types[Math.floor(pseudoRandom() * types.length)];

        if (typeChoice === 'house_wood') {
          buildStructure(x, z, bw, bd, 5 + Math.floor(pseudoRandom() * 3), BLOCK.WOOD, 'pitched_roof');
        } else if (typeChoice === 'house_brick') {
          buildStructure(x, z, bw, bd, 6 + Math.floor(pseudoRandom() * 3), BLOCK.BRICK, 'pitched_roof');
        } else if (typeChoice === 'modern') {
          buildStructure(x, z, bw, bd, 7 + Math.floor(pseudoRandom() * 5), BLOCK.CONCRETE, 'apartment');
        } else if (typeChoice === 'commercial') {
          buildStructure(x, z, bw + 2, bd + 2, 8 + Math.floor(pseudoRandom() * 8), BLOCK.CONCRETE, 'glass_office');
        }
      }
    }
  };

  // 北部高台住宅街 (Z: 25 ~ 170)
  placeOrganicZone(25, 570, 25, 75, 0.85, ['modern', 'house_brick']);
  placeOrganicZone(25, 570, 105, 175, 0.88, ['house_wood', 'house_brick', 'modern']);

  // 中央低地・浸水想定市街地 (Z: 275 ~ 425)
  placeOrganicZone(25, 570, 275, 305, 0.85, ['commercial', 'modern', 'house_brick']);
  placeOrganicZone(25, 570, 325, 360, 0.90, ['house_wood', 'house_brick', 'modern', 'commercial']);
  placeOrganicZone(25, 570, 375, 425, 0.88, ['house_wood', 'house_brick', 'modern']);

  // 南部高台住宅地 (Z: 440 ~ 575)
  placeOrganicZone(25, 570, 440, 520, 0.85, ['house_wood', 'house_brick']);
  placeOrganicZone(25, 570, 525, 575, 0.80, ['house_wood']);

  // 開始地点 (南側低地の住宅街道路上 X:300, Z:365)
  let spawnY = 5;
  for (let y = MAP_GRID_Y - 1; y >= 0; y--) {
    if (getVoxel(300, y, 365) !== BLOCK.AIR) {
      spawnY = y + 1;
      break;
    }
  }
  spawnPoint = { gridX: 300, gridY: spawnY, gridZ: 365 };
  setVoxel(spawnPoint.gridX, spawnPoint.gridY, spawnPoint.gridZ, BLOCK.SPAWN);
}

// ==========================================
//   超高速・軽量なRLE圧縮シリアライザー
// ==========================================
// 連長圧縮 (RLE) で 3.6MB のボクセルデータを数KB〜数十KBに圧縮
function serializeVoxelMap(): string {
  const runs: number[] = [];
  let currentType = voxelMap[0];
  let currentCount = 1;

  for (let i = 1; i < voxelMap.length; i++) {
    const val = voxelMap[i];
    if (val === currentType && currentCount < 65535) {
      currentCount++;
    } else {
      runs.push(currentType, currentCount);
      currentType = val;
      currentCount = 1;
    }
  }
  runs.push(currentType, currentCount);

  // JSON 文字列化
  return JSON.stringify(runs);
}

function deserializeVoxelMap(dataStr: string) {
  try {
    const runs: number[] = JSON.parse(dataStr);
    let offset = 0;
    for (let i = 0; i < runs.length; i += 2) {
      const type = runs[i];
      const count = runs[i + 1];
      voxelMap.fill(type, offset, offset + count);
      offset += count;
    }
  } catch (e) {
    console.error('Failed to deserialize voxel map', e);
  }
}

// ==========================================
//      マップのクラウド保存 & ローカル同期
// ==========================================
async function saveMapData(showToast = false) {
  try {
    const serialized = serializeVoxelMap();
    const maxWaterDepthInput = document.getElementById('input-editor-max-water-depth') as HTMLInputElement | null;
    if (maxWaterDepthInput) {
      const requestedMaxWaterDepth = Number(maxWaterDepthInput.value);
      maxWaterLevel = Math.max(INITIAL_WATER_LEVEL, Math.min(25, Number.isFinite(requestedMaxWaterDepth) ? requestedMaxWaterDepth : DEFAULT_MAX_WATER_LEVEL));
      maxWaterDepthInput.value = maxWaterLevel.toFixed(1);
    }
    console.log(`[saveMapData] マップデータ圧縮サイズ: ${(serialized.length / 1024).toFixed(1)}KB, 避難所数: ${shelters.length}`);

    // 1. ローカル保存
    localStorage.setItem(CUSTOM_MAP_KEY, serialized);
    localStorage.setItem(SHELTER_LIST_KEY, JSON.stringify(shelters));
    localStorage.setItem(WATER_LEVEL_KEY, maxWaterLevel.toString());
    console.log('[saveMapData] ローカルストレージに保存完了');

    // 2. Supabase クラウド保存
    if (supabase) {
      try {
        const { error } = await supabase.from('maps').upsert({
          id: 'custom_main_v7',
          title: '150m広域カスタム避難タウン',
          voxel_data: serialized,
          shelters: shelters,
          spawn_point: spawnPoint,
          updated_at: new Date().toISOString()
        });
        if (error) throw error;
        console.log('[saveMapData] Supabaseクラウド保存成功');
        if (showToast) alert('マップデータをクラウド(Supabase)に保存しました！');
      } catch (e) {
        console.warn('[saveMapData] Supabase保存失敗:', e);
        if (showToast) alert('ローカルストレージに保存しました (クラウド同期はオフライン)');
      }
    } else {
      console.log('[saveMapData] Supabase未設定 - ローカルのみ');
      if (showToast) alert('ローカルストレージに保存しました！');
    }
    return true;
  } catch (err) {
    console.error('[saveMapData] 保存エラー:', err);
    if (showToast) alert('保存中にエラーが発生しました');
    return false;
  }
}

async function loadMapData(useCustom: boolean) {
  console.log(`[loadMapData] useCustom=${useCustom}`);
  if (useCustom) {
    if (supabase) {
      try {
        const { data, error } = await supabase.from('maps').select('*').eq('id', 'custom_main_v7').single();
        if (!error && data && data.voxel_data) {
          deserializeVoxelMap(data.voxel_data);
          shelters = data.shelters || [];
          if (data.spawn_point?.gridX) spawnPoint = data.spawn_point;
          console.log(`[loadMapData] Supabaseからカスタムマップロード成功 (避難所: ${shelters.length})`);
          return;
        }
      } catch (e) {
        console.warn('[loadMapData] Supabaseからの取得失敗、ローカルにフォールバック', e);
      }
    }

    const savedMap = localStorage.getItem(CUSTOM_MAP_KEY);
    const savedShelters = localStorage.getItem(SHELTER_LIST_KEY);
    if (savedMap) {
      try {
        deserializeVoxelMap(savedMap);
        shelters = savedShelters ? JSON.parse(savedShelters) : [];
        console.log(`[loadMapData] ローカルストレージからカスタムマップロード成功 (避難所: ${shelters.length})`);
        return;
      } catch (e) {
        console.error('[loadMapData] ローカルカスタムマップの解析失敗', e);
      }
    }
  }

  console.log('[loadMapData] デフォルトマップを生成');
  buildDefaultMap();
}

// ==========================================
//  表面カリング最適化 Three.js ボクセルレンダラー
// ==========================================
// 6方向のうち1面でも空気/水/半透明と接しているブロックのみ描画（描画ブロック数を90%削減し超高速化）
function isVoxelVisible(x: number, y: number, z: number, type: BlockType): boolean {
  if (type === BLOCK.AIR) return false;
  if (type === BLOCK.GLASS || type === BLOCK.WATER || type === BLOCK.BARRIER || type === BLOCK.SHELTER || type === BLOCK.SPAWN) return true;

  // 最外周・最上部は常に可視
  if (x === 0 || x === MAP_GRID_X - 1 || z === 0 || z === MAP_GRID_Z - 1 || y === MAP_GRID_Y - 1 || y === 0) return true;

  // 6方向チェック
  const neighbors = [
    getVoxel(x + 1, y, z),
    getVoxel(x - 1, y, z),
    getVoxel(x, y + 1, z),
    getVoxel(x, y - 1, z),
    getVoxel(x, y, z + 1),
    getVoxel(x, y, z - 1)
  ];

  for (const n of neighbors) {
    if (n === BLOCK.AIR || n === BLOCK.WATER || n === BLOCK.GLASS || n === BLOCK.BARRIER) {
      return true; // 1面でも隙間があれば可視
    }
  }
  return false; // 完全に埋まっている内部ブロックはスキップ
}

function createVoxelMeshes(isEditor = false): { meshes: THREE.InstancedMesh[]; shelterMeshes: THREE.Group } {
  const instancedMeshes: THREE.InstancedMesh[] = [];
  const shelterGroup = new THREE.Group();

  // 可視ブロックのみカウント
  const visiblePositions: { x: number; y: number; z: number; type: BlockType }[] = [];
  const counts: Record<number, number> = {};

  for (let x = 0; x < MAP_GRID_X; x++) {
    for (let y = 0; y < MAP_GRID_Y; y++) {
      for (let z = 0; z < MAP_GRID_Z; z++) {
        const type = getVoxel(x, y, z);
        if (type === BLOCK.AIR) continue;
        if (!isEditor && BLOCK_CONFIGS[type]?.invisibleInGame) continue;

        if (isVoxelVisible(x, y, z, type)) {
          visiblePositions.push({ x, y, z, type });
          counts[type] = (counts[type] || 0) + 1;
        }
      }
    }
  }

  const boxGeo = new THREE.BoxGeometry(VOXEL_SIZE, VOXEL_SIZE, VOXEL_SIZE);
  const typeToMesh: Record<number, { mesh: THREE.InstancedMesh; index: number }> = {};

  Object.keys(BLOCK_CONFIGS).forEach(key => {
    const type = Number(key);
    const count = counts[type] || 0;
    if (count === 0) return;

    const conf = BLOCK_CONFIGS[type];
    const mat = new THREE.MeshStandardMaterial({
      color: conf.color,
      roughness: conf.roughness || 0.7,
      transparent: !!conf.transparent,
      opacity: conf.opacity || 1.0,
      flatShading: true
    });

    const mesh = new THREE.InstancedMesh(boxGeo, mat, count);
    mesh.castShadow = !conf.transparent && !conf.invisibleInGame;
    mesh.receiveShadow = true;
    instancedMeshes.push(mesh);
    typeToMesh[type] = { mesh, index: 0 };
  });

  const dummy = new THREE.Object3D();

  for (let i = 0; i < visiblePositions.length; i++) {
    const { x, y, z, type } = visiblePositions[i];
    const info = typeToMesh[type];
    if (!info) continue;

    const worldX = (x - MAP_GRID_X / 2) * VOXEL_SIZE + VOXEL_SIZE / 2;
    const worldY = y * VOXEL_SIZE + VOXEL_SIZE / 2;
    const worldZ = (z - MAP_GRID_Z / 2) * VOXEL_SIZE + VOXEL_SIZE / 2;

    dummy.position.set(worldX, worldY, worldZ);
    dummy.updateMatrix();
    info.mesh.setMatrixAt(info.index++, dummy.matrix);

    if (type === BLOCK.SHELTER) {
      const flag = createShelterFlag(worldX, worldY + VOXEL_SIZE / 2, worldZ);
      shelterGroup.add(flag);
    }
  }

  instancedMeshes.forEach(m => m.instanceMatrix.needsUpdate = true);
  return { meshes: instancedMeshes, shelterMeshes: shelterGroup };
}

function createShelterFlag(x: number, y: number, z: number): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);

  const poleGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.8);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const pole = new THREE.Mesh(poleGeo, poleMat);
  pole.position.y = 0.9;
  group.add(pole);

  const flagGeo = new THREE.BoxGeometry(0.6, 0.4, 0.04);
  const flagMat = new THREE.MeshStandardMaterial({ color: 0xf43f5e });
  const flag = new THREE.Mesh(flagGeo, flagMat);
  flag.position.set(0.3, 1.6, 0);
  group.add(flag);

  return group;
}

// ==========================================
//      ゲーム＆三人称後方追従＆精密衝突判定
// ==========================================
let gameScene: THREE.Scene;
let gameCamera: THREE.PerspectiveCamera;
let gameRenderer: THREE.WebGLRenderer;
let gameClock: THREE.Clock;
let isPlaying = false;
let gameTime = 0;
const MAX_GAME_TIME = 300;
const INITIAL_WATER_LEVEL = 0.2;
const DEFAULT_MAX_WATER_LEVEL = 10.5;
const DROWNING_DEPTH = 0.5;
let maxWaterLevel = DEFAULT_MAX_WATER_LEVEL;
let waterRiseRate = 0.0;
let waterLevel = INITIAL_WATER_LEVEL;
const WATER_START_SEC = 30;
let trajectoryData: any[] = [];
let currentSession: any = null;

// プレイヤー物理パラメータ (リアルで制御しやすい歩行・走行速度: 3.8m/s)
const player = {
  pos: new THREE.Vector3(0, 3, 0),
  vel: new THREE.Vector3(0, 0, 0),
  facingAngle: 0,
  speed: 3.8,
  radius: 0.22,
  height: 1.6,
  onGround: false
};

// シミュレーション時の自由三人称カメラパラメータ
let gameCamYaw = Math.PI; // プレイヤーの背後から見る角度
let gameCamPitch = 0.35;  // 見下ろし角度 (rad)
let gameCamDist = 6.0;    // カメラ距離 (m)
let isGameDragging = false;
let gameDragStartX = 0;
let gameDragStartY = 0;

let playerMesh: THREE.Mesh;
const gameKeys = { w: false, a: false, s: false, d: false };
const gameJoystick = { active: false, dx: 0, dy: 0 };
let gameWaterMesh: THREE.Mesh;
let gameVoxelGroup = new THREE.Group();

function initGameThree() {
  const container = document.getElementById('game-canvas-container')!;
  gameScene = new THREE.Scene();
  gameScene.background = new THREE.Color(0x0f172a);
  gameScene.fog = new THREE.FogExp2(0x0f172a, 0.005);

  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || window.innerHeight;
  gameCamera = new THREE.PerspectiveCamera(55, w / h, 0.1, 1000);

  gameRenderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  gameRenderer.setSize(w, h);
  gameRenderer.shadowMap.enabled = true;
  gameRenderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(gameRenderer.domElement);

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x334155, 0.65);
  gameScene.add(hemiLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.85);
  dirLight.position.set(80, 160, 80);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 1024;
  dirLight.shadow.mapSize.height = 1024;
  const shadowRange = 60;
  dirLight.shadow.camera.left = -shadowRange;
  dirLight.shadow.camera.right = shadowRange;
  dirLight.shadow.camera.top = shadowRange;
  dirLight.shadow.camera.bottom = -shadowRange;
  gameScene.add(dirLight);

  const charGeo = new THREE.CapsuleGeometry(player.radius, player.height - player.radius * 2, 4, 8);
  const charMat = new THREE.MeshStandardMaterial({ color: 0x06b6d4, roughness: 0.4 });
  playerMesh = new THREE.Mesh(charGeo, charMat);
  playerMesh.castShadow = true;
  gameScene.add(playerMesh);

  const waterGeo = new THREE.PlaneGeometry(MAP_GRID_X * VOXEL_SIZE * 1.5, MAP_GRID_Z * VOXEL_SIZE * 1.5);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x1d4ed8,
    transparent: true,
    opacity: 0.68,
    roughness: 0.1,
    metalness: 0.8,
    side: THREE.DoubleSide
  });
  gameWaterMesh = new THREE.Mesh(waterGeo, waterMat);
  gameWaterMesh.rotateX(-Math.PI / 2);
  gameWaterMesh.position.y = 0.0;
  gameScene.add(gameWaterMesh);

  gameScene.add(gameVoxelGroup);
  gameClock = new THREE.Clock();

  window.addEventListener('resize', () => {
    if (!gameRenderer) return;
    gameCamera.aspect = container.clientWidth / container.clientHeight;
    gameCamera.updateProjectionMatrix();
    gameRenderer.setSize(container.clientWidth, container.clientHeight);
  });
}

async function startSimulationMode(mapType: string) {
  await loadMapData(mapType === 'custom');

  while (gameVoxelGroup.children.length > 0) {
    const obj = gameVoxelGroup.children[0];
    gameVoxelGroup.remove(obj);
  }

  const { meshes, shelterMeshes } = createVoxelMeshes(false);
  meshes.forEach(m => gameVoxelGroup.add(m));
  gameVoxelGroup.add(shelterMeshes);

  player.pos.set(
    (spawnPoint.gridX - MAP_GRID_X / 2) * VOXEL_SIZE + VOXEL_SIZE / 2,
    spawnPoint.gridY * VOXEL_SIZE + 0.1,
    (spawnPoint.gridZ - MAP_GRID_Z / 2) * VOXEL_SIZE + VOXEL_SIZE / 2
  );
  player.vel.set(0, 0, 0);
  player.facingAngle = Math.PI;

  gameCamYaw = Math.PI;
  gameCamPitch = 0.35;
  gameCamDist = 6.0;

  waterLevel = INITIAL_WATER_LEVEL;
  waterRiseRate = (maxWaterLevel - INITIAL_WATER_LEVEL) / (MAX_GAME_TIME - WATER_START_SEC);
  gameTime = 0;
  isPlaying = true;
  trajectoryData = [];

  gameClock.getDelta();
}

// 精密な衝突判定 & 段差登り & カメラ向きに連動した直感的移動
function updateGamePhysics(dt: number) {
  let rawX = 0;
  let rawZ = 0;

  if (gameKeys.w) rawZ -= 1;
  if (gameKeys.s) rawZ += 1;
  if (gameKeys.a) rawX -= 1;
  if (gameKeys.d) rawX += 1;

  if (gameJoystick.active) {
    rawX = gameJoystick.dx;
    rawZ = gameJoystick.dy;
  }

  let moveSpeed = player.speed;

  const waterDepth = waterLevel - player.pos.y;
  if (waterDepth > 0) {
    if (waterDepth > 1.2) moveSpeed *= 0.25;
    else if (waterDepth > 0.5) moveSpeed *= 0.5;
    else moveSpeed *= 0.8;
  }

  // カメラの水平向き (gameCamYaw) に応じた移動方向を算出
  const forwardX = -Math.sin(gameCamYaw);
  const forwardZ = -Math.cos(gameCamYaw);
  const rightX = -forwardZ; // 90度回転
  const rightZ = forwardX;

  const moveDirX = rawX * rightX - rawZ * forwardX;
  const moveDirZ = rawX * rightZ - rawZ * forwardZ;
  const moveLen = Math.sqrt(moveDirX * moveDirX + moveDirZ * moveDirZ);

  if (moveLen > 0.001) {
    const dirX = moveDirX / moveLen;
    const dirZ = moveDirZ / moveLen;
    player.facingAngle = Math.atan2(dirX, dirZ);

    player.vel.x = dirX * moveSpeed;
    player.vel.z = dirZ * moveSpeed;
  } else {
    player.vel.x = 0;
    player.vel.z = 0;
  }

  player.vel.y -= 16.0 * dt;

  const nextPosX = player.pos.x + player.vel.x * dt;
  const nextPosZ = player.pos.z + player.vel.z * dt;

  const halfWidth = (MAP_GRID_X * VOXEL_SIZE) / 2 - 0.8;
  const halfDepth = (MAP_GRID_Z * VOXEL_SIZE) / 2 - 0.8;
  const clampedX = Math.max(-halfWidth, Math.min(halfWidth, nextPosX));
  const clampedZ = Math.max(-halfDepth, Math.min(halfDepth, nextPosZ));

  // X軸の移動と段差判定
  if (player.vel.x !== 0) {
    const stepUpY = getStepUpHeight(clampedX, player.pos.y, player.pos.z);
    if (stepUpY !== null && stepUpY - player.pos.y <= VOXEL_SIZE + 0.05) {
      if (!checkCollision(clampedX, stepUpY, player.pos.z)) {
        player.pos.x = clampedX;
        player.pos.y = Math.max(player.pos.y, stepUpY);
        player.vel.y = 0;
        player.onGround = true;
      }
    } else if (!checkCollision(clampedX, player.pos.y, player.pos.z)) {
      player.pos.x = clampedX;
    }
  }

  // Z軸の移動と段差判定
  if (player.vel.z !== 0) {
    const stepUpY = getStepUpHeight(player.pos.x, player.pos.y, clampedZ);
    if (stepUpY !== null && stepUpY - player.pos.y <= VOXEL_SIZE + 0.05) {
      if (!checkCollision(player.pos.x, stepUpY, clampedZ)) {
        player.pos.z = clampedZ;
        player.pos.y = Math.max(player.pos.y, stepUpY);
        player.vel.y = 0;
        player.onGround = true;
      }
    } else if (!checkCollision(player.pos.x, player.pos.y, clampedZ)) {
      player.pos.z = clampedZ;
    }
  }

  // Y軸の落下 & 着地
  const nextPosY = player.pos.y + player.vel.y * dt;
  if (checkCollision(player.pos.x, nextPosY, player.pos.z)) {
    if (player.vel.y < 0) {
      player.onGround = true;
      player.pos.y = Math.ceil(nextPosY / VOXEL_SIZE) * VOXEL_SIZE;
    }
    player.vel.y = 0;
  } else {
    player.pos.y = nextPosY;
    player.onGround = false;
  }

  playerMesh.position.set(player.pos.x, player.pos.y + player.height / 2, player.pos.z);
  playerMesh.rotation.y = player.facingAngle;

  if (gameTime >= WATER_START_SEC) {
    waterLevel = Math.min(maxWaterLevel, waterLevel + waterRiseRate * dt);
  }
  gameWaterMesh.position.y = waterLevel;

  if (waterLevel - player.pos.y >= DROWNING_DEPTH) {
    endSimulation('drowned');
  }

  // 自由回転三人称カメラの位置計算
  const camOffsetX = gameCamDist * Math.sin(gameCamYaw) * Math.cos(gameCamPitch);
  const camOffsetY = gameCamDist * Math.sin(gameCamPitch) + 1.2;
  const camOffsetZ = gameCamDist * Math.cos(gameCamYaw) * Math.cos(gameCamPitch);

  const targetCamPos = new THREE.Vector3(
    player.pos.x + camOffsetX,
    player.pos.y + camOffsetY,
    player.pos.z + camOffsetZ
  );
  gameCamera.position.lerp(targetCamPos, 0.15);
  gameCamera.lookAt(player.pos.x, player.pos.y + 1.0, player.pos.z);
}

function getStepUpHeight(px: number, py: number, pz: number): number | null {
  const minGx = Math.floor((px - player.radius + (MAP_GRID_X * VOXEL_SIZE) / 2) / VOXEL_SIZE);
  const maxGx = Math.floor((px + player.radius + (MAP_GRID_X * VOXEL_SIZE) / 2) / VOXEL_SIZE);
  const minGz = Math.floor((pz - player.radius + (MAP_GRID_Z * VOXEL_SIZE) / 2) / VOXEL_SIZE);
  const maxGz = Math.floor((pz + player.radius + (MAP_GRID_Z * VOXEL_SIZE) / 2) / VOXEL_SIZE);
  const currentGy = Math.floor(py / VOXEL_SIZE);

  let highestStep = -1;

  for (let gx = minGx; gx <= maxGx; gx++) {
    for (let gz = minGz; gz <= maxGz; gz++) {
      const stepBlock = getVoxel(gx, currentGy, gz);
      if (stepBlock !== BLOCK.AIR && stepBlock !== BLOCK.WATER && stepBlock !== BLOCK.SPAWN && stepBlock !== BLOCK.SHELTER && stepBlock !== BLOCK.BARRIER) {
        // 段差の上の頭上空間が2ブロック分空いているか
        const aboveBlock1 = getVoxel(gx, currentGy + 1, gz);
        const aboveBlock2 = getVoxel(gx, currentGy + 2, gz);
        const aboveBlock3 = getVoxel(gx, currentGy + 3, gz);
        if (
          (aboveBlock1 === BLOCK.AIR || aboveBlock1 === BLOCK.WATER) &&
          (aboveBlock2 === BLOCK.AIR || aboveBlock2 === BLOCK.WATER) &&
          (aboveBlock3 === BLOCK.AIR || aboveBlock3 === BLOCK.WATER)
        ) {
          highestStep = Math.max(highestStep, (currentGy + 1) * VOXEL_SIZE);
        } else {
          return null; // 壁やすき間の狭い場所は登れない
        }
      }
    }
  }

  return highestStep !== -1 ? highestStep : null;
}

// プレイヤーの全高にわたる厳格なAABB衝突判定
function checkCollision(px: number, py: number, pz: number): boolean {
  if (py < 0) return true;

  const minGx = Math.floor((px - player.radius + (MAP_GRID_X * VOXEL_SIZE) / 2) / VOXEL_SIZE);
  const maxGx = Math.floor((px + player.radius + (MAP_GRID_X * VOXEL_SIZE) / 2) / VOXEL_SIZE);
  const minGy = Math.floor(py / VOXEL_SIZE);
  const maxGy = Math.floor((py + player.height - 0.05) / VOXEL_SIZE);
  const minGz = Math.floor((pz - player.radius + (MAP_GRID_Z * VOXEL_SIZE) / 2) / VOXEL_SIZE);
  const maxGz = Math.floor((pz + player.radius + (MAP_GRID_Z * VOXEL_SIZE) / 2) / VOXEL_SIZE);

  for (let gx = minGx; gx <= maxGx; gx++) {
    for (let gy = minGy; gy <= maxGy; gy++) {
      for (let gz = minGz; gz <= maxGz; gz++) {
        const type = getVoxel(gx, gy, gz);
        if (type !== BLOCK.AIR && type !== BLOCK.WATER && type !== BLOCK.SPAWN && type !== BLOCK.SHELTER) {
          return true;
        }
      }
    }
  }
  return false;
}

function getNearbyShelter(): ShelterInfo | null {
  for (const s of shelters) {
    const sx = (s.gridX - MAP_GRID_X / 2) * VOXEL_SIZE + VOXEL_SIZE / 2;
    const sy = s.gridY * VOXEL_SIZE;
    const sz = (s.gridZ - MAP_GRID_Z / 2) * VOXEL_SIZE + VOXEL_SIZE / 2;

    const distXZ = Math.sqrt((player.pos.x - sx) ** 2 + (player.pos.z - sz) ** 2);
    const distY = Math.abs(player.pos.y - sy);

    if (distXZ < 3.0 && distY < 3.0) {
      return s;
    }
  }
  return null;
}

// ==========================================
//   3D クリエイティブ マップエディタ (適正飛行速度: 15.0m/s)
// ==========================================
let editorScene: THREE.Scene;
let editorCamera: THREE.PerspectiveCamera;
let editorRenderer: THREE.WebGLRenderer;
let editorClock: THREE.Clock;
let isEditorActive = false;
let isPointerLocked = false;
let isInventoryOpen = false;

const editorFly = {
  pos: new THREE.Vector3(0, 35, 90),
  yaw: 0,
  pitch: -Math.PI / 5,
  speed: 15.0 // 操作しやすい適正飛行速度
};

const editorKeys = { w: false, a: false, s: false, d: false, up: false, down: false };
const editorJoystick = { active: false, dx: 0, dy: 0 };
let currentBrushBlock: BlockType = BLOCK.GRASS;
let editorMode: 'place' | 'break' = 'place';
let editorTool: 'single' | 'hill' | 'box' | 'stamp' = 'single';
let currentStampType = 'house';

let hillBrushRadius = 12;
let hillBrushHeight = 8;

let wePos1: { x: number; y: number; z: number } | null = null;
let wePos2: { x: number; y: number; z: number } | null = null;
let weSelectingPos: 1 | 2 | null = null;

let editorVoxelGroup = new THREE.Group();
let highlightBox: THREE.LineSegments;
let selectionBox: THREE.LineSegments;
let targetVoxelPos: { x: number; y: number; z: number; normal: THREE.Vector3; distance: number; inReach: boolean } | null = null;

function initEditorThree() {
  const container = document.getElementById('editor-canvas-container')!;
  editorScene = new THREE.Scene();
  editorScene.background = new THREE.Color(0x090d16);

  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || window.innerHeight;
  editorCamera = new THREE.PerspectiveCamera(60, w / h, 0.1, 1000);

  editorRenderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  editorRenderer.setSize(w, h);
  editorRenderer.shadowMap.enabled = true;
  container.appendChild(editorRenderer.domElement);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x1e293b, 0.7);
  editorScene.add(hemi);

  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(100, 200, 100);
  dir.castShadow = true;
  editorScene.add(dir);

  const gridHelper = new THREE.GridHelper(MAP_GRID_X * VOXEL_SIZE, MAP_GRID_X / 4, 0x06b6d4, 0x1e293b);
  editorScene.add(gridHelper);

  const boxGeo = new THREE.BoxGeometry(VOXEL_SIZE * 1.02, VOXEL_SIZE * 1.02, VOXEL_SIZE * 1.02);
  const edges = new THREE.EdgesGeometry(boxGeo);
  highlightBox = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x38bdf8, linewidth: 2 }));
  editorScene.add(highlightBox);

  const selGeo = new THREE.BoxGeometry(1, 1, 1);
  const selEdges = new THREE.EdgesGeometry(selGeo);
  selectionBox = new THREE.LineSegments(selEdges, new THREE.LineBasicMaterial({ color: 0xf59e0b, linewidth: 3 }));
  selectionBox.visible = false;
  editorScene.add(selectionBox);

  editorScene.add(editorVoxelGroup);
  editorClock = new THREE.Clock();

  container.addEventListener('click', () => {
    if (!isPointerLocked && isEditorActive && !isInventoryOpen) {
      container.requestPointerLock();
    }
  });

  document.addEventListener('pointerlockchange', () => {
    isPointerLocked = (document.pointerLockElement === container);
    const hint = document.getElementById('pointer-lock-hint');
    if (hint) {
      hint.innerText = isPointerLocked ? '視点操作中 (Eキーでメニュー)' : 'クリックして視点操作を開始 (Eキーでメニュー)';
      hint.className = isPointerLocked 
        ? 'absolute top-3 right-3 bg-emerald-950/80 border border-emerald-700 px-3 py-1.5 rounded-lg text-xs text-emerald-300 pointer-events-none'
        : 'absolute top-3 right-3 bg-slate-950/80 border border-slate-700 px-3 py-1.5 rounded-lg text-xs text-slate-300 pointer-events-none';
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (!isEditorActive || isInventoryOpen) return;
    if (isPointerLocked) {
      editorFly.yaw -= e.movementX * 0.0025;
      editorFly.pitch = Math.max(-Math.PI / 2.05, Math.min(Math.PI / 2.05, editorFly.pitch - e.movementY * 0.0025));
    }
  });

  container.addEventListener('mousedown', (e) => {
    if (!isEditorActive || !isPointerLocked || isInventoryOpen) return;

    if (weSelectingPos === 1 && targetVoxelPos && targetVoxelPos.inReach) {
      wePos1 = { x: targetVoxelPos.x, y: targetVoxelPos.y, z: targetVoxelPos.z };
      weSelectingPos = null;
      updateWorldEditUI();
    } else if (weSelectingPos === 2 && targetVoxelPos && targetVoxelPos.inReach) {
      wePos2 = { x: targetVoxelPos.x, y: targetVoxelPos.y, z: targetVoxelPos.z };
      weSelectingPos = null;
      updateWorldEditUI();
    } else if (editorTool === 'hill') {
      if (targetVoxelPos && targetVoxelPos.inReach) {
        applyHillBrush(targetVoxelPos.x, targetVoxelPos.z, e.button === 0 ? hillBrushHeight : -hillBrushHeight);
      }
    } else if (editorTool === 'stamp') {
      if (targetVoxelPos && targetVoxelPos.inReach) {
        applyStampAtTarget(currentStampType);
      }
    } else {
      if (e.button === 0) executeEditorAction(editorMode);
      else if (e.button === 2) executeEditorAction('break');
    }
  });

  container.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('resize', () => {
    if (!editorRenderer) return;
    editorCamera.aspect = container.clientWidth / container.clientHeight;
    editorCamera.updateProjectionMatrix();
    editorRenderer.setSize(container.clientWidth, container.clientHeight);
  });
}

function refreshEditorVoxelScene() {
  while (editorVoxelGroup.children.length > 0) {
    const obj = editorVoxelGroup.children[0];
    editorVoxelGroup.remove(obj);
  }

  const { meshes, shelterMeshes } = createVoxelMeshes(true);
  meshes.forEach(m => editorVoxelGroup.add(m));
  editorVoxelGroup.add(shelterMeshes);

  const badge = document.getElementById('badge-shelter-count');
  if (badge) badge.innerText = shelters.length.toString();
}

async function openEditor() {
  await loadMapData(true);
  const savedMaxWaterLevel = Number(localStorage.getItem(WATER_LEVEL_KEY));
  if (Number.isFinite(savedMaxWaterLevel)) {
    maxWaterLevel = Math.max(INITIAL_WATER_LEVEL, Math.min(25, savedMaxWaterLevel));
  }
  const maxWaterDepthInput = document.getElementById('input-editor-max-water-depth') as HTMLInputElement | null;
  if (maxWaterDepthInput) maxWaterDepthInput.value = maxWaterLevel.toFixed(1);
  isEditorActive = true;
  refreshEditorVoxelScene();
  editorClock.getDelta();
}

function toggleInventory(open?: boolean) {
  const modal = document.getElementById('modal-inventory')!;
  const nextState = (open !== undefined) ? open : !isInventoryOpen;
  isInventoryOpen = nextState;

  if (isInventoryOpen) {
    if (document.exitPointerLock) document.exitPointerLock();
    modal.classList.remove('hidden');
  } else {
    modal.classList.add('hidden');
    const container = document.getElementById('editor-canvas-container')!;
    if (container && isEditorActive) {
      container.requestPointerLock();
    }
  }
}

function updateEditorRaycast() {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(0, 0), editorCamera);

  const intersects = raycaster.intersectObjects(editorVoxelGroup.children, true);
  const crosshair = document.getElementById('editor-crosshair');
  const distLabel = document.getElementById('editor-distance-label');

  if (intersects.length > 0) {
    const hit = intersects[0];
    const normal = hit.face?.normal || new THREE.Vector3(0, 1, 0);

    const hitPoint = hit.point.clone().sub(normal.clone().multiplyScalar(VOXEL_SIZE * 0.4));
    const gx = Math.floor((hitPoint.x + (MAP_GRID_X * VOXEL_SIZE) / 2) / VOXEL_SIZE);
    const gy = Math.floor(hitPoint.y / VOXEL_SIZE);
    const gz = Math.floor((hitPoint.z + (MAP_GRID_Z * VOXEL_SIZE) / 2) / VOXEL_SIZE);

    const distance = hit.distance;
    const inReach = distance <= MAX_REACH_DISTANCE;

    targetVoxelPos = { x: gx, y: gy, z: gz, normal, distance, inReach };

    const highlightTarget = (editorMode === 'place' && editorTool === 'single')
      ? { x: gx + normal.x, y: gy + normal.y, z: gz + normal.z }
      : { x: gx, y: gy, z: gz };

    highlightBox.position.set(
      (highlightTarget.x - MAP_GRID_X / 2) * VOXEL_SIZE + VOXEL_SIZE / 2,
      highlightTarget.y * VOXEL_SIZE + VOXEL_SIZE / 2,
      (highlightTarget.z - MAP_GRID_Z / 2) * VOXEL_SIZE + VOXEL_SIZE / 2
    );

    highlightBox.visible = inReach;
    if (crosshair) {
      crosshair.className = inReach 
        ? 'w-4 h-4 border-2 border-emerald-400 rounded-full' 
        : 'w-4 h-4 border-2 border-red-500/50 rounded-full';
    }

    const posLabel = document.getElementById('editor-cursor-pos');
    if (posLabel) {
      posLabel.innerText = `X: ${highlightTarget.x}, Y: ${highlightTarget.y} (標高 ${(highlightTarget.y * VOXEL_SIZE).toFixed(1)}m), Z: ${highlightTarget.z}`;
    }

    if (distLabel) {
      distLabel.innerText = inReach 
        ? `距離: ${distance.toFixed(1)}m (リーチ内)` 
        : `距離: ${distance.toFixed(1)}m (遠すぎます - 最大${MAX_REACH_DISTANCE}m)`;
      distLabel.className = inReach ? 'text-[10px] text-emerald-400' : 'text-[10px] text-red-400 font-bold';
    }
  } else {
    targetVoxelPos = null;
    highlightBox.visible = false;
    if (crosshair) crosshair.className = 'w-4 h-4 border-2 border-white/50 rounded-full';
    if (distLabel) {
      distLabel.innerText = '対象なし';
      distLabel.className = 'text-[10px] text-slate-500';
    }
  }

  if (wePos1 && wePos2) {
    const minX = Math.min(wePos1.x, wePos2.x);
    const maxX = Math.max(wePos1.x, wePos2.x);
    const minY = Math.min(wePos1.y, wePos2.y);
    const maxY = Math.max(wePos1.y, wePos2.y);
    const minZ = Math.min(wePos1.z, wePos2.z);
    const maxZ = Math.max(wePos1.z, wePos2.z);

    const sizeX = (maxX - minX + 1) * VOXEL_SIZE;
    const sizeY = (maxY - minY + 1) * VOXEL_SIZE;
    const sizeZ = (maxZ - minZ + 1) * VOXEL_SIZE;

    const centerX = ((minX + maxX) / 2 - MAP_GRID_X / 2) * VOXEL_SIZE + VOXEL_SIZE / 2;
    const centerY = ((minY + maxY) / 2) * VOXEL_SIZE + VOXEL_SIZE / 2;
    const centerZ = ((minZ + maxZ) / 2 - MAP_GRID_Z / 2) * VOXEL_SIZE + VOXEL_SIZE / 2;

    selectionBox.position.set(centerX, centerY, centerZ);
    selectionBox.scale.set(sizeX, sizeY, sizeZ);
    selectionBox.visible = true;
  } else {
    selectionBox.visible = false;
  }
}

function executeEditorAction(mode: 'place' | 'break') {
  if (!targetVoxelPos || !targetVoxelPos.inReach) return;

  if (mode === 'place') {
    const tx = targetVoxelPos.x + targetVoxelPos.normal.x;
    const ty = targetVoxelPos.y + targetVoxelPos.normal.y;
    const tz = targetVoxelPos.z + targetVoxelPos.normal.z;

    if (tx >= 0 && tx < MAP_GRID_X && ty >= 0 && ty < MAP_GRID_Y && tz >= 0 && tz < MAP_GRID_Z) {
      setVoxel(tx, ty, tz, currentBrushBlock);

      if (currentBrushBlock === BLOCK.SHELTER) {
        const id = `shelter-${Date.now()}`;
        shelters.push({
          id,
          name: `避難所 #${shelters.length + 1}`,
          gridX: tx,
          gridY: ty,
          gridZ: tz,
          notes: `標高 ${(ty * VOXEL_SIZE).toFixed(1)}m`
        });
      } else if (currentBrushBlock === BLOCK.SPAWN) {
        setVoxel(spawnPoint.gridX, spawnPoint.gridY, spawnPoint.gridZ, BLOCK.AIR);
        spawnPoint = { gridX: tx, gridY: ty, gridZ: tz };
        setVoxel(tx, ty, tz, BLOCK.SPAWN);
      }

      refreshEditorVoxelScene();
    }
  } else if (mode === 'break') {
    const tx = targetVoxelPos.x;
    const ty = targetVoxelPos.y;
    const tz = targetVoxelPos.z;

    const oldBlock = getVoxel(tx, ty, tz);
    if (oldBlock !== BLOCK.AIR) {
      setVoxel(tx, ty, tz, BLOCK.AIR);
      if (oldBlock === BLOCK.SHELTER) {
        shelters = shelters.filter(s => !(s.gridX === tx && s.gridY === ty && s.gridZ === tz));
      }
      refreshEditorVoxelScene();
    }
  }
}

function applyHillBrush(centerX: number, centerZ: number, deltaHeight: number) {
  const R = hillBrushRadius;

  for (let dx = -R; dx <= R; dx++) {
    for (let dz = -R; dz <= R; dz++) {
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > R) continue;

      const factor = Math.cos((dist / R) * (Math.PI / 2));
      const addY = Math.round(deltaHeight * factor);

      const targetX = centerX + dx;
      const targetZ = centerZ + dz;
      if (targetX < 0 || targetX >= MAP_GRID_X || targetZ < 0 || targetZ >= MAP_GRID_Z) continue;

      let currentTopY = 0;
      for (let y = MAP_GRID_Y - 1; y >= 0; y--) {
        const b = getVoxel(targetX, y, targetZ);
        if (b !== BLOCK.AIR && b !== BLOCK.WATER && b !== BLOCK.BARRIER) {
          currentTopY = y;
          break;
        }
      }

      const newTopY = Math.max(1, Math.min(MAP_GRID_Y - 2, currentTopY + addY));

      if (addY > 0) {
        for (let y = currentTopY; y <= newTopY; y++) {
          if (y === newTopY) setVoxel(targetX, y, targetZ, BLOCK.GRASS);
          else if (y >= newTopY - 2) setVoxel(targetX, y, targetZ, BLOCK.DIRT);
          else setVoxel(targetX, y, targetZ, BLOCK.STONE);
        }
      } else if (addY < 0) {
        for (let y = currentTopY; y > newTopY; y--) {
          setVoxel(targetX, y, targetZ, BLOCK.AIR);
        }
        setVoxel(targetX, newTopY, targetZ, BLOCK.GRASS);
      }
    }
  }

  refreshEditorVoxelScene();
}

function applyWorldEditFill(fillType: BlockType) {
  if (!wePos1 || !wePos2) {
    alert('先にPos1とPos2を指定してください');
    return;
  }

  const minX = Math.max(0, Math.min(wePos1.x, wePos2.x));
  const maxX = Math.min(MAP_GRID_X - 1, Math.max(wePos1.x, wePos2.x));
  const minY = Math.max(0, Math.min(wePos1.y, wePos2.y));
  const maxY = Math.min(MAP_GRID_Y - 1, Math.max(wePos1.y, wePos2.y));
  const minZ = Math.max(0, Math.min(wePos1.z, wePos2.z));
  const maxZ = Math.min(MAP_GRID_Z - 1, Math.max(wePos1.z, wePos2.z));

  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        setVoxel(x, y, z, fillType);
      }
    }
  }

  refreshEditorVoxelScene();
}

function applyStampAtTarget(stampType: string) {
  if (!targetVoxelPos || !targetVoxelPos.inReach) return;

  const bx = targetVoxelPos.x;
  const by = targetVoxelPos.y + (targetVoxelPos.normal.y > 0 ? 1 : 0);
  const bz = targetVoxelPos.z;

  if (stampType === 'house') {
    // 木造住宅 (2階建)
    for (let x = 0; x < 10; x++) {
      for (let z = 0; z < 10; z++) {
        for (let y = 0; y < 8; y++) {
          const isWall = (x === 0 || x === 9 || z === 0 || z === 9);
          const isFloor = (y === 0 || y === 4 || y === 7);
          const isWindow = (isWall && (y === 2 || y === 5) && (x % 3 === 0 || z % 3 === 0));

          if (isFloor) setVoxel(bx + x, by + y, bz + z, BLOCK.WOOD);
          else if (isWindow) setVoxel(bx + x, by + y, bz + z, BLOCK.GLASS);
          else if (isWall) setVoxel(bx + x, by + y, bz + z, BLOCK.WOOD);
        }
      }
    }
  } else if (stampType === 'house_brick') {
    // 洋風レンガ住宅 (傾斜屋根付き)
    for (let x = 0; x < 12; x++) {
      for (let z = 0; z < 10; z++) {
        for (let y = 0; y < 8; y++) {
          const isWall = (x === 0 || x === 11 || z === 0 || z === 9);
          const isFloor = (y === 0 || y === 4 || y === 7);
          const isWindow = (isWall && (y === 2 || y === 5) && (x % 3 === 0 || z % 3 === 0));

          if (isFloor) setVoxel(bx + x, by + y, bz + z, BLOCK.CONCRETE);
          else if (isWindow) setVoxel(bx + x, by + y, bz + z, BLOCK.GLASS);
          else if (isWall) setVoxel(bx + x, by + y, bz + z, BLOCK.BRICK);
        }
        // 屋根
        const distToCenter = Math.abs(z - 5);
        const roofHeight = Math.max(0, 4 - distToCenter);
        for (let ry = 0; ry <= roofHeight; ry++) {
          setVoxel(bx + x, by + 8 + ry, bz + z, BLOCK.BRICK);
        }
      }
    }
  } else if (stampType === 'house_modern') {
    // 近代アパート (3階建)
    for (let x = 0; x < 14; x++) {
      for (let z = 0; z < 12; z++) {
        for (let y = 0; y < 12; y++) {
          const isWall = (x === 0 || x === 13 || z === 0 || z === 11);
          const isFloor = (y % 4 === 0 || y === 11);
          const isWindow = (isWall && (y % 4 === 2) && (x % 3 === 0 || z % 3 === 0));

          if (isFloor) setVoxel(bx + x, by + y, bz + z, BLOCK.CONCRETE);
          else if (isWindow) setVoxel(bx + x, by + y, bz + z, BLOCK.GLASS);
          else if (isWall) setVoxel(bx + x, by + y, bz + z, BLOCK.CONCRETE);
        }
      }
    }
  } else if (stampType === 'building_mid') {
    // 中規模ビル (5階)
    for (let x = 0; x < 14; x++) {
      for (let z = 0; z < 14; z++) {
        for (let y = 0; y < 16; y++) {
          const isWall = (x === 0 || x === 13 || z === 0 || z === 13);
          const isFloor = (y % 4 === 0 || y === 15);
          const isWindow = (isWall && (y % 4 === 2) && (x % 2 === 0 || z % 2 === 0));

          if (isFloor) setVoxel(bx + x, by + y, bz + z, BLOCK.CONCRETE);
          else if (isWindow) setVoxel(bx + x, by + y, bz + z, BLOCK.GLASS);
          else if (isWall) setVoxel(bx + x, by + y, bz + z, BLOCK.CONCRETE);
        }
      }
    }
  } else if (stampType === 'building_tall') {
    // 高層ビル (12階)
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        for (let y = 0; y < 30; y++) {
          const isWall = (x === 0 || x === 15 || z === 0 || z === 15);
          const isFloor = (y % 4 === 0 || y === 29);
          const isGlassWall = (isWall && y > 2 && (x > 2 && x < 13 && z > 2 && z < 13));

          if (isFloor) setVoxel(bx + x, by + y, bz + z, BLOCK.CONCRETE);
          else if (isGlassWall) setVoxel(bx + x, by + y, bz + z, BLOCK.GLASS);
          else if (isWall) setVoxel(bx + x, by + y, bz + z, BLOCK.CONCRETE);
        }
      }
    }
  } else if (stampType === 'shelter_tower') {
    // 津波・高所避難タワー (頑強な柱と最上階避難所)
    for (let x = 0; x < 12; x++) {
      for (let z = 0; z < 12; z++) {
        const isPillar = (
          (x <= 1 || x >= 10) && (z <= 1 || z >= 10) || 
          (x >= 5 && x <= 6 && z >= 5 && z <= 6)
        );
        for (let y = 0; y < 24; y++) {
          if (y === 0 || y === 12 || y === 23) {
            setVoxel(bx + x, by + y, bz + z, BLOCK.CONCRETE);
            if (y === 23 && (x === 0 || x === 11 || z === 0 || z === 11)) {
              setVoxel(bx + x, by + y + 1, bz + z, BLOCK.CONCRETE); // 手すり
            }
          } else if (isPillar) {
            setVoxel(bx + x, by + y, bz + z, BLOCK.CONCRETE);
          }
        }
      }
    }
    // 最上階中央に避難所ブロックを設置
    setVoxel(bx + 6, by + 24, bz + 6, BLOCK.SHELTER);
    shelters.push({
      id: `shelter-${Date.now()}`,
      name: `津波避難タワー #${shelters.length + 1}`,
      gridX: bx + 6,
      gridY: by + 24,
      gridZ: bz + 6,
      notes: `標高 ${((by + 24) * VOXEL_SIZE).toFixed(1)}m`
    });
  } else if (stampType === 'bridge') {
    for (let x = 0; x < 20; x++) {
      for (let z = 0; z < 8; z++) {
        setVoxel(bx + x, by, bz + z, BLOCK.WOOD);
        if (z === 0 || z === 7) setVoxel(bx + x, by + 1, bz + z, BLOCK.WOOD);
      }
    }
  } else if (stampType === 'stairs') {
    for (let i = 0; i < 12; i++) {
      for (let z = 0; z < 6; z++) {
        for (let y = 0; y <= i; y++) {
          setVoxel(bx + i, by + y, bz + z, BLOCK.ASPHALT);
        }
      }
    }
  } else if (stampType === 'park') {
    // 街角の小さな緑地・公園・ベンチ
    for (let x = 0; x < 12; x++) {
      for (let z = 0; z < 12; z++) {
        setVoxel(bx + x, by, bz + z, BLOCK.GRASS);
      }
    }
    // 樹木
    setVoxel(bx + 3, by + 1, bz + 3, BLOCK.WOOD);
    setVoxel(bx + 3, by + 2, bz + 3, BLOCK.WOOD);
    setVoxel(bx + 3, by + 3, bz + 3, BLOCK.GRASS);
    setVoxel(bx + 8, by + 1, bz + 8, BLOCK.WOOD);
    setVoxel(bx + 8, by + 2, bz + 8, BLOCK.WOOD);
    setVoxel(bx + 8, by + 3, bz + 8, BLOCK.GRASS);
    // ベンチ
    setVoxel(bx + 6, by + 1, bz + 5, BLOCK.WOOD);
    setVoxel(bx + 6, by + 1, bz + 6, BLOCK.WOOD);
  }

  refreshEditorVoxelScene();
}

function updateWorldEditUI() {
  const info = document.getElementById('we-selection-info');
  if (info) {
    if (wePos1 && wePos2) {
      const count = (Math.abs(wePos1.x - wePos2.x) + 1) * (Math.abs(wePos1.y - wePos2.y) + 1) * (Math.abs(wePos1.z - wePos2.z) + 1);
      info.innerText = `Pos1: [${wePos1.x},${wePos1.y},${wePos1.z}] - Pos2: [${wePos2.x},${wePos2.y},${wePos2.z}] (${count.toLocaleString()}ブロック)`;
    } else if (wePos1) {
      info.innerText = `Pos1: [${wePos1.x},${wePos1.y},${wePos1.z}] - Pos2未設定`;
    } else {
      info.innerText = 'Pos1, Pos2 を指定してください';
    }
  }
}

function updateEditorFly(dt: number) {
  if (isInventoryOpen) return;

  let moveX = 0;
  let moveZ = 0;
  let moveY = 0;

  if (editorKeys.w) moveZ -= 1;
  if (editorKeys.s) moveZ += 1;
  if (editorKeys.a) moveX -= 1;
  if (editorKeys.d) moveX += 1;
  if (editorKeys.up) moveY += 1;
  if (editorKeys.down) moveY -= 1;

  if (editorJoystick.active) {
    moveX = editorJoystick.dx;
    moveZ = editorJoystick.dy;
  }

  const dir = new THREE.Vector3(moveX, 0, moveZ);
  if (dir.lengthSq() > 0.001) {
    dir.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), editorFly.yaw);
    editorFly.pos.x += dir.x * editorFly.speed * dt;
    editorFly.pos.z += dir.z * editorFly.speed * dt;
  }
  editorFly.pos.y += moveY * editorFly.speed * dt;

  editorCamera.position.copy(editorFly.pos);
  const lookDir = new THREE.Vector3(0, 0, -1);
  lookDir.applyAxisAngle(new THREE.Vector3(1, 0, 0), editorFly.pitch);
  lookDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), editorFly.yaw);
  editorCamera.lookAt(editorFly.pos.clone().add(lookDir));

  updateEditorRaycast();
}

// ==========================================
//        全体UIイベント & コントローラー
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  initGameThree();
  initEditorThree();
  setupEventListeners();

  function mainLoop() {
    requestAnimationFrame(mainLoop);
    if (isPlaying) {
      const dt = gameClock.getDelta();
      updateGamePhysics(dt);
      updateGameUI();
      gameRenderer.render(gameScene, gameCamera);
    } else if (isEditorActive) {
      const dt = editorClock.getDelta();
      updateEditorFly(dt);
      editorRenderer.render(editorScene, editorCamera);
    }
  }
  mainLoop();
});

function setupEventListeners() {
  const screenStart = document.getElementById('screen-start')!;
  const screenGame = document.getElementById('screen-game')!;
  const screenEditor = document.getElementById('screen-editor')!;
  const screenResult = document.getElementById('screen-result')!;
  const screenAdmin = document.getElementById('screen-admin')!;

  const startForm = document.getElementById('start-form') as HTMLFormElement;
  const btnGotoEditor = document.getElementById('btn-goto-editor')!;
  const btnGotoAdmin = document.getElementById('btn-goto-admin')!;
  const btnEditorSave = document.getElementById('btn-editor-save')!;
  const btnAdminClose = document.getElementById('btn-admin-close')!;
  const btnResultRestart = document.getElementById('btn-result-restart')!;
  const btnEvacuate = document.getElementById('btn-evacuate') as HTMLButtonElement;

  startForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = (document.getElementById('input-name') as HTMLInputElement).value;
    const age = (document.getElementById('input-age') as HTMLSelectElement).value;
    const mapType = (document.getElementById('select-map') as HTMLSelectElement).value;
    const hasHazard = (document.getElementById('input-hazard') as HTMLInputElement).checked;

    currentSession = {
      id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2),
      created_at: new Date().toISOString(),
      name,
      age_group: age,
      has_hazard_map: hasHazard,
      max_water_depth: maxWaterLevel,
      selected_destination: '',
      status: 'playing',
      duration: 0
    };

    screenStart.classList.add('hidden');
    screenGame.classList.remove('hidden');
    window.dispatchEvent(new Event('resize'));

    await startSimulationMode(mapType);
    startTimerIntervals();
  });

  btnGotoEditor.addEventListener('click', () => {
    screenStart.classList.add('hidden');
    screenEditor.classList.remove('hidden');
    window.dispatchEvent(new Event('resize'));
    openEditor();
  });

  // 保存して戻る
  btnEditorSave.addEventListener('click', async () => {
    if (document.exitPointerLock) document.exitPointerLock();
    toggleInventory(false);
    await saveMapData(false);
    isEditorActive = false;
    screenEditor.classList.add('hidden');
    screenStart.classList.remove('hidden');
    (document.getElementById('select-map') as HTMLSelectElement).value = 'custom';
  });

  // 標準マップをエディターにロード
  const btnLoadDefault = document.getElementById('btn-load-default')!;
  btnLoadDefault.addEventListener('click', async () => {
    if (!confirm('現在のマップを破棄して標準マップ（広島・深川）をロードしますか？\n※ 現在のマップは保存されていなければ失われます。')) return;
    if (document.exitPointerLock) document.exitPointerLock();
    toggleInventory(false);
    await loadMapData(false); // false = 標準マップ (buildDefaultMap)
    refreshEditorVoxelScene();
    alert('標準マップをロードしました。編集して保存してください。');
  });

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

  btnEvacuate.addEventListener('click', () => {
    const s = getNearbyShelter();
    if (s) endSimulation('evacuated', s);
  });

  setupInventoryModal();

  const btnModePlace = document.getElementById('btn-mode-place')!;
  const btnModeBreak = document.getElementById('btn-mode-break')!;
  btnModePlace.addEventListener('click', () => {
    editorMode = 'place';
    btnModePlace.className = 'px-2.5 py-1 rounded bg-cyan-600 text-white font-bold text-xs';
    btnModeBreak.className = 'px-2.5 py-1 rounded text-slate-400 font-bold text-xs hover:text-white';
  });
  btnModeBreak.addEventListener('click', () => {
    editorMode = 'break';
    btnModeBreak.className = 'px-2.5 py-1 rounded bg-red-600 text-white font-bold text-xs';
    btnModePlace.className = 'px-2.5 py-1 rounded text-slate-400 font-bold text-xs hover:text-white';
  });

  const paletteButtons = document.querySelectorAll('.palette-block');
  paletteButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      paletteButtons.forEach(b => b.classList.remove('active', 'border-cyan-400', 'border-2'));
      btn.classList.add('active', 'border-cyan-400', 'border-2');
      currentBrushBlock = Number(btn.getAttribute('data-block')) as BlockType;

      const label = document.getElementById('editor-current-block-label');
      if (label && BLOCK_CONFIGS[currentBrushBlock]) {
        label.innerText = BLOCK_CONFIGS[currentBrushBlock].name;
      }
    });
  });

  setupShelterModal();

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    
    if (isEditorActive && (k === 'e' || e.code === 'KeyE')) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      e.preventDefault();
      toggleInventory();
      return;
    }

    if (isPlaying) {
      if (k === 'w' || k === 'arrowup') gameKeys.w = true;
      if (k === 's' || k === 'arrowdown') gameKeys.s = true;
      if (k === 'a' || k === 'arrowleft') gameKeys.a = true;
      if (k === 'd' || k === 'arrowright') gameKeys.d = true;
    } else if (isEditorActive && !isInventoryOpen) {
      if (k === 'w') editorKeys.w = true;
      if (k === 's') editorKeys.s = true;
      if (k === 'a') editorKeys.a = true;
      if (k === 'd') editorKeys.d = true;
      if (k === ' ') editorKeys.up = true;
      if (k === 'shift' || k === 'q') editorKeys.down = true;
    }
  });

  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (isPlaying) {
      if (k === 'w' || k === 'arrowup') gameKeys.w = false;
      if (k === 's' || k === 'arrowdown') gameKeys.s = false;
      if (k === 'a' || k === 'arrowleft') gameKeys.a = false;
      if (k === 'd' || k === 'arrowright') gameKeys.d = false;
    } else if (isEditorActive) {
      if (k === 'w') editorKeys.w = false;
      if (k === 's') editorKeys.s = false;
      if (k === 'a') editorKeys.a = false;
      if (k === 'd') editorKeys.d = false;
      if (k === ' ') editorKeys.up = false;
      if (k === 'shift' || k === 'q') editorKeys.down = false;
    }
  });

  setupJoystick('game-joystick-zone', 'game-joystick-handle', (dx, dy, active) => {
    gameJoystick.active = active;
    gameJoystick.dx = dx;
    gameJoystick.dy = dy;
  });

  // シミュレーション時の三人称視点ドラッグ操作 (マウス & タッチ)
  const gameContainer = document.getElementById('game-canvas-container')!;
  gameContainer.addEventListener('mousedown', (e: MouseEvent) => {
    if (!isPlaying) return;
    isGameDragging = true;
    gameDragStartX = e.clientX;
    gameDragStartY = e.clientY;
  });

  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (!isPlaying || !isGameDragging) return;
    const dx = e.clientX - gameDragStartX;
    const dy = e.clientY - gameDragStartY;
    gameDragStartX = e.clientX;
    gameDragStartY = e.clientY;

    gameCamYaw -= dx * 0.006;
    gameCamPitch = Math.max(0.05, Math.min(1.4, gameCamPitch + dy * 0.005));
  });

  window.addEventListener('mouseup', () => {
    isGameDragging = false;
  });

  // タッチスワイプによる視点回転（ジョイスティック領域を除外）
  let gameTouchCamId: number | null = null;
  let gameTouchStartX = 0;
  let gameTouchStartY = 0;

  gameContainer.addEventListener('touchstart', (e: TouchEvent) => {
    if (!isPlaying) return;
    const touch = e.changedTouches[0];
    // ジョイスティック領域で始まったタッチは視点操作にしない
    const joystickZone = document.getElementById('game-joystick-zone');
    if (joystickZone) {
      const rect = joystickZone.getBoundingClientRect();
      if (touch.clientX >= rect.left && touch.clientX <= rect.right &&
          touch.clientY >= rect.top && touch.clientY <= rect.bottom) {
        return; // ジョイスティック領域なのでスキップ
      }
    }
    // 避難ボタン領域も除外
    const btnEvac = document.getElementById('btn-evacuate');
    if (btnEvac) {
      const rect = btnEvac.getBoundingClientRect();
      if (touch.clientX >= rect.left && touch.clientX <= rect.right &&
          touch.clientY >= rect.top && touch.clientY <= rect.bottom) {
        return;
      }
    }
    gameTouchCamId = touch.identifier;
    gameTouchStartX = touch.clientX;
    gameTouchStartY = touch.clientY;
  }, { passive: true });

  window.addEventListener('touchmove', (e: TouchEvent) => {
    if (!isPlaying || gameTouchCamId === null) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t.identifier === gameTouchCamId) {
        const dx = t.clientX - gameTouchStartX;
        const dy = t.clientY - gameTouchStartY;
        gameTouchStartX = t.clientX;
        gameTouchStartY = t.clientY;

        gameCamYaw -= dx * 0.007;
        gameCamPitch = Math.max(0.05, Math.min(1.4, gameCamPitch + dy * 0.006));
      }
    }
  }, { passive: true });

  const endTouchCam = (e: TouchEvent) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === gameTouchCamId) {
        gameTouchCamId = null;
      }
    }
  };
  window.addEventListener('touchend', endTouchCam);
  window.addEventListener('touchcancel', endTouchCam);

  setupJoystick('editor-joystick-zone', 'editor-joystick-handle', (dx, dy, active) => {
    editorJoystick.active = active;
    editorJoystick.dx = dx;
    editorJoystick.dy = dy;
  });

  const btnFlyUp = document.getElementById('btn-fly-up')!;
  const btnFlyDown = document.getElementById('btn-fly-down')!;
  const btnTouchAction = document.getElementById('btn-touch-action')!;

  btnFlyUp.addEventListener('touchstart', (e) => { e.preventDefault(); editorKeys.up = true; });
  btnFlyUp.addEventListener('touchend', () => editorKeys.up = false);
  btnFlyDown.addEventListener('touchstart', (e) => { e.preventDefault(); editorKeys.down = true; });
  btnFlyDown.addEventListener('touchend', () => editorKeys.down = false);
  btnTouchAction.addEventListener('click', () => {
    if (editorTool === 'hill') {
      if (targetVoxelPos && targetVoxelPos.inReach) applyHillBrush(targetVoxelPos.x, targetVoxelPos.z, hillBrushHeight);
    } else if (editorTool === 'stamp') {
      if (targetVoxelPos && targetVoxelPos.inReach) applyStampAtTarget(currentStampType);
    } else {
      executeEditorAction(editorMode);
    }
  });
}

function setupInventoryModal() {
  const btnOpen = document.getElementById('btn-open-inventory')!;
  const btnClose = document.getElementById('btn-close-inventory')!;
  const btnConfirm = document.getElementById('btn-inventory-confirm')!;
  
  btnOpen.addEventListener('click', () => toggleInventory(true));
  btnClose.addEventListener('click', () => toggleInventory(false));
  btnConfirm.addEventListener('click', () => toggleInventory(false));

  const invBlockBtns = document.querySelectorAll('.inv-block-btn');
  invBlockBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      invBlockBtns.forEach(b => b.classList.remove('border-cyan-400', 'bg-slate-700'));
      btn.classList.add('border-cyan-400', 'bg-slate-700');
      currentBrushBlock = Number(btn.getAttribute('data-block')) as BlockType;

      const label = document.getElementById('editor-current-block-label');
      if (label && BLOCK_CONFIGS[currentBrushBlock]) {
        label.innerText = BLOCK_CONFIGS[currentBrushBlock].name;
      }
    });
  });

  const toolSingle = document.getElementById('inv-tool-single')!;
  const toolHill = document.getElementById('inv-tool-hill')!;
  const toolBox = document.getElementById('inv-tool-box')!;
  const toolStamp = document.getElementById('inv-tool-stamp')!;
  const hillSettings = document.getElementById('inv-hill-settings')!;
  const boxSettings = document.getElementById('inv-box-settings')!;
  const stampSettings = document.getElementById('inv-stamp-settings')!;
  const modeLabel = document.getElementById('editor-mode-label')!;

  function resetInvTools() {
    [toolSingle, toolHill, toolBox, toolStamp].forEach(b => {
      b.className = 'p-2.5 rounded-xl border bg-slate-800 border-slate-700 hover:border-slate-500 text-slate-200 font-bold text-xs flex flex-col items-center justify-center';
    });
    hillSettings.classList.add('hidden');
    boxSettings.classList.add('hidden');
    stampSettings.classList.add('hidden');
  }

  toolSingle.addEventListener('click', () => {
    resetInvTools();
    editorTool = 'single';
    toolSingle.className = 'p-2.5 rounded-xl border bg-emerald-700 border-emerald-500 text-white font-bold text-xs flex flex-col items-center justify-center';
    modeLabel.innerText = 'モード: 単体設置/破壊';
  });

  toolHill.addEventListener('click', () => {
    resetInvTools();
    editorTool = 'hill';
    toolHill.className = 'p-2.5 rounded-xl border bg-emerald-700 border-emerald-500 text-white font-bold text-xs flex flex-col items-center justify-center';
    hillSettings.classList.remove('hidden');
    modeLabel.innerText = 'モード: 丘陵ブラシ (左クリックで盛る/右クリックで削る)';
  });

  toolBox.addEventListener('click', () => {
    resetInvTools();
    editorTool = 'box';
    toolBox.className = 'p-2.5 rounded-xl border bg-emerald-700 border-emerald-500 text-white font-bold text-xs flex flex-col items-center justify-center';
    boxSettings.classList.remove('hidden');
    modeLabel.innerText = 'モード: 範囲 (WorldEdit)';
    updateWorldEditUI();
  });

  toolStamp.addEventListener('click', () => {
    resetInvTools();
    editorTool = 'stamp';
    toolStamp.className = 'p-2.5 rounded-xl border bg-amber-700 border-amber-500 text-white font-bold text-xs flex flex-col items-center justify-center';
    stampSettings.classList.remove('hidden');
    modeLabel.innerText = 'モード: 建築スタンプ配置';
  });

  // WorldEdit ボタン
  document.getElementById('inv-we-pos1')?.addEventListener('click', () => {
    toggleInventory(false);
    weSelectingPos = 1;
    alert('画面中央のクロスヘアを合わせてブロックをクリックし、Pos1 を設定してください');
  });

  document.getElementById('inv-we-pos2')?.addEventListener('click', () => {
    toggleInventory(false);
    weSelectingPos = 2;
    alert('画面中央のクロスヘアを合わせてブロックをクリックし、Pos2 を設定してください');
  });

  document.getElementById('inv-we-fill')?.addEventListener('click', () => applyWorldEditFill(currentBrushBlock));
  document.getElementById('inv-we-clear')?.addEventListener('click', () => applyWorldEditFill(BLOCK.AIR));

  // 丘陵設定
  document.getElementById('inv-hill-radius')!.addEventListener('change', (e) => {
    hillBrushRadius = Number((e.target as HTMLSelectElement).value);
  });
  document.getElementById('inv-hill-height')!.addEventListener('change', (e) => {
    hillBrushHeight = Number((e.target as HTMLSelectElement).value);
  });

  // スタンプ設定
  const stampItems = document.querySelectorAll('.inv-stamp-item');
  stampItems.forEach(item => {
    item.addEventListener('click', () => {
      stampItems.forEach(i => i.className = 'inv-stamp-item bg-slate-800 text-slate-300 p-2 rounded border border-slate-700');
      item.className = 'inv-stamp-item bg-amber-800 text-white font-bold p-2 rounded border border-amber-600';
      currentStampType = item.getAttribute('data-stamp') || 'house';
    });
  });

  // インベントリ内マネージメント
  document.getElementById('inv-btn-shelters')!.addEventListener('click', () => {
    toggleInventory(false);
    const modal = document.getElementById('modal-shelters')!;
    setupShelterModal();
    modal.classList.remove('hidden');
  });

  document.getElementById('inv-btn-cloud')!.addEventListener('click', async () => {
    await saveMapData(true);
  });

  document.getElementById('inv-btn-clear')!.addEventListener('click', () => {
    if (confirm('マップを平坦な草地に初期化しますか？')) {
      voxelMap.fill(BLOCK.AIR);
      for (let x = 0; x < MAP_GRID_X; x++) {
        for (let z = 0; z < MAP_GRID_Z; z++) {
          setVoxel(x, 0, z, BLOCK.STONE);
          setVoxel(x, 1, z, BLOCK.DIRT);
          setVoxel(x, 2, z, BLOCK.GRASS);
        }
      }
      shelters = [];
      spawnPoint = { gridX: 150, gridY: 3, gridZ: 150 };
      setVoxel(spawnPoint.gridX, spawnPoint.gridY, spawnPoint.gridZ, BLOCK.SPAWN);
      refreshEditorVoxelScene();
      toggleInventory(false);
    }
  });
}

function setupJoystick(zoneId: string, handleId: string, onUpdate: (dx: number, dy: number, active: boolean) => void) {
  const zone = document.getElementById(zoneId);
  const handle = document.getElementById(handleId);
  if (!zone || !handle) return;

  let touchId: number | null = null;
  let startX = 0;
  let startY = 0;

  zone.addEventListener('touchstart', (e: TouchEvent) => {
    const touch = e.touches[0];
    touchId = touch.identifier;
    const rect = zone.getBoundingClientRect();
    startX = rect.left + rect.width / 2;
    startY = rect.top + rect.height / 2;
    update(touch.clientX, touch.clientY);
  });

  window.addEventListener('touchmove', (e: TouchEvent) => {
    if (touchId === null) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === touchId) {
        update(e.changedTouches[i].clientX, e.changedTouches[i].clientY);
      }
    }
  }, { passive: false });

  const endHandler = (e: TouchEvent) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === touchId) {
        touchId = null;
        handle.style.transform = 'translate(0px, 0px)';
        onUpdate(0, 0, false);
      }
    }
  };
  window.addEventListener('touchend', endHandler);
  window.addEventListener('touchcancel', endHandler);

  function update(cx: number, cy: number) {
    const dx = cx - startX;
    const dy = cy - startY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const maxDist = 45;

    let nx = dx;
    let ny = dy;
    if (dist > maxDist) {
      nx = (dx / dist) * maxDist;
      ny = (dy / dist) * maxDist;
    }

    handle!.style.transform = `translate(${nx}px, ${ny}px)`;
    onUpdate(nx / maxDist, ny / maxDist, true);
  }
}

function setupShelterModal() {
  const modal = document.getElementById('modal-shelters')!;
  const btnClose = document.getElementById('btn-close-shelter-modal')!;
  const btnSave = document.getElementById('btn-save-shelters')!;
  const list = document.getElementById('shelter-list')!;

  btnClose.addEventListener('click', () => modal.classList.add('hidden'));

  btnSave.addEventListener('click', () => {
    const inputs = list.querySelectorAll('.shelter-name-input') as NodeListOf<HTMLInputElement>;
    inputs.forEach(inp => {
      const id = inp.getAttribute('data-id');
      const s = shelters.find(item => item.id === id);
      if (s) s.name = inp.value;
    });
    modal.classList.add('hidden');
  });

  renderShelterList();

  function renderShelterList() {
    list.innerHTML = '';
    if (shelters.length === 0) {
      list.innerHTML = '<p class="text-xs text-slate-500 py-4 text-center">設置された避難所がありません。<br>エディタで避難所ブロックを配置してください。</p>';
      return;
    }

    shelters.forEach((s, idx) => {
      const elev = (s.gridY * VOXEL_SIZE).toFixed(1);
      const row = document.createElement('div');
      row.className = 'bg-slate-800 p-3 rounded-xl border border-slate-700 flex flex-col space-y-2';
      row.innerHTML = `
        <div class="flex justify-between items-center text-xs">
          <span class="font-bold text-cyan-300">避難所 #${idx + 1} (標高: ${elev}m)</span>
          <button data-id="${s.id}" class="btn-delete-shelter text-rose-400 hover:text-rose-300 text-xs">削除</button>
        </div>
        <input type="text" value="${s.name}" data-id="${s.id}" 
          class="shelter-name-input w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-white" />
        <div class="text-[10px] text-slate-400">位置: [X: ${s.gridX}, Y: ${s.gridY}, Z: ${s.gridZ}]</div>
      `;

      row.querySelector('.btn-delete-shelter')?.addEventListener('click', () => {
        setVoxel(s.gridX, s.gridY, s.gridZ, BLOCK.AIR);
        shelters = shelters.filter(item => item.id !== s.id);
        renderShelterList();
        refreshEditorVoxelScene();
      });

      list.appendChild(row);
    });
  }
}

function updateGameUI() {
  const heightDisp = document.getElementById('height-display')!;
  const locDisp = document.getElementById('location-display')!;
  const btnEvacuate = document.getElementById('btn-evacuate') as HTMLButtonElement;

  heightDisp.innerText = `標高: ${(player.pos.y).toFixed(1)}m`;

  const s = getNearbyShelter();
  if (s) {
    locDisp.innerText = s.name;
    locDisp.className = 'text-xs md:text-sm font-bold text-cyan-400 animate-pulse';
    btnEvacuate.disabled = false;
    btnEvacuate.innerText = `ここに避難する (${s.name})`;
    btnEvacuate.className = 'bg-cyan-600 hover:bg-cyan-500 active:scale-95 text-white font-black px-5 py-3 md:px-6 md:py-3.5 rounded-xl text-sm md:text-base shadow-2xl transition select-none cursor-pointer';
  } else {
    locDisp.innerText = '市街地';
    locDisp.className = 'text-xs md:text-sm font-bold text-slate-200';
    btnEvacuate.disabled = true;
    btnEvacuate.innerText = 'ここに避難する (確定)';
    btnEvacuate.className = 'bg-slate-800 text-slate-500 font-black px-5 py-3 md:px-6 md:py-3.5 rounded-xl text-sm md:text-base shadow-2xl cursor-not-allowed transition select-none';
  }

  const warningTicker = document.getElementById('warning-ticker')!;
  if (gameTime >= WATER_START_SEC && gameTime < WATER_START_SEC + 15) {
    warningTicker.classList.remove('hidden');
  } else {
    warningTicker.classList.add('hidden');
  }
}

let timerInterval: any = null;
let logInterval: any = null;

function startTimerIntervals() {
  clearInterval(timerInterval);
  clearInterval(logInterval);

  timerInterval = setInterval(() => {
    gameTime++;
    const remain = Math.max(0, MAX_GAME_TIME - gameTime);
    const m = Math.floor(remain / 60).toString().padStart(2, '0');
    const s = (remain % 60).toString().padStart(2, '0');
    document.getElementById('timer-display')!.innerText = `${m}:${s}`;

    const waterInfo = document.getElementById('water-info')!;
    if (gameTime < WATER_START_SEC) {
      waterInfo.innerText = `浸水開始まで ${WATER_START_SEC - gameTime} 秒`;
      waterInfo.className = 'text-[11px] text-yellow-400 font-bold mt-0.5';
    } else {
      waterInfo.innerText = `現在水位: ${waterLevel.toFixed(2)}m (上昇中)`;
      waterInfo.className = 'text-[11px] text-red-500 font-bold mt-0.5 animate-pulse';
    }

    if (gameTime >= MAX_GAME_TIME) {
      endSimulation('timeout');
    }
  }, 1000);

  logInterval = setInterval(() => {
    trajectoryData.push({
      step_second: gameTime,
      pos_x: Number(player.pos.x.toFixed(2)),
      pos_y: Number(player.pos.y.toFixed(2)),
      pos_z: Number(player.pos.z.toFixed(2)),
      water_level: Number(waterLevel.toFixed(2))
    });
  }, 1000);
}

async function endSimulation(reason: 'evacuated' | 'drowned' | 'timeout', shelter: ShelterInfo | null = null) {
  isPlaying = false;
  clearInterval(timerInterval);
  clearInterval(logInterval);

  let status = 'survived';
  let title = '避難完了 (安全)';
  let desc = '';
  const finalElevation = player.pos.y;
  const PEAK_WATER_LEVEL = maxWaterLevel;
  let inundationDepth = 0;

  const badgeElem = document.getElementById('result-badge')!;

  if (reason === 'evacuated' && shelter) {
    currentSession.selected_destination = shelter.name;
    const shelterY = shelter.gridY * VOXEL_SIZE;
    inundationDepth = Math.max(0, Number((PEAK_WATER_LEVEL - shelterY).toFixed(2)));

    // 到達時間に関係なく、この避難所がピーク時に水没するかで最終安全性を判定
    if (shelterY >= PEAK_WATER_LEVEL + 0.5) {
      // 想定最高水位より高く完全安全 (北山展望公園・高層ビル屋上など)
      status = 'survived';
      title = '避難成功 (完全安全・高台)';
      badgeElem.innerText = '[ 避難成功 ]';
      badgeElem.className = 'inline-block px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider mb-3 bg-emerald-950 border border-emerald-600 text-emerald-400';
      desc = `【避難成功】標高の高い「${shelter.name}」（標高${shelterY.toFixed(1)}m）に到達しました。想定最高水位（${PEAK_WATER_LEVEL.toFixed(1)}m）を上回っており、浸水深0mで安全を完全に確保できました。`;
    } else if (shelterY >= PEAK_WATER_LEVEL - 0.5) {
      // わずかな浸水（足元〜床上浸水程度）
      status = 'survived';
      title = '避難完了 (軽微な浸水)';
      badgeElem.innerText = '[ 軽微な浸水 ]';
      badgeElem.className = 'inline-block px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider mb-3 bg-yellow-950 border border-yellow-600 text-yellow-400';
      desc = `【避難完了】「${shelter.name}」（標高${shelterY.toFixed(1)}m）に避難しました。想定最高水位（${PEAK_WATER_LEVEL.toFixed(1)}m）により最大約${inundationDepth.toFixed(1)}mの浸水が想定されます。より高所・垂直避難も検討してください。`;
    } else {
      // 低地避難所（標高が低く、後に水没する）
      status = 'drowned';
      title = '避難失敗 (避難所が水没)';
      badgeElem.innerText = '[ 避難失敗 ]';
      badgeElem.className = 'inline-block px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider mb-3 bg-rose-950 border border-rose-600 text-rose-400';
      desc = `【避難失敗】「${shelter.name}」（標高${shelterY.toFixed(1)}m）に早期到達しましたが、この避難所は低地にあるため、その後の増水で想定最高水位（${PEAK_WATER_LEVEL.toFixed(1)}m）に達した際に約${inundationDepth.toFixed(1)}m水没してしまいます。ハザードマップで標高を確認し、高台や高層階へ避難する必要があります。`;
    }
  } else if (reason === 'drowned') {
    status = 'drowned';
    title = '避難失敗 (水没・溺死)';
    badgeElem.innerText = '[ 避難失敗 ]';
    badgeElem.className = 'inline-block px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider mb-3 bg-rose-950 border border-rose-600 text-rose-400';
    desc = '【避難失敗】避難途中に水位の上昇に追いつかれ、水没してしまいました。水害が発生したら、より迅速に高台へ逃げる必要があります。';
  } else {
    status = 'timeout';
    title = 'タイムアップ (時間切れ)';
    badgeElem.innerText = '[ タイムアップ ]';
    badgeElem.className = 'inline-block px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider mb-3 bg-slate-800 border border-slate-600 text-slate-300';
    desc = '【時間切れ】避難所へ逃げ込めないまま5分が経過してしまいました。早めの避難判断が重要です。';
  }

  currentSession.status = status;
  currentSession.duration = gameTime;

  document.getElementById('screen-game')!.classList.add('hidden');
  document.getElementById('screen-result')!.classList.remove('hidden');

  const titleElem = document.getElementById('result-title')!;
  titleElem.innerText = title;
  titleElem.className = status === 'survived' ? 'text-2xl md:text-3xl font-black mb-2 text-emerald-400' : 'text-2xl md:text-3xl font-black mb-2 text-rose-400';
  document.getElementById('result-desc')!.innerText = desc;

  document.getElementById('res-name')!.innerText = currentSession.name;
  document.getElementById('res-dest')!.innerText = currentSession.selected_destination || '未避難';
  document.getElementById('res-elev')!.innerText = `${finalElevation.toFixed(1)}m`;
  document.getElementById('res-water')!.innerText = `${PEAK_WATER_LEVEL.toFixed(1)}m (現${waterLevel.toFixed(1)}m)`;
  const inundationElem = document.getElementById('res-inundation');
  if (inundationElem) {
    inundationElem.innerText = `${inundationDepth.toFixed(1)}m`;
    inundationElem.className = inundationDepth > 0.5 ? 'font-bold text-rose-400' : (inundationDepth > 0 ? 'font-bold text-yellow-400' : 'font-bold text-emerald-400');
  }
  document.getElementById('res-time')!.innerText = `${Math.floor(gameTime / 60)}分 ${gameTime % 60}秒`;
  document.getElementById('res-status')!.innerText = status === 'survived' ? '生存' : '失敗';

  await saveSessionData(currentSession, trajectoryData);
}

async function saveSessionData(session: any, trajectories: any[]) {
  console.log(`[saveSessionData] セッション: ${session.id}, 名前: ${session.name}, 状態: ${session.status}, 軌跡数: ${trajectories.length}`);

  const sessions = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '[]');
  sessions.push(session);
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(sessions));

  const allTraj = JSON.parse(localStorage.getItem(LOCAL_TRAJECTORY_KEY) || '{}');
  allTraj[session.id] = trajectories;
  localStorage.setItem(LOCAL_TRAJECTORY_KEY, JSON.stringify(allTraj));
  console.log('[saveSessionData] ローカルストレージに保存完了');

  if (supabase) {
    try {
      const { error: sessionError } = await supabase.from('sessions').insert({
        id: session.id,
        created_at: session.created_at,
        name: session.name,
        age_group: session.age_group,
        has_hazard_map: session.has_hazard_map,
        selected_destination: session.selected_destination,
        status: session.status,
        duration: session.duration
      });
      if (sessionError) console.warn('[saveSessionData] Supabaseセッション保存エラー:', sessionError);

      const formatted = trajectories.map(t => ({
        session_id: session.id,
        step_second: t.step_second,
        pos_x: t.pos_x,
        pos_z: t.pos_z,
        pos_y: t.pos_y,
        water_level: t.water_level
      }));

      for (let i = 0; i < formatted.length; i += 100) {
        const { error: trajError } = await supabase.from('trajectories').insert(formatted.slice(i, i + 100));
        if (trajError) console.warn('[saveSessionData] Supabase軌跡保存エラー:', trajError);
      }
      console.log('[saveSessionData] Supabaseにセッション+軌跡保存成功');
    } catch (e) {
      console.error('[saveSessionData] Supabase保存失敗:', e);
    }
  } else {
    console.log('[saveSessionData] Supabase未設定 - ローカルのみ');
  }
}

// ==========================================
//        管理者ダッシュボード & 軌跡
// ==========================================
let allSessions: any[] = [];
let selectedSessionIds = new Set<string>();

async function loadAdminSessions() {
  if (supabase) {
    try {
      const { data } = await supabase.from('sessions').select('*').order('created_at', { ascending: false });
      allSessions = data || [];
    } catch {
      allSessions = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '[]');
    }
  } else {
    allSessions = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '[]');
  }

  renderAdminList();
  drawTrajectories();
}

function renderAdminList() {
  const container = document.getElementById('session-list')!;
  container.innerHTML = '';

  const filterVal = (document.getElementById('filter-hazard') as HTMLSelectElement)?.value || 'all';
  let filtered = allSessions;
  if (filterVal === 'map-yes') filtered = allSessions.filter(s => s.has_hazard_map);
  if (filterVal === 'map-no') filtered = allSessions.filter(s => !s.has_hazard_map);

  if (filtered.length === 0) {
    container.innerHTML = '<p class="text-slate-500 text-center py-4">データがありません</p>';
    return;
  }

  filtered.forEach(s => {
    const isSelected = selectedSessionIds.has(s.id);
    const date = new Date(s.created_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const card = document.createElement('div');
    card.className = `p-2.5 rounded-lg border cursor-pointer transition ${
      isSelected ? 'bg-cyan-950 border-cyan-500 text-white' : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700'
    }`;

    card.innerHTML = `
      <div class="flex justify-between items-center font-bold text-xs">
        <span>${s.name || '被験者'}</span>
        <span class="text-[10px] text-slate-500">${date}</span>
      </div>
      <div class="text-[10px] text-slate-400 mt-1">避難先: ${s.selected_destination || '未避難'}</div>
      <div class="flex justify-between text-[10px] mt-1">
        <span>${s.has_hazard_map ? 'マップ確認済' : '未確認'}</span>
        <span class="${s.status === 'survived' ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}">${s.status === 'survived' ? '生存' : '失敗'}</span>
      </div>
    `;

    card.addEventListener('click', () => {
      if (selectedSessionIds.has(s.id)) selectedSessionIds.delete(s.id);
      else selectedSessionIds.add(s.id);
      renderAdminList();
      drawTrajectories();
    });

    container.appendChild(card);
  });
}

async function drawTrajectories() {
  const canvas = document.getElementById('map-canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;

  ctx.fillStyle = '#090d16';
  ctx.fillRect(0, 0, w, h);

  const cellW = w / MAP_GRID_X;
  const cellH = h / MAP_GRID_Z;

  for (let x = 0; x < MAP_GRID_X; x++) {
    for (let z = 0; z < MAP_GRID_Z; z++) {
      let topType: BlockType = BLOCK.AIR;
      let topY = 0;
      for (let y = MAP_GRID_Y - 1; y >= 0; y--) {
        const b = getVoxel(x, y, z);
        if (b !== BLOCK.AIR && b !== BLOCK.BARRIER) {
          topType = b;
          topY = y;
          break;
        }
      }

      if (topType === BLOCK.WATER) {
        ctx.fillStyle = '#1d4ed8';
      } else if (topType === BLOCK.ASPHALT) {
        ctx.fillStyle = '#334155';
      } else if (topType === BLOCK.CONCRETE || topType === BLOCK.BRICK) {
        ctx.fillStyle = '#cbd5e1';
      } else {
        if (topY < 5) ctx.fillStyle = 'rgba(239, 68, 68, 0.25)';
        else if (topY < 14) ctx.fillStyle = 'rgba(234, 179, 8, 0.2)';
        else ctx.fillStyle = 'rgba(16, 185, 129, 0.25)';
      }
      ctx.fillRect(x * cellW, z * cellH, cellW, cellH);
    }
  }

  shelters.forEach(s => {
    ctx.fillStyle = '#f43f5e';
    ctx.beginPath();
    ctx.arc(s.gridX * cellW, s.gridZ * cellH, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 7px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('避難所', s.gridX * cellW, s.gridZ * cellH + 3);
  });

  const ids = Array.from(selectedSessionIds);
  for (const sessionId of ids) {
    let traj: any[] = [];
    if (supabase) {
      try {
        const { data } = await supabase.from('trajectories').select('*').eq('session_id', sessionId).order('step_second');
        traj = data || [];
      } catch {
        const allTraj = JSON.parse(localStorage.getItem(LOCAL_TRAJECTORY_KEY) || '{}');
        traj = allTraj[sessionId] || [];
      }
    } else {
      const allTraj = JSON.parse(localStorage.getItem(LOCAL_TRAJECTORY_KEY) || '{}');
      traj = allTraj[sessionId] || [];
    }

    if (traj.length < 2) continue;

    ctx.beginPath();
    const startGX = (traj[0].pos_x / VOXEL_SIZE) + MAP_GRID_X / 2;
    const startGZ = (traj[0].pos_z / VOXEL_SIZE) + MAP_GRID_Z / 2;
    ctx.moveTo(startGX * cellW, startGZ * cellH);

    for (let i = 1; i < traj.length; i++) {
      const gx = (traj[i].pos_x / VOXEL_SIZE) + MAP_GRID_X / 2;
      const gz = (traj[i].pos_z / VOXEL_SIZE) + MAP_GRID_Z / 2;
      ctx.lineTo(gx * cellW, gz * cellH);
    }

    const sMeta = allSessions.find(item => item.id === sessionId);
    ctx.strokeStyle = sMeta?.has_hazard_map ? '#22d3ee' : '#f97316';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
}
