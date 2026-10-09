// 游戏冒烟测试：node game_smoke.mjs <游戏.html 或 抽出的模块脚本.mjs> [标签]
// 用 mock 的 THREE / DOM 把整份游戏脚本真正执行：生成世界、跑 90 帧动画、换队伍(覆盖全部 12 个角色)、存读档，
// 并输出世界布局指纹（道路/建筑/资源/树石的 x,z）——改完游戏文件后跑一遍，能立刻看出"有没有抛错""世界布局有没有被改动"。
// 注意：这不是真实 WebGL 渲染，只验证"不抛错 + 逻辑一致 + 布局不变"；外观仍需在浏览器里目检。
// 故障注入：SABOTAGE=ground|terrain|figure|rock|all node game_smoke.mjs 游戏.html   （验证新模型出错时会回退到旧实现）
import fs from 'node:fs';

const [, , scriptPath, label = 'run'] = process.argv;
// ── 让两次运行完全可比：固定 Date.now 与 Math.random
let _s = 123456789; Math.random = () => ((_s = (_s * 1664525 + 1013904223) >>> 0) / 4294967296);
Date.now = () => 1700000000000;

// ── 通用"万能对象"（DOM 元素、2D 画布上下文等）
const store = new WeakMap();
function U(name = 'U') {
  const own = {};
  const p = new Proxy(function () {}, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === Symbol.iterator) return function* () {};
      if (k === 'length') return own.length ?? 0;
      if (k === 'then') return undefined;
      if (k === 'value') return own.value ?? '';
      if (k === 'getBoundingClientRect') return () => ({ left: 0, top: 0, width: 500, height: 360 });
      if (k in own) return own[k];
      return (own[k] = U(String(k)));
    },
    set(t, k, v) { own[k] = v; return true; },
    apply() { return U('ret'); },
    construct() { return U('new'); },
  });
  return p;
}
const elements = new Map();
const document = {
  getElementById: (id) => { if (!elements.has(id)) elements.set(id, U(id)); return elements.get(id); },
  createElement: () => U('created'), querySelector: () => U('q'), querySelectorAll: () => [],
  addEventListener() {}, body: U('body'), hidden: false,
};
const handlers = {};
const window = { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, addEventListener: (n, f) => { (handlers[n] ??= []).push(f); }, removeEventListener() {} };
const mem = new Map();
const localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
let rafCb = null; const requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
const navigator = { maxTouchPoints: 0, userAgent: 'smoke' };

// ── 最小 THREE：数学/层级是真实现，几何/材质只记参数
class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  setScalar(s) { this.x = this.y = this.z = s; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new V3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  addVectors(a, b) { this.x = a.x + b.x; this.y = a.y + b.y; this.z = a.z + b.z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  applyMatrix4() { return this; } applyQuaternion() { return this; } applyEuler() { return this; }
  lerpVectors(a, b, t) { this.x = a.x + (b.x - a.x) * t; this.y = a.y + (b.y - a.y) * t; this.z = a.z + (b.z - a.z) * t; return this; }
  crossVectors(a, b) { const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x; this.x = x; this.y = y; this.z = z; return this; }
  cross(v) { return this.crossVectors(this, v); }
  divideScalar(s) { return this.multiplyScalar(1 / s); } negate() { return this.multiplyScalar(-1); } addScalar(s) { this.x += s; this.y += s; this.z += s; return this; }
  setLength(l) { return this.normalize().multiplyScalar(l); } distanceToSquared(v) { return (this.x - v.x) ** 2 + (this.y - v.y) ** 2 + (this.z - v.z) ** 2; }
  equals(v) { return this.x === v.x && this.y === v.y && this.z === v.z; } fromArray(a, o = 0) { this.x = a[o]; this.y = a[o + 1]; this.z = a[o + 2]; return this; } toArray() { return [this.x, this.y, this.z]; }
  clampLength(a, b) { const l = this.length(); return l ? this.multiplyScalar(Math.min(b, Math.max(a, l)) / l) : this; }
  multiply(v) { this.x *= v.x; this.y *= v.y; this.z *= v.z; return this; } setX(v) { this.x = v; return this; } setY(v) { this.y = v; return this; } setZ(v) { this.z = v; return this; }
}
class Euler { constructor() { this.x = 0; this.y = 0; this.z = 0; this.order = 'XYZ'; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } copy(e) { this.x = e.x; this.y = e.y; this.z = e.z; return this; } }
class Color {
  constructor(c) { this.r = 1; this.g = 1; this.b = 1; this.isColor = true; if (c !== undefined) this.set(c); }
  set(c) { if (typeof c === 'number') { this.r = ((c >> 16) & 255) / 255; this.g = ((c >> 8) & 255) / 255; this.b = (c & 255) / 255; } else if (c && c.isColor) this.copy(c); else if (typeof c === 'string' && c[0] === '#') this.set(parseInt(c.slice(1), 16)); return this; }
  setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; return this; }
  copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; }
  clone() { return new Color().copy(this); }
  lerp(c, t) { this.r += (c.r - this.r) * t; this.g += (c.g - this.g) * t; this.b += (c.b - this.b) * t; return this; }
  lerpColors(a, b, t) { this.copy(a); return this.lerp(b, t); }
  multiplyScalar(s) { this.r *= s; this.g *= s; this.b *= s; return this; }
  setHSL() { return this; } getHex() { return 0; } getHexString() { return '000000'; }
}
class Object3D {
  constructor() { this.position = new LV3(); this.scale = new LV3(1, 1, 1); this.rotation = new Euler(); this.children = []; this.parent = null; this.userData = {}; this.visible = true; this.name = ''; this.castShadow = false; this.receiveShadow = false; this.renderOrder = 0; this.frustumCulled = true; }
  add(...o) { for (const c of o) { if (c.parent) c.parent.remove(c); c.parent = this; this.children.push(c); } return this; }
  remove(...o) { for (const c of o) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parent = null; } } return this; }
  clear() { this.children.length = 0; return this; }
  traverse(fn) { fn(this); for (const c of [...this.children]) c.traverse(fn); }
  getWorldPosition(t) { return t.copy(this.position); }
  lookAt() {} updateMatrixWorld() {} updateWorldMatrix() {} localToWorld(v) { return v; } worldToLocal(v) { return v; } rotateY(a) { this.rotation.y += a; } getWorldDirection(t) { return t.set(0, 0, 1); }
}
class Attr { constructor(arr, itemSize) { this.array = arr; this.itemSize = itemSize; this.count = arr.length / itemSize; this.needsUpdate = false; }
  getX(i) { return this.array[i * this.itemSize]; } getY(i) { return this.array[i * this.itemSize + 1]; } getZ(i) { return this.array[i * this.itemSize + 2]; }
  setX(i, v) { this.array[i * this.itemSize] = v; } setY(i, v) { this.array[i * this.itemSize + 1] = v; } setZ(i, v) { this.array[i * this.itemSize + 2] = v; }
  setXYZ(i, x, y, z) { this.array[i * this.itemSize] = x; this.array[i * this.itemSize + 1] = y; this.array[i * this.itemSize + 2] = z; } }
class BufferGeometry { constructor() { this.attributes = {}; this.index = null; this.disposed = false; this.isBufferGeometry = true; }
  setAttribute(n, a) { this.attributes[n] = a; return this; } getAttribute(n) { return this.attributes[n]; } setIndex(a) { this.index = a; return this; }
  computeBoundingBox() {} computeBoundingSphere() {} computeVertexNormals() {} dispose() { this.disposed = true; }
  rotateX(a) { const p = this.attributes.position; if (p) for (let i = 0; i < p.count; i++) { const y = p.getY(i), z = p.getZ(i); p.setY(i, y * Math.cos(a) - z * Math.sin(a)); p.setZ(i, y * Math.sin(a) + z * Math.cos(a)); } return this; }
  translate() { return this; } scale() { return this; } rotateY() { return this; } rotateZ() { return this; } toNonIndexed() { return this; } applyMatrix4() { return this; } }
const geo = () => class extends BufferGeometry { constructor(...args) { super(); this.args = args; this.attributes.position = new Attr(new Float32Array(3 * 8), 3); } };
class PlaneGeometry extends BufferGeometry {
  constructor(w, h, ws = 1, hs = 1) { super(); const n = (ws + 1) * (hs + 1), a = new Float32Array(n * 3); let k = 0; for (let j = 0; j <= hs; j++) for (let i = 0; i <= ws; i++) { a[k++] = (i / ws - 0.5) * w; a[k++] = (0.5 - j / hs) * h; a[k++] = 0; } this.attributes.position = new Attr(a, 3); this.args = [w, h, ws, hs]; } }
class Material { constructor(p = {}) { Object.assign(this, p); this.color = p.color instanceof Color ? p.color : new Color(p.color ?? 0xffffff); this.disposed = false; } dispose() { this.disposed = true; } }
class Mesh extends Object3D { constructor(g, m) { super(); this.geometry = g; this.material = m; this.isMesh = true; } }
class InstancedMesh extends Mesh { constructor(g, m, n) { super(g, m); this.count = n; this.instanceMatrix = { needsUpdate: false }; this.instanceColor = null; } setMatrixAt() {} setColorAt() {} getMatrixAt() {} }
class Matrix4 { constructor() { this.elements = new Array(16).fill(0); } fromArray(a) { a.forEach((v, i) => { this.elements[i] = v; }); return this; } compose() { return this; } makeTranslation() { return this; } makeScale() { return this; } identity() { return this; } setPosition() { return this; } multiply() { return this; } }
class CatmullRomCurve3 {
  constructor(pts = []) { this.points = pts; }
  _len() { let s = 0; for (let i = 1; i < this.points.length; i++) s += this.points[i].distanceTo(this.points[i - 1]); return s; }
  getLength() { return this._len(); }
  getPointAt(u, t = new V3()) { const L = this._len() * Math.min(1, Math.max(0, u)); let acc = 0; for (let i = 1; i < this.points.length; i++) { const a = this.points[i - 1], b = this.points[i], d = a.distanceTo(b); if (acc + d >= L || i === this.points.length - 1) { const f = d ? Math.min(1, (L - acc) / d) : 0; return t.set(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f); } acc += d; } return t; }
  getPoint(u, t) { return this.getPointAt(u, t); }
  getSpacedPoints(n) { return Array.from({ length: n + 1 }, (_, i) => this.getPointAt(i / n, new V3())); }
  getTangentAt(u, t = new V3()) { const a = this.getPointAt(Math.max(0, u - 0.01)), b = this.getPointAt(Math.min(1, u + 0.01)); return t.copy(b).sub(a).normalize(); }
}
class Light extends Object3D { constructor(...a) { super(); this.args = a; this.intensity = 1; this.color = new Color(); this.groundColor = new Color(); this.target = new Object3D(); this.shadow = { camera: new Object3D(), mapSize: new V3(), bias: 0 }; Object.assign(this.shadow.camera, { left: 0, right: 0, top: 0, bottom: 0, near: 0, far: 0 }); } }
const loose = (Cls) => class extends Cls { constructor(...a) { super(...a); return new Proxy(this, { get: (t, k, r) => (k in t ? Reflect.get(t, k, t) : (typeof k === 'string' && /^(set|get|add|sub|multiply|divide|apply|copy|clone|lerp|normalize|negate|clamp|floor|ceil|round|min|max|project|reflect|rotate|translate|compose|decompose|make|from|to|update|look|cross|dot|distance|length|angle|equals|invert|transpose|premultiply|identity|dispose)/.test(k) ? function () { return t; } : undefined)) }); } };
const LV3 = loose(V3), LObj = loose(Object3D), LColor = loose(Color);
const THREE = {
  Vector3: LV3, Color: LColor, Euler, Object3D: LObj, Group: class Group extends LObj {}, Mesh, InstancedMesh, Matrix4, BufferGeometry, PlaneGeometry, CatmullRomCurve3, Float32BufferAttribute: Attr, BufferAttribute: Attr,
  BoxGeometry: geo(), CylinderGeometry: geo(), ConeGeometry: geo(), SphereGeometry: geo(), CapsuleGeometry: geo(), TorusGeometry: geo(), IcosahedronGeometry: geo(), DodecahedronGeometry: geo(),
  MeshStandardMaterial: Material, MeshBasicMaterial: Material, MeshPhysicalMaterial: Material, MeshLambertMaterial: Material, LineBasicMaterial: Material,
  DirectionalLight: Light, HemisphereLight: Light, PointLight: Light, AmbientLight: Light,
  Scene: class Scene extends Object3D { constructor() { super(); this.background = new Color(); this.fog = null; } },
  FogExp2: class { constructor(c, d) { this.color = new Color(c); this.density = d; } },
  PerspectiveCamera: class extends Object3D { constructor() { super(); this.aspect = 1; this.fov = 60; this.near = 0.1; this.far = 5000; } updateProjectionMatrix() {} },
  WebGLRenderer: class { constructor() { this.domElement = U('canvas'); this.shadowMap = { enabled: false, type: 0 }; this.frames = 0; } setSize() {} setPixelRatio() {} setClearColor() {} render() { this.frames++; } },
  Clock: class { getDelta() { return 1 / 60; } getElapsedTime() { return 1; } },
  MathUtils: { clamp: (v, a, b) => Math.min(b, Math.max(a, v)), lerp: (a, b, t) => a + (b - a) * t, degToRad: (d) => d * Math.PI / 180, radToDeg: (r) => r * 180 / Math.PI, damp: (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt)), euclideanModulo: (n, m) => ((n % m) + m) % m },
  PCFSoftShadowMap: 2, PCFShadowMap: 1, DoubleSide: 2, FrontSide: 0, BackSide: 1, SRGBColorSpace: 'srgb', ACESFilmicToneMapping: 4,
};

// ── 读取并改造脚本：去掉 import，末尾追加探针（同一作用域内，能访问 let/const）
let code = fs.readFileSync(scriptPath, 'utf8');
if (scriptPath.endsWith('.html')) { const a = code.indexOf('<script type="module">'); if (a < 0) throw new Error('没找到 <script type="module">'); code = code.slice(a + '<script type="module">'.length, code.lastIndexOf('</script>')); }
code = code.replace(/^\s*import \* as THREE from [^\n]+\n/m, '\n');
// 故障注入：SABOTAGE=ground|terrain|figure|rock|all —— 让新模块的对应入口抛错，验证回退路径
const SAB = process.env.SABOTAGE;
if (SAB) {
  const boom = (name) => `XM.${name} = () => { throw new Error('故障注入:${name}'); };`;
  const map = { ground: ['makeGround'], terrain: ['buildTerrain'], figure: ['createStaticCharacter'], rock: ['makeRockPrototypes'], all: ['makeGround', 'buildTerrain', 'createStaticCharacter', 'makeRockPrototypes'] };
  code = code.replace('    const XM_CFG = {', map[SAB].map(boom).join('\n') + '\n    const XM_CFG = {');
}
if (process.env.TRACE) {
  for (const n of ['startNewRun', 'generateRoadNetwork', 'createRoads', 'createRoadMeshes', 'generateBuildings', 'populateWorld', 'createTerrain', 'buildOpeningScene', 'rebuildCompanions', 'setPlayerRider', 'createOtherParty', 'spawnResources', 'generateResources', 'animate', 'clearGroup', 'connectNodes', 'makeNode', 'createTree', 'createRock', 'createTemple', 'createBuilding'])
    code = code.replace(new RegExp(`function ${n}\\(([^)]*)\\) \\{`), `function ${n}($1) { globalThis.__t && globalThis.__t('${n}');`);
  globalThis.__t = (n) => process.stderr.write('> ' + n + '\n');
}
code += `
;function __setParty(a) { party = a; }
return { roads, roadNodes, buildings, resources, otherParties, companions, worldGroup, propGroup, npcGroup, roadGroup, buildingGroup, playerGroup, player, characters,
  getParty: () => party, setParty: __setParty, terrainHeight, terrainSurfaceHeight, startNewRun, animate, gatherSave, applySave, rebuildCompanions, setPlayerRider, createCharacterFigure,
  CONFIG, getSeed: () => rngSeed, XM_STATE: typeof XM_STATE !== 'undefined' ? XM_STATE : null, XM: typeof XM !== 'undefined' ? XM : null };`;

const logs = { error: [], warn: [] };
const fakeConsole = { log() {}, info() {}, debug() {}, warn: (...a) => logs.warn.push(a.map(String).join(' ')), error: (...a) => logs.error.push(a.map((x) => (x && x.stack) || String(x)).join(' ')) };
const t0 = performance.now();
let H;
try {
  H = new Function('THREE', 'document', 'window', 'localStorage', 'requestAnimationFrame', 'navigator', 'console', 'addEventListener', 'removeEventListener', 'innerWidth', 'innerHeight', 'devicePixelRatio', 'cancelAnimationFrame', 'alert', 'confirm', 'prompt', code)(
    THREE, document, window, localStorage, requestAnimationFrame, navigator, fakeConsole, window.addEventListener, window.removeEventListener, 1280, 720, 1, () => {}, () => {}, () => true, () => '');
} catch (e) { console.log(`[${label}] ✗ 初始化抛错：`, e.stack.split('\n').slice(0, 6).join('\n')); process.exit(1); }
const tInit = performance.now() - t0;

const count = (g) => { let meshes = 0, tris = 0; g.traverse((o) => { if (o.isMesh) { meshes++; const gm = o.geometry; tris += gm.index ? gm.index.count / 3 : 0; } }); return { meshes, tris }; };
const R = (v) => Math.round(v * 100) / 100;
const out = { label, initMs: Math.round(tInit), seed: H.getSeed(), roads: H.roads.length, nodes: H.roadNodes.length, buildings: H.buildings.length, resources: H.resources.length, parties: H.otherParties.length };
out.world = count(H.worldGroup); out.props = count(H.propGroup);
// 世界布局指纹（只看 x,z：y 允许不同，因为地形不同）
const xz = (arr, get) => arr.map((o) => { const p = get(o); return `${R(p.x)},${R(p.z)}`; }).join('|');
const fp = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); };
out.layout = {
  nodes: fp(xz(H.roadNodes, (n) => n.position ?? n)), buildings: fp(xz(H.buildings, (b) => b.position ?? b.group?.position ?? b)), resources: fp(xz(H.resources, (r) => r.position ?? r.mesh?.position ?? r)),
  props: fp(xz(H.propGroup.children, (m) => m.position)),
};
// 多帧动画
let frameErr = null; try { for (let i = 0; i < 90; i++) H.animate(); } catch (e) { frameErr = e.stack.split('\n').slice(0, 5).join('\n'); }
out.frameErr = frameErr;
// 换队伍：覆盖全部 12 个角色（每次 4 人）+ 主角轮换（第一位是骑手）
const all = H.characters, runs = [];
try {
  for (let i = 0; i < all.length; i++) {
    const team = [all[i], all[(i + 1) % all.length], all[(i + 2) % all.length], all[(i + 3) % all.length]];
    H.setParty(team); H.setPlayerRider(team[0]); H.rebuildCompanions(); for (let f = 0; f < 5; f++) H.animate();
    runs.push(`${team[0].id}:${H.companions.length}`);
  }
  out.partyRuns = runs.join(' ');
} catch (e) { out.partyErr = e.stack.split('\n').slice(0, 6).join('\n'); }
// 存档 → 同种子重开 → 读档：布局与地形一致
try {
  const save = H.gatherSave(); const h1 = [H.terrainHeight(120, -80), H.terrainHeight(-300, 410)];
  H.startNewRun(false, false); H.applySave(save); const h2 = [H.terrainHeight(120, -80), H.terrainHeight(-300, 410)];
  out.saveRoundTrip = { seed: H.getSeed() === out.seed, terrainStable: Math.abs(h1[0] - h2[0]) < 1e-9 && Math.abs(h1[1] - h2[1]) < 1e-9 };
  for (let f = 0; f < 5; f++) H.animate();
} catch (e) { out.saveErr = e.stack.split('\n').slice(0, 6).join('\n'); }
// 新版专属检查
if (H.XM_STATE) {
  const S = H.XM_STATE;
  out.new = { groundActive: !!S.ground, gridCols: S.grid?.cols, hAtOrigin: R(H.terrainHeight(0, 0)), surfaceEqHeight: H.terrainSurfaceHeight(33, -71) === H.terrainHeight(33, -71) };
  const terrain = H.worldGroup.children.find((c) => c.name === 'terrain'); out.new.terrainVerts = terrain?.geometry.attributes.position.count; out.new.mountainMeshes = H.worldGroup.children.find((c) => c.name === 'mountains')?.children.length;
  for (const id of ['tang', 'wukong', 'bajie', 'wujing', 'heixiong', 'bailong']) {
    const f = H.createCharacterFigure(all.find((c) => c.id === id), 0.9, { ride: true }); const c = count(f);
    out.new['fig_' + id] = `${c.meshes}mesh/${Math.round(c.tris)}tri rideY=${f.userData.rideY === undefined ? '-' : R(f.userData.rideY)}`;
  }
}
out.consoleErrors = logs.error.slice(0, 5); out.consoleWarns = logs.warn.length;
process.stdout.write(JSON.stringify(out, null, 1) + '\n', () => process.exit(0));   // 游戏里有 setInterval，不主动退出会一直挂着
