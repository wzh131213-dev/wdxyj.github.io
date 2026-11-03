// xiyou.motion.test.mjs — 动力学与物理仿真测试：node xiyou.motion.test.mjs
import assert from 'node:assert/strict';
import * as C from './xiyou-core.js';
import * as MO from './xiyou-motion.js';
import { test, section, near, done } from './_harness.mjs';

section('动力学：阻尼弹簧 · 呼吸微动 · 步态 · 鞍座跟随 · 风');
const fnv = (arr) => { let h = 2166136261 >>> 0; for (const v of arr) { h ^= Math.round(v * 1e6) & 0xffffffff; h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); };
test('smoothDamp：临界阻尼无过冲、收敛，大步长也稳定', () => {
  const st = { v: 0 }; let x = 0, over = 0; for (let i = 0; i < 300; i++) { x = MO.smoothDamp(x, 1, st, 0.3, 1 / 60); over = Math.max(over, x - 1); }
  near(x, 1, 1e-3); assert.ok(over <= 1e-9, `过冲 ${over}`);
  const s2 = { v: 0 }; let y = 5; for (let i = 0; i < 20; i++) y = MO.smoothDamp(y, -3, s2, 0.2, 0.5); assert.ok(Number.isFinite(y) && Math.abs(y + 3) < 1e-2);
});
test('呼吸微动：确定性；呼吸频率≈0.22 Hz；各骨幅度在界内', () => {
  const run = (seed, still = true, T = 60) => { const A = new MO.IdleAnimator(seed), rows = []; for (let i = 0; i < T * 60; i++) { const p = A.update(1 / 60, still); rows.push([p.spine1[0], p.spine2[0], p.chest[0], p.head[1], p.head[0], p.blink, p.chestScale, p.eyeX, p.eyeY, p.clavL[2]]); } return rows; };
  const a = run(7), b = run(7), c = run(8); assert.equal(fnv(a.flat()), fnv(b.flat())); assert.notEqual(fnv(a.flat()), fnv(c.flat()));
  let cross = 0; for (let i = 1; i < a.length; i++) if (a[i - 1][2] < 0 !== a[i][2] < 0) cross++;
  assert.ok(cross >= 18 && cross <= 36, `过零 ${cross}（60 s，期望≈26）`);
  const mx = (k) => Math.max(...a.map((r) => Math.abs(r[k]))); assert.ok(mx(0) <= 0.0095 && mx(1) <= 0.0135 && mx(2) <= 0.0185 && mx(3) <= 0.24 && mx(6) <= 0.0095 && mx(9) <= 0.0185, `幅度 ${[0, 1, 2, 3, 6, 9].map(mx)}`);
});
test('呼吸相位滞后：以 spine1 为基准，spine2 滞后≈0.35 rad、chest 滞后≈0.7 rad（互相关求滞后帧）', () => {
  const A = new MO.IdleAnimator(3), S = [[], [], []]; for (let i = 0; i < 60 * 90; i++) { const p = A.update(1 / 60, true); S[0].push(-p.spine1[0] / 0.006); S[1].push(-p.spine2[0] / 0.009); S[2].push(-p.chest[0] / 0.012); }
  const lagOf = (k) => { let bl = 0, bv = -1e9; for (let lag = -10; lag < 90; lag++) { let sum = 0, n = 0; for (let i = 100; i < S[0].length - 100; i++) { sum += S[0][i - lag] * S[k][i]; n++; } if (sum / n > bv) { bv = sum / n; bl = lag; } } return bl; };
  const l1 = lagOf(1), l2 = lagOf(2); assert.ok(l1 >= 9 && l1 <= 22 && l2 >= 22 && l2 <= 40 && l2 > l1, `滞后帧 ${l1}, ${l2}（期望≈15, ≈30）`);
});
test('头部与眨眼：转头平滑且换目标 10–30 次/分；眨眼 8–30 次/分；闭合度 0..1；移动时头部微动减弱但呼吸不停', () => {
  const A = new MO.IdleAnimator(11); let blinks = 0, was = false, maxStep = 0, last = 0, mxBlink = 0, changes = 0, lastTarget = null;
  for (let i = 0; i < 3600; i++) { const p = A.update(1 / 60, true); if (i) maxStep = Math.max(maxStep, Math.abs(p.head[1] - last)); last = p.head[1]; if (p.blink > 0.5 && !was) blinks++; was = p.blink > 0.5; mxBlink = Math.max(mxBlink, p.blink); if (A.head.ty !== lastTarget) { changes++; lastTarget = A.head.ty; } assert.ok(p.blink >= 0 && p.blink <= 1.0000001); }
  assert.ok(blinks >= 8 && blinks <= 30, `眨眼 ${blinks}`); assert.ok(mxBlink > 0.95); assert.ok(maxStep < 0.01, `转头步长 ${maxStep}`); assert.ok(changes >= 10 && changes <= 30, `换目标 ${changes}`);
  const B = new MO.IdleAnimator(11); for (let i = 0; i < 240; i++) B.update(1 / 60, false); const q = B.update(1 / 60, false); assert.ok(B.w < 0.05 && Math.abs(q.head[1]) < 0.02, '移动时头部微动应淡出');
  let br = 0; for (let i = 0; i < 300; i++) br = Math.max(br, Math.abs(B.update(1 / 60, false).chest[0])); assert.ok(br > 0.003, '移动时呼吸仍在');
});
test('边界/异常：dt=0 不变；dt 很大/NaN 被安全化；输出全是有限数', () => {
  const A = new MO.IdleAnimator(5); const p0 = JSON.stringify(A.update(0, true)), p1 = JSON.stringify(A.update(0, true)); assert.equal(p0, p1);
  const B = new MO.IdleAnimator(5); for (const dt of [1e9, -1, NaN, 0.5, 5]) { const p = B.update(dt, true); assert.ok(Object.values(p).flat().every((v) => Number.isFinite(v)), `dt=${dt}`); }
});
test('步态：走=侧序四拍(各腿依次差 1/4 周期)；小跑=对角同相、左右反相', () => {
  const sim = (speed, T = 20) => { const G = new MO.GaitModel(), rows = []; for (let i = 0; i < T * 60; i++) { const o = G.step(1 / 60, speed, true); rows.push(o.legs.map((l) => l.hip)); } return rows; };
  const walk = sim(4).slice(600), freq = Math.min(2.3, Math.max(0.8, 0.8 + 0.085 * 4)), shift = Math.round(60 * 0.25 / freq);
  const corr = (X, Y) => { const mx = X.reduce((s, v) => s + v, 0) / X.length, my = Y.reduce((s, v) => s + v, 0) / Y.length; let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < X.length; i++) { sxy += (X[i] - mx) * (Y[i] - my); sxx += (X[i] - mx) ** 2; syy += (Y[i] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
  const n = walk.length - shift - 5; for (const [a, b] of [[0, 1], [1, 2], [2, 3]]) assert.ok(corr(walk.slice(shift, shift + n).map((r) => r[b]), walk.slice(0, n).map((r) => r[a])) > 0.98 || corr(walk.slice(0, n).map((r) => r[b]), walk.slice(shift, shift + n).map((r) => r[a])) > 0.98, `走 ${a}->${b}`);
  const trot = sim(16, 25).slice(900), col = (k) => trot.map((r) => r[k]);
  assert.ok(corr(col(1), col(2)) > 0.97 && corr(col(3), col(0)) > 0.97, '对角同相'); assert.ok(corr(col(1), col(3)) < -0.9 && corr(col(0), col(2)) < -0.9, '左右反相');
});
test('步态：变速连续无突变（不超过稳态最大帧间变化的 1.4 倍）；停下后收回；膝只向后折；髋摆在界内；全是有限数', () => {
  const steadyAll = (() => { const G = new MO.GaitModel(); let pv = null, m = 0, mb = 0, pb = 0; for (let i = 0; i < 60 * 8; i++) { const o = G.step(1 / 60, 22, true), h = o.legs.map((l) => l.hip); if (pv && i > 240) { m = Math.max(m, ...h.map((v, k) => Math.abs(v - pv[k]))); mb = Math.max(mb, Math.abs(o.bob - pb)); } pv = h; pb = o.bob; } return { m, mb }; })(), steady = steadyAll.m;
  const G = new MO.GaitModel(); let prev = null, maxHip = 0, maxBob = 0, kneePos = 0, hipMax = 0;
  for (let i = 0; i < 60 * 12; i++) {
    const t = i / 60, speed = t < 6 ? t * 3.4 : (12 - t) * 3.4, o = G.step(1 / 60, speed, t < 10);
    const hips = o.legs.map((l) => l.hip); if (prev) { maxHip = Math.max(maxHip, ...hips.map((h, k) => Math.abs(h - prev.h[k]))); maxBob = Math.max(maxBob, Math.abs(o.bob - prev.b)); } prev = { h: hips, b: o.bob };
    for (const l of o.legs) { assert.ok(Number.isFinite(l.hip) && Number.isFinite(l.knee)); if (l.knee > 1e-9) kneePos++; hipMax = Math.max(hipMax, Math.abs(l.hip)); }
  }
  assert.ok(maxHip <= steady * 1.4, `变速最大帧间 ${maxHip} vs 稳态 ${steady}`); assert.ok(maxBob <= steadyAll.mb * 1.4, `bob 帧间 ${maxBob} vs 稳态 ${steadyAll.mb}`); assert.equal(kneePos, 0); assert.ok(hipMax <= 0.43);
  const o = (() => { let r; for (let i = 0; i < 120; i++) r = G.step(1 / 60, 0, false); return r; })(); assert.ok(o.legs.every((l) => Math.abs(l.hip) < 0.02 && Math.abs(l.knee) < 0.02) && Math.abs(o.bob) < 0.004, '停下后应收回');
  const B = new MO.GaitModel(); for (const dt of [NaN, -1, 1e9, 0]) { const r = B.step(dt, NaN, true); assert.ok(r.legs.every((l) => Number.isFinite(l.hip) && Number.isFinite(l.knee))); }
});
test('鞍座跟随：夹紧在界内；常量输入收敛到 0；步长 1/60、1/30 都稳定；有滞后（软座）', () => {
  for (const dt of [1 / 60, 1 / 30, 0.05]) {
    const F = new MO.SaddleFollow(); let mx = 0, mp = 0;
    for (let i = 0; i < 600; i++) { const t = i * dt, o = F.step(dt, 0.07 * Math.sin(2 * Math.PI * 2 * t), 0.02 * Math.sin(2 * Math.PI * 2 * t + 1)); mx = Math.max(mx, Math.abs(o.dy)); mp = Math.max(mp, Math.abs(o.dpitch)); assert.ok(Number.isFinite(o.dy) && Number.isFinite(o.dpitch)); }
    assert.ok(mx <= 0.05 + 1e-9 && mp <= 0.06 + 1e-9 && mx > 0.002, `dt=${dt} dy=${mx}`);
  }
  const F = new MO.SaddleFollow(); for (let i = 0; i < 30; i++) F.step(1 / 60, 0.3 * (i < 5 ? 0 : 1), 0); let o; for (let i = 0; i < 120; i++) o = F.step(1 / 60, 0.3, 0); assert.ok(Math.abs(o.dy) < 1e-3, '常量输入应收敛');
  const J = new MO.SaddleFollow(); J.step(1 / 60, 0, 0); const j = J.step(1 / 60, 1.0, 0); assert.ok(Math.abs(j.dy) <= 0.05 + 1e-9);
  assert.ok(Number.isFinite(new MO.SaddleFollow().step(NaN, 0, 0).dy));
});
test('风场：沿 WIND_DIR、非负、确定性；矩阵求逆正确', () => {
  for (let i = 0; i < 200; i++) { const w = MO.windAt(i * 0.37, i * 3.1, -i * 1.7, 6); const h = Math.hypot(w[0], w[2]); if (h > 1e-9) near((w[0] * 0.62 + w[2] * 0.78) / h / Math.hypot(0.62, 0.78), 1, 1e-9); assert.ok(h >= 0 && h <= 6 * 1.02 + 1e-9); }
  assert.deepEqual(MO.windAt(3, 1, 2, 5), MO.windAt(3, 1, 2, 5));
  const c = Math.cos(0.7), s = Math.sin(0.7), M = [2 * c, 0, -2 * s, 0, 0, 2, 0, 0, 2 * s, 0, 2 * c, 0, 3, -4, 5, 1], Mi = MO.invertAffine(M);
  const mul = (a, b) => { const o = new Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[4 * j + i] += a[4 * k + i] * b[4 * j + k]; return o; };
  mul(M, Mi).forEach((v, i) => near(v, i % 5 === 0 ? 1 : 0, 1e-9));
});

section('布料/毛发：Verlet(PBD) 仿真器');
const gridPanel = (rows, cols, w, h) => { const P = [], I = [], W = cols + 1; for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) P.push((c / cols - 0.5) * w, -r / rows * h, 0); for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const a = r * W + c; I.push(a, a + 1, a + W + 1, a, a + W + 1, a + W); } const pin = new Float32Array((rows + 1) * W); for (let c = 0; c <= cols; c++) pin[c] = 1; return { positions: Float32Array.from(P), indices: Uint32Array.from(I), pin, rows, cols }; };
const mat4 = (tx = 0, ty = 0, tz = 0, yaw = 0, s = 1) => { const c = Math.cos(yaw) * s, sn = Math.sin(yaw) * s; return [c, 0, -sn, 0, 0, s, 0, 0, sn, 0, c, 0, tx, ty, tz, 1]; };
const runCloth = (cl, seconds, matAt, windAt = () => [0, 0, 0], cols = null, dt = 1 / 60) => { for (let i = 0; i < seconds / dt; i++) cl.step(dt, matAt(i * dt), windAt(i * dt), cols); };
test('悬挂布料：只受重力时形状稳定、边伸长率 <6%、无 NaN、仍近似垂直悬挂', () => {
  const g = gridPanel(12, 8, 0.6, 1.0), cl = new MO.Cloth(g.positions, g.indices, { pin: g.pin, gravity: 9.8 }); runCloth(cl, 4, () => mat4());
  assert.ok(cl.x.every(Number.isFinite)); assert.ok(cl.maxStrain() < 0.06, `strain ${cl.maxStrain()}`);
  const W = g.cols + 1; for (let c = 0; c <= g.cols; c++) { const k = 3 * (g.rows * W + c); assert.ok(cl.x[k + 1] <= -0.9 && cl.x[k + 1] >= -1.07 && Math.abs(cl.x[k + 2]) < 0.06, `底边 y=${cl.x[k + 1]} z=${cl.x[k + 2]}`); }
  assert.equal(cl.P, (g.rows + 1) * (g.cols + 1));
});
test('风：沿法线方向吹动，方向随风反转；风越大位移越大；平行风几乎无效', () => {
  const g = gridPanel(10, 6, 0.6, 1.0), mk = () => new MO.Cloth(g.positions, g.indices, { pin: g.pin, gravity: 9.8 }), W = g.cols + 1;
  const dz = (wind) => { const cl = mk(); runCloth(cl, 3, () => mat4(), () => wind); let s = 0; for (let c = 0; c <= g.cols; c++) s += cl.x[3 * (g.rows * W + c) + 2]; return s / W; };
  const pos = dz([0, 0, 6]), neg = dz([0, 0, -6]), big = dz([0, 0, 12]), par = dz([6, 0, 0]);
  assert.ok(pos > 0.08 && neg < -0.08 && big > pos && Math.abs(par) < 0.03, `pos=${pos} neg=${neg} big=${big} par=${par}`);
});
test('惯性：加速时下摆落在后面，停下后回到静止形状；转向时下摆滞后；阻力使摆动衰减', () => {
  const g = gridPanel(12, 8, 0.6, 1.0), cl = new MO.Cloth(g.positions, g.indices, { pin: g.pin, gravity: 9.8 }), W = g.cols + 1, bot = (k) => 3 * (g.rows * W + k);
  const x = (tm) => (tm < 0.2 ? 20 * tm * tm : 0.8 + 8 * (Math.min(tm, 1.5) - 0.2)); let lag = 0;
  for (let i = 0; i < 90; i++) { cl.step(1 / 60, mat4(x(i / 60), 0, 0), [0, 0, 0]); lag = Math.max(lag, cl.anchor[bot(4)] - cl.x[bot(4)]); }
  assert.ok(lag > 0.05, `加速段最大滞后 ${lag}`);
  let amp1 = 0, amp2 = 0; for (let i = 0; i < 360; i++) { cl.step(1 / 60, mat4(x(1.5), 0, 0), [0, 0, 0]); const d = Math.abs(cl.x[bot(4)] - cl.anchor[bot(4)]); if (i < 60) amp1 = Math.max(amp1, d); if (i >= 300) amp2 = Math.max(amp2, d); }
  assert.ok(amp1 > 0.05 && amp2 < amp1 * 0.3 && amp2 < 0.03, `停下后摆动应衰减 ${amp1} → ${amp2}`); assert.ok(cl.maxStrain() < 0.06, `strain ${cl.maxStrain()}`);
  const c2 = new MO.Cloth(g.positions, g.indices, { pin: g.pin, gravity: 9.8 }); let dev = 0; for (let i = 0; i < 40; i++) { c2.step(1 / 60, mat4(0, 0, 0, 6 * i / 60), [0, 0, 0]); const k = bot(0); dev = Math.max(dev, Math.hypot(c2.x[k] - c2.anchor[k], c2.x[k + 1] - c2.anchor[k + 1], c2.x[k + 2] - c2.anchor[k + 2])); }
  assert.ok(dev > 0.03, `转向时应有惯性滞后 dev=${dev}`);
});
test('碰撞：风把布推向球体时粒子不会陷进球；软固定比自由粒子晃得少', () => {
  const g = gridPanel(12, 8, 0.6, 1.0), sphere = [{ a: [0, -0.5, 0.12], b: [0, -0.5, 0.12], r: 0.2 }];
  const cl = new MO.Cloth(g.positions, g.indices, { pin: g.pin, gravity: 9.8 }); runCloth(cl, 3, () => mat4(), () => [0, 0, -8], sphere);
  let minD = 1e9; for (let p = 0; p < cl.P; p++) if (cl.pin[p] < 0.99) minD = Math.min(minD, Math.hypot(cl.x[3 * p] - 0, cl.x[3 * p + 1] + 0.5, cl.x[3 * p + 2] - 0.12)); assert.ok(minD >= 0.2 - 2e-3, `最近距离 ${minD}`);
  const soft = Float32Array.from(g.pin); for (let c = 0; c <= g.cols; c++) soft[(g.cols + 1) + c] = 0.8;
  const a = new MO.Cloth(g.positions, g.indices, { pin: g.pin, gravity: 9.8 }), b = new MO.Cloth(g.positions, g.indices, { pin: soft, gravity: 9.8 }); runCloth(a, 2, () => mat4(), () => [0, 0, 8]); runCloth(b, 2, () => mat4(), () => [0, 0, 8]);
  const row1 = (cl) => cl.x[3 * ((g.cols + 1) + 3) + 2]; assert.ok(Math.abs(row1(b)) < Math.abs(row1(a)), '第二排软固定应更稳');
});
test('传送/异常：瞬移后立即贴回静止形状；dt<=0 与退化矩阵不动；大步长不炸', () => {
  const g = gridPanel(10, 6, 0.6, 1.0), cl = new MO.Cloth(g.positions, g.indices, { pin: g.pin, gravity: 9.8 }); runCloth(cl, 1, () => mat4(), () => [0, 0, 6]);
  cl.step(1 / 60, mat4(100, 0, 0), [0, 0, 6]); let d = 0; for (let p = 0; p < cl.P; p++) d = Math.max(d, Math.hypot(cl.x[3 * p] - cl.anchor[3 * p], cl.x[3 * p + 1] - cl.anchor[3 * p + 1], cl.x[3 * p + 2] - cl.anchor[3 * p + 2])); assert.ok(d < 1e-5, `传送后偏差 ${d}`);
  assert.equal(cl.step(0, mat4(), [0, 0, 0]), false); assert.equal(cl.step(-1, mat4(), [0, 0, 0]), false); assert.equal(cl.step(NaN, mat4(), [0, 0, 0]), false); assert.equal(cl.step(1 / 60, new Array(16).fill(0), [0, 0, 0]), false);
  const c2 = new MO.Cloth(g.positions, g.indices, { pin: g.pin, gravity: 9.8 }); c2.step(1 / 60, mat4(), [0, 0, 0]); for (const dt of [1, 0.5, 1 / 5]) c2.step(dt, mat4(), [0, 0, 8]); assert.ok(c2.x.every(Number.isFinite) && c2.maxStrain() < 0.5, `strain ${c2.maxStrain()}`);
});
test('毛发(管状网格)：接缝焊接成同一粒子；根部硬、梢部软；边保持；写回局部空间与法线单位长', () => {
  const rings = Array.from({ length: 6 }, (_, i) => ({ c: [0, -i * 0.12, 0], ra: 0.04, rb: 0.03 })), tube = C.loft(rings, { sides: 10 });
  const pin = new Float32Array(tube.positions.length / 3); for (let i = 0; i < pin.length; i++) { const ring = Math.floor(i / 11); pin[i] = [1, 0.6, 0.3, 0, 0, 0][ring]; }
  const cl = new MO.Cloth(tube.positions, tube.indices, { pin, ...MO.CLOTH_PRESETS.hair, gravity: 9.8 }); assert.equal(cl.P, 6 * 10);
  runCloth(cl, 3, (t) => mat4(0.3 * Math.sin(3 * t), 0, 0), () => [0, 0, 5], null);
  assert.ok(cl.maxStrain() < 0.08, `strain ${cl.maxStrain()}`);
  const out = new Float32Array(tube.positions.length), nrm = new Float32Array(tube.positions.length); cl.writeLocal(MO.invertAffine(mat4(0.3 * Math.sin(9), 0, 0)), out, nrm);
  for (let r = 0; r < 6; r++) for (let k = 0; k < 3; k++) near(out[3 * (r * 11) + k], out[3 * (r * 11 + 10) + k], 1e-5, '接缝');
  for (let i = 0; i < nrm.length; i += 3) near(Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]), 1, 1e-4);
});
test('性能：约 1000 粒子 × 600 步，平均每步 <1.5 ms', () => {
  const g = gridPanel(24, 40, 1.2, 2.0), cl = new MO.Cloth(g.positions, g.indices, { pin: g.pin, gravity: 9.8 }); const t = performance.now();
  for (let i = 0; i < 600; i++) cl.step(1 / 60, mat4(Math.sin(i * 0.05), 0, 0), [3, 0, 3], [{ a: [0, -1, 0.1], b: [0, -1.5, 0.1], r: 0.3 }]);
  const ms = (performance.now() - t) / 600; assert.ok(ms < 1.5, `${ms} ms/step`); return `${cl.P} 粒子，平均 ${ms.toFixed(2)} ms/步`;
});
done('动力学：');
