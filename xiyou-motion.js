// xiyou-motion.js — 重走西游 · 人物动态与物理仿真（纯数学，零 THREE 依赖）
// 内容：阻尼弹簧 / 程序化呼吸·微动·眨眼 / 白龙马步态 / 骑手鞍座阻尼跟随 / 风场 / 通用 Verlet(PBD) 布料毛发仿真器。
// 约定：矩阵为列主序 4×4（与 THREE.Matrix4.elements 相同）；骨骼静止朝向为单位旋转，动画 = 相对静止姿态的欧拉偏移。
import { TAU, clamp, lerp, smoothstep, mulberry32 } from './xiyou-core.js';
import { WIND_DIR } from './xiyou-world.js';

/** Unity 风格临界阻尼平滑。st = { v:0 } 保存速度；返回新值 */
export function smoothDamp(cur, target, st, smoothTime, dt, maxSpeed = Infinity) {
  smoothTime = Math.max(1e-4, smoothTime);
  const w = 2 / smoothTime, x = w * dt, e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x), maxChange = maxSpeed * smoothTime;
  const change = clamp(cur - target, -maxChange, maxChange), tgt = cur - change, temp = (st.v + w * change) * dt;
  st.v = (st.v - w * temp) * e;
  let out = tgt + (change + temp) * e;
  if (target - cur > 0 === out > target) { out = target; st.v = dt > 0 ? (out - target) / dt : 0; }
  return out;
}
const expo = (lambda, dt) => 1 - Math.exp(-lambda * dt);
const safeDt = (dt, max) => (Number.isFinite(dt) ? clamp(dt, 0, max) : 0);       // NaN/负数/超大 → 0 或上限
const h3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);                        // 比 Math.hypot 快得多，热循环里用

// ═════════════════════════════ 程序化呼吸 / 微动 / 眨眼 ═════════════════════════════
/**
 * 非移动状态下的自然起伏：spine1→spine2→chest→head 依次带相位滞后的正弦旋转（吸气时脊柱微后仰、胸廓扩张、肩略抬），
 * 头部周期性随机轻转（临界阻尼平滑），眨眼（偶有连眨）与眼球微扫视。确定性：同 seed 同序列。
 * update(dt, still) 返回复用的 pose 对象：骨骼名 → [rx,ry,rz]（弧度），另有 chestScale、blink(0 睁..1 闭)、eyeX/eyeY(-1..1)。
 */
export class IdleAnimator {
  constructor(seed = 1, o = {}) {
    this.rnd = mulberry32((seed >>> 0) || 1); this.o = { breathHz: 0.22, headYaw: 0.17, ...o };
    this.t = 0; this.ph = this.rnd() * TAU; this.w = 1;
    this.head = { ty: 0, tp: 0, y: 0, p: 0, sy: { v: 0 }, sp: { v: 0 }, next: 0.8 + this.rnd() * 1.5 };
    this.blink = { next: 1.2 + this.rnd() * 3, t: -1, again: false };
    this.eye = { tx: 0, ty: 0, x: 0, y: 0, next: 0.6 };
    this.pose = { spine1: [0, 0, 0], spine2: [0, 0, 0], chest: [0, 0, 0], head: [0, 0, 0], clavL: [0, 0, 0], clavR: [0, 0, 0], chestScale: 0, blink: 0, eyeX: 0, eyeY: 0, weight: 1 };
  }
  update(dt, still = true) {
    dt = safeDt(dt, 0.1); this.t += dt; this.w += ((still ? 1 : 0) - this.w) * expo(5, dt);
    const w = this.w, bw = 0.4 + 0.6 * w, o = this.o, P = this.pose;
    this.ph += TAU * o.breathHz * (1 + 0.08 * Math.sin(0.13 * this.t)) * dt;
    const b = (lag) => Math.sin(this.ph - lag) + 0.18 * Math.sin(2 * (this.ph - lag) + 0.6);          // 吸气略快于呼气
    P.spine1[0] = -0.006 * b(0) * bw; P.spine2[0] = -0.009 * b(0.35) * bw; P.chest[0] = -0.012 * b(0.7) * bw;
    P.clavL[2] = 0.012 * b(0.7) * bw; P.clavR[2] = -0.012 * b(0.7) * bw; P.chestScale = 0.006 * b(0.7) * bw;
    // 头部：周期性随机轻转 + 缓慢微摆
    const H = this.head; H.next -= dt;
    if (H.next <= 0) { H.ty = clamp((this.rnd() - 0.5) * 2 * o.headYaw * (0.4 + 0.6 * this.rnd()), -0.22, 0.22); H.tp = (this.rnd() - 0.5) * 0.07; H.next = 2.2 + this.rnd() * 3.8; }
    H.y = smoothDamp(H.y, H.ty, H.sy, 0.32, dt); H.p = smoothDamp(H.p, H.tp, H.sp, 0.4, dt);
    const sway = 0.012 * Math.sin(0.55 * this.t) * w;
    P.head[1] = H.y * w + sway; P.head[0] = H.p * w - 0.008 * b(1.0) * bw; P.head[2] = 0.006 * Math.sin(0.37 * this.t + 1) * w;
    // 眨眼
    const K = this.blink; K.next -= dt;
    if (K.t < 0 && K.next <= 0) { K.t = 0; K.again = this.rnd() < 0.18; }
    let closure = 0;
    if (K.t >= 0) { K.t += dt; const u = K.t / 0.15; if (u >= 1) { K.t = -1; K.next = K.again ? 0.12 : 2.4 + this.rnd() * 4; K.again = false; } else closure = Math.pow(Math.sin(Math.PI * u), 1.5); }
    P.blink = closure;
    // 视线聚焦：眼球微扫视
    const E = this.eye; E.next -= dt;
    if (E.next <= 0) { E.tx = (this.rnd() - 0.5) * 2; E.ty = (this.rnd() - 0.5) * 1.2; E.next = 0.6 + this.rnd() * 1.8; }
    E.x += (E.tx - E.x) * expo(14, dt); E.y += (E.ty - E.y) * expo(14, dt); P.eyeX = E.x; P.eyeY = E.y; P.weight = w;
    return P;
  }
}

// ═════════════════════════════ 白龙马步态 ═════════════════════════════
const WALK_OFF = [0.0, 0.25, 0.5, 0.75];   // [后左, 前左, 后右, 前右]：侧序四拍 LH→LF→RH→RF
const TROT_OFF = [0.5, 0.0, 0.0, 0.5];     // 对角小跑：LF+RH 同相，RF+LH 同相
/**
 * 四蹄步态：相位连续积分（变速不跳变），走(侧序四拍)↔小跑(对角)按速度平滑混合；每条腿 髋摆(+前) 与 膝折(负=小腿后折)。
 * out = { legs:[{hip,knee}×4], bob, pitch(绕本地Z,+抬头), roll(绕本地X), phase, blend, amp }
 */
export class GaitModel {
  constructor() { this.phase = 0; this.blend = 0; this.amp = 0; this.out = { legs: [0, 1, 2, 3].map(() => ({ hip: 0, knee: 0 })), bob: 0, pitch: 0, roll: 0, phase: 0, blend: 0, amp: 0 }; }
  step(dt, speed, moving) {
    dt = safeDt(dt, 0.1); speed = Number.isFinite(speed) ? Math.max(0, speed) : 0;
    const ampT = moving ? clamp(0.4 + speed / 9, 0.4, 1) : 0, blendT = moving ? smoothstep(7, 11, speed) : 0;
    this.amp += (ampT - this.amp) * expo(moving ? 6 : 9, dt); this.blend += (blendT - this.blend) * expo(3, dt);
    this.phase = (this.phase + clamp(0.8 + 0.085 * speed, 0.8, 2.3) * dt * (moving || this.amp > 0.02 ? 1 : 0)) % 1;
    const o = this.out, bl = this.blend, am = this.amp, beta = lerp(0.62, 0.45, bl), A = lerp(0.30, 0.42, bl) * am;
    for (let i = 0; i < 4; i++) {
      const s = (this.phase + lerp(WALK_OFF[i], TROT_OFF[i], bl) + 4) % 1, L = o.legs[i], front = i === 1 || i === 3;
      if (s < beta) { const u = s / beta; L.hip = A * Math.cos(Math.PI * u); L.knee = -0.08 * am * Math.sin(Math.PI * u); }
      else { const v = (s - beta) / (1 - beta); L.hip = -A * Math.cos(Math.PI * v); L.knee = -(front ? 1.0 : 0.85) * am * Math.pow(Math.sin(Math.PI * v), 1.3); }
    }
    o.bob = lerp(0.035, 0.075, bl) * am * Math.sin(4 * Math.PI * this.phase + 0.6);
    o.pitch = lerp(0.018, 0.024, bl) * am * Math.sin(4 * Math.PI * this.phase + 1.2);
    o.roll = 0.014 * (1 - 0.6 * bl) * am * Math.sin(TAU * this.phase + Math.PI / 3);
    o.phase = this.phase; o.blend = bl; o.amp = am;
    return o;
  }
}

// ═════════════════════════════ 骑手鞍座阻尼跟随 ═════════════════════════════
/**
 * 骑手随马鞍起伏的二阶阻尼：y'' = -2ζω·y' - ω²·y - a_anchor（锚点加速度作为扰动），位移与俯仰都夹紧在小范围内，
 * 既有"软座"的滞后感，又保证臀部始终贴在鞍上（不穿模、不悬空）。返回 { dy, dpitch }（相对锚点的修正量）。
 */
export class SaddleFollow {
  constructor(o = {}) { this.w = o.omega ?? 15; this.z = o.zeta ?? 0.9; this.maxY = o.maxY ?? 0.05; this.maxP = o.maxPitch ?? 0.06; this.reset(); this.out = { dy: 0, dpitch: 0 }; }
  reset() { this.y = 0; this.vy = 0; this.p = 0; this.vp = 0; this.pa = null; this.pp = null; this.lvy = 0; this.lvp = 0; this.fy = 0; this.fp = 0; }
  step(dt, anchorY, anchorPitch) {
    dt = Number.isFinite(dt) ? clamp(dt, 1e-4, 0.05) : 1 / 60;
    if (this.pa === null) { this.pa = anchorY; this.pp = anchorPitch; }
    const vy = (anchorY - this.pa) / dt, vp = (anchorPitch - this.pp) / dt;
    this.fy += ((vy - this.lvy) / dt - this.fy) * 0.5; this.fp += ((vp - this.lvp) / dt - this.fp) * 0.5;      // 低通后的加速度
    this.pa = anchorY; this.pp = anchorPitch; this.lvy = vy; this.lvp = vp;
    const w = this.w, c = 2 * this.z * w;
    this.vy += (-c * this.vy - w * w * this.y - this.fy) * dt; this.y += this.vy * dt;
    this.vp += (-c * this.vp - w * w * this.p - this.fp) * dt; this.p += this.vp * dt;
    if (this.y > this.maxY) { this.y = this.maxY; this.vy = Math.min(0, this.vy); } else if (this.y < -this.maxY) { this.y = -this.maxY; this.vy = Math.max(0, this.vy); }
    if (this.p > this.maxP) { this.p = this.maxP; this.vp = Math.min(0, this.vp); } else if (this.p < -this.maxP) { this.p = -this.maxP; this.vp = Math.max(0, this.vp); }
    this.out.dy = this.y; this.out.dpitch = this.p;
    return this.out;
  }
}

// ═════════════════════════════ 风场 ═════════════════════════════
/** 世界风（沿 WIND_DIR 的阵风 + 缓慢变化 + 微弱上下扰动），返回 [x,y,z]（世界单位/秒） */
export function windAt(t, x = 0, z = 0, strength = 6, out = [0, 0, 0]) {
  const s = Math.max(0, strength * (0.65 + 0.25 * Math.sin(0.5 * t + 0.013 * x) + 0.12 * Math.sin(1.7 * t + 0.021 * z + 1.3)));
  out[0] = WIND_DIR[0] * s; out[1] = 0.08 * s * Math.sin(2.3 * t + 0.02 * (x + z)); out[2] = WIND_DIR[1] * s;
  return out;
}

// ═════════════════════════════ Verlet / PBD 布料毛发仿真器 ═════════════════════════════
export function invertAffine(M, out = new Float64Array(16)) {
  const a = M[0], b = M[4], c = M[8], d = M[1], e = M[5], f = M[9], g = M[2], h = M[6], i = M[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  const id = Math.abs(det) > 1e-18 ? 1 / det : 0;
  const m00 = A * id, m10 = B * id, m20 = C * id, m01 = -(b * i - c * h) * id, m11 = (a * i - c * g) * id, m21 = -(a * h - b * g) * id, m02 = (b * f - c * e) * id, m12 = -(a * f - c * d) * id, m22 = (a * e - b * d) * id;
  out[0] = m00; out[1] = m10; out[2] = m20; out[3] = 0; out[4] = m01; out[5] = m11; out[6] = m21; out[7] = 0; out[8] = m02; out[9] = m12; out[10] = m22; out[11] = 0;
  out[12] = -(m00 * M[12] + m01 * M[13] + m02 * M[14]); out[13] = -(m10 * M[12] + m11 * M[13] + m12 * M[14]); out[14] = -(m20 * M[12] + m21 * M[13] + m22 * M[14]); out[15] = 1;
  return out;
}
/** 各类布料的推荐参数（世界单位按游戏：1 单位≈0.6 m，重力取 16） */
export const CLOTH_PRESETS = {
  cape: { gravity: 16, damping: 0.990, drag: 1.2, wind: 3.2, iterations: 3, bend: 0.30, pinK: 0.5 },
  tails: { gravity: 16, damping: 0.990, drag: 1.0, wind: 4.0, iterations: 3, bend: 0.20, pinK: 0.5 },
  drape: { gravity: 16, damping: 0.985, drag: 1.4, wind: 1.8, iterations: 3, bend: 0.40, pinK: 0.5 },     // 袈裟下摆
  hair: { gravity: 16, damping: 0.965, drag: 1.6, windFull: true, wind: 0.7, iterations: 4, bend: 0.50, pinK: 0.4 },
};
/**
 * 通用网格布料：把任意三角网格按位置焊接成粒子，边 → 距离约束（含对顶点弯曲/剪切约束），
 * pin(0..1) 为"跟随骨骼/锚点"的程度（1=固定，0=自由，中间值=软固定，越靠近根部越硬）。
 * 在世界空间做位置 Verlet（角色移动/转向的惯性自然产生），再转回网格局部空间写入。小步长(2 个子步×3 次迭代)比大步长多迭代更硬。
 * o = { pin: Float32Array(每顶点), gravity, damping, drag, wind, windFull, iterations, bend, pinK, teleport, maxStep, hMax, maxSub, dtMax }
 */
export class Cloth {
  constructor(positions, indices, o = {}) {
    const nv = positions.length / 3, map = new Map(), vp = new Int32Array(nv), rest = [];
    for (let i = 0; i < nv; i++) {
      const key = Math.round(positions[3 * i] * 1e4) + ',' + Math.round(positions[3 * i + 1] * 1e4) + ',' + Math.round(positions[3 * i + 2] * 1e4);
      let id = map.get(key);
      if (id === undefined) { id = rest.length / 3; map.set(key, id); rest.push(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]); }
      vp[i] = id;
    }
    const P = rest.length / 3, R = Float32Array.from(rest);
    this.P = P; this.vp = vp; this.rest = R; this.indices = indices;
    const seen = new Set(), ea = [], eb = [], ek = [], opp = new Map();
    const addEdge = (a, b, k) => { if (a === b) return; const lo = a < b ? a : b, hi = a < b ? b : a, key = lo * P + hi; if (seen.has(key)) return; seen.add(key); ea.push(lo); eb.push(hi); ek.push(k); };
    for (let t = 0; t < indices.length; t += 3) {
      const a = vp[indices[t]], b = vp[indices[t + 1]], c = vp[indices[t + 2]];
      if (a === b || b === c || a === c) continue;
      addEdge(a, b, 1); addEdge(b, c, 1); addEdge(c, a, 1);
      for (const [u, v, w] of [[a, b, c], [b, c, a], [c, a, b]]) {
        const key = (u < v ? u : v) * P + (u < v ? v : u), prev = opp.get(key);
        if (prev === undefined) opp.set(key, w); else if (prev !== w) addEdge(prev, w, o.bend ?? 0.3);
      }
    }
    this.ea = Int32Array.from(ea); this.eb = Int32Array.from(eb); this.ek = Float32Array.from(ek);
    this.el = new Float32Array(ea.length);
    for (let e = 0; e < ea.length; e++) this.el[e] = Math.hypot(R[3 * ea[e]] - R[3 * eb[e]], R[3 * ea[e] + 1] - R[3 * eb[e] + 1], R[3 * ea[e] + 2] - R[3 * eb[e] + 2]);
    this.pin = new Float32Array(P);
    if (o.pin) for (let i = 0; i < nv; i++) this.pin[vp[i]] = Math.max(this.pin[vp[i]], clamp(o.pin[i], 0, 1));
    // 粒子静止法线（用于风的受力方向）
    this.nrm0 = new Float32Array(3 * P);
    for (let t = 0; t < indices.length; t += 3) {
      const a = vp[indices[t]], b = vp[indices[t + 1]], c = vp[indices[t + 2]];
      const ux = R[3 * b] - R[3 * a], uy = R[3 * b + 1] - R[3 * a + 1], uz = R[3 * b + 2] - R[3 * a + 2], vx = R[3 * c] - R[3 * a], vy = R[3 * c + 1] - R[3 * a + 1], vz = R[3 * c + 2] - R[3 * a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const q of [a, b, c]) { this.nrm0[3 * q] += nx; this.nrm0[3 * q + 1] += ny; this.nrm0[3 * q + 2] += nz; }
    }
    for (let p = 0; p < P; p++) { const l = Math.hypot(this.nrm0[3 * p], this.nrm0[3 * p + 1], this.nrm0[3 * p + 2]) || 1; this.nrm0[3 * p] /= l; this.nrm0[3 * p + 1] /= l; this.nrm0[3 * p + 2] /= l; }
    this.x = new Float32Array(3 * P); this.px = new Float32Array(3 * P); this.anchor = new Float32Array(3 * P); this.pn = new Float32Array(3 * P);
    this.params = { gravity: 16, damping: 0.99, drag: 0.6, wind: 3, windFull: false, iterations: 3, pinK: 0.5, teleport: 3, maxStep: 0.4, hMax: 1 / 120, maxSub: 4, dtMax: 1 / 20, friction: 0.2, ...o };
    this.ready = false; this.time = 0;
  }
  reset() { this.ready = false; }
  /**
   * dt 秒；M = 网格局部→世界矩阵(列主序)；wind = 世界风向量；colliders = 局部空间胶囊 [{a:[x,y,z], b:[x,y,z], r}]。
   * 返回 false 表示本次未仿真（dt≤0/NaN 或矩阵退化）。
   */
  step(dt, M, wind = [0, 0, 0], colliders = null) {
    if (!(dt > 0) || !Number.isFinite(dt)) return false;
    dt = Math.min(dt, this.params.dtMax);
    const sx = h3(M[0], M[1], M[2]); if (!(sx > 1e-6)) return false;
    const P = this.P, R = this.rest, X = this.x, PX = this.px, A = this.anchor, pr = this.params;
    let jump = 0;
    for (let p = 0; p < P; p++) {
      const rx = R[3 * p], ry = R[3 * p + 1], rz = R[3 * p + 2];
      const ax = M[0] * rx + M[4] * ry + M[8] * rz + M[12], ay = M[1] * rx + M[5] * ry + M[9] * rz + M[13], az = M[2] * rx + M[6] * ry + M[10] * rz + M[14];
      if (this.ready && this.pin[p] > 0.99) { const d = h3(ax - A[3 * p], ay - A[3 * p + 1], az - A[3 * p + 2]); if (d > jump) jump = d; }
      A[3 * p] = ax; A[3 * p + 1] = ay; A[3 * p + 2] = az;
    }
    if (!this.ready || jump > pr.teleport * sx) { X.set(A); PX.set(A); this.ready = true; return true; }   // 首帧/传送：直接贴回静止形状
    const n = Math.min(pr.maxSub, Math.max(1, Math.ceil(dt / pr.hMax))), h = dt / n;
    const cw = [];
    if (colliders) for (const c of colliders) cw.push({ a: this._tp(M, c.a), b: this._tp(M, c.b), r: c.r * sx });
    const r0 = [M[0] / sx, M[1] / sx, M[2] / sx, M[4] / sx, M[5] / sx, M[6] / sx, M[8] / sx, M[9] / sx, M[10] / sx];   // 旋转部分（均匀缩放假设）
    for (let s = 0; s < n; s++) { this.time += h; this._sub(h, sx, r0, wind, cw); }
    return true;
  }
  _tp(M, v) { return [M[0] * v[0] + M[4] * v[1] + M[8] * v[2] + M[12], M[1] * v[0] + M[5] * v[1] + M[9] * v[2] + M[13], M[2] * v[0] + M[6] * v[1] + M[10] * v[2] + M[14]]; }
  _sub(h, sx, r0, wind, cw) {
    const P = this.P, X = this.x, PX = this.px, A = this.anchor, pr = this.params, pin = this.pin, nrm = this.nrm0;
    const damp = Math.pow(pr.damping, h * 60), maxStep = pr.maxStep * sx, g = pr.gravity, pkF = 1 - Math.pow(1 - pr.pinK, h * 60);   // 小步长：每子步的软固定强度按步长换算
    for (let p = 0; p < P; p++) {
      const i = 3 * p;
      if (pin[p] >= 0.999) { X[i] = A[i]; X[i + 1] = A[i + 1]; X[i + 2] = A[i + 2]; PX[i] = X[i]; PX[i + 1] = X[i + 1]; PX[i + 2] = X[i + 2]; continue; }
      const vx = (X[i] - PX[i]) / h, vy = (X[i + 1] - PX[i + 1]) / h, vz = (X[i + 2] - PX[i + 2]) / h;
      // 风：布片取相对风速在法线方向的分量(双面)；windFull(发丝)各向同性被吹向下风
      const nx = r0[0] * nrm[i] + r0[3] * nrm[i + 1] + r0[6] * nrm[i + 2], ny = r0[1] * nrm[i] + r0[4] * nrm[i + 1] + r0[7] * nrm[i + 2], nz = r0[2] * nrm[i] + r0[5] * nrm[i + 1] + r0[8] * nrm[i + 2];
      const gust = 0.8 + 0.2 * Math.sin(this.time * 2.3 + p * 0.61), rel = ((wind[0] - vx) * nx + (wind[1] - vy) * ny + (wind[2] - vz) * nz) * pr.wind * gust, wg = pr.wind * gust;
      // drag：对静止空气的线性阻力，抑制钟摆式长时间摆动
      const ax = (pr.windFull ? wg * wind[0] : rel * nx) - pr.drag * vx, ay = -g + (pr.windFull ? wg * wind[1] : rel * ny) - pr.drag * vy, az = (pr.windFull ? wg * wind[2] : rel * nz) - pr.drag * vz;
      let dx = (X[i] - PX[i]) * damp + ax * h * h, dy = (X[i + 1] - PX[i + 1]) * damp + ay * h * h, dz = (X[i + 2] - PX[i + 2]) * damp + az * h * h;
      const dl = h3(dx, dy, dz); if (dl > maxStep) { const k = maxStep / dl; dx *= k; dy *= k; dz *= k; }
      PX[i] = X[i]; PX[i + 1] = X[i + 1]; PX[i + 2] = X[i + 2]; X[i] += dx; X[i + 1] += dy; X[i + 2] += dz;
      if (pin[p] > 0) { const k = pin[p] * pkF; X[i] += (A[i] - X[i]) * k; X[i + 1] += (A[i + 1] - X[i + 1]) * k; X[i + 2] += (A[i + 2] - X[i + 2]) * k; }
    }
    const ea = this.ea, eb = this.eb, el = this.el, ek = this.ek, E = ea.length;
    for (let it = 0; it < pr.iterations; it++) {
      for (let e = 0; e < E; e++) {
        const a = 3 * ea[e], b = 3 * eb[e], dx = X[b] - X[a], dy = X[b + 1] - X[a + 1], dz = X[b + 2] - X[a + 2], len = h3(dx, dy, dz);
        if (len < 1e-9) continue;
        const wa = 1 - clamp(pin[ea[e]], 0, 1), wb = 1 - clamp(pin[eb[e]], 0, 1), ws = wa + wb; if (ws <= 1e-6) continue;
        const c = ((len - el[e] * sx) / len) * ek[e] / ws;
        X[a] += dx * c * wa; X[a + 1] += dy * c * wa; X[a + 2] += dz * c * wa; X[b] -= dx * c * wb; X[b + 1] -= dy * c * wb; X[b + 2] -= dz * c * wb;
      }
    }
    for (const c of cw) {
      const abx = c.b[0] - c.a[0], aby = c.b[1] - c.a[1], abz = c.b[2] - c.a[2], l2 = abx * abx + aby * aby + abz * abz || 1e-12;
      for (let p = 0; p < P; p++) {
        if (pin[p] >= 0.999) continue;
        const i = 3 * p, t = clamp(((X[i] - c.a[0]) * abx + (X[i + 1] - c.a[1]) * aby + (X[i + 2] - c.a[2]) * abz) / l2, 0, 1);
        const qx = c.a[0] + abx * t, qy = c.a[1] + aby * t, qz = c.a[2] + abz * t, dx = X[i] - qx, dy = X[i + 1] - qy, dz = X[i + 2] - qz, d = h3(dx, dy, dz);
        if (d < c.r) {
          const k = d > 1e-9 ? c.r / d : 0, ox = d > 1e-9 ? qx + dx * k : qx, oy = d > 1e-9 ? qy + dy * k : qy + c.r, oz = d > 1e-9 ? qz + dz * k : qz;
          X[i] = ox; X[i + 1] = oy; X[i + 2] = oz;
          PX[i] += (X[i] - PX[i]) * pr.friction; PX[i + 1] += (X[i + 1] - PX[i + 1]) * pr.friction; PX[i + 2] += (X[i + 2] - PX[i + 2]) * pr.friction;   // 擦碰损失速度
        }
      }
    }
  }
  /** 把仿真结果写回网格局部空间。Minv = invertAffine(M)。可同时重算（焊接后）法线 */
  writeLocal(Minv, out, normalsOut = null) {
    const X = this.x, vp = this.vp, nv = vp.length;
    for (let i = 0; i < nv; i++) {
      const p = 3 * vp[i], wx = X[p], wy = X[p + 1], wz = X[p + 2];
      out[3 * i] = Minv[0] * wx + Minv[4] * wy + Minv[8] * wz + Minv[12]; out[3 * i + 1] = Minv[1] * wx + Minv[5] * wy + Minv[9] * wz + Minv[13]; out[3 * i + 2] = Minv[2] * wx + Minv[6] * wy + Minv[10] * wz + Minv[14];
    }
    if (!normalsOut) return;
    const pn = this.pn, I = this.indices; pn.fill(0);
    for (let t = 0; t < I.length; t += 3) {
      const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2], ux = out[b] - out[a], uy = out[b + 1] - out[a + 1], uz = out[b + 2] - out[a + 2], vx = out[c] - out[a], vy = out[c + 1] - out[a + 1], vz = out[c + 2] - out[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const q of [I[t], I[t + 1], I[t + 2]]) { const k = 3 * vp[q]; pn[k] += nx; pn[k + 1] += ny; pn[k + 2] += nz; }
    }
    for (let i = 0; i < nv; i++) { const k = 3 * vp[i], l = Math.hypot(pn[k], pn[k + 1], pn[k + 2]) || 1; normalsOut[3 * i] = pn[k] / l; normalsOut[3 * i + 1] = pn[k + 1] / l; normalsOut[3 * i + 2] = pn[k + 2] / l; }
  }
  /** 当前最大边伸长率（测试/调参用；sx = 当前缩放） */
  maxStrain(sx = 1) {
    let m = 0; const X = this.x;
    for (let e = 0; e < this.ea.length; e++) { if (this.ek[e] < 1) continue; const a = 3 * this.ea[e], b = 3 * this.eb[e], l = Math.hypot(X[b] - X[a], X[b + 1] - X[a + 1], X[b + 2] - X[a + 2]); m = Math.max(m, Math.abs(l / (this.el[e] * sx) - 1)); }
    return m;
  }
}
