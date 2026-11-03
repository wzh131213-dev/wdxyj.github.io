// xiyou-fx.js — 重走西游 · 光影 / 环境 / 后期（THREE 由调用方注入；纯数学部分可在 Node 里测试）
// 内容：色温、昼夜调色板(黎明/正午/黄昏/夜晚平滑过渡)、程序化噪点法线贴图数据、地形高度混合、画质自适应、阴影贴图对齐；
//       指数高度雾(改写 fog_* ShaderChunk，带太阳方向暖色散射)、天空穹顶、PMREM 环境、地形混合材质、后期管线(Bloom/SSAO/ACES)。
// 所有 GLSL 补丁都带"出错即回滚"：renderer.debug.onShaderError 触发后恢复内置着色器并关闭相关特效，游戏照常运行。
import { TAU, clamp, smoothstep, v3 } from './xiyou-core.js';

const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ═════════════════════════════ 色温 / 昼夜调色板 ═════════════════════════════
/** 开尔文 → 线性 RGB（最大分量归一到 1；Tanner Helland 近似，1000–12000 K） */
export function kelvinToRGB(K) {
  const t = clamp(K, 1000, 12000) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592), g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = [r, g, b].map((v) => Math.pow(clamp(v, 0, 255) / 255, 2.2)), m = Math.max(...c, 1e-6);
  return c.map((v) => v / m);
}
/** 与游戏原 updateDayNight 同一条太阳轨迹：sun = (cos a·500, sin a·500+150, 220)，a = dayTime·2π */
export function sunDirAt(dayTime) {
  const a = dayTime * TAU;
  return { dir: v3.norm([Math.cos(a) * 500, Math.sin(a) * 500 + 150, 220]), rising: Math.cos(a) > 0, a };
}
// 关键帧按太阳高度角(度)插值。字段：K(太阳色温) I(日光强度) hs/hg(半球天/地色，线性) hi(半球强度) fog(地平线雾色) zen(天顶) warm(暖散射强度) exp(曝光系数) bloom
const KEYS = [
  { e: -18, K: 1800, I: 0.00, hs: [0.020, 0.030, 0.085], hg: [0.010, 0.012, 0.020], hi: 0.55, fog: [0.016, 0.026, 0.070], zen: [0.002, 0.004, 0.018], warm: 0.00, exp: 1.45, bloom: 0.75 },
  { e: -8, K: 1800, I: 0.00, hs: [0.040, 0.052, 0.140], hg: [0.016, 0.018, 0.030], hi: 0.62, fog: [0.040, 0.050, 0.110], zen: [0.006, 0.012, 0.050], warm: 0.10, exp: 1.35, bloom: 0.65 },
  { e: -2, K: 2200, I: 0.30, hs: [0.200, 0.140, 0.190], hg: [0.060, 0.045, 0.050], hi: 0.85, fog: [0.560, 0.250, 0.150], zen: [0.030, 0.060, 0.220], warm: 1.00, exp: 1.22, bloom: 0.55 },
  { e: 4, K: 2900, I: 0.95, hs: [0.480, 0.400, 0.420], hg: [0.130, 0.110, 0.090], hi: 1.15, fog: [0.640, 0.470, 0.330], zen: [0.060, 0.150, 0.430], warm: 0.95, exp: 1.14, bloom: 0.50 },
  { e: 12, K: 3900, I: 1.90, hs: [0.620, 0.660, 0.760], hg: [0.200, 0.200, 0.160], hi: 1.55, fog: [0.610, 0.640, 0.650], zen: [0.080, 0.230, 0.610], warm: 0.65, exp: 1.06, bloom: 0.42 },
  { e: 28, K: 5400, I: 2.70, hs: [0.700, 0.780, 0.940], hg: [0.240, 0.270, 0.210], hi: 1.95, fog: [0.560, 0.690, 0.820], zen: [0.090, 0.280, 0.760], warm: 0.28, exp: 1.00, bloom: 0.36 },
  { e: 60, K: 6500, I: 3.20, hs: [0.730, 0.820, 1.000], hg: [0.260, 0.300, 0.240], hi: 2.10, fog: [0.540, 0.700, 0.860], zen: [0.100, 0.320, 0.850], warm: 0.18, exp: 0.96, bloom: 0.34 },
];
function keyAt(e) {
  if (e <= KEYS[0].e) return KEYS[0];
  for (let i = 0; i < KEYS.length - 1; i++) {
    const a = KEYS[i], b = KEYS[i + 1];
    if (e <= b.e) {
      const t = smoothstep(a.e, b.e, e), L = (x, y) => x + (y - x) * t, L3 = (x, y) => mix3(x, y, t);
      return { e, K: L(a.K, b.K), I: L(a.I, b.I), hs: L3(a.hs, b.hs), hg: L3(a.hg, b.hg), hi: L(a.hi, b.hi), fog: L3(a.fog, b.fog), zen: L3(a.zen, b.zen), warm: L(a.warm, b.warm), exp: L(a.exp, b.exp), bloom: L(a.bloom, b.bloom) };
    }
  }
  return KEYS[KEYS.length - 1];
}
/**
 * 一天中任意时刻的大气状态（全部线性色）。夜晚自动切换为月光（同一盏方向光），日出/日落的色温与暖雾强度不同。
 * 返回 { lightDir, lightColor, lightIntensity, isMoon, sunDir, sunElev, hemiSky, hemiGround, hemiIntensity, fogColor, zenith, warmColor, warmAmt, exposure, bloom, stars }
 */
export function atmosphereAt(dayTime) {
  const { dir, rising, a } = sunDirAt(dayTime), elev = (Math.asin(clamp(dir[1], -1, 1)) * 180) / Math.PI, k = keyAt(elev);
  const evening = smoothstep(0.2, -0.2, Math.cos(a));                                   // 0 清晨 … 1 黄昏
  const sunCol = kelvinToRGB(k.K - 350 * evening), sunK = smoothstep(-5, 1, elev), moonK = smoothstep(2, -9, elev), isMoon = elev < -5;
  const warm = mix3(mix3([1.0, 0.78, 0.45], [1.0, 0.62, 0.40], evening), [0.55, 0.65, 1.0], moonK);
  const moonDir = v3.norm([-dir[0], Math.abs(dir[1]) * 0.8 + 0.25, -dir[2]]);
  // 太阳强度在 −5° 降到 0，之后才换成月光（月光强度从 0 起渐入）：方向切换发生在光强为 0 时，阴影不跳变
  const lightDir = isMoon ? moonDir : v3.norm([dir[0], Math.max(dir[1], 0.03), dir[2]]);
  return {
    sunDir: dir, sunElev: elev, rising,
    lightDir, isMoon, lightColor: isMoon ? [0.55, 0.68, 1.0] : sunCol,
    lightIntensity: isMoon ? 0.42 * smoothstep(-5, -12, elev) : k.I * sunK,
    hemiSky: k.hs, hemiGround: k.hg, hemiIntensity: k.hi, fogColor: k.fog, zenith: k.zen, warmColor: warm, warmAmt: k.warm * (1 - 0.7 * moonK),
    exposure: k.exp, bloom: k.bloom, stars: smoothstep(-3, -14, elev),
  };
}

// ═════════════════════════════ 程序化噪点法线贴图（可无缝平铺） ═════════════════════════════
function hash2(x, y, seed) { let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2147483647)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
/** x 周期 perX、y 周期 perY 的平铺值噪声（两个周期可不同 → 各向异性拉伸） */
function tileNoise(x, y, perX, perY, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), mx = (n) => ((n % perX) + perX) % perX, my = (n) => ((n % perY) + perY) % perY;
  const a = hash2(mx(xi), my(yi), seed), b = hash2(mx(xi + 1), my(yi), seed), c = hash2(mx(xi), my(yi + 1), seed), d = hash2(mx(xi + 1), my(yi + 1), seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/**
 * size×size 的 RGBA8 切线空间法线贴图（可无缝平铺）。约定：U(x) 沿网格圆周方向，V(y) 沿网格长度方向（发丝/经线沿 V 走）。
 * 生成顺序：① 在各向异性(沿某一轴拉伸)的平铺噪声/正弦图案上得到高度场，取有限差分得原始 X/Y 扰动；
 *          ② Z = sqrt(1 - X² - Y²)（先把 |XY| 限在 0.92 内，保证单位长）；③ 映射到 [0,255]；
 *          ④ 所有噪声坐标都对各轴周期取模 → 边缘无缝平铺。
 * kind：'pore' 皮肤毛孔(各向同性) / 'fur' 毛发(沿 V 略拉伸) / 'strand' 发丝(沿 V 强拉伸：横向细密、纵向舒缓) / 'weave' 织物(经线沿 V 更密更强，纬线起伏更缓)。
 * strength = 整张图的 RMS 倾斜倍数(缺省 1，按 kind 有各自基准)；X/Y 共用同一个缩放，因此方向性(X、Y 方差之比)得以保留。
 */
export function makeNormalMapData(size = 128, { kind = 'pore', seed = 1, strength = null } = {}) {
  const CFG = { pore: { f: [8, 8], oct: 3, rms: 0.30 }, fur: { f: [22, 8], oct: 3, rms: 0.40 }, strand: { f: [28, 3], oct: 2, rms: 0.42 }, weave: { f: [0, 0], oct: 0, rms: 0.32 } };
  const c = CFG[kind] ?? CFG.pore, H = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size; let h = 0;
    if (kind === 'weave') {
      const warp = 0.5 + 0.5 * Math.sin(u * TAU * 16 + 0.8 * Math.sin(v * TAU * 5)), weft = 0.5 + 0.5 * Math.sin(v * TAU * 7);   // 经线：横向 16 根，沿 V 微微起伏；纬线：沿 V 7 道（频率留在 Nyquist 以内，避免混叠）
      h = 0.55 * warp * (0.65 + 0.35 * weft) + 0.25 * weft * (1 - 0.5 * warp) + 0.12 * (tileNoise(u * 24, v * 4, 24, 4, seed) - 0.5);                // 沿 V 拉伸的纤维噪声
    } else {
      let amp = 1, tot = 0;
      for (let o = 0; o < c.oct; o++) { const px = c.f[0] << o, py = c.f[1] << o; h += amp * tileNoise(u * px, v * py, px, py, seed + o * 17); tot += amp; amp *= 0.5; }     // x、y 采样频率不同 = 沿低频轴拉伸
      h = h / tot - 0.5;
    }
    H[y * size + x] = h;
  }
  const w = (i) => ((i % size) + size) % size, GX = new Float32Array(size * size), GY = new Float32Array(size * size);
  let e2 = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {                                    // ① 原始 X/Y 扰动（周期回绕的中心差分）
    const gx = -(H[y * size + w(x + 1)] - H[y * size + w(x - 1)]) * 0.5, gy = -(H[w(y + 1) * size + x] - H[w(y - 1) * size + x]) * 0.5;
    GX[y * size + x] = gx; GY[y * size + x] = gy; e2 += gx * gx + gy * gy;
  }
  const k = ((strength ?? 1) * c.rms) / Math.sqrt(e2 / (size * size) + 1e-12), out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    let X = GX[i] * k, Y = GY[i] * k; const m = Math.hypot(X, Y); if (m > 0.92) { X *= 0.92 / m; Y *= 0.92 / m; }
    const Z = Math.sqrt(Math.max(0, 1 - X * X - Y * Y));                                              // ② 保证单位长
    out[4 * i] = Math.round((X * 0.5 + 0.5) * 255); out[4 * i + 1] = Math.round((Y * 0.5 + 0.5) * 255); out[4 * i + 2] = Math.round((Z * 0.5 + 0.5) * 255); out[4 * i + 3] = 255;   // ③ 映射到 [0,255]
  }
  return out;
}

// ═════════════════════════════ 地形：平滑高度混合 ═════════════════════════════
/**
 * 层权重 w(和为1) + 每层噪声 n(0..1) → 平滑混合后的权重。与地形着色器里的 GLSL 完全同一算法：
 * 高度混合 h_i = w_i + amp·(n_i-0.5)，最大值附近 width 宽度内按比例过渡 → 交界处是"有机"的锯齿渐变，没有多边形硬边。
 */
export function heightBlend(w, n, { amp = 0.34, width = 0.24 } = {}) {
  const h = w.map((v, i) => Math.max(v, 0) + amp * (n[i] - 0.5)), m = Math.max(...h), b = h.map((v) => clamp((v - (m - width)) / width, 0, 1)), s = b.reduce((x, y) => x + y, 0) || 1;
  return b.map((v) => v / s);
}

// ═════════════════════════════ 画质档位 / 自适应 ═════════════════════════════
export const QUALITY = {
  high: { shadow: 4096, ssao: true, bloom: true, msaa: 4, env: true, post: true, atmosphere: true, cloth: true, pixelRatioMax: 1.8 },
  medium: { shadow: 2048, ssao: false, bloom: true, msaa: 2, env: true, post: true, atmosphere: true, cloth: true, pixelRatioMax: 1.5 },
  low: { shadow: 1024, ssao: false, bloom: false, msaa: 0, env: false, post: false, atmosphere: false, cloth: false, pixelRatioMax: 1.0 },
};
export const TIERS = ['high', 'medium', 'low'];
/** 帧时间自适应：EMA 超标持续一段时间则降一档；长时间余量充足则升一档；手动锁定后不再自动调整 */
export class QualityGovernor {
  constructor(tier = 'high', o = {}) { this.tier = tier; this.locked = !!o.locked; this.o = { slowMs: 24, fastMs: 11, downFrames: 90, upFrames: 900, cooldown: 20, ...o }; this.ema = 16.7; this.slow = 0; this.fast = 0; this.t = 0; this.lastChange = -1e9; }
  setTier(t, lock = true) { if (TIERS.includes(t)) { this.tier = t; this.locked = lock; this.slow = this.fast = 0; this.lastChange = this.t; } return this.tier; }
  /** dtMs：本帧耗时(毫秒)。返回新档位名（有变化时），否则 null */
  update(dtMs) {
    if (!Number.isFinite(dtMs) || dtMs <= 0 || dtMs > 1000) return null;                     // 切后台/卡顿尖峰不计入
    this.t += dtMs / 1000; this.ema += (dtMs - this.ema) * 0.05;
    if (this.locked) return null;
    const i = TIERS.indexOf(this.tier);
    if (this.ema > this.o.slowMs) { this.slow++; this.fast = 0; } else if (this.ema < this.o.fastMs) { this.fast++; this.slow = 0; } else { this.slow = Math.max(0, this.slow - 1); this.fast = 0; }
    if (this.slow >= this.o.downFrames && i < TIERS.length - 1) { this.tier = TIERS[i + 1]; this.slow = 0; this.lastChange = this.t; this.ema = 16.7; return this.tier; }
    if (this.fast >= this.o.upFrames && i > 0 && this.t - this.lastChange > this.o.cooldown) { this.tier = TIERS[i - 1]; this.fast = 0; this.lastChange = this.t; this.ema = 16.7; return this.tier; }
    return null;
  }
}
/** 阴影相机跟随目标并对齐到光空间纹素网格（移动时阴影边缘不闪烁）。light = 单位方向(指向太阳)，返回对齐后的目标 [x,y,z] */
export function snapToTexel(target, lightDir, texel) {
  const up = Math.abs(lightDir[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0], r = v3.norm(v3.cross(up, lightDir)), u = v3.cross(lightDir, r);
  const x = v3.dot(target, r), y = v3.dot(target, u), z = v3.dot(target, lightDir);
  const sx = Math.round(x / texel) * texel, sy = Math.round(y / texel) * texel;
  return [r[0] * sx + u[0] * sy + lightDir[0] * z, r[1] * sx + u[1] * sy + lightDir[1] * z, r[2] * sx + u[2] * sy + lightDir[2] * z];
}

// ═════════════════════════════ GLSL（保持保守写法，贴近 three r160 内置 chunk） ═════════════════════════════
export const GLSL = {
  fogParsVertex: `#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vXmFogPos;
#endif`,
  fogVertex: `#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vXmFogPos = cameraPosition + transpose( mat3( viewMatrix ) ) * mvPosition.xyz;
#endif`,
  fogParsFragment: `#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vXmFogPos;
  #ifdef FOG_EXP2
    uniform float fogDensity;
    uniform vec4 xmFogA;
    uniform vec3 xmFogSun;
    uniform vec3 xmFogWarm;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`,
  fogFragment: `#ifdef USE_FOG
  #ifdef FOG_EXP2
    vec3 xmV = vXmFogPos - cameraPosition;
    float xmDist = length( xmV );
    vec3 xmRd = xmV / max( xmDist, 0.0001 );
    float xmB = max( xmFogA.x, 0.00001 );
    float xmY0 = clamp( cameraPosition.y - xmFogA.y, -400.0, 4000.0 );
    float xmK = xmB * xmRd.y;
    float xmInt = abs( xmK ) > 0.0001 ? ( 1.0 - exp( - xmK * xmDist ) ) / xmK : xmDist;
    float xmOpt = fogDensity * exp( - xmB * xmY0 ) * xmInt;
    float xmFogF = clamp( 1.0 - exp( - max( xmOpt, 0.0 ) ), 0.0, 1.0 );
    float xmSunT = pow( max( dot( xmRd, normalize( xmFogSun ) ), 0.0 ), xmFogA.w );
    vec3 xmCol = mix( fogColor, xmFogWarm, clamp( xmSunT * xmFogA.z, 0.0, 1.0 ) );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, xmCol, xmFogF );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
  #endif
#endif`,
  skyVertex: `varying vec3 vDir;
void main() {
  vDir = normalize( position );
  vec4 p = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  gl_Position = p.xyww;
}`,
  skyFragment: `uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uWarm;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uWarmAmt;
uniform float uWarmPow;
uniform float uSunDisc;
uniform float uStars;
varying vec3 vDir;
float xmHash( vec3 p ) {
  p = fract( p * 0.3183099 + 0.1 );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
void main() {
  vec3 rd = normalize( vDir );
  vec3 sd = normalize( uSunDir );
  float s = max( dot( rd, sd ), 0.0 );
  vec3 horizon = mix( uHorizon, uWarm, clamp( pow( s, uWarmPow ) * uWarmAmt, 0.0, 1.0 ) );
  vec3 col = mix( horizon, uZenith, pow( clamp( rd.y, 0.0, 1.0 ), 0.5 ) );
  col = mix( col, uHorizon, smoothstep( 0.02, -0.12, rd.y ) );
  col += uSunColor * ( pow( s, 6.0 ) * 0.10 + pow( s, 500.0 ) * uSunDisc );
  float st = step( 0.9965, xmHash( floor( rd * 220.0 ) ) ) * uStars * smoothstep( 0.05, 0.5, rd.y );
  col += vec3( st );
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
  terrainVertDecl: `attribute vec4 splat;
varying vec4 vSplat;
varying vec3 vXmTerrainPos;`,
  terrainVertMain: `vSplat = splat;
vXmTerrainPos = ( modelMatrix * vec4( position, 1.0 ) ).xyz;`,
  terrainFragDecl: `varying vec4 vSplat;
varying vec3 vXmTerrainPos;
uniform vec3 xmPalLush;
uniform vec3 xmPalDry;
uniform vec3 xmPalRock;
uniform vec3 xmPalDirt;
float xmTH( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float xmTN( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( xmTH( i ), xmTH( i + vec2( 1.0, 0.0 ) ), f.x ), mix( xmTH( i + vec2( 0.0, 1.0 ) ), xmTH( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
float xmTF( vec2 p ) { return 0.5 * xmTN( p ) + 0.3 * xmTN( p * 2.1 + 7.3 ) + 0.2 * xmTN( p * 4.3 + 1.7 ); }`,
  terrainFragMain: `vec2 xmP = vXmTerrainPos.xz;
vec4 xmW = max( vSplat, vec4( 0.0 ) );
vec4 xmNz = vec4( xmTF( xmP * 0.21 + 1.3 ), xmTF( xmP * 0.21 + 8.1 ), xmTF( xmP * 0.21 + 15.7 ), xmTF( xmP * 0.21 + 22.9 ) );
vec4 xmHh = xmW + 0.34 * ( xmNz - 0.5 );
float xmMx = max( max( xmHh.x, xmHh.y ), max( xmHh.z, xmHh.w ) );
vec4 xmB = clamp( ( xmHh - ( xmMx - 0.24 ) ) / 0.24, 0.0, 1.0 );
xmB = xmB / max( xmB.x + xmB.y + xmB.z + xmB.w, 0.0001 );
vec3 xmAlb = xmB.x * xmPalLush + xmB.y * xmPalDry + xmB.z * xmPalRock + xmB.w * xmPalDirt;
diffuseColor.rgb = xmAlb * ( 0.92 + 0.16 * xmTF( xmP * 1.9 ) );`,
};

// ═════════════════════════════ THREE 胶水 ═════════════════════════════
/** 噪点法线贴图 → THREE.DataTexture（按 kind+tile 缓存） */
export function makeNormalTextureFactory(THREE) {
  const cache = new Map();
  return (spec) => {
    const key = `${spec.kind}:${spec.tile?.join('x')}`;
    if (cache.has(key)) return cache.get(key);
    const size = 128, tex = new THREE.DataTexture(makeNormalMapData(size, { kind: spec.kind, seed: 7 + key.length }), size, size, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(spec.tile?.[0] ?? 8, spec.tile?.[1] ?? 8);
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true; tex.anisotropy = 4;
    if (THREE.NoColorSpace !== undefined) tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true; cache.set(key, tex);
    return tex;
  };
}

/** 指数高度雾：改写 fog_* ShaderChunk，并通过 Material.prototype.onBeforeCompile 注入共享 uniform。返回控制器 */
export function installHeightFog(THREE) {
  const SC = THREE.ShaderChunk, saved = { fog_pars_vertex: SC.fog_pars_vertex, fog_vertex: SC.fog_vertex, fog_pars_fragment: SC.fog_pars_fragment, fog_fragment: SC.fog_fragment }, protoHook = THREE.Material.prototype.onBeforeCompile;
  const U = { xmFogA: { value: new THREE.Vector4(0.004, 0, 0.7, 6) }, xmFogSun: { value: new THREE.Vector3(0.5, 0.8, 0.3) }, xmFogWarm: { value: new THREE.Color(1, 0.7, 0.4) } };
  const hook = function (shader) { if (shader.fragmentShader && shader.fragmentShader.indexOf('xmFogA') >= 0) { shader.uniforms.xmFogA = U.xmFogA; shader.uniforms.xmFogSun = U.xmFogSun; shader.uniforms.xmFogWarm = U.xmFogWarm; } };
  SC.fog_pars_vertex = GLSL.fogParsVertex; SC.fog_vertex = GLSL.fogVertex; SC.fog_pars_fragment = GLSL.fogParsFragment; SC.fog_fragment = GLSL.fogFragment;
  THREE.Material.prototype.onBeforeCompile = hook;
  return {
    uniforms: U, active: true, hook,
    /** heightFalloff：高度衰减系数(1/单位)；baseHeight：雾基准面高度；warmAmt/warmPow：太阳方向暖色散射强度/集中度 */
    set({ heightFalloff = 0.004, baseHeight = 0, warmAmt = 0.7, warmPow = 6, sunDir = [0.5, 0.8, 0.3], warm = [1, 0.7, 0.4] } = {}) { U.xmFogA.value.set(heightFalloff, baseHeight, warmAmt, warmPow); U.xmFogSun.value.set(sunDir[0], sunDir[1], sunDir[2]); U.xmFogWarm.value.setRGB(warm[0], warm[1], warm[2]); },
    restore() { if (!this.active) return; SC.fog_pars_vertex = saved.fog_pars_vertex; SC.fog_vertex = saved.fog_vertex; SC.fog_pars_fragment = saved.fog_pars_fragment; SC.fog_fragment = saved.fog_fragment; THREE.Material.prototype.onBeforeCompile = protoHook; this.active = false; },
  };
}

/** 天空穹顶（BackSide，渲染到远平面，随相机移动）；uniforms 同时供 PMREM 环境使用 */
export function createSkyDome(THREE, { radius = 1000 } = {}) {
  const U = { uZenith: { value: new THREE.Color(0.1, 0.3, 0.8) }, uHorizon: { value: new THREE.Color(0.6, 0.7, 0.8) }, uWarm: { value: new THREE.Color(1, 0.7, 0.4) }, uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.3) }, uSunColor: { value: new THREE.Color(1, 0.9, 0.7) }, uWarmAmt: { value: 0.7 }, uWarmPow: { value: 6 }, uSunDisc: { value: 6 }, uStars: { value: 0 } };
  const mat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: GLSL.skyVertex, fragmentShader: GLSL.skyFragment, side: THREE.BackSide, depthWrite: false, fog: false });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), mat); mesh.name = 'skyDome'; mesh.frustumCulled = false; mesh.renderOrder = -1000;
  const set = (st) => { U.uZenith.value.setRGB(...st.zenith); U.uHorizon.value.setRGB(...st.fogColor); U.uWarm.value.setRGB(...st.warmColor); U.uSunDir.value.set(...st.sunDir); U.uSunColor.value.setRGB(...st.lightColor); U.uWarmAmt.value = st.warmAmt; U.uStars.value = st.stars; U.uSunDisc.value = st.sunElev > -2 ? 6 : 0; };
  return { mesh, uniforms: U, set, material: mat };
}

/** PMREM 环境（角色金属/皮肤/布料的 IBL）。materials 在 register 时登记，refresh 后统一换 envMap。不改变场景整体光照 */
export function createEnvironment(THREE, renderer, sky) {
  const pmrem = new THREE.PMREMGenerator(renderer), envScene = new THREE.Scene(), dome = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), sky.material.clone());
  dome.material.uniforms = sky.uniforms; dome.material.side = THREE.BackSide; envScene.add(dome);
  const targets = new Set(); let rt = null;
  return {
    texture: null,
    register(mat) { targets.add(mat); if (this.texture) mat.envMap = this.texture; },
    refresh() {
      const prev = rt; rt = pmrem.fromScene(envScene, 0.02); this.texture = rt.texture;
      for (const m of targets) m.envMap = this.texture;
      if (prev) prev.dispose();
    },
    dispose() { if (rt) rt.dispose(); pmrem.dispose(); targets.clear(); },
  };
}

/** 地形混合材质：splat(vec4) 顶点属性 + 高度混合；失败可 revert() 回到顶点色 */
export function patchTerrainMaterial(THREE, material, palette) {
  const U = { xmPalLush: { value: new THREE.Color().setRGB(...palette.lush) }, xmPalDry: { value: new THREE.Color().setRGB(...palette.dry) }, xmPalRock: { value: new THREE.Color().setRGB(...palette.rock) }, xmPalDirt: { value: new THREE.Color().setRGB(...palette.dirt) } };
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = function (shader) {
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + GLSL.terrainVertDecl).replace('#include <begin_vertex>', '#include <begin_vertex>\n' + GLSL.terrainVertMain);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + GLSL.terrainFragDecl).replace('#include <color_fragment>', '#include <color_fragment>\n' + GLSL.terrainFragMain);
    if (prev && prev !== THREE.Material.prototype.onBeforeCompile) prev.call(this, shader);
    else if (THREE.Material.prototype.onBeforeCompile) THREE.Material.prototype.onBeforeCompile.call(this, shader);     // 链上全局雾 uniform 注入
  };
  material.customProgramCacheKey = () => 'xm-terrain-blend';
  material.needsUpdate = true;
  return { uniforms: U, revert() { material.onBeforeCompile = prev; material.customProgramCacheKey = () => ''; material.needsUpdate = true; } };
}

/**
 * 后期管线：RenderPass →（SSAO）→ UnrealBloom → OutputPass（ACES + 输出色彩空间）。M = 动态 import 得到的模块
 * { EffectComposer, RenderPass, UnrealBloomPass, SSAOPass, OutputPass }。MSAA 通过 HalfFloat 渲染目标的 samples 保留。
 */
export function createPostPipeline(THREE, M, renderer, scene, camera, o = {}) {
  const size = renderer.getSize(new THREE.Vector2()), pr = renderer.getPixelRatio();
  const rt = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, { type: THREE.HalfFloatType, samples: renderer.capabilities.isWebGL2 ? (o.msaa ?? 4) : 0 });
  const composer = new M.EffectComposer(renderer, rt); composer.setPixelRatio(pr); composer.setSize(size.x, size.y);
  composer.addPass(new M.RenderPass(scene, camera));
  let ssao = null;
  if (o.ssao && M.SSAOPass) {
    ssao = new M.SSAOPass(scene, camera, size.x, size.y);
    const unit = 1 / Math.max(1, camera.far - camera.near);                      // SSAOPass 的距离阈值是"归一化线性深度"：按相机远近平面换算成世界单位
    ssao.kernelRadius = o.aoRadius ?? 1.6; ssao.minDistance = 0.05 * unit; ssao.maxDistance = (o.aoRadius ?? 1.6) * 1.4 * unit; composer.addPass(ssao);
  }
  const bloom = new M.UnrealBloomPass(new THREE.Vector2(size.x, size.y), o.bloomStrength ?? 0.4, o.bloomRadius ?? 0.55, o.bloomThreshold ?? 2.6);
  bloom.enabled = o.bloom !== false; composer.addPass(bloom);
  composer.addPass(new M.OutputPass());
  return {
    composer, bloom, ssao, render(dt) { composer.render(dt); },
    setSize(w, h) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h); },
    dispose() { composer.passes.forEach((p) => p.dispose && p.dispose()); rt.dispose(); },
  };
}
