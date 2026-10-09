// xiyou.test.mjs — 零依赖测试：node xiyou.test.mjs（Node ≥ 20）。失败时进程退出码为 1。
// 每个板块都含：核心业务场景 / 边界条件(极值) / 异常输入。THREE 适配层用最小 stub 验证调用逻辑（沙箱无网络、无真实 three.js）。
import assert from 'node:assert/strict';
import * as C from './xiyou-core.js';
import * as CH from './xiyou-character.js';
import * as W from './xiyou-world.js';
import * as TH from './xiyou-three.js';

let pass = 0, fail = 0;
const fails = [];
const section = (t) => console.log(`\n■ ${t}`);
function test(name, fn) {
  const t = performance.now();
  try { const note = fn(); pass++; console.log(`  ✓ ${name}${note ? '  — ' + note : ''}  (${(performance.now() - t).toFixed(0)} ms)`); }
  catch (e) { fail++; fails.push(name); console.log(`  ✗ ${name}\n      ${String(e.message).split('\n')[0]}`); }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} ≉ ${b} (±${tol})`);

// ═════════════════════════════ 核心 ═════════════════════════════
section('核心几何 / 噪声');
test('噪声：确定性 + 值域 [-1,1] + 不同种子不同', () => {
  const a = C.makeNoise(7), b = C.makeNoise(7), c = C.makeNoise(8);
  let mx = 0, diff = 0;
  for (let i = 0; i < 20000; i++) { const x = (i * 0.37) % 91, y = (i * 0.113) % 77; const v = a.simplex2(x, y); assert.equal(v, b.simplex2(x, y)); mx = Math.max(mx, Math.abs(v), Math.abs(a.simplex3(x, y, i * 0.01))); if (v !== c.simplex2(x, y)) diff++; }
  assert.ok(mx <= 1.0001 && diff > 19000); return `max|n|=${mx.toFixed(3)}`;
});
test('smoothstep 支持反向边界（BIBLE 写法 smoothstep(16,7,r)）', () => {
  assert.equal(C.smoothstep(16, 7, 3), 1); assert.equal(C.smoothstep(16, 7, 20), 0); near(C.smoothstep(16, 7, 11.5), 0.5, 1e-12);
});
test('放样：任意朝向(上/下/沿Z)封闭圆柱体积≈πr²h 且为正', () => {
  const up = C.loft([{ c: [0, 0, 0], ra: .5, rb: .5 }, { c: [0, 2, 0], ra: .5, rb: .5 }], { sides: 64, cap: 'both' });
  const dn = C.loft([{ c: [0, 2, 0], ra: .5, rb: .5 }, { c: [0, 0, 0], ra: .5, rb: .5 }], { sides: 64, cap: 'both' });
  const z = C.loft([{ c: [0, 0, 0], ra: .5, rb: .5 }, { c: [0, 0, 2], ra: .5, rb: .5 }], { sides: 64, cap: 'both', hint: [0, 1, 0] });
  for (const m of [up, dn, z]) { near(C.signedVolume(m), Math.PI * 0.25 * 2, 0.02); assert.deepEqual(C.validateMesh(m), []); }
});
test('旋转体/椭球/圆环/二十面体：体积为正且接近解析值', () => {
  near(C.signedVolume(C.ellipsoid([0, 0, 0], [1, 1, 1], { lat: 32, lon: 48 })), 4 / 3 * Math.PI, 0.1);
  near(C.signedVolume(C.lathe([[0, 0], [1, 0], [1, 1], [0, 1]], { sides: 64 })), Math.PI, 0.02);
  near(C.signedVolume(C.torus(1, 0.2, { segs: 48, tube: 16 })), 2 * Math.PI * Math.PI * 0.04, 0.05);
  near(C.signedVolume(C.icosphere(3)), 4 / 3 * Math.PI, 0.15);
});
test('镜像/滤三角/合并后仍然有效且朝外', () => {
  const m = C.mirrorX(C.loft([{ c: [1, 0, 0], ra: .3, rb: .3 }, { c: [1, 1, 0], ra: .3, rb: .3 }], { cap: 'both' }));
  assert.ok(C.signedVolume(m) > 0 && m.positions[0] < 0);
  const half = C.filterTris(C.icosphere(2), (c) => c[1] > 0); assert.ok(half.indices.length > 0 && half.indices.length < C.icosphere(2).indices.length);
  assert.deepEqual(C.validateMesh(C.mergeMeshes([m, half])), []);
});
test('异常输入：validateMesh 能抓到 NaN / 索引越界 / 蒙皮权重和≠1', () => {
  const m = C.icosphere(1); m.positions[4] = NaN; assert.ok(C.validateMesh(m).some((s) => s.includes('非有限')));
  const n = C.icosphere(1); n.indices[0] = 99999; assert.ok(C.validateMesh(n).some((s) => s.includes('越界')));
  const s = C.icosphere(1), nv = s.positions.length / 3; s.skinIndex = new Uint16Array(nv * 4); s.skinWeight = new Float32Array(nv * 4).fill(0.5);
  assert.ok(C.validateMesh(s, { bones: 3 }).some((x) => x.includes('权重和')));
});

// ═════════════════════════════ 人物 ═════════════════════════════
section('人物建模（唐僧 / 悟空 / 八戒 / 沙僧）');
const KINDS = Object.keys(CH.CHARACTERS);
const REQUIRED = ['root', 'pelvis', 'spine1', 'spine2', 'chest', 'neck', 'head', 'weapon_R', 'scabbard_L', ...['clavicle', 'upperArm', 'foreArm', 'hand', 'thigh', 'shin', 'foot', 'toe', 'thumb1', 'thumb2', 'index1', 'index2', 'middle1', 'middle2', 'ringPinky1', 'ringPinky2'].flatMap((n) => [n + '_L', n + '_R'])];
const BONE_RULE = { // 各部件允许出现的骨骼（验证"候选骨骼受限"确实生效）
  skin: /^(spine2|chest|neck|head|pelvis|spine1|clavicle_[LR]|upperArm_[LR]|foreArm_[LR]|hand_[LR]|(thumb|index|middle|ringPinky)[12]_[LR]|thigh_[LR]|shin_[LR]|foot_[LR])$/,
  eyes: /^head$/, hat: /^head$/, hatTrim: /^head$/, crown: /^head$/, feathers: /^head$/, beard: /^head$/, beads: /^chest$/, skulls: /^chest$/,
  shoes: /^(thigh_[LR]|shin_[LR]|foot_[LR]|toe_[LR])$/, belt: /^(pelvis|spine1)$/, sash: /^(pelvis|spine1|spine2)$/,
  propWood: /^weapon_R$/, propMetal: /^weapon_R$/, propBody: /^weapon_R$/,
};
const built = {};
for (const kind of KINDS) {
  test(`${kind}：构建通过 + 全部网格校验 + 面数预算`, () => {
    const d = (built[kind] = CH.buildCharacterData({ kind })), nb = d.skeleton.bones.length;
    for (const p of d.parts) assert.deepEqual(C.validateMesh(p, { bones: nb }), [], `部件 ${p.name}`);
    assert.ok(d.stats.triangles <= 12000 && d.stats.vertices <= 8000, JSON.stringify(d.stats));
    return `${d.name}: ${d.stats.vertices} 顶点 / ${d.stats.triangles} 三角 / ${d.stats.parts} 部件`;
  });
  test(`${kind}：骨架 41 根、命名齐全、父在前、左右镜像对称`, () => {
    const sk = built[kind].skeleton; assert.equal(sk.bones.length, 41);
    for (const n of REQUIRED) assert.ok(n in sk.index, `缺骨骼 ${n}`);
    sk.bones.forEach((b, i) => assert.ok(b.parent < i));
    for (const b of sk.bones) if (b.name.endsWith('_L')) {
      const rn = b.name.replace('_L', '_R'); if (!(rn in sk.index)) { assert.equal(b.name, 'scabbard_L', '只有剑鞘骨允许没有右侧镜像'); continue; }
      const r = sk.bones[sk.index[rn]]; near(b.pos[0], -r.pos[0], 1e-6); near(b.pos[1], r.pos[1], 1e-6); near(b.pos[2], r.pos[2], 1e-6);
    }
  });
  test(`${kind}：身高 = 设定值（头顶 ±2 mm），鞋底贴地 ±1 mm`, () => {
    const d = built[kind], skin = d.parts.find((p) => p.name === 'skin'), shoes = d.parts.find((p) => p.name === 'shoes');
    near(C.bounds(skin).max[1], d.height, 0.002, '头顶'); near(C.bounds(shoes).min[1], 0, 0.001, '鞋底');
    return `H=${d.height} m`;
  });
  test(`${kind}：蒙皮 ≤4 影响、和为 1，且每个部件只用到它被允许的骨骼`, () => {
    const d = built[kind], names = d.skeleton.bones.map((b) => b.name);
    for (const p of d.parts) {
      const rule = BONE_RULE[p.name]; if (!rule) continue;
      for (let i = 0; i < p.skinIndex.length; i++) if (p.skinWeight[i] > 0) assert.ok(rule.test(names[p.skinIndex[i]]), `${p.name} 用到了 ${names[p.skinIndex[i]]}`);
    }
  });
  test(`${kind}：兵器标记/受击胶囊/布料网格元数据自洽`, () => {
    const d = built[kind], w = d.weapon, names = new Set(d.skeleton.bones.map((b) => b.name));
    assert.ok(w && w.length > 1 && w.tip[1] > w.base[1]); near(Math.hypot(...w.tip.map((v, i) => v - w.base[i])), w.length, 1e-9);
    for (const c of d.capsules) { assert.ok(names.has(c.a) && names.has(c.b) && c.r > 0); }
    for (const p of d.parts) if (p.cloth) assert.equal(p.positions.length / 3, p.cloth.panels * (p.cloth.rows + 1) * (p.cloth.cols + 1), `布料 ${p.name}`);
  });
}
test('特征部件：悟空有金冠/长翎/披风，八戒有猪嘴/耳，沙僧有骷髅/胡须，唐僧有帽/袈裟/念珠', () => {
  const has = (k, ...ns) => ns.forEach((n) => assert.ok(built[k].parts.some((p) => p.name === n), `${k} 缺 ${n}`));
  has('wukong', 'crown', 'feathers', 'cape', 'tigerSkirt', 'armor'); has('bajie', 'pants', 'belt'); has('wujing', 'skulls', 'beard', 'hair'); has('tangseng', 'hat', 'kasaya', 'beads');
  assert.ok(C.bounds(built.bajie.parts.find((p) => p.name === 'skin')).max[2] > built.bajie.layout.head.c[2] + built.bajie.layout.head.rz, '猪嘴应伸出头部前方');
});
test('确定性：同 kind+seed 逐位相同；seed 变体身高在 ±1.5% 内；各角色互不相同', () => {
  for (const kind of KINDS) {
    const a = CH.buildCharacterData({ kind }), b = CH.buildCharacterData({ kind });
    a.parts.forEach((p, i) => assert.equal(C.hashMesh(p), C.hashMesh(b.parts[i])));
    const v1 = CH.buildCharacterData({ kind, seed: 7 }), v2 = CH.buildCharacterData({ kind, seed: 7 }), v3 = CH.buildCharacterData({ kind, seed: 8 });
    assert.equal(C.hashMesh(v1.parts[0]), C.hashMesh(v2.parts[0])); assert.notEqual(C.hashMesh(v1.parts[0]), C.hashMesh(v3.parts[0]));
    assert.ok(Math.abs(v1.height / CH.CHARACTERS[kind].height - 1) <= 0.0151);
  }
  assert.equal(new Set(KINDS.map((k) => C.hashMesh(built[k].parts[0]))).size, KINDS.length);
});
test('边界：极矮 1.0 m / 极高 2.4 m / 最大 uint32 种子 / belly=0 仍然有效', () => {
  for (const h of [1.0, 2.4]) { const d = CH.buildCharacterData({ kind: 'wujing', override: { height: h } }); near(C.bounds(d.parts.find((p) => p.name === 'skin')).max[1], h, 0.003); d.parts.forEach((p) => assert.deepEqual(C.validateMesh(p, { bones: 41 }), [])); }
  const s = CH.buildCharacterData({ kind: 'bajie', seed: 4294967295 }); s.parts.forEach((p) => assert.deepEqual(C.validateMesh(p, { bones: 41 }), []));
  assert.ok(CH.buildCharacterData({ kind: 'bajie', override: { build: { belly: 0 } } }).stats.triangles > 0);
});
test('异常输入：未知角色 / NaN 或越界身高 / 负体型 → 抛出明确错误', () => {
  assert.throws(() => CH.buildCharacterData({ kind: 'nope' }), /未知角色/);
  assert.throws(() => CH.buildCharacterData({ kind: 'wukong', override: { height: NaN } }), RangeError);
  assert.throws(() => CH.buildCharacterData({ kind: 'wukong', override: { height: 9 } }), RangeError);
  assert.throws(() => CH.buildCharacterData({ kind: 'wukong', override: { build: { arm: -1 } } }), RangeError);
});

// ═════════════════════════════ 环境 ═════════════════════════════
section('环境建模（地形 / 道路 / 岩石 / 远山）');
const ground = W.makeGround({ seed: 1 });
test('确定性：同种子逐点相同，不同种子不同', () => {
  const g2 = W.makeGround({ seed: 1 }), g3 = W.makeGround({ seed: 2 }); let diff = 0;
  for (let i = 0; i < 500; i++) { const x = (i * 13.7) % 300 - 150, z = (i * 7.3) % 300 - 150; assert.equal(ground.heightAt(x, z), g2.heightAt(x, z)); if (Math.abs(ground.heightAt(x, z) - g3.heightAt(x, z)) > 1e-6) diff++; }
  assert.ok(diff > 450);
});
test('丘顶平台：r<7 m 内 |H−Hc| ≤ 0.03（BIBLE：直径约 14 m 的决斗平地）', () => {
  let mx = 0; for (let a = 0; a < 360; a += 10) for (const r of [0, 2, 4, 6, 6.99]) mx = Math.max(mx, Math.abs(ground.heightAt(Math.cos(a * Math.PI / 180) * r, Math.sin(a * Math.PI / 180) * r) - ground.Hc));
  assert.ok(mx <= 0.0301); return `max=${mx.toFixed(4)} m`;
});
test('道路：中心线高度贴合 LUT grade；grade 平滑；距离/弧长查询正确', () => {
  const rd = ground.roads[0]; let mx = 0, d2 = 0;
  for (let i = 0; i < rd.n; i += 4) mx = Math.max(mx, Math.abs(ground.heightAt(rd.x[i], rd.z[i]) - rd.g[i]));
  for (let i = 1; i < rd.n - 1; i++) d2 = Math.max(d2, Math.abs(rd.g[i + 1] - 2 * rd.g[i] + rd.g[i - 1]));
  assert.ok(mx < 0.35, `center-grade=${mx}`); assert.ok(d2 < 0.12, `2nd diff=${d2}`);
  const i = 600, info = ground.roadInfo(rd.x[i], rd.z[i]); assert.ok(info.d < 0.02); near(info.s, i * 0.5, 0.6);
  assert.ok(ground.roadInfo(rd.x[i] + 5, rd.z[i] + 5).d > 3); return `|H-grade|max=${mx.toFixed(3)} m，grade 二阶差 max=${d2.toFixed(3)}`;
});
test('法线：单位长、朝上；极大坐标仍为有限数', () => {
  for (let i = 0; i < 2000; i++) { const n = ground.normalAt((i * 37.7) % 800 - 400, (i * 91.3) % 800 - 400); near(Math.hypot(...n), 1, 1e-9); assert.ok(n[1] > 0); }
  for (const p of [[1e5, 1e5], [-3e5, 2e5]]) assert.ok(Number.isFinite(ground.heightAt(...p)) && Number.isFinite(ground.normalAt(...p)[1]));
});
test('路网输入：无路 / 多条路 / 种子生成的路 / 非法控制点', () => {
  const none = W.makeGround({ seed: 1, roads: null }); assert.equal(none.roadInfo(0, 30).d, Infinity); assert.equal(none.roads.length, 0);
  const r1 = W.generateRoad(5), r2 = W.generateRoad(5), r3 = W.generateRoad(6); assert.deepEqual(r1, r2); assert.notDeepEqual(r1, r3); assert.equal(r1.length, 9);
  const multi = W.makeGround({ seed: 1, roads: [W.DEFAULT_ROAD, [[300, 300], [350, 340], [420, 380]]] }); assert.equal(multi.roads.length, 2);
  assert.equal(multi.roadInfo(350, 340).road, 1); assert.equal(multi.roadInfo(0, 30).road, 0);
  assert.ok(Number.isFinite(W.makeGround({ seed: 3, roads: [r1] }).heightAt(-420, 130)));
  assert.throws(() => W.makeGround({ roads: [[[0, 0]]] }), RangeError); assert.throws(() => W.makeGround({ roads: [[[0, 0], [NaN, 5]]] }), RangeError);
});
test('可分离网格轴：对称递增，内部 427 列，总数≈627', () => {
  const ax = W.makeAxis(); for (let i = 1; i < ax.length; i++) assert.ok(ax[i] > ax[i - 1]);
  for (let i = 0; i < ax.length; i++) near(ax[i], -ax[ax.length - 1 - i], 1e-9);
  assert.equal(ax.filter((v) => Math.abs(v) < 160).length, 427); assert.ok(ax.length >= 620 && ax.length <= 630); near(ax[ax.length - 1], 1500, 1e-9); return `${ax.length} 条轴线`;
});
test('粗网格：有效、全部三角朝上、种子路网也能铺', () => {
  for (const g of [ground, W.makeGround({ seed: 9, roads: [W.generateRoad(9)] })]) {
    const m = W.buildTerrain(g, { axisOpts: { step: 6, growth: 1.2 }, cavity: false }), P = m.positions, I = m.indices; let flip = 0;
    for (let t = 0; t < I.length; t += 3) { const a = I[t], b = I[t + 1], c = I[t + 2]; if ((P[3 * b + 2] - P[3 * a + 2]) * (P[3 * c] - P[3 * a]) - (P[3 * b] - P[3 * a]) * (P[3 * c + 2] - P[3 * a + 2]) <= 0) flip++; }
    assert.equal(flip, 0); assert.deepEqual(C.validateMesh({ ...m, uvs: new Float32Array(0) }), []);
  }
});
let fullMesh = null;
test('全分辨率网格：顶点/三角数、顶点=解析高度、法线朝上、网格与解析面偏差', () => {
  const t = performance.now(); fullMesh = W.buildTerrain(ground); const dt = performance.now() - t, m = fullMesh;
  assert.equal(m.positions.length / 3, 625 * 625); assert.equal(m.indices.length / 3, 2 * 624 * 624);
  for (let k = 0; k < 4000; k++) { const v = (k * 97) % (625 * 625); near(m.positions[3 * v + 1], ground.heightAt(m.positions[3 * v], m.positions[3 * v + 2]), 1e-3); }
  for (let i = 1; i < m.normals.length; i += 3) assert.ok(m.normals[i] > 0);
  let s2 = 0, n = 0, mx = 0, mxRoad = 0; let a = 12345; const rnd = () => (a = (a * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 4000; i++) { const x = (rnd() * 2 - 1) * 159, z = (rnd() * 2 - 1) * 159, e = Math.abs(W.terrainHeightFromMesh(m, x, z) - ground.heightAt(x, z)); if (ground.roadInfo(x, z).d > 8) { s2 += e * e; n++; mx = Math.max(mx, e); } else mxRoad = Math.max(mxRoad, e); }
  const rms = Math.sqrt(s2 / n); assert.ok(rms < 0.008 && mx < 0.06 && mxRoad < 0.1, `rms=${rms} max=${mx}`);
  return `构建 ${(dt / 1000).toFixed(1)} s；离路 RMS ${(rms * 1000).toFixed(1)} mm / 最大 ${(mx * 1000).toFixed(0)} mm；路边最大 ${(mxRoad * 1000).toFixed(0)} mm`;
});
test('着色权重：和为 1 且非负；路面→泥土、岩石摆放后→岩石；草密度/湿度在 [0,1]', () => {
  let a = 99; const rnd = () => (a = (a * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 1500; i++) { const x = (rnd() * 2 - 1) * 400, z = (rnd() * 2 - 1) * 400, w = ground.splatAt(x, z, ground.normalAt(x, z), ground.cavityAt(x, z)); near(w[0] + w[1] + w[2] + w[3], 1, 1e-9); w.forEach((v) => assert.ok(v >= -1e-12)); }
  const rd = ground.roads[0]; assert.ok(ground.splatAt(rd.x[300], rd.z[300])[3] > 0.9);
  const gi = ground.groundInfoAt(rd.x[300], rd.z[300]); assert.equal(gi.density, 0); for (const g of [ground.groundInfoAt(40, -60), gi]) { assert.ok(g.density >= 0 && g.density <= 1 && g.moisture >= 0 && g.moisture <= 1 && g.ao >= 0.45 && g.ao <= 1); }
});
const protos = W.makeRockPrototypes();
test('岩石原型：6 个，封闭(体积>0)，法线有效，hi/lo 两档轮廓一致', () => {
  assert.equal(protos.length, 6);
  for (const p of protos) { assert.ok(C.signedVolume(p.hi) > 0); assert.deepEqual(C.validateMesh(p.hi), []); assert.deepEqual(C.validateMesh(p.lo), []); const bh = C.bounds(p.hi), bl = C.bounds(p.lo); for (let k = 0; k < 3; k++) near(bh.max[k], bl.max[k], 0.12 * (bh.max[k] - bh.min[k]) + 0.05); }
  return `hi ${protos[0].hi.indices.length / 3} 三角 / lo ${protos[0].lo.indices.length / 3} 三角`;
});
const placement = W.placeRocks(ground, protos);
test('岩石摆放：5–12 主石、每块 3–9 碎石、2–3 立石(y×2.5)、normal.y≥0.72、下沉 25–50%', () => {
  const by = (k) => placement.instances.filter((r) => r.kind === k), heroes = by('hero'), debris = by('debris'), stand = by('standing');
  assert.ok(heroes.length >= 5 && heroes.length <= 12 && stand.length >= 2 && stand.length <= 3, `hero=${heroes.length}`);
  assert.ok(debris.length >= heroes.length * 3 * 0.5 && debris.length <= heroes.length * 9);
  for (const r of placement.instances) { assert.ok(r.sink >= 0.25 && r.sink <= 0.5); if (r.kind !== 'outcrop') assert.ok(r.normalY >= 0.72); else assert.ok(r.normalY < 0.8); }
  for (const r of heroes) assert.ok(r.scale[0] >= 1.5 && r.scale[0] <= 4); for (const r of stand) near(r.scale[1] / r.scale[0], 2.5, 1e-9);
  const again = W.placeRocks(W.makeGround({ seed: 1 }), protos); assert.deepEqual(again.instances.map((r) => r.matrix[12]), placement.instances.map((r) => r.matrix[12]));
  return `主石 ${heroes.length} / 碎石 ${debris.length} / 立石 ${stand.length} / 露头 ${by('outcrop').length}`;
});
test('岩石矩阵：基向量正交且长度=缩放；露头对齐地面法线；岩石脚印在着色里变成岩石', () => {
  for (const r of placement.instances) { const m = r.matrix, rx = [m[0], m[1], m[2]], up = [m[4], m[5], m[6]], fw = [m[8], m[9], m[10]]; near(C.v3.dot(rx, up), 0, 1e-4); near(C.v3.dot(up, fw), 0, 1e-4); near(C.v3.len(rx), r.scale[0], 1e-4); near(C.v3.len(up), r.scale[1], 1e-4); near(C.v3.len(fw), r.scale[2], 1e-4); }
  const o = placement.instances.find((r) => r.kind === 'outcrop'), n = ground.normalAt(o.x, o.z); near(o.matrix[5] / o.scale[1], n[1], 1e-3);
  const h = placement.instances.find((r) => r.kind === 'hero'); assert.ok(ground.splatAt(h.x, h.z)[2] > 0.9);
});
const rings = W.buildMountainRings();
test('远山环带：4 层 481×11，有效，首尾无缝，日落缺口，雪只在第 3 层', () => {
  assert.equal(rings.length, 4);
  rings.forEach((m, li) => { assert.equal(m.positions.length / 3, 481 * 11); assert.deepEqual(C.validateMesh(m), []); const L = W.MOUNTAIN_LAYERS[li]; for (let k = 0; k < 481 * 11; k++) { const y = m.positions[3 * k + 1]; assert.ok(y >= L.base - 1e-3 && y <= L.base + L.H * 1.2 + 1e-3); } for (let j = 0; j < 11; j++) for (let c = 0; c < 3; c++) near(m.positions[3 * j + c], m.positions[3 * (480 * 11 + j) + c], 1e-2, '接缝'); });
  const thSun = Math.atan2(W.SUN_DIR[0], W.SUN_DIR[2]), m = rings[3], crest = (i) => { let b = -1e9; for (let j = 0; j < 11; j++) b = Math.max(b, m.positions[3 * (i * 11 + j) + 1]); return b; };
  let near_ = 0, nn = 0, far_ = 0, nf = 0; for (let i = 0; i < 480; i++) { const th = 2 * Math.PI * i / 480, d = Math.abs(((th - thSun + 3 * Math.PI) % (2 * Math.PI)) - Math.PI); if (d < 0.15) { near_ += crest(i); nn++; } else if (d > 1.5) { far_ += crest(i); nf++; } }
  assert.ok(near_ / nn < 0.8 * far_ / nf, '日落方向应有缺口');
  assert.ok(rings.every((r) => r.colors.every((v) => v >= 0 && v < 1.5)));
  const snowCount = rings.map((r) => r.snow.reduce((a, b) => a + b, 0)); assert.ok(snowCount[2] > 0 && snowCount[0] + snowCount[1] + snowCount[3] === 0, `雪=${snowCount}`);
  const r2 = rings[2]; for (let i = 0; i < 481; i++) for (let j = 0; j < 11; j++) { const k = i * 11 + j; if (r2.snow[k]) { const th = 2 * Math.PI * i / 480; assert.ok(Math.abs(((th - thSun - Math.PI + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) < 0.874); assert.ok(r2.relH[k] > 0.52 && r2.normals[3 * k + 1] > 0.55, '雪线 = 0.62 + 0.1·fbm，fbm∈[-1,1] → 下限 0.52'); } }
  return `缺口比 ${(near_ / nn / (far_ / nf)).toFixed(2)}；雪顶点 ${snowCount[2]}（仅第 3 层、仅背日一侧）`;
});

// ═════════════════════════════ 游戏接入所需（栅格高度 / 坐姿 / 烘焙） ═════════════════════════════
section('游戏接入：栅格高度 · 坐姿 · 烘焙 · 参数');
const GAME = { swell: 28, swellFreq: 0.001, swellOct: 3, undul: 0.8, hummock: 0.08, boundAmp: 0, pad: { inner: 9, outer: 40 }, rim: { start: 880, end: 1350, amp: 60, square: true }, dryBias: -0.25 };
test('栅格高度：与渲染网格严格一致（同一三角划分），越界夹边，且与解析面的偏差在预期量级', () => {
  const g = W.makeGround({ seed: 11, roads: null, ...GAME }), ax = W.makeAxis({ inner: 900, step: 5, growth: 1.045, outer: 1500 });
  const S = W.sampleHeights(g, ax), M = W.buildTerrain(g, { heights: S.heights, axis: ax, cavity: false, colors: false });
  assert.equal(S.cols, ax.length); assert.equal(M.positions.length / 3, ax.length * ax.length);
  let a = 7; const rnd = () => (a = (a * 1664525 + 1013904223) >>> 0) / 4294967296; let s2 = 0, n = 0;
  for (let i = 0; i < 3000; i++) { const x = (rnd() * 2 - 1) * 880, z = (rnd() * 2 - 1) * 880; near(W.terrainHeightFromMesh(S, x, z), W.terrainHeightFromMesh(M, x, z), 1e-6); const e = W.terrainHeightFromMesh(S, x, z) - g.heightAt(x, z); s2 += e * e; n++; }
  for (const [x, z] of [[5000, 5000], [-5000, 0], [0, -9e9]]) assert.ok(Number.isFinite(W.terrainHeightFromMesh(S, x, z)));
  const nodeI = ax.findIndex((v) => Math.abs(v) < 1e-9); near(S.heights[nodeI * S.cols + nodeI], g.heightAt(0, 0), 1e-4);
  const rms = Math.sqrt(s2 / n); assert.ok(rms < 0.2, `rms=${rms}`); return `5 m 网格：偏差 RMS ${(rms * 100).toFixed(0)} cm（细节交给解析法线，几何与玩法一致）`;
});
test('栅格法线：单位长、朝上；在可玩区(±880 m)内与解析法线平均夹角<2°，且比解析法线快', () => {
  const g = W.makeGround({ seed: 21, roads: null, ...GAME }), ax = W.makeAxis({ inner: 900, step: 6, growth: 1.06, outer: 1500 }), S = W.sampleHeights(g, ax), nx = ax.length;
  let t = performance.now(); const A = W.buildTerrain(g, { axis: ax, heights: S.heights, colors: false, gridNormals: true }); const tg = performance.now() - t;
  t = performance.now(); const B = W.buildTerrain(g, { axis: ax, heights: S.heights, colors: false }); const ta = performance.now() - t;
  let worst = 0, sum = 0, n = 0;
  for (let k = 0; k < nx * nx; k++) {
    const i = 3 * k; near(Math.hypot(A.normals[i], A.normals[i + 1], A.normals[i + 2]), 1, 1e-5); assert.ok(A.normals[i + 1] > 0);
    if (Math.abs(ax[k % nx]) > 880 || Math.abs(ax[Math.floor(k / nx)]) > 880) continue;
    const d = Math.acos(Math.min(1, A.normals[i] * B.normals[i] + A.normals[i + 1] * B.normals[i + 1] + A.normals[i + 2] * B.normals[i + 2])); worst = Math.max(worst, d); sum += d; n++;
  }
  assert.ok(sum / n < 0.035, `平均夹角 ${sum / n}`); assert.ok(tg < ta);
  return `可玩区内平均夹角 ${(sum / n * 180 / Math.PI).toFixed(2)}°、最大 ${(worst * 180 / Math.PI).toFixed(1)}°；栅格法线 ${tg.toFixed(0)} ms vs 解析 ${ta.toFixed(0)} ms`;
});
test('游戏参数：山脊只在可玩区之外；平台过渡可调；起伏幅度可调；偏绿', () => {
  const g = W.makeGround({ seed: 4, roads: null, ...GAME }), g0 = W.makeGround({ seed: 4, roads: null, ...GAME, rim: { ...GAME.rim, amp: 0 } });
  for (let i = 0; i < 400; i++) { const x = Math.sin(i) * 860, z = Math.cos(i * 1.9) * 860; assert.equal(g.heightAt(x, z), g0.heightAt(x, z)); }
  let rimMax = -1e9; for (let i = 0; i < 400; i++) { const x = Math.cos(i) * 1250, z = Math.sin(i * 1.3) * 1250; rimMax = Math.max(rimMax, g.heightAt(x, z) - g0.heightAt(x, z)); } assert.ok(rimMax > 10, `rim=${rimMax}`);
  const sd = (gg) => { let s = 0, s2 = 0, n = 0; for (let i = 0; i < 4000; i++) { const h = gg.heightAt(Math.sin(i * 0.7) * 700, Math.cos(i * 1.1) * 700); s += h; s2 += h * h; n++; } return Math.sqrt(s2 / n - (s / n) ** 2); };
  const ratio = sd(W.makeGround({ seed: 4, roads: null, ...GAME, swell: 24 })) / sd(W.makeGround({ seed: 4, roads: null, ...GAME, swell: 16 })); assert.ok(ratio > 1.15 && ratio < 1.6, `ratio=${ratio}`);
  const dry = (gg) => { let s = 0; for (let i = 0; i < 800; i++) { const x = Math.sin(i * 0.9) * 600, z = Math.cos(i * 1.7) * 600; s += gg.splatAt(x, z)[1]; } return s / 800; };
  assert.ok(dry(W.makeGround({ seed: 4, roads: null, dryBias: -0.4 })) < dry(W.makeGround({ seed: 4, roads: null, dryBias: 0 })));
  const pal = W.makeGround({ seed: 4, roads: null, palette: { lush: [1, 0, 0], dry: [1, 0, 0], dirt: [1, 0, 0], rock: [1, 0, 0] } }).colorAt(100, 100); assert.ok(pal[0] > 0.5 && pal[1] < 0.2);
  const gp = W.makeGround({ seed: 4, roads: null, pad: { inner: 9, outer: 40 } }); for (let a = 0; a < 6; a++) near(gp.heightAt(Math.cos(a) * 8.9, Math.sin(a) * 8.9), gp.Hc, 0.031);
});
test('坡度：游戏参数下地形与旧地形(正弦叠加)同一量级——建筑/树按缓坡设计，不能更陡', () => {
  const legacy = (x, z) => Math.sin(x * 0.008) * 8 + Math.cos(z * 0.011) * 7 + Math.sin((x + z) * 0.004) * 9 + Math.cos(Math.hypot(x, z) * 0.014) * 5 - Math.exp(-(((x + z * 0.25) / 70) ** 2)) * 12;
  const g = W.makeGround({ seed: 3811803460, roads: null, ...GAME });
  const stats = (h) => { const s = []; let a = 5; const rnd = () => (a = (a * 1664525 + 1013904223) >>> 0) / 4294967296; for (let i = 0; i < 8000; i++) { const x = (rnd() * 2 - 1) * 850, z = (rnd() * 2 - 1) * 850, e = 3; s.push(Math.hypot((h(x + e, z) - h(x - e, z)) / (2 * e), (h(x, z + e) - h(x, z - e)) / (2 * e))); } s.sort((p, q) => p - q); return { p50: s[Math.floor(s.length * 0.5)], p90: s[Math.floor(s.length * 0.9)] }; };
  const a = stats(legacy), b = stats((x, z) => g.heightAt(x, z));
  assert.ok(b.p50 <= a.p50 * 1.3 && b.p90 <= a.p90 * 1.3, `新 ${JSON.stringify(b)} 旧 ${JSON.stringify(a)}`);
  return `坡度中位数 新 ${b.p50.toFixed(3)} / 旧 ${a.p50.toFixed(3)}；p90 新 ${b.p90.toFixed(3)} / 旧 ${a.p90.toFixed(3)}`;
});
test('远山 bake:false / albedoScale：只输出反照率(0..1)，仍保留雪标记；面片整体朝上(俯视可见)', () => {
  const raw = W.buildMountainRings({ bake: false, albedoScale: 3 }), base = W.buildMountainRings({ bake: false });
  raw.forEach((m, li) => { assert.ok(m.colors.every((v) => v >= 0 && v <= 1)); assert.deepEqual(C.validateMesh(m), []); let down = 0; for (let i = 1; i < m.normals.length; i += 3) if (m.normals[i] < -1e-6) down++; assert.equal(down, 0, `第${li}层有朝下的法线`); });
  assert.ok(raw[0].colors[3] > base[0].colors[3] * 2.5); assert.ok(raw[2].snow.some((v) => v === 1));
});
test('坐姿：静止姿态往返无损；骑马姿态下大腿前屈、膝弯；蒙皮权重不被破坏；摆姿不改原数据', () => {
  for (const kind of KINDS) {
    const d = built[kind], hashBefore = d.parts.map((p) => C.hashMesh(p)), rest = CH.poseData(d, { bones: {} }), ride = CH.poseData(d, CH.RIDE_POSE);
    d.parts.forEach((p, i) => { for (let k = 0; k < p.positions.length; k++) near(p.positions[k], rest.parts[i].positions[k], 1e-5); assert.equal(C.hashMesh(p), hashBefore[i]); assert.deepEqual(C.validateMesh(ride.parts[i], { bones: 41 }), []); });
    const shoes = (x) => C.bounds(x.parts.find((p) => p.name === 'shoes')); assert.ok(shoes(ride).min[2] > shoes(d).min[2] + 0.3 * d.height * 0.6 - 0.01, '脚应向前伸'); assert.ok(shoes(ride).min[1] > 0.15, '脚离地、悬在坐骑身侧');
  }
  assert.ok(CH.eulerMat(0, 0, 0).every((v, i) => v === (i % 4 === 0 ? 1 : 0)));
  const m = CH.eulerMat(0.3, -0.7, 1.1); near(m[0] * m[4] * m[8] + m[1] * m[5] * m[6] + m[2] * m[3] * m[7] - m[2] * m[4] * m[6] - m[1] * m[3] * m[8] - m[0] * m[5] * m[7], 1, 1e-9);
});
test('烘焙：≤3 个桶，三角/顶点守恒，颜色在 [0,1] 且随 colorScale 变亮，金属只在金属桶', () => {
  for (const kind of KINDS) {
    const d = built[kind], b1 = CH.bakeCharacter(d), b2 = CH.bakeCharacter(d, { colorScale: 1.5 });
    assert.ok(b1.buckets.length >= 2 && b1.buckets.length <= 3); const tri = (b) => b.buckets.reduce((s, x) => s + x.mesh.indices.length / 3, 0); assert.equal(tri(b1), d.stats.triangles);
    for (const bk of b2.buckets) { assert.ok(bk.mesh.colors.every((v) => v >= 0 && v <= 1)); assert.deepEqual(C.validateMesh(bk.mesh, { bones: 41 }), []); }
    const avg = (b) => { let s = 0, n = 0; for (const x of b.buckets) for (const v of x.mesh.colors) { s += v; n++; } return s / n; }; assert.ok(avg(b2) > avg(b1));
  }
  const wk = CH.bakeCharacter(built.wukong); assert.ok(wk.buckets.some((x) => x.name === 'metal') && wk.buckets.some((x) => x.name === 'gloss'));
});

// ═════════════════════════════ THREE 适配层（stub） ═════════════════════════════
section('THREE 适配层（最小 stub 验证调用逻辑；真机请在浏览器里目检）');
function makeThreeStub() {
  class Vector3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } }
  class Color { constructor() { this.r = 1; this.g = 1; this.b = 1; } setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; return this; } }
  class Matrix4 { constructor() { this.elements = new Array(16).fill(0); } fromArray(a) { a.forEach((v, i) => { this.elements[i] = v; }); return this; } }
  class Object3D { constructor() { this.name = ''; this.position = new Vector3(); this.children = []; this.parent = null; this.userData = {}; }
    add(...o) { for (const c of o) { c.parent = this; this.children.push(c); } return this; } updateMatrixWorld() {}
    world() { const p = new Vector3(); for (let n = this; n; n = n.parent) { p.x += n.position.x; p.y += n.position.y; p.z += n.position.z; } return p; }
    localToWorld(v) { const w = this.world(); v.x += w.x; v.y += w.y; v.z += w.z; return v; } }
  class Mat { constructor(p = {}) { Object.assign(this, p); this.color = new Color(); this.sheenColor = new Color(); } dispose() { this.disposed = true; } }
  class BufferAttribute { constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.count = array.length / itemSize; } }
  class BufferGeometry { constructor() { this.attributes = {}; this.index = null; } setAttribute(n, a) { this.attributes[n] = a; return this; } setIndex(a) { this.index = a; return this; } computeBoundingBox() {} computeBoundingSphere() {} dispose() { this.disposed = true; } }
  class Mesh extends Object3D { constructor(g, m) { super(); this.geometry = g; this.material = m; } }
  class InstancedMesh extends Mesh { constructor(g, m, n) { super(g, m); this.count = n; this.mats = []; this.instanceMatrix = { needsUpdate: false }; } setMatrixAt(i, m) { this.mats[i] = m; } }
  return { Vector3, Color, Matrix4, Object3D, BufferAttribute, BufferGeometry, Mesh, InstancedMesh, DoubleSide: 2, FrontSide: 0,
    Group: class Group extends Object3D {}, Bone: class Bone extends Object3D {}, Skeleton: class Skeleton { constructor(b) { this.bones = b; } },
    SkinnedMesh: class SkinnedMesh extends Mesh { bind(s) { this.skeleton = s; } },
    MeshStandardMaterial: class MeshStandardMaterial extends Mat {}, MeshPhysicalMaterial: class MeshPhysicalMaterial extends Mat {}, MeshBasicMaterial: class MeshBasicMaterial extends Mat {} };
}
const T = makeThreeStub();
test('角色：骨骼层级与静止世界位置一致，所有 SkinnedMesh 共用同一 Skeleton，属性长度正确', () => {
  for (const kind of KINDS) {
    const d = built[kind], ch = TH.createCharacter(T, d);
    d.skeleton.bones.forEach((b, i) => { const w = ch.bones[i].world(); near(w.x, b.pos[0], 1e-9); near(w.y, b.pos[1], 1e-9); near(w.z, b.pos[2], 1e-9); assert.equal(ch.bones[i].name, b.name); });
    assert.equal(ch.meshes.length, d.parts.length);
    ch.meshes.forEach((m, i) => { const n = d.parts[i].positions.length / 3; assert.equal(m.skeleton, ch.skeleton); assert.equal(m.geometry.attributes.skinIndex.count, n); assert.equal(m.geometry.attributes.skinWeight.count, n); assert.ok(m.geometry.index.array instanceof Uint32Array); assert.equal(m.material.vertexColors, !!d.parts[i].colors); });
    assert.equal(ch.weapon.object.name, 'weapon_R'); near(ch.weapon.tip.position.y - ch.weapon.base.position.y, d.weapon.length, 1e-9);
  }
});
test('受击胶囊：数量/端点正确，复用输出数组不新增对象；自定义材质工厂生效', () => {
  const d = built.wukong, ch = TH.createCharacter(T, d, { materialFactory: (s) => (s.kind === 'metal' ? new T.MeshBasicMaterial({ custom: true }) : null) });
  const out = ch.hurtCapsules(), first = out[0]; assert.equal(out.length, d.capsules.length); assert.equal(ch.hurtCapsules(out)[0], first);
  const neck = d.skeleton.bones.find((b) => b.name === 'neck'); near(out[0].a.x, neck.pos[0], 1e-9); near(out[0].a.y, neck.pos[1], 1e-9);
  out.forEach((e) => { assert.ok([e.a.x, e.a.y, e.a.z, e.b.x, e.b.y, e.b.z, e.r].every(Number.isFinite)); });
  assert.ok(ch.meshes.some((m) => m.material.custom)); assert.ok(ch.meshes.some((m) => m.userData.cloth));
  ch.dispose(); assert.ok(ch.meshes.every((m) => m.geometry.disposed));
});
test('异常输入：无兵器的角色数据也能创建；材质 vertexColors 与数据一致', () => {
  const d = { ...built.tangseng, weapon: null }, ch = TH.createCharacter(T, d); assert.equal(ch.weapon, null);
  assert.equal(ch.meshes.find((m) => m.name === 'kasaya').material.vertexColors, true);
});
test('静态角色：每桶一个 Mesh、顶点色开启、无骨骼；lit 远山用标准材质并受雾影响', () => {
  const st = TH.createStaticCharacter(T, CH.bakeCharacter(CH.poseData(built.tangseng, CH.RIDE_POSE), { colorScale: 1.4 })); assert.ok(st.meshes.length >= 2 && st.meshes.length <= 3);
  st.meshes.forEach((m) => { assert.equal(m.material.vertexColors, true); assert.ok(!m.skeleton); assert.equal(m.castShadow, true); assert.ok(m.geometry.attributes.color && !m.geometry.attributes.skinIndex); });
  const lit = TH.createMountains(T, W.buildMountainRings({ bake: false }), { lit: true }); assert.ok(lit.children.every((c) => c.material instanceof T.MeshStandardMaterial && c.material.side === T.DoubleSide)); st.dispose(); assert.ok(st.meshes.every((m) => m.geometry.disposed));
});
test('地形/岩石/远山：属性数量、实例矩阵、渲染顺序', () => {
  const t = TH.createTerrainMesh(T, fullMesh); assert.equal(t.geometry.attributes.position.count, 625 * 625); assert.equal(t.geometry.index.count, 778752 * 3); assert.equal(t.frustumCulled, false); assert.equal(t.material.vertexColors, true);
  const rk = TH.createRocks(T, protos, placement); assert.equal(rk.meshes.reduce((s, m) => s + m.count, 0), placement.instances.length); assert.equal(rk.loGeometries.length, 6);
  const im = rk.meshes[0], first = placement.instances.find((r) => r.proto === im.userData.protoId); near(im.mats[0].elements[12], first.matrix[12], 1e-6);
  const mt = TH.createMountains(T, rings); assert.equal(mt.children.length, 4); assert.ok(mt.children[3].renderOrder < mt.children[0].renderOrder); assert.equal(mt.children[0].material.fog, false);
  const all = TH.createWorldObjects(T, { terrain: W.buildTerrain(ground, { axisOpts: { step: 8, growth: 1.3 }, colors: false, cavity: false }), protos, placement, rings }); assert.ok(all.terrain && all.rocks && all.mountains);
  return `一个场景 ≈ 1 地形 + ${rk.meshes.length} 岩石实例网格 + 4 远山 = ${1 + rk.meshes.length + 4} 次绘制`;
});

console.log(`\n${fail ? '✗' : '✓'} 通过 ${pass} / ${pass + fail}${fail ? `；失败：${fails.join(' | ')}` : ''}`);
process.exitCode = fail ? 1 : 0;
