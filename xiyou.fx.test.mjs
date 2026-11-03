// xiyou.fx.test.mjs — 光影 / 环境 / 材质 / 画质测试：node xiyou.fx.test.mjs
import assert from 'node:assert/strict';
import * as C from './xiyou-core.js';
import * as FX from './xiyou-fx.js';
import { test, section, near, done } from './_harness.mjs';

section('光影与环境：色温 · 昼夜调色板 · 噪点法线 · 高度混合 · 画质自适应 · 阴影对齐 · GLSL 自检');
test('色温：归一化、蓝分量随色温单调上升、低色温偏红偏暖、6500K 接近白', () => {
  let prevB = -1; for (let K = 1500; K <= 9000; K += 250) { const c = FX.kelvinToRGB(K); assert.ok(Math.max(...c) <= 1 + 1e-9 && Math.max(...c) >= 0.999 && c.every((v) => v >= 0)); assert.ok(c[2] >= prevB - 1e-9, `K=${K}`); prevB = c[2]; }
  const w = FX.kelvinToRGB(1800), n = FX.kelvinToRGB(6500); assert.ok(w[0] > w[2] * 4 && n.every((v) => v > 0.9));
});
test('昼夜调色板：全天连续(无跳变)、数值在界内、日月切换发生在光强≈0时、正午/子夜特征正确', () => {
  let prev = FX.atmosphereAt(0), mI = 0, mE = 0, mF = 0, mD = 0, mH = 0;
  for (let i = 1; i <= 4000; i++) {
    const a = FX.atmosphereAt(i / 4000); mI = Math.max(mI, Math.abs(a.lightIntensity - prev.lightIntensity)); mE = Math.max(mE, Math.abs(a.exposure - prev.exposure)); mF = Math.max(mF, ...a.fogColor.map((v, k) => Math.abs(v - prev.fogColor[k]))); mH = Math.max(mH, Math.abs(a.hemiIntensity - prev.hemiIntensity));
    if (a.isMoon === prev.isMoon) mD = Math.max(mD, Math.acos(Math.min(1, C.v3.dot(a.lightDir, prev.lightDir)))); else assert.ok(a.lightIntensity < 0.02 && prev.lightIntensity < 0.02, '日月切换必须发生在光强≈0');
    assert.ok(a.lightIntensity >= 0 && a.lightIntensity <= 3.3 && a.exposure > 0.9 && a.exposure < 1.5 && a.hemiIntensity > 0.5 && a.hemiIntensity <= 2.2 && a.stars >= 0 && a.stars <= 1);
    near(C.v3.len(a.lightDir), 1, 1e-9); near(C.v3.len(a.sunDir), 1, 1e-9); [a.fogColor, a.zenith, a.hemiSky, a.hemiGround, a.lightColor, a.warmColor].forEach((c) => assert.ok(c.every((v) => Number.isFinite(v) && v >= 0 && v <= 1.0001)));
    prev = a;
  }
  assert.ok(mI < 0.06 && mE < 0.01 && mF < 0.02 && mD < 0.02 && mH < 0.03, `最大步进 I=${mI} E=${mE} F=${mF} D=${mD} H=${mH}`);
  const noon = FX.atmosphereAt(0.25), mid = FX.atmosphereAt(0.75); assert.ok(noon.lightIntensity > 2.8 && !noon.isMoon && noon.hemiIntensity > 1.9 && noon.stars === 0);
  assert.ok(mid.isMoon && mid.lightIntensity > 0.4 && mid.lightIntensity < 0.43 && mid.stars > 0.95 && mid.exposure > 1.3 && mid.lightColor[2] > mid.lightColor[0]);
  assert.ok(noon.lightColor.every((v) => v > 0.85));
});
test('昼夜调色板：低太阳时暖色(红>蓝)且暖雾强；同高度角下黄昏比清晨更暖', () => {
  const at = (t) => FX.atmosphereAt(t); let morn = null, eve = null;
  for (let t = 0.0; t < 0.6; t += 0.0005) { const a = at(t); if (a.rising && !morn && a.sunElev >= 8) morn = a; if (!a.rising && a.sunElev <= 8 && a.sunElev > 0 && !eve) eve = a; }
  assert.ok(morn && eve && morn.lightColor[0] > morn.lightColor[2] && eve.lightColor[2] < morn.lightColor[2] + 1e-9 && eve.warmAmt > 0.5, `晨蓝 ${morn?.lightColor[2]} 昏蓝 ${eve?.lightColor[2]}`);
  const dusk = at(0.54); assert.ok(dusk.warmAmt > at(0.25).warmAmt * 2 && dusk.fogColor[0] > dusk.fogColor[2], `黄昏暖雾 ${dusk.warmAmt} 雾色 ${dusk.fogColor}`);
});
test('噪点法线贴图：单位长、整体朝上、确定性、无缝平铺；发丝/织物/毛发为各向异性，毛孔各向同性', () => {
  const dec = (d, i) => [d[i] / 127.5 - 1, d[i + 1] / 127.5 - 1, d[i + 2] / 127.5 - 1];
  for (const kind of ['pore', 'fur', 'strand', 'weave']) {
    const N = 64, a = FX.makeNormalMapData(N, { kind, seed: 3 }), b = FX.makeNormalMapData(N, { kind, seed: 3 }), c = FX.makeNormalMapData(N, { kind, seed: 4 }); assert.deepEqual(Array.from(a), Array.from(b)); assert.notDeepEqual(Array.from(a), Array.from(c));
    let mz = 0, worst = 0, ax = 0, ay = 0; for (let i = 0; i < N * N; i++) { const n = dec(a, 4 * i); worst = Math.max(worst, Math.abs(Math.hypot(...n) - 1)); mz += n[2]; ax += Math.abs(n[0]); ay += Math.abs(n[1]); assert.equal(a[4 * i + 3], 255); }
    assert.ok(worst < 0.02 && mz / (N * N) > 0.85, `${kind} 单位长误差 ${worst} 平均z ${mz / (N * N)}`);
    let sx = 0, sy = 0, ix = 0, iy = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const p = dec(a, 4 * (y * N + x)), r = dec(a, 4 * (y * N + (x + 1) % N)), d = dec(a, 4 * (((y + 1) % N) * N + x)), dxm = Math.max(Math.abs(p[0] - r[0]), Math.abs(p[1] - r[1])), dym = Math.max(Math.abs(p[0] - d[0]), Math.abs(p[1] - d[1]));
      if (x === N - 1) sx = Math.max(sx, dxm); else ix = Math.max(ix, dxm); if (y === N - 1) sy = Math.max(sy, dym); else iy = Math.max(iy, dym);
    }
    assert.ok(Math.max(sx - ix, sy - iy) <= 0.08, `${kind} 接缝比内部更突兀：sx=${sx} ix=${ix} sy=${sy} iy=${iy}`);
    const R = ax / ay;   // 平均 |X| / 平均 |Y|：>1 说明横向(U)起伏更强 = 条纹沿 V 走
    if (kind === 'strand') assert.ok(R > 2.0, `发丝应是强各向异性(横向细密纵向舒缓)：|X|/|Y|=${R.toFixed(2)}`);
    if (kind === 'weave') assert.ok(R > 1.8, `织物经线方向性：|X|/|Y|=${R.toFixed(2)}`);
    if (kind === 'fur') assert.ok(R > 1.1 && R < 2.4, `毛发应略有方向：${R.toFixed(2)}`);
    if (kind === 'pore') assert.ok(R > 0.75 && R < 1.35, `毛孔应各向同性：${R.toFixed(2)}`);
  }
});
test('地形高度混合：权重和为1且非负；连续(无硬边)；占优层保持占优；噪声让交界有机', () => {
  const nz = (x) => [0.5 + 0.5 * Math.sin(x * 7.1), 0.5 + 0.5 * Math.sin(x * 5.3 + 1), 0.5 + 0.5 * Math.sin(x * 3.7 + 2), 0.5 + 0.5 * Math.sin(x * 9.1 + 3)];
  let prev = null, maxStep = 0; for (let i = 0; i <= 1000; i++) { const t = i / 1000, r = FX.heightBlend([1 - t, t, 0, 0], nz(t * 2.5)); near(r.reduce((s, v) => s + v, 0), 1, 1e-9); assert.ok(r.every((v) => v >= -1e-12 && v <= 1 + 1e-12)); if (prev) maxStep = Math.max(maxStep, ...r.map((v, k) => Math.abs(v - prev[k]))); prev = r; }
  assert.ok(maxStep < 0.05, `最大步进 ${maxStep}`);
  const dn = FX.heightBlend([0.5, 0.5, 0, 0], [0.5, 0.5, 0.5, 0.5]), dn2 = FX.heightBlend([0.5, 0.5, 0, 0], [0.51, 0.5, 0.5, 0.5]); assert.ok(Math.abs(dn[0] - dn2[0]) < 0.2, '对噪声也连续');
  const dom = FX.heightBlend([0.96, 0.04, 0, 0], [0.5, 0.5, 0.5, 0.5]); assert.ok(dom[0] > 0.95);
  const mixed = FX.heightBlend([0.5, 0.5, 0, 0], [0.8, 0.2, 0.5, 0.5]), flip = FX.heightBlend([0.5, 0.5, 0, 0], [0.2, 0.8, 0.5, 0.5]); assert.ok(mixed[0] > mixed[1] && flip[1] > flip[0], '噪声决定交界处谁占上风');
  const g = FX.GLSL.terrainFragMain; assert.ok(g.includes('0.34') && g.includes('0.24'));    // 与 GLSL 常量一致
});
test('画质自适应：慢则降档、闲则升档(有冷却)、锁定不动、尖峰不计入', () => {
  const G = new FX.QualityGovernor('high'); let changes = []; for (let i = 0; i < 400; i++) { const r = G.update(40); if (r) changes.push([i, r]); } assert.deepEqual(changes.map((c) => c[1]), ['medium', 'low'], JSON.stringify(changes)); assert.ok(changes[0][0] >= 90);
  for (let i = 0; i < 400; i++) assert.equal(G.update(40), null);                                            // 已是最低档
  let up = 0; for (let i = 0; i < 4000; i++) { const r = G.update(8); if (r) up++; } assert.ok(up >= 1 && up <= 2, `升档 ${up}`);
  const L = new FX.QualityGovernor('high', { locked: true }); for (let i = 0; i < 500; i++) assert.equal(L.update(60), null); assert.equal(L.tier, 'high');
  const S = new FX.QualityGovernor('high'); for (let i = 0; i < 300; i++) assert.equal(S.update(5000), null); assert.equal(S.tier, 'high'); assert.equal(S.update(NaN), null);
  assert.equal(S.setTier('low'), 'low'); assert.equal(S.locked, true); assert.deepEqual(Object.keys(FX.QUALITY), ['high', 'medium', 'low']); assert.equal(FX.QUALITY.high.shadow, 4096);
});
test('阴影对齐：落在光空间纹素网格上，小位移不抖动，偏差 ≤ 半个纹素对角', () => {
  const L = C.v3.norm([-0.5, 0.84, 0.3]), texel = 0.05, up = [0, 1, 0], r = C.v3.norm(C.v3.cross(up, L)), u = C.v3.cross(L, r);
  for (let i = 0; i < 200; i++) { const t = [Math.sin(i) * 300, Math.cos(i * 1.3) * 20, Math.sin(i * 0.7) * 300], s = FX.snapToTexel(t, L, texel), sx = C.v3.dot(s, r) / texel, sy = C.v3.dot(s, u) / texel; near(sx, Math.round(sx), 1e-6); near(sy, Math.round(sy), 1e-6); assert.ok(C.v3.dist(s, t) <= texel * 0.71 + 1e-9); }
  const p0 = C.v3.add(C.v3.add(C.v3.mul(r, 3 * texel), C.v3.mul(u, -4 * texel)), C.v3.mul(L, 7.3)), shift = (dx, dy) => C.v3.add(C.v3.add(p0, C.v3.mul(r, dx * texel)), C.v3.mul(u, dy * texel));
  const base = FX.snapToTexel(p0, L, texel).map((v) => +v.toFixed(9)); for (const [dx, dy] of [[0.2, 0], [-0.3, 0.1], [0.1, -0.35], [0.3, 0.3]]) assert.deepEqual(FX.snapToTexel(shift(dx, dy), L, texel).map((v) => +v.toFixed(9)), base, '小位移不应让阴影网格抖动');
});
test('GLSL 自检：括号配平、varying/uniform 声明与使用一致、关键分支存在（沙箱无 GPU，真实编译需在浏览器验证）', () => {
  const bal = (src, a, b) => { let d = 0; for (const ch of src) { if (ch === a) d++; if (ch === b) d--; if (d < 0) return false; } return d === 0; };
  for (const [k, src] of Object.entries(FX.GLSL)) { assert.ok(bal(src, '{', '}') && bal(src, '(', ')') && bal(src, '[', ']'), `${k} 括号不配平`); assert.ok(!/\t/.test(src) && !/[；，]/.test(src), `${k} 含制表符/全角标点`); const ifs = (src.match(/#if(def|ndef)?\b/g) || []).length, ends = (src.match(/#endif/g) || []).length; assert.equal(ifs, ends, `${k} #if/#endif 不匹配`); }
  const G = FX.GLSL, has = (s, re) => re.test(s);
  for (const v of ['vFogDepth', 'vXmFogPos']) assert.ok(has(G.fogParsVertex, new RegExp('varying [a-z0-9]+ ' + v)) && has(G.fogParsFragment, new RegExp('varying [a-z0-9]+ ' + v)), `varying ${v} 两端都要声明`);
  for (const u of ['fogColor', 'fogDensity', 'xmFogA', 'xmFogSun', 'xmFogWarm']) assert.ok(G.fogParsFragment.includes(u), `${u} 未声明`);
  for (const u of ['xmFogA', 'xmFogSun', 'xmFogWarm', 'fogDensity', 'fogColor', 'vXmFogPos', 'cameraPosition']) assert.ok(G.fogFragment.includes(u), `雾片段没用到 ${u}`);
  assert.ok(G.fogFragment.includes('#ifdef FOG_EXP2') && G.fogFragment.includes('smoothstep( fogNear, fogFar, vFogDepth )'), '必须保留线性雾分支'); assert.ok(G.fogVertex.includes('mvPosition') && G.fogVertex.includes('viewMatrix') && !G.fogVertex.includes('transformed'));
  assert.ok(G.skyVertex.includes('varying vec3 vDir') && G.skyFragment.includes('varying vec3 vDir'));
  for (const u of ['uZenith', 'uHorizon', 'uWarm', 'uSunDir', 'uSunColor', 'uWarmAmt', 'uWarmPow', 'uSunDisc', 'uStars']) assert.ok(new RegExp('uniform [a-z0-9]+ ' + u + ';').test(G.skyFragment), `sky ${u}`);
  assert.ok(G.skyFragment.includes('#include <tonemapping_fragment>') && G.skyFragment.includes('#include <colorspace_fragment>') && G.skyVertex.includes('p.xyww'));
  for (const v of ['vSplat', 'vXmTerrainPos']) assert.ok(new RegExp('varying [a-z0-9]+ ' + v).test(G.terrainVertDecl) && new RegExp('varying [a-z0-9]+ ' + v).test(G.terrainFragDecl));
  for (const u of ['xmPalLush', 'xmPalDry', 'xmPalRock', 'xmPalDirt']) assert.ok(G.terrainFragDecl.includes(u) && G.terrainFragMain.includes(u)); assert.ok(G.terrainVertDecl.includes('attribute vec4 splat') && G.terrainFragMain.includes('diffuseColor.rgb ='));
  for (const fn of ['xmTH', 'xmTN', 'xmTF']) assert.ok(G.terrainFragDecl.includes('float ' + fn + '(')); assert.ok(!/\bdiffuseColor\b/.test(G.terrainFragDecl));
});

const makeFxStub = () => {
  class Vec { constructor(...a) { this.set(...a); } set(...a) { this.v = a; return this; } setRGB(...a) { this.v = a; return this; } }
  class Color extends Vec {} class Vector3 extends Vec {} class Vector4 extends Vec {} class Vector2 extends Vec { constructor(x = 0, y = 0) { super(x, y); this.x = x; this.y = y; } }
  class Material { constructor(p = {}) { Object.assign(this, p); } clone() { return new this.constructor(this); } onBeforeCompile() {} dispose() {} }
  class ShaderMaterial extends Material {} class MeshStandardMaterial extends Material {}
  class Obj { constructor() { this.children = []; this.position = new Vector3(); } add(...o) { this.children.push(...o); return this; } }
  class Mesh extends Obj { constructor(g, m) { super(); this.geometry = g; this.material = m; } }
  class Texture { constructor() { this.repeat = new Vec(); } }
  class DataTexture extends Texture { constructor(d, w, h, f) { super(); this.image = { data: d, width: w, height: h }; this.format = f; } }
  class WebGLRenderTarget { constructor(w, h, o) { this.w = w; this.h = h; this.o = o; this.texture = {}; } dispose() { this.disposed = true; } }
  return { Color, Vector3, Vector4, Vector2, Material, ShaderMaterial, MeshStandardMaterial, Scene: Obj, Mesh, SphereGeometry: class { constructor(...a) { this.a = a; } }, DataTexture, WebGLRenderTarget,
    RepeatWrapping: 1000, LinearFilter: 1006, LinearMipmapLinearFilter: 1008, RGBAFormat: 1023, NoColorSpace: '', BackSide: 1, HalfFloatType: 1016,
    ShaderChunk: { fog_pars_vertex: 'A', fog_vertex: 'B', fog_pars_fragment: 'C', fog_fragment: 'D' },
    PMREMGenerator: class { constructor() { this.n = 0; } fromScene() { this.n++; return new WebGLRenderTarget(1, 1, {}); } dispose() {} } };
};
test('THREE 胶水(stub)：高度雾改写并可回滚；地形混合补丁注入/回退；天空穹顶；环境登记与刷新；法线贴图缓存；后期管线装配', () => {
  const T = makeFxStub(), proto = T.Material.prototype.onBeforeCompile, fog = FX.installHeightFog(T);
  assert.equal(T.ShaderChunk.fog_fragment, FX.GLSL.fogFragment); assert.notEqual(T.Material.prototype.onBeforeCompile, proto);
  const sh = { fragmentShader: 'uniform vec4 xmFogA;', uniforms: {} }; T.Material.prototype.onBeforeCompile(sh); assert.ok(sh.uniforms.xmFogA && sh.uniforms.xmFogSun && sh.uniforms.xmFogWarm);
  const sh2 = { fragmentShader: 'void main(){}', uniforms: {} }; T.Material.prototype.onBeforeCompile(sh2); assert.deepEqual(Object.keys(sh2.uniforms), []);
  fog.set({ heightFalloff: 0.01, baseHeight: 5, warmAmt: 0.5, warmPow: 4, sunDir: [1, 2, 3], warm: [1, 0.5, 0.2] }); assert.deepEqual(fog.uniforms.xmFogA.value.v, [0.01, 5, 0.5, 4]);
  fog.restore(); assert.equal(T.ShaderChunk.fog_fragment, 'D'); assert.equal(T.Material.prototype.onBeforeCompile, proto); fog.restore();
  const mat = new T.MeshStandardMaterial({ vertexColors: true }), pt = FX.patchTerrainMaterial(T, mat, { lush: [0.3, 0.4, 0.1], dry: [0.5, 0.4, 0.2], rock: [0.4, 0.4, 0.4], dirt: [0.4, 0.3, 0.2] });
  const ts = { uniforms: {}, vertexShader: '#include <common>\nvoid main(){\n#include <begin_vertex>\n}', fragmentShader: '#include <common>\nvoid main(){\n#include <color_fragment>\n}' }; mat.onBeforeCompile(ts);
  assert.ok(ts.vertexShader.includes('attribute vec4 splat') && ts.vertexShader.includes('vSplat = splat') && ts.fragmentShader.includes('xmPalLush') && ts.fragmentShader.includes('diffuseColor.rgb') && ts.uniforms.xmPalRock); pt.revert(); assert.equal(typeof mat.onBeforeCompile, 'function');
  const sky = FX.createSkyDome(T); assert.equal(sky.mesh.renderOrder, -1000); assert.equal(sky.mesh.frustumCulled, false); sky.set(FX.atmosphereAt(0.25)); assert.equal(sky.uniforms.uSunDisc.value, 6); sky.set(FX.atmosphereAt(0.75)); assert.equal(sky.uniforms.uSunDisc.value, 0);
  const env = FX.createEnvironment(T, {}, sky), m1 = new T.MeshStandardMaterial(); env.register(m1); assert.equal(m1.envMap, undefined); env.refresh(); assert.ok(m1.envMap && env.texture === m1.envMap); const old = m1.envMap; env.refresh(); assert.notEqual(m1.envMap, old); env.dispose();
  const mk = FX.makeNormalTextureFactory(T), t1 = mk({ kind: 'pore', tile: [9, 9] }), t2 = mk({ kind: 'pore', tile: [9, 9] }), t3 = mk({ kind: 'weave', tile: [3, 3] }); assert.equal(t1, t2); assert.notEqual(t1, t3); assert.equal(t1.image.data.length, 128 * 128 * 4);
  const made = []; const cls = (n) => class { constructor(...a) { this.n = n; this.a = a; this.passes = []; made.push(this); } addPass(p) { this.passes.push(p); } setSize() {} setPixelRatio() {} render() {} };
  const M = { EffectComposer: cls('composer'), RenderPass: cls('render'), UnrealBloomPass: cls('bloom'), SSAOPass: cls('ssao'), OutputPass: cls('output') };
  const renderer = { getSize: () => new T.Vector2(800, 600), getPixelRatio: () => 2, capabilities: { isWebGL2: true } }, cam = { far: 5000, near: 0.1 };
  const p = FX.createPostPipeline(T, M, renderer, {}, cam, { ssao: true, msaa: 4 }); assert.deepEqual(made.find((x) => x.n === 'composer').passes.map((x) => x.n), ['render', 'ssao', 'bloom', 'output']);
  const ss = made.find((x) => x.n === 'ssao'); assert.ok(ss.maxDistance > ss.minDistance && ss.maxDistance < 0.001 && ss.kernelRadius > 0); assert.equal(p.composer.a[1].o.samples, 4);
  const q = FX.createPostPipeline(T, M, renderer, {}, cam, { ssao: false }); assert.equal(q.ssao, null);
});
done('光影：');
