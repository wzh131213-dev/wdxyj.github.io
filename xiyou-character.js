// xiyou-character.js — 重走西游 · 人物建模（程序化、纯数据；接入 THREE 见 xiyou-three.js）
// 依据 BIBLE §7.2：米制骨架(Mixamo 风格命名)；躯干 14 环、四肢 8 环、16 边的椭圆放样；
// 距离权重蒙皮(2~4 影响、归一化、2 次拉普拉斯平滑)；手为低模连指手套(拇指/食指/中指/无名+小指各 2 节)。
// 静止姿态 = A 字站姿，所有骨骼静止旋转为单位四元数 → 动画层用"相对静止姿态的欧拉偏移"即可。
import {
  TAU, clamp, lerp, smoothstep, v3, mulberry32, hashStr, computeNormals, xf, mirrorX, filterTris,
  mergeMeshes, colorize, loft, lathe, ellipsoid, torus, bounds, MeshBuilder,
} from './xiyou-core.js';

const rad = (d) => (d * Math.PI) / 180;

// ═════════════════════════════ 比例 / 骨架 ═════════════════════════════
/** spec.height(米) 与 spec.build{shoulder,hip,thick,belly,arm,leg,legThick,hand,head} → 比例布局 L */
export function makeLayout(spec) {
  const H = spec.height, k = H / 1.78, b = spec.build ?? {};
  const L = {
    H, k, sw: b.shoulder ?? 1, hw: b.hip ?? 1, thick: b.thick ?? 1, belly: b.belly ?? 0,
    armK: b.arm ?? 1, legK: b.leg ?? 1, legT: b.legThick ?? 1, handK: b.hand ?? 1, headK: b.head ?? 1,
  };
  L.hipY = 0.53 * H * L.legK;
  // f = 标准身高分数(0..1)，Y(f) 把它映射到本角色(腿长系数会挪动髋高，头顶始终 = H)
  L.Y = (f) => (f <= 0.53 ? (f * L.hipY) / 0.53 : L.hipY + ((f - 0.53) * (H - L.hipY)) / 0.47);
  L.fOf = (y) => (y <= L.hipY ? (y * 0.53) / L.hipY : 0.53 + ((y - L.hipY) * 0.47) / (H - L.hipY));
  const { Y } = L;
  L.kneeY = Y(0.285); L.ankleY = Y(0.039);
  L.hipX = 0.092 * k * L.hw;
  const J = {}; // 左侧关节(+X)，右侧镜像
  J.clavicle = [0.03 * k, Y(0.797), 0.02 * k];
  J.upperArm = [0.185 * k * L.sw, Y(0.803), 0];
  const A1 = rad(58);
  const d1 = v3.norm([Math.cos(A1), -Math.sin(A1), 0.02]);
  const d2 = v3.norm([Math.cos(A1 + 0.24), -Math.sin(A1 + 0.24), 0.16]);
  const along = v3.norm([Math.cos(A1 + 0.32), -Math.sin(A1 + 0.32), 0.07]);
  J.foreArm = v3.add(J.upperArm, v3.mul(d1, 0.300 * k * L.armK));
  J.hand = v3.add(J.foreArm, v3.mul(d2, 0.262 * k * L.armK));
  // 手：掌心朝向身体；拇指在前(+Z)
  const fwd = [0, 0, 1], inward = v3.norm(v3.cross(along, fwd));
  const hk = k * L.handK, pl = 0.092 * hk;
  L.handDir = along; L.handInward = inward;
  J.palmEnd = v3.add(J.hand, v3.mul(along, pl));
  const finger = (lat, l1, l2, c1, c2, base) => {
    const p1 = v3.add(v3.add(J.hand, v3.mul(along, pl * base)), v3.mul(fwd, lat * hk));
    const p2 = v3.add(p1, v3.mul(v3.norm(v3.add(along, v3.mul(inward, c1))), l1 * hk));
    return { p1, p2, tip: v3.add(p2, v3.mul(v3.norm(v3.add(along, v3.mul(inward, c2))), l2 * hk)) };
  };
  J.index = finger(0.034, 0.042, 0.036, 0.12, 0.35, 1.0);
  J.middle = finger(0.012, 0.046, 0.038, 0.14, 0.40, 1.04);
  J.ringPinky = finger(-0.016, 0.040, 0.032, 0.18, 0.45, 0.98);
  {
    const p1 = v3.add(v3.add(v3.add(J.hand, v3.mul(along, 0.2 * pl)), v3.mul(fwd, 0.032 * hk)), v3.mul(inward, 0.026 * hk));
    const dir = v3.norm(v3.add(v3.add(v3.mul(along, 0.55), v3.mul(fwd, 0.75)), v3.mul(inward, 0.15)));
    const p2 = v3.add(p1, v3.mul(dir, 0.040 * hk));
    J.thumb = { p1, p2, tip: v3.add(p2, v3.mul(v3.norm(v3.add(dir, v3.mul(inward, 0.2))), 0.034 * hk)) };
  }
  J.grip = v3.add(v3.add(J.hand, v3.mul(along, 0.5 * pl)), v3.mul(inward, 0.022 * hk)); // 握持中心（weapon_R）
  J.thigh = [L.hipX, L.hipY, 0];
  J.shin = [L.hipX * 0.97, L.kneeY, 0.010 * k];
  J.foot = [L.hipX * 0.94, L.ankleY, -0.004 * k];
  J.toe = [L.hipX * 0.94, 0.030 * k, 0.135 * k];
  J.toeTip = [L.hipX * 0.94, 0.018 * k, 0.215 * k];
  L.J = J;
  const hr = { rx: 0.078 * k * L.headK, ry: 0.118 * k * L.headK, rz: 0.098 * k * L.headK };
  L.head = { ...hr, c: [0, H - hr.ry, 0.012 * k] };
  return L;
}

/** 骨骼顺序即父在前；pos = 静止世界位置，tail = 主子骨位置(用于蒙皮距离) */
export function buildSkeleton(L) {
  const bones = [], J = L.J, { Y, k, H } = L;
  const add = (name, parent, pos, tail) => bones.push({ name, parent: parent == null ? -1 : bones.findIndex((b) => b.name === parent), pos, tail });
  add('root', null, [0, 0, 0], [0, L.hipY, 0]);
  add('pelvis', 'root', [0, L.hipY, 0], [0, Y(0.585), 0]);
  add('spine1', 'pelvis', [0, Y(0.585), 0], [0, Y(0.65), 0]);
  add('spine2', 'spine1', [0, Y(0.65), 0], [0, Y(0.725), 0]);
  add('chest', 'spine2', [0, Y(0.725), 0], [0, Y(0.82), 0.005 * k]);
  add('neck', 'chest', [0, Y(0.82), 0.005 * k], [0, Y(0.865), 0.012 * k]);
  add('head', 'neck', [0, Y(0.865), 0.012 * k], [0, H, 0.012 * k]);
  for (const s of ['L', 'R']) {
    const X = s === 'L' ? (p) => p : v3.mirrorX;
    add(`clavicle_${s}`, 'chest', X(J.clavicle), X(J.upperArm));
    add(`upperArm_${s}`, `clavicle_${s}`, X(J.upperArm), X(J.foreArm));
    add(`foreArm_${s}`, `upperArm_${s}`, X(J.foreArm), X(J.hand));
    add(`hand_${s}`, `foreArm_${s}`, X(J.hand), X(J.palmEnd));
    for (const n of ['thumb', 'index', 'middle', 'ringPinky']) {
      add(`${n}1_${s}`, `hand_${s}`, X(J[n].p1), X(J[n].p2));
      add(`${n}2_${s}`, `${n}1_${s}`, X(J[n].p2), X(J[n].tip));
    }
    add(`thigh_${s}`, 'pelvis', X(J.thigh), X(J.shin));
    add(`shin_${s}`, `thigh_${s}`, X(J.shin), X(J.foot));
    add(`foot_${s}`, `shin_${s}`, X(J.foot), X(J.toe));
    add(`toe_${s}`, `foot_${s}`, X(J.toe), X(J.toeTip));
  }
  const g = v3.mirrorX(J.grip);
  add('weapon_R', 'hand_R', g, v3.add(g, [0, 0.1 * k, 0]));
  add('scabbard_L', 'pelvis', [0.2 * k * L.hw, L.hipY - 0.02 * k, 0], [0.14 * k * L.hw, L.hipY - 0.45 * k, 0]);
  return { bones, index: Object.fromEntries(bones.map((b, i) => [b.name, i])) };
}

// ═════════════════════════════ 蒙皮 ═════════════════════════════
function distSeg(px, py, pz, a, b) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2], l2 = abx * abx + aby * aby + abz * abz || 1e-12;
  const t = clamp(((px - a[0]) * abx + (py - a[1]) * aby + (pz - a[2]) * abz) / l2, 0, 1);
  return Math.hypot(px - a[0] - abx * t, py - a[1] - aby * t, pz - a[2] - abz * t);
}
/** 只在 names 给出的候选骨骼内做 距离^-p 权重 → 邻域拉普拉斯平滑(passes 次) → 取前 4 → 归一化 */
export function skinMesh(mesh, names, sk, k, o = {}) {
  const power = o.power ?? 3, passes = o.passes ?? 2, eps = (o.eps ?? 0.02) * k;
  const K = names.length, P = mesh.positions, n = P.length / 3;
  const seg = names.map((nm) => { const b = sk.bones[sk.index[nm]]; if (!b) throw new Error(`蒙皮：没有骨骼 ${nm}`); return [b.pos, b.tail]; });
  const gid = new Int32Array(n), map = new Map();
  let G = 0;
  for (let i = 0; i < n; i++) {
    const key = Math.round(P[3 * i] * 1e4) + ',' + Math.round(P[3 * i + 1] * 1e4) + ',' + Math.round(P[3 * i + 2] * 1e4);
    let id = map.get(key);
    if (id === undefined) { id = G++; map.set(key, id); }
    gid[i] = id;
  }
  let cur = new Float32Array(G * K), nxt = new Float32Array(G * K);
  const seen = new Uint8Array(G);
  for (let i = 0; i < n; i++) {
    const g = gid[i]; if (seen[g]) continue; seen[g] = 1;
    let sum = 0;
    for (let j = 0; j < K; j++) { const d = distSeg(P[3 * i], P[3 * i + 1], P[3 * i + 2], seg[j][0], seg[j][1]); const w = 1 / Math.pow(d + eps, power); cur[g * K + j] = w; sum += w; }
    for (let j = 0; j < K; j++) cur[g * K + j] /= sum;
  }
  const nb = Array.from({ length: G }, () => new Set()), I = mesh.indices;
  for (let t = 0; t < I.length; t += 3) {
    const a = gid[I[t]], b = gid[I[t + 1]], c = gid[I[t + 2]];
    nb[a].add(b); nb[a].add(c); nb[b].add(a); nb[b].add(c); nb[c].add(a); nb[c].add(b);
  }
  const nbA = nb.map((s) => [...s]);
  for (let p = 0; p < passes; p++) {
    for (let g = 0; g < G; g++) {
      const list = nbA[g];
      for (let j = 0; j < K; j++) {
        let s = 0; for (const q of list) s += cur[q * K + j];
        nxt[g * K + j] = 0.5 * cur[g * K + j] + 0.5 * (list.length ? s / list.length : cur[g * K + j]);
      }
    }
    const t = cur; cur = nxt; nxt = t;
  }
  const SI = new Uint16Array(n * 4), SW = new Float32Array(n * 4), ord = Array.from({ length: K }, (_, j) => j);
  for (let i = 0; i < n; i++) {
    const base = gid[i] * K;
    ord.sort((a, b) => cur[base + b] - cur[base + a]);
    let sum = 0; const top = Math.min(4, K);
    for (let j = 0; j < top; j++) sum += cur[base + ord[j]];
    for (let j = 0; j < top; j++) { SI[4 * i + j] = sk.index[names[ord[j]]]; SW[4 * i + j] = sum > 0 ? cur[base + ord[j]] / sum : (j === 0 ? 1 : 0); }
  }
  mesh.skinIndex = SI; mesh.skinWeight = SW;
  return mesh;
}
/** 刚性绑定：100% 权重给一根骨骼（帽子、道具、念珠等） */
export function rigidMesh(mesh, name, sk) {
  const n = mesh.positions.length / 3, SI = new Uint16Array(n * 4), SW = new Float32Array(n * 4), bi = sk.index[name];
  if (bi === undefined) throw new Error(`刚性绑定：没有骨骼 ${name}`);
  for (let i = 0; i < n; i++) { SI[4 * i] = bi; SW[4 * i] = 1; }
  mesh.skinIndex = SI; mesh.skinWeight = SW;
  return mesh;
}

// ═════════════════════════════ 人体曲线 ═════════════════════════════
// 躯干截面表：[身高分数 f, 半宽 rx, 半厚 rz, 中心偏前 cz]（米，k=1 即 1.78 m 基准）
const TT = [
  [0.47, 0.150, 0.100, 0.000], [0.53, 0.172, 0.108, 0.000], [0.585, 0.160, 0.098, 0.004], [0.62, 0.145, 0.092, 0.006],
  [0.70, 0.152, 0.098, 0.008], [0.76, 0.170, 0.108, 0.006], [0.805, 0.176, 0.090, 0.000], [0.825, 0.118, 0.070, -0.004], [0.842, 0.062, 0.058, -0.004],
];
function catmull(tab, col, f) {
  let i = 0;
  while (i < tab.length - 2 && f > tab[i + 1][0]) i++;
  const t = clamp((f - tab[i][0]) / (tab[i + 1][0] - tab[i][0]), 0, 1);
  const p0 = tab[Math.max(i - 1, 0)][col], p1 = tab[i][col], p2 = tab[i + 1][col], p3 = tab[Math.min(i + 2, tab.length - 1)][col];
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
}
export function torsoAt(L, f) {
  f = clamp(f, 0.47, 0.842);
  let rx = catmull(TT, 1, f) * L.k * lerp(L.hw, L.sw, smoothstep(0.54, 0.78, f));
  let rz = catmull(TT, 2, f) * L.k * L.thick, cz = catmull(TT, 3, f) * L.k;
  const bump = Math.exp(-(((f - 0.60) / 0.075) ** 2));   // 肚腩
  rz += L.belly * L.k * 0.10 * bump; cz += L.belly * L.k * 0.055 * bump; rx += L.belly * L.k * 0.03 * bump;
  return { rx, rz, cz };
}
const interp = (S, R, s) => {
  s = clamp(s, 0, 1);
  let i = 0; while (i < S.length - 2 && s > S[i + 1]) i++;
  return lerp(R[i], R[i + 1], (s - S[i]) / (S[i + 1] - S[i]));
};
const LEG_S = [0, 0.12, 0.35, 0.47, 0.5, 0.62, 0.8, 1.0], LEG_R = [0.098, 0.092, 0.07, 0.056, 0.052, 0.056, 0.042, 0.034];
export const legRadius = (L, y) => interp(LEG_S, LEG_R, (L.hipY - y) / (L.hipY - L.ankleY)) * L.k * L.legT;
/** 左腿中心线在高度 y 处的点 */
export function legPoint(L, y) {
  const J = L.J;
  return y >= L.kneeY ? v3.lerp(J.thigh, J.shin, (L.hipY - y) / (L.hipY - L.kneeY)) : v3.lerp(J.shin, J.foot, (L.kneeY - y) / (L.kneeY - L.ankleY));
}
const ARM_S = [0, 0.15, 0.4, 0.534, 0.62, 0.85, 1], ARM_R = [0.060, 0.053, 0.042, 0.037, 0.039, 0.030, 0.026];
function polyline(pts) {
  const seg = [], cum = [0];
  for (let i = 0; i < pts.length - 1; i++) { seg.push(v3.dist(pts[i], pts[i + 1])); cum.push(cum[i] + seg[i]); }
  const total = cum[cum.length - 1];
  return { total, at(s) { const d = clamp(s, 0, 1) * total; let i = 0; while (i < seg.length - 1 && d > cum[i + 1]) i++; return v3.lerp(pts[i], pts[i + 1], seg[i] ? clamp((d - cum[i]) / seg[i], 0, 1) : 0); } };
}
/** 左臂折线：肩→肘→腕(→腕外延 ext 米，用于袖口) */
export function armPath(L, ext = 0) {
  const J = L.J, pts = [J.upperArm, J.foreArm, J.hand];
  if (ext > 0) pts.push(v3.add(J.hand, v3.mul(L.handDir, ext)));
  return polyline(pts);
}
export const armRadius = (L, s) => interp(ARM_S, ARM_R, s) * L.k;

// ═════════════════════════════ 躯干 / 四肢 / 头 / 手 / 脚 ═════════════════════════════
const sideMesh = (m, side) => (side === 'L' ? m : mirrorX(m));

function torsoMesh(ctx) {
  const { L } = ctx, rings = [];
  for (let i = 0; i < 14; i++) { const f = lerp(0.47, 0.842, i / 13), t = torsoAt(L, f); rings.push({ c: [0, L.Y(f), t.cz], ra: t.rx, rb: t.rz }); }
  return loft(rings, { sides: 16, cap: 'both' });
}
function neckMesh(ctx) {
  const { L } = ctx, k = L.k, h = L.head, y0 = L.Y(0.80), y1 = h.c[1] - h.ry + 0.03 * k, rings = [];
  for (let i = 0; i < 4; i++) { const s = i / 3; rings.push({ c: [0, lerp(y0, y1, s), lerp(0.004, 0.014, s) * k], ra: lerp(0.060, 0.050, s) * k, rb: lerp(0.058, 0.050, s) * k }); }
  return loft(rings, { sides: 16, cap: 'both' });
}
function legMesh(ctx, side) {
  const { L } = ctx, rings = [];
  for (const s of [0, 0.14, 0.3, 0.5, 0.62, 0.78, 0.92, 1]) {
    const y = L.hipY - s * (L.hipY - L.ankleY), r = legRadius(L, y);
    rings.push({ c: legPoint(L, y), ra: r, rb: r * (s > 0.5 && s < 0.85 ? 1.06 : 1) });
  }
  return sideMesh(loft(rings, { sides: 16, cap: 'both' }), side);
}
function armMesh(ctx, side) {
  const { L } = ctx, path = armPath(L), rings = [];
  for (const s of [0, 0.14, 0.3, 0.45, 0.534, 0.65, 0.82, 1]) { const r = armRadius(L, s); rings.push({ c: path.at(s), ra: r, rb: r }); }
  return sideMesh(loft(rings, { sides: 16, cap: 'both' }), side);
}
function handMesh(ctx, side) {
  const { L } = ctx, J = L.J, hk = L.k * L.handK, parts = [];
  parts.push(loft([0, 0.35, 0.7, 1].map((s) => ({ c: v3.lerp(J.hand, J.palmEnd, s), ra: lerp(0.015, 0.014, s) * hk, rb: lerp(0.034, 0.040, s) * hk })), { sides: 8, cap: 'both' }));
  for (const n of ['thumb', 'index', 'middle', 'ringPinky']) {
    const f = J[n], r0 = (n === 'thumb' ? 0.0115 : 0.0095) * hk;
    parts.push(loft([{ c: f.p1, ra: r0, rb: r0 }, { c: f.p2, ra: r0 * 0.9, rb: r0 * 0.9 }, { c: f.tip, ra: r0 * 0.6, rb: r0 * 0.6 }], { sides: 6, cap: 'both' }));
  }
  return sideMesh(mergeMeshes(parts), side);
}
/** 脚 = 鞋：沿 +Z 放样，底面压平贴地 */
export function footMesh(ctx, side) {
  const { L } = ctx, k = L.k, J = L.J, rings = [];
  const Z = [-0.075, -0.05, -0.01, 0.04, 0.09, 0.14, 0.185, 0.215], RX = [0.036, 0.040, 0.041, 0.043, 0.046, 0.047, 0.040, 0.026], RY = [0.045, 0.062, 0.058, 0.046, 0.036, 0.030, 0.025, 0.017];
  for (let i = 0; i < Z.length; i++) rings.push({ c: [J.foot[0], RY[i] * k * 0.55, J.foot[2] + Z[i] * k], ra: RX[i] * k, rb: RY[i] * k, hint: [0, 1, 0] });
  const m = loft(rings, { sides: 14, cap: 'both', mod: (p) => [p[0], Math.max(p[1], 0), p[2]] });
  return sideMesh(m, side);
}

/** 头：椭球 + 五官位移（眉弓/鼻/眼窝/颧骨/下巴/猴吻）。u = 单位方向 */
export function headShape(ctx, u) {
  const { L, spec } = ctx, k = L.k, h = L.head, hd = spec.head ?? {};
  let x = u[0] * h.rx, y = u[1] * h.ry, z = u[2] * h.rz;
  const tl = smoothstep(0.1, -0.85, u[1]);
  x *= 1 - 0.17 * tl; z *= 1 - 0.05 * tl;                              // 下颌收窄
  const front = smoothstep(0.05, 0.45, u[2]);
  const g = (cx, cy, sx, sy) => Math.exp(-(((u[0] - cx) / sx) ** 2) - (((u[1] - cy) / sy) ** 2)) * front;
  const nose = hd.nose ?? 1, brow = hd.brow ?? 1, cheek = hd.cheek ?? 1, mz = hd.muzzle ?? 0, hk = L.headK;
  let d = 0;
  d += nose * 0.026 * k * hk * g(0, -0.10, 0.10, 0.13) + nose * 0.010 * k * hk * g(0, 0.12, 0.05, 0.16);
  d += brow * 0.011 * k * hk * g(0, 0.24, 0.50, 0.07);
  d -= 0.004 * k * hk * (g(0.30, 0.13, 0.12, 0.08) + g(-0.30, 0.13, 0.12, 0.08));
  d += cheek * 0.007 * k * hk * (g(0.44, -0.12, 0.17, 0.12) + g(-0.44, -0.12, 0.17, 0.12));
  d += 0.012 * k * hk * g(0, -0.64, 0.17, 0.12);
  d += mz * 0.045 * k * hk * g(0, -0.38, 0.38, 0.28);
  d -= 0.004 * k * hk * g(0, -0.43, 0.18, 0.025) * (1 - 0.7 * mz);     // 嘴缝
  return [x + u[0] * d, y + u[1] * d, z + u[2] * d];
}
function headMesh(ctx) {
  const h = ctx.L.head;
  return ellipsoid(h.c, [h.rx, h.ry, h.rz], { lat: 20, lon: 32, shape: (u) => headShape(ctx, u) });
}
function cloneMesh(m) {
  const o = {};
  for (const key of Object.keys(m)) o[key] = m[key].slice();
  return o;
}
function earMeshes(ctx) {
  const { L, spec } = ctx, k = L.k * L.headK, h = L.head;
  const e = { sx: 0.012, sy: 0.036, sz: 0.022, point: 0, out: 0.35, tilt: 0, drop: 0, dx: 0, back: -0.006, ...(spec.head?.ear ?? {}) };
  const r = [e.sx * k, e.sy * k, e.sz * k];
  const m = ellipsoid([0, 0, 0], r, {
    lat: 8, lon: 12,
    shape: (u) => { const up = Math.max(u[1], 0); return [u[0] * r[0] * (1 - 0.5 * e.point * up), u[1] * r[1] * (1 + e.point * smoothstep(0.1, 1, up)), u[2] * r[2] * (1 - 0.45 * e.point * up)]; },
  });
  xf(m, { r: [0, e.out, e.tilt], t: [h.rx + e.sx * k * 0.6 + e.dx * k, h.c[1] + 0.002 * k - e.drop * k, h.c[2] + e.back * k] });
  return [m, mirrorX(cloneMesh(m))];
}

/** 眼睛：小球嵌在眼窝里 */
function eyeMeshes(ctx) {
  const { L, spec } = ctx, h = L.head, k = L.k * L.headK, hd = spec.head ?? {}, r = 0.0115 * k * (hd.eye ?? 1), out = [];
  for (const sx of [1, -1]) {
    const u = v3.norm([sx * (hd.eyeX ?? 0.30), 0.13, 0.94]), s = headShape(ctx, u), nn = v3.norm([u[0] / h.rx, u[1] / h.ry, u[2] / h.rz]);
    out.push(ellipsoid([h.c[0] + s[0] - nn[0] * 0.001 * k, h.c[1] + s[1] - nn[1] * 0.001 * k, h.c[2] + s[2] - nn[2] * 0.001 * k], [r, r * 0.9, r * 0.8], { lat: 6, lon: 8 }));
  }
  return out;
}

// ═════════════════════════════ 材质（线性色，贴合 BIBLE §1.4 低反照率纪律） ═════════════════════════════
export const mat = {
  skin: (c, o) => ({ kind: 'skin', color: c, roughness: 0.6, metalness: 0, ...o }),
  cloth: (c, o) => ({ kind: 'cloth', color: c, roughness: 0.85, metalness: 0, sheen: 0.6, sheenColor: [0.9, 0.85, 0.8], side: 'double', ...o }),
  metal: (c, o) => ({ kind: 'metal', color: c, roughness: 0.32, metalness: 0.9, ...o }),
  wood: (c, o) => ({ kind: 'wood', color: c, roughness: 0.75, metalness: 0, ...o }),
  leather: (c, o) => ({ kind: 'leather', color: c, roughness: 0.7, metalness: 0, ...o }),
  hair: (c, o) => ({ kind: 'hair', color: c, roughness: 0.8, metalness: 0, side: 'double', ...o }),
  eye: (c, o) => ({ kind: 'eye', color: c, roughness: 0.12, metalness: 0, ...o }),
  bone: (c, o) => ({ kind: 'bone', color: c, roughness: 0.55, metalness: 0, ...o }),
};

// ═════════════════════════════ 蒙皮骨骼集合 ═════════════════════════════
const TORSO_BONES = ['pelvis', 'spine1', 'spine2', 'chest', 'neck', 'clavicle_L', 'clavicle_R'];
const ROBE_BONES = [...TORSO_BONES, 'thigh_L', 'thigh_R', 'shin_L', 'shin_R'];
const SKIRT_BONES = ['pelvis', 'spine1', 'thigh_L', 'thigh_R', 'shin_L', 'shin_R'];
const BACK_BONES = ['chest', 'spine2', 'spine1', 'pelvis', 'thigh_L', 'thigh_R'];
const armBones = (s) => [`clavicle_${s}`, `upperArm_${s}`, `foreArm_${s}`, `hand_${s}`];
const legBones = (s) => ['pelvis', `thigh_${s}`, `shin_${s}`, `foot_${s}`];
const handBones = (s) => [`foreArm_${s}`, `hand_${s}`, ...['thumb', 'index', 'middle', 'ringPinky'].flatMap((n) => [`${n}1_${s}`, `${n}2_${s}`])];

// ═════════════════════════════ 服装 / 配饰构件 ═════════════════════════════
/** 在高度 y 处的"衣壳"半径：髋以上贴躯干，髋以下被大腿撑开，再叠加下摆外扩 */
function shellAt(ctx, y, off, fl) {
  const { L } = ctx, f = L.fOf(y), t = torsoAt(L, Math.max(f, 0.47)), yy = Math.min(y, L.hipY);
  const blend = smoothstep(0.58, 0.52, f), lr = legRadius(L, yy), lx = legPoint(L, yy)[0];
  let rx = t.rx + off, rz = t.rz + off, cz = t.cz;
  if (blend > 0) {
    rx = lerp(rx, Math.max(rx, lx + lr + off * 1.2), blend);
    rz = lerp(rz, Math.max(rz, lr + 0.012 * L.k + off), blend);
  }
  const drop = Math.max(0, L.hipY - y);
  rx += drop * (fl?.x ?? 0.14); rz += drop * (fl?.z ?? 0.10);
  if (f < 0.47) cz = lerp(t.cz, 0, clamp((L.Y(0.47) - y) / 0.2, 0, 1));
  return { rx, rz, cz };
}
/** 通用衣壳：top/bottom 为身高分数(自上而下放样)，off 为离躯干距离(米)，zig 为锯齿下摆 */
export function shell(ctx, o) {
  const { L } = ctx, n = o.rings ?? 16, top = L.Y(o.top), bot = L.Y(o.bottom), rings = [];
  for (let i = 0; i < n; i++) {
    const y = lerp(top, bot, i / (n - 1)), s = shellAt(ctx, y, o.off, o.flare);
    rings.push({ c: [0, y, s.cz], ra: s.rx, rb: s.rz });
  }
  let mod = o.mod;
  if (o.zig) {
    const { amp, teeth } = o.zig, last = n - 1;
    mod = (p, k, th) => (k !== last ? p : [p[0], p[1] - amp * (1 - Math.abs((((th / TAU) * teeth) % 1) - 0.5) * 2), p[2]]);
  }
  return loft(rings, { sides: o.sides ?? 20, mod, cap: o.cap });
}
/** 布料网格（rows×cols 个四边形；第 0 行为固定行，供后续 verlet 布料接管） */
function gridPanel(rows, cols, fn) {
  const b = new MeshBuilder();
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) { const p = fn(c / cols, r / rows); b.vert(p[0], p[1], p[2], c / cols, r / rows); }
  const W = cols + 1;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const A = r * W + c; b.tri(A, A + 1, A + W + 1); b.tri(A, A + W + 1, A + W); }
  return b.build();
}
const cutOff = (y, a, b) => clamp((a - y) / (a - b), 0, 1);
/** 在衣壳表面(距躯干 off 米)上取绕颈一圈的 n 个点：背/侧在颈根，正前方下垂 drop*k 米 */
function loopOnShell(ctx, n, drop, off, phase) {
  const { L } = ctx, top = L.Y(0.836), pts = [];
  for (let i = 0; i < n; i++) {
    const th = (TAU * (i + phase)) / n, ft = Math.max(0, Math.cos(th)), y = top - drop * L.k * ft * ft, s = shellAt(ctx, y, off, { x: 0, z: 0 });
    pts.push([s.rx * Math.sin(th), y, s.cz + s.rz * Math.cos(th)]);
  }
  return pts;
}

const PARTS = {
  /** 长袍：领口→下摆一体衣壳（躯干 + 裙摆） */
  robe(ctx, o) {
    const { L } = ctx;
    const m = shell(ctx, { top: 0.842, bottom: o.hem ?? 0.05, off: (o.off ?? 0.02) * L.k, flare: o.flare, rings: o.rings ?? 22, sides: 24 });
    return { name: 'robe', mesh: m, material: mat.cloth(o.color), skin: ROBE_BONES };
  },
  /** 宽袖：沿臂折线放样，袖口外扩；o.end<1 为半袖 */
  sleeves(ctx, o) {
    const { L } = ctx, k = L.k, ext = (o.ext ?? 0.03) * k, base = armPath(L), path = armPath(L, ext), end = o.end ?? 1, out = [];
    for (const side of ['L', 'R']) {
      const rings = [], cnt = 10;
      for (let i = 0; i < cnt; i++) {
        const s = (i / (cnt - 1)) * end, sa = Math.min(1, (s * path.total) / base.total);
        const r = armRadius(L, sa) + (o.off ?? 0.02) * k + (o.flare ?? 0.04) * k * Math.pow(smoothstep(0.35, 1, s), 1.5);
        rings.push({ c: path.at(s), ra: r, rb: r });
      }
      out.push({ name: 'sleeves', mesh: sideMesh(loft(rings, { sides: 18 }), side), material: mat.cloth(o.color), skin: ['chest', 'spine2', ...armBones(side)] });
    }
    return out;
  },
  /** 袈裟：披在左肩、斜过胸前到右髋（袒右肩），金边 */
  kasaya(ctx, o) {
    const { L } = ctx, k = L.k, yA = L.Y(0.83), yB = L.Y(0.50), yBot = L.Y(o.bottom ?? 0.30), xl = (y) => lerp(0.06 * k, -0.20 * k, cutOff(y, yA, yB));
    let m = shell(ctx, { top: 0.842, bottom: o.bottom ?? 0.30, off: (o.off ?? 0.036) * k, flare: { x: 0.12, z: 0.09 }, rings: 30, sides: 36 });
    m = filterTris(m, (c) => !(c[2] > -0.02 * k && c[1] > yB && c[0] < xl(c[1])));
    colorize(m, (x, y, z) => {
      const dCut = z > -0.02 * k && y > yB - 0.05 ? x - xl(y) : 9, d = Math.min(dCut, y - yBot), t = smoothstep(0.012 * k, 0.026 * k, d);
      return [lerp(o.trim[0], o.color[0], t), lerp(o.trim[1], o.color[1], t), lerp(o.trim[2], o.color[2], t)];
    });
    return { name: 'kasaya', mesh: m, material: mat.cloth([1, 1, 1]), skin: ROBE_BONES };
  },
  /** 腰带 +（可选）两条 0.6 m 飘带 */
  sash(ctx, o) {
    const { L } = ctx, k = L.k, out = [];
    out.push({ name: 'sash', mesh: shell(ctx, { top: o.top ?? 0.652, bottom: o.bottom ?? 0.59, off: 0.034 * k, rings: 4, sides: 24, flare: { x: 0, z: 0 } }), material: mat.cloth(o.color), skin: ['pelvis', 'spine1', 'spine2'] });
    if (o.tails) {
      const t = torsoAt(L, 0.60), y0 = L.Y(0.60), x0 = 0.70 * t.rx, z0 = t.cz + t.rz * 0.72 + 0.036 * k;
      for (const [dx, len, sw] of [[0, 0.60, 0.02], [0.055, 0.48, -0.03]]) {
        const m = gridPanel(6, 1, (u, v) => [x0 + dx * k + (u - 0.5) * 0.07 * k + sw * k * v, y0 - v * len * k, z0 + 0.02 * k * v]);
        out.push({ name: 'sashTails', mesh: m, material: mat.cloth(o.color), skin: ['pelvis', 'spine1', 'thigh_L', 'thigh_R'], cloth: { rows: 6, cols: 1, pin: 0 } });
      }
    }
    return out;
  },
  /** 披风：绕背部的圆柱面网格，肩部固定行 */
  cape(ctx, o) {
    const { L } = ctx, k = L.k, t = torsoAt(L, 0.80), top = L.Y(0.835), len = (o.len ?? 0.95) * k, rows = o.rows ?? 12, cols = o.cols ?? 8, arc = o.arc ?? 2.4;
    const m = gridPanel(rows, cols, (u, v) => {
      const phi = (u - 0.5) * arc;
      return [(t.rx + 0.03 * k) * Math.sin(phi) * (1 + 0.45 * v), top - v * len, -((t.rz + 0.034 * k) * Math.cos(phi)) * (1 + 0.8 * v) - 0.05 * k * v];
    });
    return { name: 'cape', mesh: m, material: mat.cloth(o.color), skin: BACK_BONES, cloth: { rows, cols, pin: 0 } };
  },
  /** 虎皮裙：锯齿下摆 + 顶点色虎纹 */
  tigerSkirt(ctx, o = {}) {
    const { L } = ctx, k = L.k, base = o.color ?? [0.62, 0.34, 0.06], dark = o.stripe ?? [0.03, 0.02, 0.01];
    const m = shell(ctx, { top: 0.608, bottom: 0.40, off: 0.03 * k, flare: { x: 0.20, z: 0.16 }, zig: { amp: 0.03 * k, teeth: 12 }, rings: 14, sides: 48 });
    colorize(m, (x, y, z) => { const t = smoothstep(0.45, 0.65, Math.sin(Math.atan2(x, z) * 8 + 5 * Math.sin((y * 11) / k))); return [lerp(base[0], dark[0], t), lerp(base[1], dark[1], t), lerp(base[2], dark[2], t)]; });
    return { name: 'tigerSkirt', mesh: m, material: mat.cloth([1, 1, 1]), skin: SKIRT_BONES };
  },
  /** 黄金甲：胸甲 + 护颈环 */
  cuirass(ctx, o) {
    const { L } = ctx, k = L.k;
    const body = shell(ctx, { top: 0.822, bottom: 0.585, off: 0.032 * k, rings: 12, sides: 26, flare: { x: 0, z: 0 } });
    const gorget = xf(torus(0.078 * k, 0.012 * k, { segs: 22, tube: 8 }), { t: [0, L.Y(0.834), 0.004 * k] });
    return [
      { name: 'armor', mesh: body, material: mat.metal(o.color, { roughness: 0.3, metalness: 0.85 }), skin: TORSO_BONES },
      { name: 'armor', mesh: gorget, material: mat.metal(o.color, { roughness: 0.3, metalness: 0.85 }), skin: ['chest', 'neck', 'spine2'] },
    ];
  },
  pauldrons(ctx, o) {
    const { L } = ctx, k = L.k, J = L.J, out = [];
    for (const s of ['L', 'R']) {
      const m = sideMesh(ellipsoid([J.upperArm[0], J.upperArm[1] + 0.012 * k, 0], [0.075 * k, 0.055 * k, 0.07 * k], { lat: 8, lon: 14 }), s);
      out.push({ name: 'armor', mesh: m, material: mat.metal(o.color, { roughness: 0.3, metalness: 0.85 }), skin: ['chest', ...armBones(s)] });
    }
    return out;
  },
  /** 鞋（脚网格）+ 可选高靴筒 */
  shoes(ctx, o) {
    const { L } = ctx, k = L.k, out = [];
    for (const s of ['L', 'R']) {
      out.push({ name: 'shoes', mesh: footMesh(ctx, s), material: mat.leather(o.color), skin: [`shin_${s}`, `foot_${s}`, `toe_${s}`] });
      if (o.shaft) {
        const rings = [];
        for (let i = 0; i < 6; i++) { const y = lerp(L.Y(0.045), L.Y(o.shaft), i / 5), r = legRadius(L, y); rings.push({ c: legPoint(L, y), ra: r + 0.012 * k, rb: r * 1.06 + 0.012 * k }); }
        out.push({ name: 'shoes', mesh: sideMesh(loft(rings, { sides: 18 }), s), material: mat.leather(o.color), skin: [`thigh_${s}`, `shin_${s}`, `foot_${s}`] });
      }
    }
    return out;
  },
  /** 灯笼裤：每条腿一只宽管 */
  pants(ctx, o) {
    const { L } = ctx, k = L.k, out = [];
    for (const s of ['L', 'R']) {
      const rings = [];
      for (let i = 0; i < 9; i++) { const sN = i / 8, y = lerp(L.Y(0.40), L.Y(0.05), sN), r = legRadius(L, y), w = (0.012 + 0.03 * Math.sin(Math.PI * sN * 0.9)) * k; rings.push({ c: legPoint(L, y), ra: r + w, rb: r * 1.06 + w }); }
      out.push({ name: 'pants', mesh: sideMesh(loft(rings, { sides: 18 }), s), material: mat.cloth(o.color), skin: legBones(s) });
    }
    return out;
  },
  /** 草绳腰带（肚腩下沿一圈）*/
  ropeBelt(ctx, o) {
    const { L } = ctx, k = L.k, f = 0.575, t = torsoAt(L, f);
    const m = xf(torus(1, 0.016 * k, { segs: 30, tube: 8 }), { s: [t.rx + 0.034 * k, 1, t.rz + 0.034 * k], t: [0, L.Y(f), t.cz] });
    return { name: 'belt', mesh: m, material: mat.leather(o.color), skin: ['pelvis', 'spine1'] };
  },
  /** 毗卢帽 */
  pilu(ctx, o) {
    const { L } = ctx, h = L.head, kk = L.k * L.headK, c = [0, h.c[1] + 0.068 * kk, h.c[2] - 0.004 * kk];
    const hat = lathe([[0.092, -0.01], [0.096, 0.01], [0.095, 0.045], [0.100, 0.09], [0.106, 0.14], [0.100, 0.175], [0.078, 0.19], [0, 0.196]].map(([r, y]) => [r * kk, y * kk]), { sides: 28, center: c });
    const band = lathe([[0.0925, -0.012], [0.099, -0.012], [0.099, 0.026], [0.0925, 0.026], [0.0925, -0.012]].map(([r, y]) => [r * kk, y * kk]), { sides: 28, center: c });
    return [
      { name: 'hat', mesh: hat, material: mat.cloth(o.color), rigid: 'head' },
      { name: 'hatTrim', mesh: band, material: mat.metal(o.trim, { roughness: 0.4, metalness: 0.7 }), rigid: 'head' },
    ];
  },
  /** 凤翅紫金冠：金冠 + 两根后掠长翎 */
  crown(ctx, o = {}) {
    const { L } = ctx, h = L.head, kk = L.k * L.headK, yb = h.c[1] + 0.06 * kk, gold = o.gold ?? [0.78, 0.55, 0.12], out = [];
    const cap = lathe([[0.100, 0], [0.106, 0.02], [0.090, 0.064], [0.052, 0.094], [0.012, 0.106], [0, 0.106]].map(([r, y]) => [r * kk, y * kk]), { sides: 26, center: [0, yb, h.c[2] - 0.002 * kk] });
    const spike = lathe([[0, 0.10], [0.016, 0.10], [0.009, 0.14], [0, 0.17]].map(([r, y]) => [r * kk, y * kk]), { sides: 10, center: [0, yb, h.c[2] - 0.002 * kk] });
    out.push({ name: 'crown', mesh: mergeMeshes([cap, spike]), material: mat.metal(gold, { roughness: 0.28, metalness: 0.9 }), rigid: 'head' });
    for (const sx of [1, -1]) {
      const rings = [];
      for (let i = 0; i < 10; i++) {
        const s = i / 9;
        rings.push({ c: [sx * (0.082 + 0.03 * s) * kk, yb + (0.045 + 0.50 * s - 0.10 * s * s) * kk, h.c[2] + (-0.01 - 0.20 * s * s) * kk], ra: 0.013 * kk * (1 - 0.55 * s * s), rb: 0.003 * kk, hint: [1, 0, 0] });
      }
      out.push({ name: 'feathers', mesh: loft(rings, { sides: 10, cap: 'both' }), material: mat.cloth(o.feather ?? [0.50, 0.10, 0.04], { sheen: 0.3 }), rigid: 'head' });
    }
    return out;
  },
  /** 发罩/毛罩：头部椭球外扩薄壳，按 keep 保留头顶与后脑；long 再加垂到肩胛的长发 */
  hairCap(ctx, o) {
    const { L } = ctx, h = L.head, k = L.k, t = (o.thick ?? 0.012) * k, out = [];
    const m = ellipsoid(h.c, [h.rx, h.ry, h.rz], { lat: 18, lon: 28, shape: (u) => { const s = headShape(ctx, u); return [s[0] + u[0] * t, s[1] + u[1] * t, s[2] + u[2] * t]; } });
    const keep = o.keep ?? ((u) => u[1] > 0.38 || (u[2] < -0.05 && u[1] > -0.25) || (Math.abs(u[0]) > 0.8 && u[1] > -0.05));
    const cap = filterTris(m, (p) => keep(v3.norm([(p[0] - h.c[0]) / h.rx, (p[1] - h.c[1]) / h.ry, (p[2] - h.c[2]) / h.rz])));
    out.push({ name: 'hair', mesh: cap, material: mat.hair(o.color), rigid: 'head' });
    if (o.long) {
      const rings = [[0, h.c[1] - 0.01 * k, h.c[2] - h.rz * 0.92, 0.070, 0.026], [0, L.Y(0.80), -0.115 * k, 0.085, 0.030], [0, L.Y(0.75), -0.135 * k, 0.092, 0.030], [0, L.Y(0.70), -0.14 * k, 0.07, 0.024], [0, L.Y(0.665), -0.135 * k, 0.025, 0.014]]
        .map(([x, y, z, a, b]) => ({ c: [x, y, z], ra: a * k, rb: b * k }));
      out.push({ name: 'hair', mesh: loft(rings, { sides: 12, cap: 'end' }), material: mat.hair(o.color), skin: ['head', 'neck', 'chest', 'spine2'] });
    }
    return out;
  },
  beard(ctx, o) {
    const { L } = ctx, k = L.k, h = L.head, cy = h.c[1] - h.ry, cz = h.c[2] + h.rz * 0.70;
    const rings = [[0.02, 0.0, 0.045, 0.02], [-0.04, 0.012, 0.060, 0.035], [-0.12, 0.018, 0.062, 0.040], [-0.22, 0.012, 0.036, 0.030], [-0.30, 0.006, 0.008, 0.010]]
      .map(([dy, dz, a, b]) => ({ c: [0, cy + dy * k, cz + dz * k], ra: a * k, rb: b * k }));
    return { name: 'beard', mesh: loft(rings, { sides: 14, cap: 'end' }), material: mat.hair(o.color), rigid: 'head' };
  },
  /** 猪嘴：沿 +Z 的短管 + 平整鼻盘 + 两个鼻孔 */
  snout(ctx) {
    const { L } = ctx, h = L.head, kk = L.k * L.headK, z0 = h.c[2] + h.rz * 0.80, y0 = h.c[1] - 0.035 * kk;
    const rings = [0, 0.045, 0.09].map((dz, i) => ({ c: [0, y0 - i * 0.002, z0 + dz * kk], ra: [0.048, 0.046, 0.054][i] * kk, rb: [0.040, 0.038, 0.046][i] * kk, hint: [0, 1, 0] }));
    const zEnd = z0 + 0.092 * kk, nostrils = [1, -1].map((sx) => ellipsoid([sx * 0.017 * kk, y0 - 0.003 * kk, zEnd], [0.008 * kk, 0.010 * kk, 0.006 * kk], { lat: 5, lon: 8 }));
    return [
      { name: 'skin', mesh: loft(rings, { sides: 16, cap: 'both' }), rigid: 'head' },
      { name: 'eyes', mesh: mergeMeshes(nostrils), rigid: 'head' },
    ];
  },
  /** 念珠：沿衣壳表面绕颈一圈，胸前下垂成 V 形 */
  beads(ctx, o) {
    const { L } = ctx, k = L.k, r = 0.012 * k;
    const ms = loopOnShell(ctx, o.n ?? 18, 0.20, 0.042 * k, 0).map((c) => ellipsoid(c, [r, r, r], { lat: 5, lon: 8 }));
    return { name: 'beads', mesh: mergeMeshes(ms), material: mat.wood(o.color, { roughness: 0.45 }), rigid: 'chest' };
  },
  /** 九颗骷髅项链 */
  skulls(ctx, o) {
    const { L } = ctx, k = L.k, ms = [];
    for (const c of loopOnShell(ctx, o.n ?? 9, 0.27, 0.05 * k, 0.5)) {
      ms.push(ellipsoid(c, [0.024 * k, 0.028 * k, 0.026 * k], { lat: 6, lon: 8 }), ellipsoid([c[0], c[1] - 0.022 * k, c[2] + 0.006 * k], [0.015 * k, 0.012 * k, 0.014 * k], { lat: 4, lon: 6 }));
    }
    return { name: 'skulls', mesh: mergeMeshes(ms), material: mat.bone(o.color ?? [0.55, 0.50, 0.42]), rigid: 'chest' };
  },
};

// ═════════════════════════════ 兵器 / 法器（刚性挂在 weapon_R；轴线为竖直，底端着地） ═════════════════════════════
const PROPS = {
  /** 九环锡杖 */
  xizhang(ctx) {
    const { L } = ctx, k = L.k, g = L.J.grip, T = [-g[0], 0, g[2]], len = 1.62 * k, yR = 1.56 * k, R = 0.075 * k;
    const shaft = lathe([[0, 0], [0.0125 * k, 0], [0.0115 * k, 0.05 * k], [0.0115 * k, 1.5 * k], [0, 1.5 * k]], { sides: 10, center: T });
    const ms = [xf(torus(R, 0.0075 * k, { segs: 28, tube: 8 }), { r: [Math.PI / 2, 0, 0], t: [T[0], yR, T[2]] }),
      lathe([[0, 0], [0.022 * k, 0], [0.012 * k, 0.025 * k], [0.02 * k, 0.05 * k], [0.007 * k, 0.085 * k], [0, 0.11 * k]], { sides: 10, center: [T[0], yR + R, T[2]] })];
    for (const a of [-0.9, -0.54, -0.18, 0.18, 0.54, 0.9]) ms.push(xf(torus(0.016 * k, 0.003 * k, { segs: 12, tube: 5 }), { r: [0, 0, Math.PI / 2], t: [T[0] + R * Math.sin(a), yR - R * Math.cos(a), T[2]] }));
    return { len, pieces: [{ name: 'propWood', mesh: shaft, material: mat.wood([0.12, 0.07, 0.035]) }, { name: 'propMetal', mesh: mergeMeshes(ms), material: mat.metal([0.60, 0.42, 0.14], { roughness: 0.4, metalness: 0.8 }) }] };
  },
  /** 如意金箍棒（红身金箍） */
  jingubang(ctx) {
    const { L } = ctx, k = L.k, g = L.J.grip, T = [-g[0], 0, g[2]], len = 2.1 * k, r = 0.022 * k, rb = 0.029 * k, band = 0.14 * k;
    const body = lathe([[0, band], [r, band], [r, len - band], [0, len - band]], { sides: 14, center: T });
    const bands = mergeMeshes([lathe([[0, 0], [rb, 0], [rb, band], [r, band], [0, band]], { sides: 14, center: T }), lathe([[0, len - band], [r, len - band], [rb, len - band], [rb, len], [0, len]], { sides: 14, center: T })]);
    return { len, pieces: [{ name: 'propBody', mesh: body, material: mat.wood([0.36, 0.02, 0.02], { roughness: 0.4 }) }, { name: 'propMetal', mesh: bands, material: mat.metal([0.78, 0.55, 0.12], { roughness: 0.28, metalness: 0.9 }) }] };
  },
  /** 九齿钉耙：耙头横杆在底端，齿朝下着地 */
  rake(ctx) {
    const { L } = ctx, k = L.k, g = L.J.grip, T = [-g[0], 0, g[2]], len = 1.55 * k, yBar = 0.24 * k;
    const shaft = lathe([[0, yBar], [0.017 * k, yBar], [0.015 * k, len], [0, len]], { sides: 10, center: T });
    const bar = loft([{ c: [T[0] - 0.25 * k, yBar, T[2]], ra: 0.018 * k, rb: 0.018 * k }, { c: [T[0] + 0.25 * k, yBar, T[2]], ra: 0.018 * k, rb: 0.018 * k }], { sides: 10, cap: 'both', hint: [0, 1, 0] });
    const ms = [bar];
    for (let i = 0; i < 9; i++) ms.push(lathe([[0, 0], [0.014 * k, yBar], [0, yBar]], { sides: 8, center: [T[0] + (-0.22 + 0.055 * i) * k, 0, T[2]] }));
    return { len, pieces: [{ name: 'propWood', mesh: shaft, material: mat.wood([0.20, 0.12, 0.06]) }, { name: 'propMetal', mesh: mergeMeshes(ms), material: mat.metal([0.35, 0.36, 0.37], { roughness: 0.4, metalness: 0.9 }) }] };
  },
  /** 降妖宝杖：月牙铲 */
  baozhang(ctx) {
    const { L } = ctx, k = L.k, g = L.J.grip, T = [-g[0], 0, g[2]], len = 1.72 * k, R = 0.11 * k;
    const shaft = lathe([[0, 0], [0.0155 * k, 0], [0.0145 * k, len], [0, len]], { sides: 10, center: T });
    const crescent = xf(torus(R, 0.013 * k, { segs: 30, tube: 8, arc: 1.24 * Math.PI, start: -0.62 * Math.PI }), { r: [Math.PI / 2, 0, 0], t: [T[0], len + R * 0.85, T[2]] });
    const spade = lathe([[0, 0], [0.05 * k, 0.015 * k], [0.03 * k, 0.15 * k], [0, 0.19 * k]], { sides: 10, center: T });
    return { len, pieces: [{ name: 'propWood', mesh: shaft, material: mat.wood([0.10, 0.08, 0.07]) }, { name: 'propMetal', mesh: mergeMeshes([crescent, spade]), material: mat.metal([0.45, 0.46, 0.48], { roughness: 0.35, metalness: 0.9 }) }] };
  },
};

// ═════════════════════════════ 角色设定（数据驱动） ═════════════════════════════
export const CHARACTERS = {
  tangseng: {
    zh: '唐僧', height: 1.74, build: { shoulder: 0.92, hip: 0.95, thick: 0.88, legThick: 0.92 },
    skin: [0.36, 0.23, 0.17], eye: [0.02, 0.016, 0.014],
    head: { brow: 0.7, nose: 0.9, cheek: 0.8, ear: { sx: 0.011, sy: 0.034, sz: 0.02 } },
    skip: ['torso', 'legs', 'arms'],
    parts: [
      ['robe', { color: [0.50, 0.44, 0.30], hem: 0.05, flare: { x: 0.15, z: 0.11 } }],
      ['sleeves', { color: [0.50, 0.44, 0.30], flare: 0.035, ext: 0.04 }],
      ['kasaya', { color: [0.30, 0.035, 0.03], trim: [0.62, 0.46, 0.14] }],
      ['pilu', { color: [0.52, 0.40, 0.20], trim: [0.62, 0.46, 0.14] }],
      ['beads', { n: 18, color: [0.14, 0.07, 0.035] }],
      ['shoes', { color: [0.12, 0.11, 0.10] }],
    ],
    prop: 'xizhang',
  },
  wukong: {
    zh: '孙悟空', height: 1.38, build: { shoulder: 1.0, hip: 0.92, thick: 1.0, arm: 1.12, leg: 0.9, legThick: 0.92, hand: 1.1, head: 1.12 },
    skin: [1, 1, 1], skinTint: 'monkey', eye: [0.30, 0.17, 0.03],
    head: { muzzle: 1, brow: 1.7, nose: 0.35, cheek: 1.4, eye: 1.15, eyeX: 0.27, ear: { sx: 0.014, sy: 0.045, sz: 0.028, point: 0.8, out: 0.5, tilt: -0.3 } },
    skip: [],
    parts: [
      ['hairCap', { color: [0.24, 0.12, 0.05], thick: 0.012 }],
      ['tigerSkirt', {}],
      ['cuirass', { color: [0.78, 0.55, 0.12] }],
      ['pauldrons', { color: [0.78, 0.55, 0.12] }],
      ['sash', { color: [0.40, 0.02, 0.02], tails: true }],
      ['cape', { color: [0.42, 0.018, 0.02] }],
      ['crown', {}],
      ['shoes', { color: [0.09, 0.06, 0.04], shaft: 0.20 }],
    ],
    prop: 'jingubang',
  },
  bajie: {
    zh: '猪八戒', height: 1.80, build: { shoulder: 1.1, hip: 1.18, thick: 1.15, belly: 1.0, arm: 0.95, leg: 0.86, legThick: 1.18, head: 1.15 },
    skin: [0.42, 0.28, 0.25], eye: [0.02, 0.015, 0.012],
    head: { nose: 0.1, brow: 0.5, cheek: 1.8, eye: 0.75, eyeX: 0.36, ear: { sx: 0.016, sy: 0.075, sz: 0.05, out: 0.75, drop: 0.02, dx: 0, tilt: -0.1, back: -0.01 } },
    skip: ['torso', 'legs'],
    parts: [
      ['robe', { color: [0.13, 0.17, 0.12], hem: 0.30, flare: { x: 0.10, z: 0.12 } }],
      ['sleeves', { color: [0.13, 0.17, 0.12], end: 0.5, flare: 0.03, ext: 0 }],
      ['pants', { color: [0.18, 0.15, 0.10] }],
      ['ropeBelt', { color: [0.30, 0.22, 0.10] }],
      ['shoes', { color: [0.10, 0.08, 0.06] }],
      ['snout', {}],
    ],
    prop: 'rake',
  },
  wujing: {
    zh: '沙僧', height: 1.90, build: { shoulder: 1.15, hip: 1.05, thick: 1.1, legThick: 1.05 },
    skin: [0.25, 0.15, 0.11], eye: [0.02, 0.016, 0.014],
    head: { brow: 1.3, nose: 1.1, cheek: 1.1 },
    skip: ['torso', 'legs', 'arms'],
    parts: [
      ['robe', { color: [0.03, 0.045, 0.085], hem: 0.05 }],
      ['sleeves', { color: [0.03, 0.045, 0.085], flare: 0.03, ext: 0.03 }],
      ['sash', { color: [0.30, 0.03, 0.025], tails: true }],
      ['skulls', { n: 9 }],
      ['hairCap', { color: [0.04, 0.025, 0.02], thick: 0.014, long: true, keep: (u) => u[1] > 0.46 - 0.55 * u[0] * u[0] || (u[2] < 0.1 && u[1] > -0.45) || (Math.abs(u[0]) > 0.82 && u[1] > -0.25) }],
      ['beard', { color: [0.20, 0.045, 0.03] }],
      ['shoes', { color: [0.08, 0.07, 0.06] }],
    ],
    prop: 'baozhang',
  },
};

// ═════════════════════════════ 组装 ═════════════════════════════
function jitterSpec(spec, rnd) {
  const j = (v, a) => v * (1 + (rnd() - 0.5) * 2 * a), s = { ...spec, height: j(spec.height, 0.015), build: { ...spec.build } };
  for (const key of Object.keys(s.build)) if (key !== 'belly') s.build[key] = j(s.build[key], 0.03);
  return s;
}
function tintMonkey(ctx, mesh) {
  const h = ctx.L.head, fur = [0.27, 0.15, 0.07], face = [0.40, 0.22, 0.15], R = Math.max(h.rx, h.ry, h.rz) * 1.2;
  return colorize(mesh, (x, y, z) => {
    const u = [(x - h.c[0]) / h.rx, (y - h.c[1]) / h.ry, (z - h.c[2]) / h.rz], inHead = Math.hypot(x - h.c[0], y - h.c[1], z - h.c[2]) < R;
    const t = inHead ? smoothstep(0.15, 0.4, u[2]) * smoothstep(0.62, 0.45, u[1]) * smoothstep(-0.95, -0.7, u[1]) : 0;
    return [lerp(fur[0], face[0], t), lerp(fur[1], face[1], t), lerp(fur[2], face[2], t)];
  });
}

/**
 * 构建一个角色的全部数据（纯函数，同 kind+seed 结果逐位相同）。
 * seed=0 → 标准形象；seed>0 → 身高/体型 ±1.5%/±3% 的小幅变体。
 * 返回 { kind,name,height,skeleton,parts[],capsules[],weapon,stats }；每个 part 带 skinIndex/skinWeight，可直接做 SkinnedMesh。
 */
export function buildCharacterData({ kind = 'tangseng', seed = 0, override = null } = {}) {
  const base0 = CHARACTERS[kind];
  if (!base0) throw new Error(`未知角色 "${kind}"（可选：${Object.keys(CHARACTERS).join(', ')}）`);
  // override：浅合并 height / build / head / skin 等，用于做 NPC 变体（如更高大的士兵）
  const base = override ? { ...base0, ...override, build: { ...base0.build, ...override.build }, head: { ...base0.head, ...override.head } } : base0;
  if (!(base.height >= 0.8 && base.height <= 3.5)) throw new RangeError(`身高 ${base.height} 不在 0.8~3.5 米之内`);
  for (const [key, v] of Object.entries(base.build ?? {})) { const [lo, hi] = key === 'belly' ? [0, 2] : [0.2, 3]; if (!Number.isFinite(v) || v < lo || v > hi) throw new RangeError(`build.${key}=${v} 不在 ${lo}~${hi} 之内`); }
  const spec = seed ? jitterSpec(base, mulberry32((seed >>> 0) ^ hashStr(kind))) : base;
  const L = makeLayout(spec), sk = buildSkeleton(L), k = L.k, ctx = { L, sk, spec }, skip = new Set(spec.skip ?? []);
  const skinMat = mat.skin(spec.skin), pieces = [], P = (name, mesh, material, extra) => pieces.push({ name, mesh, material, ...extra });
  // 1) 裸体部分（最终合并为 'skin' 一个部件）
  P('skin', headMesh(ctx), skinMat, { rigid: 'head' });
  for (const e of earMeshes(ctx)) P('skin', e, skinMat, { rigid: 'head' });
  P('skin', neckMesh(ctx), skinMat, { skin: ['spine2', 'chest', 'neck', 'head'] });
  if (!skip.has('torso')) P('skin', torsoMesh(ctx), skinMat, { skin: TORSO_BONES });
  for (const s of ['L', 'R']) {
    if (!skip.has('arms')) P('skin', armMesh(ctx, s), skinMat, { skin: armBones(s) });
    if (!skip.has('legs')) P('skin', legMesh(ctx, s), skinMat, { skin: legBones(s) });
    P('skin', handMesh(ctx, s), skinMat, { skin: handBones(s) });
  }
  eyeMeshes(ctx).forEach((e) => P('eyes', e, mat.eye(spec.eye), { rigid: 'head' }));
  // 2) 服装 / 配饰
  for (const [type, o] of spec.parts) {
    if (!PARTS[type]) throw new Error(`未知构件 ${type}`);
    for (const piece of [].concat(PARTS[type](ctx, o))) pieces.push(piece);
  }
  // 3) 兵器
  let weapon = null;
  if (spec.prop) {
    const pr = PROPS[spec.prop](ctx);
    for (const p of pr.pieces) pieces.push({ ...p, rigid: 'weapon_R' });
    weapon = { name: spec.prop, bone: 'weapon_R', base: [0, -L.J.grip[1], 0], tip: [0, pr.len - L.J.grip[1], 0], length: pr.len };
  }
  // 4) 蒙皮 → 按 name 合并
  const groups = new Map();
  for (const p of pieces) {
    if (p.skin) skinMesh(p.mesh, p.skin, sk, k, p.skinOpts); else rigidMesh(p.mesh, p.rigid, sk);
    const g = groups.get(p.name) ?? { name: p.name, meshes: [], material: p.material, cloth: p.cloth ? { ...p.cloth, panels: 0 } : undefined };
    if (p.cloth) g.cloth.panels++;                       // 同名布料合并成一个部件：panels 块，每块 (rows+1)*(cols+1) 个顶点，按顺序排列
    g.meshes.push(p.mesh); groups.set(p.name, g);
  }
  const parts = [...groups.values()].map((g) => {
    const mesh = g.meshes.length === 1 ? g.meshes[0] : mergeMeshes(g.meshes);
    if (g.name === 'skin' && spec.skinTint === 'monkey') tintMonkey(ctx, mesh);
    return { name: g.name, ...mesh, material: g.material, ...(g.cloth ? { cloth: g.cloth } : {}) };
  });
  // 5) 受击胶囊（骨骼局部偏移；静止朝向为单位旋转）
  const hk = L.headK, capsules = [
    { tag: 'head', a: 'neck', b: 'head', bOff: [0, 0.12 * k * hk, 0], r: 0.115 * k * hk },
    { tag: 'torso', a: 'pelvis', b: 'chest', bOff: [0, 0.06 * k, 0], r: 0.17 * k * Math.max(L.hw, L.thick) },
    ...['L', 'R'].flatMap((s) => [
      { tag: 'arm', a: `upperArm_${s}`, b: `foreArm_${s}`, r: 0.05 * k }, { tag: 'arm', a: `foreArm_${s}`, b: `hand_${s}`, r: 0.04 * k },
      { tag: 'leg', a: `thigh_${s}`, b: `shin_${s}`, r: 0.09 * k * L.legT }, { tag: 'leg', a: `shin_${s}`, b: `foot_${s}`, r: 0.06 * k * L.legT },
    ]),
  ];
  let vertices = 0, triangles = 0;
  for (const p of parts) { vertices += p.positions.length / 3; triangles += p.indices.length / 3; }
  return { kind, name: spec.zh, height: L.H, seed, layout: { k, hipY: L.hipY, head: L.head, grip: L.J.grip }, skeleton: sk, parts, capsules, weapon, stats: { vertices, triangles, parts: parts.length } };
}


// ═════════════════════════════ 摆姿势 / 烘焙 ═════════════════════════════
const matMul = (a, b) => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8]];
const matVec = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
/** 欧拉(先 X 再 Y 再 Z，弧度) → 3×3 旋转矩阵 R = Rz·Ry·Rx，与 core 的 xf 同序 */
export function eulerMat(rx, ry, rz) {
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  const X = [1, 0, 0, 0, cx, -sx, 0, sx, cx], Y = [cy, 0, sy, 0, 1, 0, -sy, 0, cy], Z = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return matMul(Z, matMul(Y, X));
}
/** 骑马坐姿：大腿前屈并外展、膝弯、脚尖微翘；手臂保持静止（右手仍竖握兵器） */
export const RIDE_POSE = {
  bones: { thigh_L: [-1.32, 0.34, 0], thigh_R: [-1.32, -0.34, 0], shin_L: [1.12, 0, 0], shin_R: [1.12, 0, 0], foot_L: [0.18, 0, 0], foot_R: [0.18, 0, 0] },
};
/**
 * 把静止姿态的角色数据按 pose 摆出来（线性混合蒙皮，法线重算）。pose = { bones:{name:[rx,ry,rz]}, root?:[dx,dy,dz] }。
 * 返回新对象，原 data 不变；骨骼静止位置不变（蒙皮用）。
 */
export function poseData(data, pose) {
  const bones = data.skeleton.bones, n = bones.length, R = new Array(n), T = new Array(n), SR = new Array(n), ST = new Array(n);
  for (let i = 0; i < n; i++) {
    const b = bones[i], e = pose.bones?.[b.name] ?? [0, 0, 0], Rl = eulerMat(e[0], e[1], e[2]);
    const tl = b.parent >= 0 ? v3.sub(b.pos, bones[b.parent].pos) : b.pos;
    if (b.parent < 0) { R[i] = Rl; T[i] = v3.add(tl, pose.root ?? [0, 0, 0]); }
    else { R[i] = matMul(R[b.parent], Rl); T[i] = v3.add(matVec(R[b.parent], tl), T[b.parent]); }
    SR[i] = R[i]; ST[i] = v3.sub(T[i], matVec(R[i], b.pos));      // S(p) = W(p − pos_i)
  }
  const parts = data.parts.map((p) => {
    const nv = p.positions.length / 3, P = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      const x = p.positions[3 * v], y = p.positions[3 * v + 1], z = p.positions[3 * v + 2];
      let ax = 0, ay = 0, az = 0;
      for (let k = 0; k < 4; k++) {
        const w = p.skinWeight[4 * v + k]; if (w <= 0) continue;
        const i = p.skinIndex[4 * v + k], m = SR[i], t = ST[i];
        ax += w * (m[0] * x + m[1] * y + m[2] * z + t[0]); ay += w * (m[3] * x + m[4] * y + m[5] * z + t[1]); az += w * (m[6] * x + m[7] * y + m[8] * z + t[2]);
      }
      P[3 * v] = ax; P[3 * v + 1] = ay; P[3 * v + 2] = az;
    }
    return computeNormals({ ...p, positions: P, normals: new Float32Array(nv * 3) });
  });
  return { ...data, parts };
}

/**
 * 把角色合并烘焙为 ≤3 个网格（matte 哑光 / metal 金属 / gloss 眼睛），颜色全部进顶点色 → 每个角色只需 2~3 次绘制。
 * colorScale 用来把"低反照率"的 BIBLE 配色提亮以适配更亮的光照。蒙皮属性一并保留。
 */
export function bakeCharacter(data, { colorScale = 1 } = {}) {
  const groups = { matte: [], metal: [], gloss: [] };
  for (const p of data.parts) {
    const nv = p.positions.length / 3, C = new Float32Array(nv * 3), base = p.material.color;
    for (let i = 0; i < nv; i++) for (let c = 0; c < 3; c++) C[3 * i + c] = Math.min(1, (p.colors ? p.colors[3 * i + c] * base[c] : base[c]) * colorScale);
    const kind = p.material.kind;
    groups[kind === 'metal' ? 'metal' : kind === 'eye' ? 'gloss' : 'matte'].push({ ...p, colors: C });
  }
  const spec = {
    matte: { kind: 'matte', color: [1, 1, 1], roughness: 0.85, metalness: 0.02, side: 'double' },
    metal: { kind: 'metal', color: [1, 1, 1], roughness: 0.35, metalness: 0.85, side: 'front' },
    gloss: { kind: 'gloss', color: [1, 1, 1], roughness: 0.15, metalness: 0, side: 'front' },
  };
  const buckets = [];
  for (const [name, list] of Object.entries(groups)) if (list.length) buckets.push({ name, mesh: mergeMeshes(list), material: spec[name] });
  return { kind: data.kind, name: data.name, height: data.height, layout: data.layout, weapon: data.weapon, capsules: data.capsules, skeleton: data.skeleton, buckets };
}
