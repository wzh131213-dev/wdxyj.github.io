// xiyou-world.js — 重走西游 · 环境建模（纯数据、种子确定；接入 THREE 见 xiyou-three.js）
// 依据 BIBLE §4.1 高度函数 / §4.2 可分离网格 / §4.3 着色权重 / §4.6 岩石 / §3.2 远山环带。
// 道路 = 若干条折线控制点（Catmull-Rom），由你的"每局路网生成器"传入；本模块只负责把路压进地形、出 LUT、出权重。
import { TAU, clamp, lerp, smoothstep, v3, mulberry32, makeNoise, computeNormals, icosphere, bounds } from './xiyou-core.js';

export const SUN_DIR = v3.norm([-0.6, 0.165, -0.78]);
export const WIND_DIR = [0.62, 0.78];
export const DEFAULT_ROAD = [[-420, 130], [-220, 75], [-70, 38], [0, 30], [80, 12], [190, -55], [420, -150]];
/** 线性反照率（BIBLE §4.4 的目标范围） */
export const PALETTE = { lush: [0.08, 0.11, 0.035], dry: [0.20, 0.145, 0.055], dirt: [0.16, 0.12, 0.08], rock: [0.18, 0.17, 0.155] };

/** 由种子生成一条蜿蜒的路（控制点）；每局换种子即换路 */
export function generateRoad(seed, o = {}) {
  const rnd = mulberry32(seed), step = o.step ?? 110, n = o.points ?? 9, lim = o.limit ?? 520;
  let [x, z] = o.start ?? [-420, 130], head = o.heading ?? -0.25;
  const pts = [[x, z]];
  for (let i = 1; i < n; i++) {
    head += (rnd() - 0.5) * (o.turn ?? 0.7);
    if (Math.hypot(x, z) > lim) head += 0.5 * Math.sin(Math.atan2(-z, -x) - head);   // 出界则轻轻拐回中心
    x += Math.cos(head) * step; z += Math.sin(head) * step; pts.push([x, z]);
  }
  return pts;
}

function splineSamples(pts, step = 0.5) {
  const P = [pts[0], ...pts, pts[pts.length - 1]], dense = [];
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]], m = Math.max(8, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 0.1));
    for (let j = 0; j < m; j++) {
      const t = j / m, t2 = t * t, t3 = t2 * t;
      dense.push([0, 1].map((k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)));
    }
  }
  dense.push(P[P.length - 2]);
  const out = [dense[0]]; let acc = 0, next = step;
  for (let i = 1; i < dense.length; i++) {
    const d = Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]);
    while (acc + d >= next) { const t = (next - acc) / d; out.push([lerp(dense[i - 1][0], dense[i][0], t), lerp(dense[i - 1][1], dense[i][1], t)]); next += step; }
    acc += d;
  }
  return out;
}

/**
 * 地面：纯函数、种子确定。
 * opts = { seed, roads:[[x,z]...][] | null, hub:[x,z],
 *          swell:16 (大尺度起伏振幅 m), undul:3.0 / hummock:0.30 (中/小尺度起伏振幅 m，调小=更平缓), swellFreq:0.0035 / swellOct:4 (大起伏的基频与倍频数，基频调低=更宽缓), rim:{start,end,amp,square} (边缘山脊；square=按方形边界), boundAmp:6 (软边界抬升，0=关), pad:{inner:7,outer:16} (丘顶平台半径/过渡带外沿),
 *          palette:{lush,dry,dirt,rock} (线性反照率覆盖), dryBias:0 (<0 更绿) }
 * 返回 heightAt / normalAt / roadInfo / splatAt / colorAt / groundInfoAt / cavityAt / attachRocks
 */
export function makeGround(opts = {}) {
  const seed = opts.seed ?? 1, hub = opts.hub ?? [0, 0], nz = makeNoise(seed);
  const swellAmp = opts.swell ?? 16, swellFreq = opts.swellFreq ?? 0.0035, swellOct = opts.swellOct ?? 4, undulAmp = opts.undul ?? 3.0, humAmp = opts.hummock ?? 0.30, rimO = { start: 320, end: 900, amp: 70, square: false, ...(opts.rim ?? {}) }, boundAmp = opts.boundAmp ?? 6, padO = { inner: 7, outer: 16, ...(opts.pad ?? {}) }, dryBias = opts.dryBias ?? 0, pal = { ...PALETTE, ...(opts.palette ?? {}) };
  const Ln = (x, z, oct, ox = 0, oz = 0) => nz.fbm2(x + ox, z + oz, oct);
  const H0 = (x, z) => {
    const r = Math.hypot(x - hub[0], z - hub[1]);
    let H = swellAmp * Ln(x * swellFreq, z * swellFreq, swellOct) + undulAmp * Ln(x * 0.014, z * 0.014, 3, 31.7, -17.3) + humAmp * Ln(x * 0.07, z * 0.07, 2, -53.1, 11.9) + 4.2 * Math.exp(-((r / 40) ** 2));
    const rr = rimO.square ? Math.max(Math.abs(x - hub[0]), Math.abs(z - hub[1])) : r, rs = rimO.amp > 0 ? smoothstep(rimO.start, rimO.end, rr) : 0;
    if (rs > 0) {
      let rim = nz.ridged2(x * 0.004 + 7.7, z * 0.004 - 3.1, 5) * rimO.amp * rs;
      const cap = 0.7 * (110 + 40 * Ln(x * 0.002, z * 0.002, 1)) * (rimO.amp / 70);
      if (rim > cap) rim = cap + (rim - cap) * 0.35;
      H += rim;
    }
    return H;
  };
  const Hc = H0(hub[0], hub[1]);
  const Hpre = (x, z) => {                                   // 丘顶压平 + 边界抬升（无路）
    const r = Math.hypot(x - hub[0], z - hub[1]), c = smoothstep(padO.outer, padO.inner, r);
    let h = H0(x, z);
    if (c > 0) h = lerp(h, Hc + 0.03 * Ln(x * 0.5, z * 0.5, 1), c);
    // BIBLE 把"边界抬升"写在修路之后；因 lerp(a+b, g+b, w) = lerp(a, g, w) + b，把它并入 Hpre 结果等价，且让路面 LUT(grade) 与最终路面一致
    return boundAmp > 0 && r > 170 ? h + boundAmp * smoothstep(170, 240, r) * (0.6 + 0.4 * Ln(x * 0.01, z * 0.01, 1)) : h;
  };
  // ── 道路 LUT：0.5 m 采样 (x,z,s,grade)，grade 为沿线高度经 12 m 箱式滤波
  const roadsPts = opts.roads === null ? [] : (opts.roads ?? [DEFAULT_ROAD]);
  const roads = roadsPts.map((pts) => {
    if (!Array.isArray(pts) || pts.length < 2 || pts.some((q) => !(Number.isFinite(q[0]) && Number.isFinite(q[1])))) throw new RangeError('道路需要 ≥2 个有限的 [x,z] 控制点');
    const sm = splineSamples(pts, 0.5), n = sm.length, X = new Float32Array(n), Z = new Float32Array(n), S = new Float32Array(n), h = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { X[i] = sm[i][0]; Z[i] = sm[i][1]; S[i] = i * 0.5; h[i + 1] = h[i] + Hpre(X[i], Z[i]); }
    const G = new Float32Array(n);
    for (let i = 0; i < n; i++) { const lo = Math.max(0, i - 12), hi = Math.min(n - 1, i + 12); G[i] = (h[hi + 1] - h[lo]) / (hi - lo + 1); }
    return { x: X, z: Z, s: S, g: G, n, length: (n - 1) * 0.5 };
  });
  const CELL = 6, grid = new Map(), key = (cx, cz) => (cx + 4096) * 8192 + (cz + 4096);
  let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
  roads.forEach((rd, ri) => {
    for (let i = 0; i < rd.n; i++) {
      const k = key(Math.floor(rd.x[i] / CELL), Math.floor(rd.z[i] / CELL));
      let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(ri * 65536 + i);
      bx0 = Math.min(bx0, rd.x[i]); bx1 = Math.max(bx1, rd.x[i]); bz0 = Math.min(bz0, rd.z[i]); bz1 = Math.max(bz1, rd.z[i]);
    }
  });
  const scratch = { d: Infinity, g: 0, s: 0, road: -1 };
  /** 到最近道路的距离 d、该处路面高度 g、弧长 s（out 缺省复用同一个对象，调用方须立即取值） */
  function roadInfo(x, z, out = scratch) {
    out.d = Infinity; out.g = 0; out.s = 0; out.road = -1;
    if (!roads.length || x < bx0 - CELL || x > bx1 + CELL || z < bz0 - CELL || z > bz1 + CELL) return out;
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    let best = Infinity, bi = -1, br = -1;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const l = grid.get(key(cx + a, cz + b)); if (!l) continue;
      for (const code of l) { const r = code >> 16, i = code & 65535, dx = x - roads[r].x[i], dz = z - roads[r].z[i], d2 = dx * dx + dz * dz; if (d2 < best) { best = d2; bi = i; br = r; } }
    }
    if (br < 0) return out;
    const rd = roads[br]; let bd = Math.sqrt(best), bt = bi;
    for (const j of [bi - 1, bi]) {                         // 精确到线段
      if (j < 0 || j + 1 >= rd.n) continue;
      const ax = rd.x[j], az = rd.z[j], ex = rd.x[j + 1] - ax, ez = rd.z[j + 1] - az, t = clamp(((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez), 0, 1), d = Math.hypot(x - ax - ex * t, z - az - ez * t);
      if (d < bd) { bd = d; bt = j + t; }
    }
    const i0 = Math.floor(bt), i1 = Math.min(rd.n - 1, i0 + 1), f = bt - i0;
    out.d = bd; out.g = lerp(rd.g[i0], rd.g[i1], f); out.s = bt * 0.5; out.road = br;
    return out;
  }
  function heightAt(x, z) {
    let H = Hpre(x, z);
    const ri = roadInfo(x, z);
    if (ri.d < 4.5) H = lerp(H, ri.g, smoothstep(4.5, 1.6, ri.d) * 0.85) - 0.07 * smoothstep(1.3, 0.4, Math.abs(ri.d - 0.65));
    return H;
  }
  function normalAt(x, z, out = [0, 1, 0]) {
    const e = 0.3, hx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e), hz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e), l = Math.hypot(hx, 1, hz);
    out[0] = -hx / l; out[1] = 1 / l; out[2] = -hz / l;
    return out;
  }
  const cavityAt = (x, z, h = heightAt(x, z)) => {
    const a = (heightAt(x + 3.5, z) + heightAt(x - 3.5, z) + heightAt(x, z + 3.5) + heightAt(x, z - 3.5)) / 4, b = (heightAt(x + 11, z) + heightAt(x - 11, z) + heightAt(x, z + 11) + heightAt(x, z - 11)) / 4;
    return clamp((a - h) * 0.2 + (b - h) * 0.035, 0, 0.55);
  };
  let colliders = [];
  /** §4.3 着色权重 [lush, dry, rock, dirt]（和为 1） */
  function splatAt(x, z, n = normalAt(x, z), cav = 0) {
    const r = Math.hypot(x - hub[0], z - hub[1]), O = nz.simplex2(x * 0.06, z * 0.06), Lm = Ln(x * 0.017, z * 0.017, 3);
    let dB = Infinity; for (const c of colliders) dB = Math.min(dB, Math.hypot(x - c.x, z - c.z) - c.r);
    let R = Math.max(smoothstep(0.26 + 0.08 * O, 0.45, 1 - n[1]), smoothstep(0.4, -0.4, dB));
    let D = Math.max(smoothstep(3.4, 1.4, roadInfo(x, z).d), smoothstep(1.6, 0.6, dB) * 0.8, smoothstep(18, 8, r) * 0.35 * (0.5 + 0.5 * Lm));
    let Y = clamp(0.55 + 0.9 * Ln(x * 0.012, z * 0.012, 3) + 0.25 * (n[0] * -SUN_DIR[0] + n[2] * -SUN_DIR[2]) - 0.6 * cav + dryBias, 0, 1);
    D *= 1 - R; Y *= (1 - R) * (1 - D);
    const lush = (1 - R) * (1 - D) * (1 - Y), s = lush + Y + R + D;
    return [lush / s, Y / s, R / s, D / s];
  }
  function colorAt(x, z, n = normalAt(x, z), cav = 0) {
    const w = splatAt(x, z, n, cav), v = 1 + 0.12 * Ln(x * 0.3, z * 0.3, 2), c = [0, 0, 0];
    [pal.lush, pal.dry, pal.rock, pal.dirt].forEach((p, i) => { for (let k = 0; k < 3; k++) c[k] += w[i] * p[k]; });
    return [c[0] * v, c[1] * v, c[2] * v];
  }
  /** §4.3 tGround：草密度 / 高度系数 / 湿润度 / 洼地 AO */
  function groundInfoAt(x, z) {
    const n = normalAt(x, z), cav = cavityAt(x, z), w = splatAt(x, z, n, cav), r = Math.hypot(x - hub[0], z - hub[1]), pad = smoothstep(18, 8, r);
    const density = (1 - w[2]) * (1 - smoothstep(0.3, 0.7, w[3])) * (0.55 + 0.45 * Ln(x * 0.05, z * 0.05, 1));
    const moisture = clamp(cav * 1.6 + 0.3 * Ln(x * 0.01, z * 0.01, 1) - w[1] * 0.5, 0, 1);
    const hf = 0.35 + 0.65 * smoothstep(-0.2, 0.6, Ln(x * 0.02, z * 0.02, 2) + moisture * 0.4) * (1 - 0.7 * pad);
    return { density: clamp(density, 0, 1), heightFactor: hf, moisture, ao: 1 - cav };
  }
  return { seed, hub, Hc, roads, heightAt, normalAt, roadInfo, splatAt, colorAt, groundInfoAt, cavityAt, attachRocks(c) { colliders = c; } };
}

// ═════════════════════════════ 地形网格（§4.2） ═════════════════════════════
/** 可分离网格轴：|x|≤inner 内均匀 step（427 列），之外按 growth 几何增长到 ±outer */
export function makeAxis({ inner = 160, step = 0.75, growth = 1.045, outer = 1500 } = {}) {
  const n = Math.floor(inner / step), mid = [];
  for (let i = -n; i <= n; i++) mid.push(i * step);
  const right = []; let x = n * step, d = step;
  while (x < outer) { d *= growth; x = Math.min(outer, x + d); right.push(x); }
  return Float64Array.from([...right.slice().reverse().map((v) => -v), ...mid, ...right]);
}
/** 只采样高度（约 14 万次求值，亚秒级）：游戏用它做"与渲染网格严格一致"的 terrainHeight */
export function sampleHeights(ground, axis = makeAxis()) {
  const nx = axis.length, H = new Float32Array(nx * nx);
  for (let j = 0; j < nx; j++) for (let i = 0; i < nx; i++) H[j * nx + i] = ground.heightAt(axis[i], axis[j]);
  return { axis, cols: nx, rows: nx, heights: H };
}
/** 顶点 = 解析高度(或 o.heights 复用)；法线 = 解析 normalAt（o.gridNormals=true 时改用栅格差分）；颜色 = 着色权重烘出的远景反照率；棋盘格对角线 */
export function buildTerrain(ground, o = {}) {
  const ax = o.axis ?? makeAxis(o.axisOpts), nx = ax.length, nv = nx * nx;
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), C = o.colors === false ? null : new Float32Array(nv * 3), tmp = [0, 1, 0];
  for (let j = 0; j < nx; j++) {
    for (let i = 0; i < nx; i++) {
      const x = ax[i], z = ax[j], k = j * nx + i, y = o.heights ? o.heights[k] : ground.heightAt(x, z);
      P[3 * k] = x; P[3 * k + 1] = y; P[3 * k + 2] = z;
      if (o.gridNormals && o.heights) {                       // 与几何一致的栅格差分法线（不额外求值，约快 4 倍）
        const H = o.heights, i0 = i > 0 ? i - 1 : i, i1 = i < nx - 1 ? i + 1 : i, j0 = j > 0 ? j - 1 : j, j1 = j < nx - 1 ? j + 1 : j;
        const gx = (H[j * nx + i1] - H[j * nx + i0]) / (ax[i1] - ax[i0]), gz = (H[j1 * nx + i] - H[j0 * nx + i]) / (ax[j1] - ax[j0]), l = Math.hypot(gx, 1, gz);
        tmp[0] = -gx / l; tmp[1] = 1 / l; tmp[2] = -gz / l;
      } else ground.normalAt(x, z, tmp);
      N[3 * k] = tmp[0]; N[3 * k + 1] = tmp[1]; N[3 * k + 2] = tmp[2];
      if (C) { const c = ground.colorAt(x, z, tmp, Math.abs(x) < 200 && Math.abs(z) < 200 && o.cavity !== false ? ground.cavityAt(x, z, y) : 0); C[3 * k] = c[0]; C[3 * k + 1] = c[1]; C[3 * k + 2] = c[2]; }
    }
  }
  const I = new Uint32Array(6 * (nx - 1) * (nx - 1));
  let t = 0;
  for (let j = 0; j < nx - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, d = a + nx, c = d + 1;
      if ((i + j) & 1) { I[t++] = a; I[t++] = d; I[t++] = c; I[t++] = a; I[t++] = c; I[t++] = b; }
      else { I[t++] = a; I[t++] = d; I[t++] = b; I[t++] = b; I[t++] = d; I[t++] = c; }
    }
  }
  const m = { positions: P, normals: N, indices: I, axis: ax, cols: nx, rows: nx };
  if (C) m.colors = C;
  return m;
}
/** 在网格上按其真实三角划分取高度。m 可以是 buildTerrain 的结果，也可以是 sampleHeights 的结果；坐标越界时夹到边缘 */
export function terrainHeightFromMesh(m, x, z) {
  const ax = m.axis, nx = m.cols, H = m.heights, P = m.positions, find = (v) => { let lo = 0, hi = ax.length - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ax[mid] <= v) lo = mid; else hi = mid; } return lo; };
  x = clamp(x, ax[0], ax[nx - 1]); z = clamp(z, ax[0], ax[nx - 1]);
  const i = find(x), j = find(z), u = (x - ax[i]) / (ax[i + 1] - ax[i]), v = (z - ax[j]) / (ax[j + 1] - ax[j]), Y = H ? (ii, jj) => H[jj * nx + ii] : (ii, jj) => P[3 * (jj * nx + ii) + 1];
  const ya = Y(i, j), yb = Y(i + 1, j), yd = Y(i, j + 1), yc = Y(i + 1, j + 1);
  if ((i + j) & 1) return u >= v ? ya + u * (yb - ya) + v * (yc - yb) : ya + v * (yd - ya) + u * (yc - yd);   // 对角线 a–c
  return u + v <= 1 ? ya + u * (yb - ya) + v * (yd - ya) : yc + (1 - u) * (yd - yc) + (1 - v) * (yb - yc);          // 对角线 b–d
}

// ═════════════════════════════ 岩石（§4.6） ═════════════════════════════
/** 6 个原型：二十面体细分球 + 脊状 3D fBm·0.35 + 层理台阶噪声，底部压平，法线重算；hi / lo 两档 LOD 同形 */
export function makeRockPrototypes({ seed = 777, hi = 4, lo = 2 } = {}) {
  return Array.from({ length: 6 }, (_, p) => {
    const nz = makeNoise(seed + p * 13), rnd = mulberry32(seed + p * 31);
    const asp = [1 + 0.25 * (rnd() - 0.5), 0.7 + 0.3 * rnd(), 1 + 0.25 * (rnd() - 0.5)], strata = 0.02 + 0.03 * rnd(), kk = 3.5 + 3 * rnd(), off = rnd() * 50;
    const build = (level) => {
      const m = icosphere(level), P = m.positions;
      for (let i = 0; i < P.length; i += 3) {
        const ux = P[i], uy = P[i + 1], uz = P[i + 2], t = uy * kk + 0.9 * nz.simplex3(ux * 1.3 + off, uy * 1.3, uz * 1.3);
        const r = 1 + 0.35 * (nz.ridged3(ux * 1.7 + off, uy * 1.7, uz * 1.7, 4) - 0.45) + strata * (t - Math.floor(t) - 0.5);
        let y = uy * r * asp[1]; const yf = -0.5 * asp[1];
        if (y < yf) y = yf + (y - yf) * 0.12;                 // 压平底部
        P[i] = ux * r * asp[0]; P[i + 1] = y; P[i + 2] = uz * r * asp[2];
      }
      return computeNormals(m);
    };
    const hiM = build(hi), loM = build(lo), b = bounds(hiM);
    return { id: p, hi: hiM, lo: loM, asp, ymin: b.min[1], ymax: b.max[1], radius: Math.max(b.max[0], b.max[2], -b.min[0], -b.min[2]) };
  });
}
/** 列主序 4×4：T · R(对齐法线, 绕法线偏航) · S */
export function composeMatrix(pos, yaw, sc, n = [0, 1, 0]) {
  const f0 = [Math.sin(yaw), 0, Math.cos(yaw)], right = v3.norm(v3.cross(n, f0)), fwd = v3.cross(right, n), m = new Float32Array(16);
  m.set([right[0] * sc[0], right[1] * sc[0], right[2] * sc[0], 0, n[0] * sc[1], n[1] * sc[1], n[2] * sc[1], 0, fwd[0] * sc[2], fwd[1] * sc[2], fwd[2] * sc[2], 0, pos[0], pos[1], pos[2], 1]);
  return m;
}
/** 摆放（seed 777）：5–12 主石 + 每块 3–9 碎石(±2.2 m) + 2–3 立石(y×2.5) + 远处坡面露头；全部 normal.y≥0.72、下沉 25–50% */
export function placeRocks(ground, protos, { seed = 777 } = {}) {
  const rnd = mulberry32(seed), inst = [], coll = [], hub = ground.hub;
  const find = (gen, minRoad, tries = 60) => {
    for (let t = 0; t < tries; t++) { const [x, z] = gen(), n = ground.normalAt(x, z); if (n[1] >= 0.72 && ground.roadInfo(x, z).d > minRoad) return { x, z, n }; }
    return null;
  };
  const add = (kind, proto, x, z, n, radius, ySquash, align) => {
    const p = protos[proto], sc = [radius, radius * ySquash, radius * (0.8 + 0.4 * rnd())], sink = 0.25 + 0.25 * rnd(), g = ground.heightAt(x, z), hProto = (p.ymax - p.ymin) * sc[1];
    const y = g - sink * hProto - p.ymin * sc[1], yaw = rnd() * TAU;
    inst.push({ kind, proto, x, y, z, scale: sc, yaw, sink, groundY: g, normalY: n[1], matrix: composeMatrix([x, y, z], yaw, sc, align ? n : [0, 1, 0]) });
    return radius;
  };
  const nHero = 5 + Math.floor(rnd() * 8);
  for (let h = 0; h < nHero; h++) {
    const edge = h < Math.ceil(nHero / 3), radius = 1.5 + rnd() * 2.5;
    const spot = find(() => { const a = rnd() * TAU, r = edge ? 18 + rnd() * 22 : 40 + rnd() * 110; return [hub[0] + Math.cos(a) * r, hub[1] + Math.sin(a) * r]; }, radius + 3);
    if (!spot) continue;
    add('hero', Math.floor(rnd() * 6), spot.x, spot.z, spot.n, radius, 0.7 + 0.3 * rnd(), false);
    coll.push({ x: spot.x, z: spot.z, r: radius * 0.9 });
    const nd = 3 + Math.floor(rnd() * 7);
    for (let d = 0; d < nd; d++) {
      const s = find(() => [spot.x + (rnd() * 2 - 1) * 2.2, spot.z + (rnd() * 2 - 1) * 2.2], 1.5, 12);
      if (s) add('debris', Math.floor(rnd() * 6), s.x, s.z, s.n, 0.15 + rnd() * 0.45, 0.6 + 0.4 * rnd(), false);
    }
  }
  const road = ground.roads[0], nStand = 2 + Math.floor(rnd() * 2);
  for (let s = 0; road && s < nStand; s++) {
    const spot = find(() => {
      const i = Math.floor(rnd() * road.n), j = Math.min(road.n - 1, i + 1), tx = road.x[j] - road.x[i], tz = road.z[j] - road.z[i], l = Math.hypot(tx, tz) || 1, side = (rnd() < 0.5 ? -1 : 1) * (4 + rnd() * 4);
      return [road.x[i] - (tz / l) * side, road.z[i] + (tx / l) * side];
    }, 3, 80);
    if (!spot) continue;
    const radius = 0.5 + rnd() * 0.4;
    add('standing', Math.floor(rnd() * 6), spot.x, spot.z, spot.n, radius, 2.5, false);
    coll.push({ x: spot.x, z: spot.z, r: radius });
  }
  for (let t = 0, got = 0; t < 600 && got < 24; t++) {                                // 远处陡坡露头，对齐地面法线
    const a = rnd() * TAU, r = 300 + rnd() * 400, x = hub[0] + Math.cos(a) * r, z = hub[1] + Math.sin(a) * r, n = ground.normalAt(x, z);
    if (n[1] < 0.8) { add('outcrop', Math.floor(rnd() * 6), x, z, n, 3 + rnd() * 5, 0.6 + 0.3 * rnd(), true); got++; }
  }
  ground.attachRocks(coll);
  return { instances: inst, colliders: coll };
}

// ═════════════════════════════ 远山环带（§3.2） ═════════════════════════════
export const MOUNTAIN_LAYERS = [
  { radius: 1800, H: 160, base: -10, depth: 260, haze: 0.30 },
  { radius: 2400, H: 320, base: -20, depth: 360, haze: 0.50 },
  { radius: 3200, H: 520, base: -40, depth: 500, haze: 0.66, snow: true },
  { radius: 4200, H: 780, base: -60, depth: 500, haze: 0.78 },
];
const wrapPI = (a) => a - TAU * Math.floor((a + Math.PI) / TAU);
/** 4 层 360° 环带（各 481×11 顶点）；颜色已烘入 森林→岩石→雪 反照率、环境+日照、雾霾混合（公式见 BIBLE §3.2） */
export function buildMountainRings({ seed = 5, sunDir = SUN_DIR, fogColor = [0.50, 0.42, 0.33], layers = MOUNTAIN_LAYERS, cols = 480, rows = 10, bake = true, albedoScale = 1 } = {}) {
  const nz = makeNoise(seed), thSun = Math.atan2(sunDir[0], sunDir[2]);
  return layers.map((Ly, li) => {
    const nC = cols + 1, nR = rows + 1, nv = nC * nR, P = new Float32Array(nv * 3), UV = new Float32Array(nv * 2), relH = new Float32Array(nv), fb = new Float32Array(nv);
    for (let i = 0; i < nC; i++) {
      const th = (TAU * i) / cols, cx = Math.cos(th) * 2.45, sx = Math.sin(th) * 2.45, d = Math.abs(wrapPI(th - thSun));
      const notch = 1 - 0.55 * Math.exp(-((d / 0.2) ** 2)), az = 0.65 + 0.35 * smoothstep(0.3, 1.2, d);
      for (let j = 0; j < nR; j++) {
        const E = j / rows, k = i * nR + j, rid = nz.ridged3(cx + li * 13.1, sx - li * 7.7, E * 1.2 + li * 3.3, 6), f = nz.fbm3(cx * 1.3 + 5.5 + li, sx * 1.3 - 2.2, E * 1.1 + 9.9, 3);
        const amp = (0.25 + 0.95 * rid * (0.55 + 0.45 * f)) * notch * az * Math.sin(Math.min(1, E * 2.2 + 0.05) * Math.PI / 2), R = Ly.radius + Ly.depth * E;
        P[3 * k] = R * Math.sin(th); P[3 * k + 1] = Ly.base + Ly.H * amp; P[3 * k + 2] = R * Math.cos(th);
        UV[2 * k] = i / cols; UV[2 * k + 1] = E; relH[k] = clamp(amp, 0, 1); fb[k] = f;
      }
    }
    const I = new Uint32Array(6 * cols * rows); let t = 0;
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) { const a = i * nR + j, b = (i + 1) * nR + j, c = b + 1, d = a + 1; I[t++] = a; I[t++] = c; I[t++] = b; I[t++] = a; I[t++] = d; I[t++] = c; }
    const m = computeNormals({ positions: P, uvs: UV, indices: I }), C = new Float32Array(nv * 3), N = m.normals, snow = new Uint8Array(nv);
    for (let i = 0; i < nC; i++) {
      const th = (TAU * i) / cols, anti = Math.abs(wrapPI(th - thSun - Math.PI)) < 0.873;
      for (let j = 0; j < nR; j++) {
        const k = i * nR + j, h = relH[k], ny = N[3 * k + 1], tt = smoothstep(0.1, 0.8, h);
        let alb = [lerp(0.035, 0.09, tt), lerp(0.05, 0.085, tt), lerp(0.045, 0.08, tt)];
        if (Ly.snow && anti && h > 0.62 + 0.1 * fb[k] && ny > 0.55) { alb = [0.8, 0.8, 0.82]; snow[k] = 1; } else if (albedoScale !== 1) alb = alb.map((v) => Math.min(1, v * albedoScale));
        const ndl = Math.max(0, N[3 * k] * sunDir[0] + ny * sunDir[1] + N[3 * k + 2] * sunDir[2]), amb = [0.30, 0.38, 0.46], sun = [3.3, 3.3 * 0.74, 3.3 * 0.47];
        const haze = Math.min(0.985, Ly.haze + (1 - Ly.haze) * (1 - smoothstep(0, 0.55, h)) * 0.65 + (1 - h) * 0.08);
        if (!bake) { for (let c = 0; c < 3; c++) C[3 * k + c] = alb[c]; continue; }
        for (let c = 0; c < 3; c++) {
          const lit = alb[c] * (amb[c] * (0.55 + 0.45 * ny) + sun[c] * ndl * 0.55) + Math.pow(ndl, 3) * 0.02 * h;
          C[3 * k + c] = lerp(lit, fogColor[c], haze);
        }
      }
    }
    m.colors = C; m.relH = relH; m.snow = snow; m.cols = nC; m.rows = nR; m.layer = li; m.haze = Ly.haze; m.radius = Ly.radius;
    return m;
  });
}
