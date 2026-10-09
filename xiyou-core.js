// xiyou-core.js — 重走西游 · 建模核心（零依赖、纯数据，可在 Node / 浏览器 / Worker 中运行）
// 约定（与 BIBLE §0.1 一致）：单位米；+Y 向上；角色朝向 +Z；角色的"左侧" = +X。
// 所有网格都是 { positions, normals, uvs, indices[, colors, skinIndex, skinWeight] } 的 TypedArray 对象。

export const TAU = Math.PI * 2;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
/** 与 GLSL 用法一致，并允许 e0 > e1 的反向写法（BIBLE 中大量出现 smoothstep(16, 7, r)） */
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

// ───────────────────────── 向量（数组形式，够用即可）
export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  mirrorX: (a) => [-a[0], a[1], a[2]],
};

// ───────────────────────── 随机数 / 哈希
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

// ───────────────────────── 单形噪声（Gustavson），带种子；输出约 [-1,1]
const SC2 = 99.2;   // 单位梯度的 2D 单形噪声归一化系数（实测使峰值≈±1）
const G3 = new Float32Array([1,1,0, -1,1,0, 1,-1,0, -1,-1,0, 1,0,1, -1,0,1, 1,0,-1, -1,0,-1, 0,1,1, 0,-1,1, 0,1,-1, 0,-1,-1]);
export function makeNoise(seed = 1) {
  const rnd = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; const t = p[i]; p[i] = p[j]; p[j] = t; }
  const perm = new Uint8Array(512), pm12 = new Uint8Array(512), gx2 = new Float32Array(256), gy2 = new Float32Array(256);
  for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]; pm12[i] = perm[i] % 12; }
  for (let i = 0; i < 256; i++) { const a = rnd() * TAU; gx2[i] = Math.cos(a); gy2[i] = Math.sin(a); }
  const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6, F3 = 1 / 3, GG3 = 1 / 6;

  function simplex2(x, y) {
    const s = (x + y) * F2, i = Math.floor(x + s), j = Math.floor(y + s), t = (i + j) * G2;
    const x0 = x - (i - t), y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0, a = 0.5 - x0 * x0 - y0 * y0;
    if (a > 0) { const g = perm[ii + perm[jj]]; a *= a; n += a * a * (gx2[g] * x0 + gy2[g] * y0); }
    a = 0.5 - x1 * x1 - y1 * y1;
    if (a > 0) { const g = perm[ii + i1 + perm[jj + j1]]; a *= a; n += a * a * (gx2[g] * x1 + gy2[g] * y1); }
    a = 0.5 - x2 * x2 - y2 * y2;
    if (a > 0) { const g = perm[ii + 1 + perm[jj + 1]]; a *= a; n += a * a * (gx2[g] * x2 + gy2[g] * y2); }
    return SC2 * n;
  }

  function simplex3(x, y, z) {
    const s = (x + y + z) * F3, i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s), t = (i + j + k) * GG3;
    const x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    const x1 = x0 - i1 + GG3, y1 = y0 - j1 + GG3, z1 = z0 - k1 + GG3;
    const x2 = x0 - i2 + 2 * GG3, y2 = y0 - j2 + 2 * GG3, z2 = z0 - k2 + 2 * GG3;
    const x3 = x0 - 1 + 3 * GG3, y3 = y0 - 1 + 3 * GG3, z3 = z0 - 1 + 3 * GG3;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    let n = 0, a = 0.6 - x0 * x0 - y0 * y0 - z0 * z0, g;
    if (a > 0) { g = pm12[ii + perm[jj + perm[kk]]] * 3; a *= a; n += a * a * (G3[g] * x0 + G3[g + 1] * y0 + G3[g + 2] * z0); }
    a = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (a > 0) { g = pm12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3; a *= a; n += a * a * (G3[g] * x1 + G3[g + 1] * y1 + G3[g + 2] * z1); }
    a = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (a > 0) { g = pm12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3; a *= a; n += a * a * (G3[g] * x2 + G3[g + 1] * y2 + G3[g + 2] * z2); }
    a = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (a > 0) { g = pm12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3; a *= a; n += a * a * (G3[g] * x3 + G3[g + 1] * y3 + G3[g + 2] * z3); }
    return 32 * n;
  }

  /** 归一化 fBm，约 [-1,1]（BIBLE 中的 Ln） */
  function fbm2(x, y, oct = 4) {
    let s = 0, a = 1, f = 1, n = 0;
    for (let o = 0; o < oct; o++) { s += a * simplex2(x * f, y * f); n += a; a *= 0.5; f *= 2; }
    return s / n;
  }
  function fbm3(x, y, z, oct = 4) {
    let s = 0, a = 1, f = 1, n = 0;
    for (let o = 0; o < oct; o++) { s += a * simplex3(x * f, y * f, z * f); n += a; a *= 0.5; f *= 2; }
    return s / n;
  }
  /** 脊状多重分形，[0,1]（BIBLE 中的 Cf） */
  function ridged2(x, y, oct = 5) {
    let s = 0, a = 1, f = 1, w = 1, n = 0;
    for (let o = 0; o < oct; o++) {
      let r = 1 - Math.abs(simplex2(x * f, y * f)); r *= r; r *= w;
      w = clamp(r * 2, 0, 1); s += r * a; n += a; a *= 0.5; f *= 2;
    }
    return s / n;
  }
  function ridged3(x, y, z, oct = 4) {
    let s = 0, a = 1, f = 1, w = 1, n = 0;
    for (let o = 0; o < oct; o++) {
      let r = 1 - Math.abs(simplex3(x * f, y * f, z * f)); r *= r; r *= w;
      w = clamp(r * 2, 0, 1); s += r * a; n += a; a *= 0.5; f *= 2;
    }
    return s / n;
  }
  return { simplex2, simplex3, fbm2, fbm3, ridged2, ridged3 };
}

// ───────────────────────── 网格构建器
export class MeshBuilder {
  constructor() { this.p = []; this.uv = []; this.idx = []; }
  get count() { return this.p.length / 3; }
  vert(x, y, z, u = 0, v = 0) { this.p.push(x, y, z); this.uv.push(u, v); return this.p.length / 3 - 1; }
  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  build() {
    return computeNormals({ positions: new Float32Array(this.p), uvs: new Float32Array(this.uv), indices: new Uint32Array(this.idx) });
  }
}

const triArea2 = (P, a, b, c) => {
  const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
  const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx); // 2×面积
};

/** 按位置焊接后的面积加权法线：接缝/封口处共享位置的顶点法线一致 */
export function computeNormals(m) {
  const P = m.positions, I = m.indices, n = P.length / 3;
  const ids = new Int32Array(n), map = new Map();
  let g = 0;
  for (let i = 0; i < n; i++) {
    const key = Math.round(P[3 * i] * 1e4) + ',' + Math.round(P[3 * i + 1] * 1e4) + ',' + Math.round(P[3 * i + 2] * 1e4);
    let id = map.get(key);
    if (id === undefined) { id = g++; map.set(key, id); }
    ids[i] = id;
  }
  const acc = new Float64Array(g * 3);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
    const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const q of [a, b, c]) { const k = ids[q] * 3; acc[k] += nx; acc[k + 1] += ny; acc[k + 2] += nz; }
  }
  const N = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const k = ids[i] * 3, l = Math.hypot(acc[k], acc[k + 1], acc[k + 2]);
    if (l > 1e-20) { N[3 * i] = acc[k] / l; N[3 * i + 1] = acc[k + 1] / l; N[3 * i + 2] = acc[k + 2] / l; } else { N[3 * i + 1] = 1; }
  }
  m.normals = N;
  return m;
}

export function transformMesh(m, f) {
  const P = m.positions;
  for (let i = 0; i < P.length; i += 3) { const q = f([P[i], P[i + 1], P[i + 2]]); P[i] = q[0]; P[i + 1] = q[1]; P[i + 2] = q[2]; }
  return computeNormals(m);
}
/** 缩放 → 旋转(X,Y,Z 顺序，弧度) → 平移 */
export function xf(m, o = {}) {
  const s = Array.isArray(o.s) ? o.s : [o.s ?? 1, o.s ?? 1, o.s ?? 1];
  const [rx, ry, rz] = o.r ?? [0, 0, 0], t = o.t ?? [0, 0, 0];
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  return transformMesh(m, (p) => {
    let x = p[0] * s[0], y = p[1] * s[1], z = p[2] * s[2], u;
    u = y * cx - z * sx; z = y * sx + z * cx; y = u;
    u = x * cy + z * sy; z = -x * sy + z * cy; x = u;
    u = x * cz - y * sz; y = x * sz + y * cz; x = u;
    return [x + t[0], y + t[1], z + t[2]];
  });
}
/** 沿 X 镜像（翻转三角形绕序，保持法线朝外） */
export function mirrorX(m) {
  const P = m.positions, I = m.indices;
  for (let i = 0; i < P.length; i += 3) P[i] = -P[i];
  for (let t = 0; t < I.length; t += 3) { const b = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = b; }
  return computeNormals(m);
}
/** 按谓词删三角形（pred 收到三角形重心），并清理未用顶点 */
export function filterTris(m, pred) {
  const P = m.positions, I = m.indices, keep = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const cx = (P[3 * a] + P[3 * b] + P[3 * c]) / 3, cy = (P[3 * a + 1] + P[3 * b + 1] + P[3 * c + 1]) / 3, cz = (P[3 * a + 2] + P[3 * b + 2] + P[3 * c + 2]) / 3;
    if (pred([cx, cy, cz])) keep.push(a, b, c);
  }
  const remap = new Int32Array(P.length / 3).fill(-1);
  let n = 0;
  for (const v of keep) if (remap[v] < 0) remap[v] = n++;
  const out = { positions: new Float32Array(n * 3), uvs: new Float32Array(n * 2), indices: new Uint32Array(keep.length) };
  for (let v = 0; v < remap.length; v++) {
    const r = remap[v]; if (r < 0) continue;
    out.positions.set(P.subarray(3 * v, 3 * v + 3), 3 * r); out.uvs.set(m.uvs.subarray(2 * v, 2 * v + 2), 2 * r);
  }
  keep.forEach((v, i) => { out.indices[i] = remap[v]; });
  return computeNormals(out);
}
export function mergeMeshes(list) {
  let nv = 0, ni = 0;
  for (const m of list) { nv += m.positions.length / 3; ni += m.indices.length; }
  const out = { positions: new Float32Array(nv * 3), normals: new Float32Array(nv * 3), uvs: new Float32Array(nv * 2), indices: new Uint32Array(ni) };
  const hasC = list.every((m) => m.colors), hasS = list.every((m) => m.skinIndex);
  if (hasC) out.colors = new Float32Array(nv * 3);
  if (hasS) { out.skinIndex = new Uint16Array(nv * 4); out.skinWeight = new Float32Array(nv * 4); }
  let vo = 0, io = 0;
  for (const m of list) {
    const n = m.positions.length / 3;
    out.positions.set(m.positions, vo * 3); out.normals.set(m.normals, vo * 3); out.uvs.set(m.uvs, vo * 2);
    if (hasC) out.colors.set(m.colors, vo * 3);
    if (hasS) { out.skinIndex.set(m.skinIndex, vo * 4); out.skinWeight.set(m.skinWeight, vo * 4); }
    for (let k = 0; k < m.indices.length; k++) out.indices[io + k] = m.indices[k] + vo;
    vo += n; io += m.indices.length;
  }
  return out;
}
/** 逐顶点上色：fn(x,y,z,nx,ny,nz,u,v) → [r,g,b]（线性空间） */
export function colorize(m, fn) {
  const n = m.positions.length / 3, C = new Float32Array(n * 3), P = m.positions, N = m.normals, U = m.uvs;
  for (let i = 0; i < n; i++) {
    const c = fn(P[3 * i], P[3 * i + 1], P[3 * i + 2], N[3 * i], N[3 * i + 1], N[3 * i + 2], U[2 * i], U[2 * i + 1]);
    C[3 * i] = c[0]; C[3 * i + 1] = c[1]; C[3 * i + 2] = c[2];
  }
  m.colors = C;
  return m;
}

// ───────────────────────── 几何原语
/**
 * 沿一串"环"放样成管。ring = { c:[x,y,z], ra, rb, hint? }
 * 局部框架：t=相邻环切线；a = norm(hint × t)（横向，半径 ra）；b = t × a（≈hint 方向，半径 rb）。
 * (a,b,t) 为右手系，因此三角形法线朝外。
 * opts: sides=16, hint=[0,0,1], cap:'none'|'start'|'end'|'both', closed=false, mod(p, ringIdx, theta)→p
 */
export function loft(rings, opts = {}) {
  const sides = opts.sides ?? 16, hint0 = opts.hint ?? [0, 0, 1], n = rings.length, closed = !!opts.closed;
  const b = new MeshBuilder(), cap = opts.cap ?? 'none';
  const fr = rings.map((r, k) => {
    const pr = rings[closed ? (k - 1 + n) % n : Math.max(k - 1, 0)].c, nx = rings[closed ? (k + 1) % n : Math.min(k + 1, n - 1)].c;
    const t = v3.norm(v3.sub(nx, pr));
    const h = r.hint ?? hint0;
    let a = v3.cross(h, t);
    if (v3.len(a) < 1e-5) a = v3.cross([1, 0, 0], t);
    a = v3.norm(a);
    return { a, b: v3.cross(t, a) };
  });
  const ringStart = [];
  for (let k = 0; k < n; k++) {
    ringStart.push(b.count);
    const r = rings[k], f = fr[k];
    for (let s = 0; s <= sides; s++) {
      const th = TAU * s / sides, ca = Math.cos(th) * r.ra, sb = Math.sin(th) * r.rb;
      let p = [r.c[0] + f.a[0] * ca + f.b[0] * sb, r.c[1] + f.a[1] * ca + f.b[1] * sb, r.c[2] + f.a[2] * ca + f.b[2] * sb];
      if (opts.mod) p = opts.mod(p, k, th);
      b.vert(p[0], p[1], p[2], s / sides, r.v ?? k / Math.max(1, closed ? n : n - 1));
    }
  }
  const segs = closed ? n : n - 1;
  for (let k = 0; k < segs; k++) {
    const k2 = (k + 1) % n;
    for (let s = 0; s < sides; s++) {
      const A = ringStart[k] + s, B = A + 1, D = ringStart[k2] + s, C = D + 1;
      b.tri(A, B, C); b.tri(A, C, D);
    }
  }
  const addCap = (k, sign) => {
    const r = rings[k], c = b.vert(r.c[0], r.c[1], r.c[2], 0.5, 0.5);
    for (let s = 0; s < sides; s++) {
      const p0 = ringStart[k] + s, p1 = p0 + 1;
      if (sign > 0) b.tri(c, p0, p1); else b.tri(c, p1, p0);
    }
  };
  if (!closed && (cap === 'start' || cap === 'both')) addCap(0, -1);
  if (!closed && (cap === 'end' || cap === 'both')) addCap(n - 1, +1);
  return b.build();
}

/** 绕 Y 轴旋转体。profile=[[r,y],...] 自下而上（r>0 在外侧）；θ=0 指向 +Z。mod(localP, j, s)→p 在平移前作用 */
export function lathe(profile, opts = {}) {
  const sides = opts.sides ?? 16, c = opts.center ?? [0, 0, 0], m = profile.length, b = new MeshBuilder();
  for (let j = 0; j < m; j++) {
    for (let s = 0; s <= sides; s++) {
      const th = TAU * s / sides;
      let p = [profile[j][0] * Math.sin(th), profile[j][1], profile[j][0] * Math.cos(th)];
      if (opts.mod) p = opts.mod(p, j, s);
      b.vert(p[0] + c[0], p[1] + c[1], p[2] + c[2], s / sides, j / (m - 1));
    }
  }
  const P = b.p;
  for (let j = 0; j < m - 1; j++) {
    for (let s = 0; s < sides; s++) {
      const A = j * (sides + 1) + s, B = A + 1, D = (j + 1) * (sides + 1) + s, C = D + 1;
      if (triArea2(P, A, B, C) > 1e-14) b.tri(A, B, C);
      if (triArea2(P, A, C, D) > 1e-14) b.tri(A, C, D);
    }
  }
  return b.build();
}

/** 椭球。shape(u:[x,y,z]单位方向) → 相对中心的位置（可叠加五官位移）；缺省为 u*rad */
export function ellipsoid(c, rad, opts = {}) {
  const lat = opts.lat ?? 12, prof = [];
  for (let i = 0; i <= lat; i++) { const ph = Math.PI * i / lat; prof.push([Math.sin(ph), -Math.cos(ph)]); }
  return lathe(prof, {
    sides: opts.lon ?? 20, center: c,
    mod: (u) => (opts.shape ? opts.shape(u) : [u[0] * rad[0], u[1] * rad[1], u[2] * rad[2]]),
  });
}

/** 圆环（位于 XZ 平面、轴向 Y）。arc<TAU 时为开口弧并封口 */
export function torus(R, r, opts = {}) {
  const segs = opts.segs ?? 24, arc = opts.arc ?? TAU, full = arc >= TAU - 1e-6, rings = [];
  const cnt = full ? segs : segs + 1;
  for (let i = 0; i < cnt; i++) {
    const a = (opts.start ?? 0) + arc * i / (full ? segs : segs);
    rings.push({ c: [R * Math.sin(a), 0, R * Math.cos(a)], ra: r, rb: r, hint: [0, 1, 0] });
  }
  return loft(rings, { sides: opts.tube ?? 8, closed: full, cap: full ? 'none' : 'both' });
}

/** 二十面体细分球（单位球），level=0..5；顶点按位置去重 */
export function icosphere(level = 2) {
  const t = (1 + Math.sqrt(5)) / 2;
  let V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((v) => v3.norm(v));
  let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let l = 0; l < level; l++) {
    const cache = new Map(), nf = [];
    const mid = (a, b) => {
      const k = a < b ? a + '_' + b : b + '_' + a;
      let i = cache.get(k);
      if (i === undefined) { V.push(v3.norm(v3.lerp(V[a], V[b], 0.5))); i = V.length - 1; cache.set(k, i); }
      return i;
    };
    for (const [a, b, c] of F) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    F = nf;
  }
  const m = {
    positions: new Float32Array(V.length * 3), uvs: new Float32Array(V.length * 2), indices: new Uint32Array(F.length * 3),
  };
  V.forEach((v, i) => { m.positions.set(v, 3 * i); m.uvs[2 * i] = 0.5 + Math.atan2(v[0], v[2]) / TAU; m.uvs[2 * i + 1] = 0.5 + Math.asin(v[1]) / Math.PI; });
  F.forEach((f, i) => { m.indices.set(f, 3 * i); });
  return computeNormals(m);
}

// ───────────────────────── 校验 / 指纹
export function signedVolume(m) {
  const P = m.positions, I = m.indices; let v = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) + P[a + 1] * (P[b + 2] * P[c] - P[b] * P[c + 2]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return v / 6;
}
export function bounds(m) {
  const P = m.positions, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { if (P[i + k] < lo[k]) lo[k] = P[i + k]; if (P[i + k] > hi[k]) hi[k] = P[i + k]; }
  return { min: lo, max: hi };
}
/** 返回问题列表（空 = 通过）。opts.bones 给出时同时校验蒙皮 */
export function validateMesh(m, opts = {}) {
  const issues = [], n = m.positions.length / 3, maxDeg = opts.maxDegenerate ?? 0.02;
  for (const key of ['positions', 'normals', 'uvs', 'colors']) {
    const a = m[key]; if (!a) continue;
    for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) { issues.push(`${key}[${i}] 非有限数`); break; }
  }
  if (m.indices.length % 3) issues.push('索引数不是 3 的倍数');
  for (let i = 0; i < m.indices.length; i++) if (m.indices[i] >= n) { issues.push(`索引越界 ${m.indices[i]} >= ${n}`); break; }
  if (m.normals) for (let i = 0; i < n; i++) { const l = Math.hypot(m.normals[3 * i], m.normals[3 * i + 1], m.normals[3 * i + 2]); if (Math.abs(l - 1) > 1e-3) { issues.push(`法线非单位长 @${i}`); break; } }
  let deg = 0; const T = m.indices.length / 3;
  for (let t = 0; t < m.indices.length; t += 3) if (triArea2(m.positions, m.indices[t], m.indices[t + 1], m.indices[t + 2]) < 1e-12) deg++;
  if (T && deg / T > maxDeg) issues.push(`退化三角形占比 ${(deg / T * 100).toFixed(1)}% > ${maxDeg * 100}%`);
  if (opts.bones !== undefined && m.skinIndex) {
    for (let i = 0; i < n; i++) {
      let sum = 0, nz = 0;
      for (let k = 0; k < 4; k++) { const w = m.skinWeight[4 * i + k]; sum += w; if (w > 0) { nz++; if (m.skinIndex[4 * i + k] >= opts.bones) issues.push(`骨骼索引越界 @${i}`); } }
      if (Math.abs(sum - 1) > 1e-4) { issues.push(`权重和=${sum.toFixed(5)} @${i}`); break; }
      if (nz > 4) { issues.push('影响数 > 4'); break; }
    }
  }
  return issues;
}
/** 量化位置的 FNV-1a 指纹，用于确定性测试 */
export function hashMesh(m) {
  let h = 2166136261 >>> 0;
  const P = m.positions;
  for (let i = 0; i < P.length; i++) { h ^= Math.round(P[i] * 1e4) & 0xffffffff; h = Math.imul(h, 16777619) >>> 0; }
  for (let i = 0; i < m.indices.length; i++) { h ^= m.indices[i]; h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
