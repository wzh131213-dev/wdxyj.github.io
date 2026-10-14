// xiyou-three.js — 把 xiyou-character / xiyou-world 产出的纯数据接到 THREE（建议 three ≥ r152）
// THREE 由调用方注入，因此既可 `import * as THREE from 'three'`，也可用静态页里的全局 THREE：
//   import { buildCharacterData } from './xiyou-character.js';
//   import { createCharacter } from './xiyou-three.js';
//   const ch = createCharacter(THREE, buildCharacterData({ kind: 'wukong' }));  scene.add(ch.group);
// 颜色均为线性空间：用 Color.setRGB(r,g,b)（r152+ 默认按工作色彩空间=线性解释），顶点色同理。

export function toGeometry(THREE, m, { skinned = false } = {}) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  if (m.normals) g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  if (m.uvs && m.uvs.length) g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
  if (m.colors) g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
  if (skinned && m.skinIndex) {
    g.setAttribute('skinIndex', new THREE.BufferAttribute(m.skinIndex, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(m.skinWeight, 4));
  }
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

/** 材质描述 → THREE 材质。全面引入 PBR（基于物理的渲染）标准：精细化分层与物理参数 */
export function makeMaterial(THREE, spec, opts = {}) {
  if (opts.materialFactory) { const custom = opts.materialFactory(spec); if (custom) return custom; }

  const kind = spec.kind;
  let mat;

  if (kind === 'metal') {
    mat = new THREE.MeshStandardMaterial({
      metalness: spec.metalness ?? 0.92,
      roughness: spec.roughness ?? 0.22,
      side: spec.side === 'double' ? THREE.DoubleSide : THREE.FrontSide,
      vertexColors: !!spec.vertexColors
    });
    if (opts.envMap || THREE.defaultEnvMap) {
      mat.envMap = opts.envMap || THREE.defaultEnvMap;
      mat.envMapIntensity = opts.envMapIntensity ?? 1.2;
    }
  } else if (kind === 'cloth' || kind === 'kasaya' || kind === 'robe') {
    const Cls = THREE.MeshPhysicalMaterial || THREE.MeshStandardMaterial;
    mat = new Cls({
      roughness: spec.roughness ?? 0.85,
      metalness: spec.metalness ?? 0,
      side: spec.side === 'double' ? THREE.DoubleSide : THREE.FrontSide,
      vertexColors: !!spec.vertexColors
    });
    if (mat.isMeshPhysicalMaterial) {
      mat.sheen = spec.sheen ?? 0.7;
      const sc = spec.sheenColor ?? [0.9, 0.85, 0.8];
      if (mat.sheenColor && mat.sheenColor.setRGB) {
        mat.sheenColor.setRGB(sc[0], sc[1], sc[2]);
      } else {
        mat.sheenColor = new THREE.Color(sc[0], sc[1], sc[2]);
      }
      mat.sheenRoughness = spec.sheenRoughness ?? 0.5;
    }
  } else if (kind === 'skin' || kind === 'hair') {
    const Cls = THREE.MeshStandardMaterial;
    mat = new Cls({
      roughness: kind === 'skin' ? (spec.roughness ?? 0.6) : (spec.roughness ?? 0.8),
      metalness: spec.metalness ?? 0,
      side: spec.side === 'double' ? THREE.DoubleSide : THREE.FrontSide,
      vertexColors: !!spec.vertexColors
    });
    if (opts.proceduralNormalMap) {
      mat.normalMap = opts.proceduralNormalMap;
      mat.normalScale = new THREE.Vector2(0.15, 0.15);
    }
  } else {
    const Cls = (spec.sheen > 0 && THREE.MeshPhysicalMaterial) || THREE.MeshStandardMaterial;
    mat = new Cls({
      roughness: spec.roughness ?? 0.8,
      metalness: spec.metalness ?? 0,
      side: spec.side === 'double' ? THREE.DoubleSide : THREE.FrontSide,
      vertexColors: !!spec.vertexColors
    });
    if (mat.isMeshPhysicalMaterial && spec.sheen > 0) {
      mat.sheen = spec.sheen;
      const sc = spec.sheenColor ?? [0.9, 0.85, 0.8];
      if (mat.sheenColor && mat.sheenColor.setRGB) {
        mat.sheenColor.setRGB(sc[0], sc[1], sc[2]);
      } else {
        mat.sheenColor = new THREE.Color(sc[0], sc[1], sc[2]);
      }
      mat.sheenRoughness = 0.5;
    }
  }

  if (spec.color) {
    if (mat.color && typeof mat.color.setRGB === 'function') {
      mat.color.setRGB(spec.color[0], spec.color[1], spec.color[2]);
    } else if (mat.color && typeof mat.color.set === 'function') {
      mat.color.set(spec.color[0], spec.color[1], spec.color[2]);
    } else if (mat.color && typeof mat.color === 'object') {
      mat.color.r = spec.color[0];
      mat.color.g = spec.color[1];
      mat.color.b = spec.color[2];
    } else {
      const ColorCls = THREE.Color || class { constructor(r, g, b) { this.r = r; this.g = g; this.b = b; } };
      mat.color = new ColorCls(spec.color[0], spec.color[1], spec.color[2]);
    }
  }
  mat.name = kind || 'material';
  return mat;
}

/**
 * 角色：骨骼层级 + 每个部件一个 SkinnedMesh（共用同一 Skeleton）。
 * 返回 { group, root, bones, skeleton, boneByName, meshes, weapon, hurtCapsules(out), dispose }。
 * 约定与 CONTRACTS 一致：+Z 朝前、角色左 = +X；静止姿态下骨骼无旋转（动画用相对静止姿态的欧拉偏移）。
 */
export function createCharacter(THREE, data, opts = {}) {
  const BoneCls = THREE.Bone || THREE.Object3D;
  const SkeletonCls = THREE.Skeleton || class Skeleton { constructor(b) { this.bones = b; } };
  const SkinnedMeshCls = THREE.SkinnedMesh || THREE.Mesh;

  const sk = data.skeleton, group = new THREE.Group();
  group.name = `character:${data.kind}`;
  const bones = sk.bones.map((b) => { const bone = new BoneCls(); bone.name = b.name; return bone; });
  sk.bones.forEach((b, i) => {
    const pp = b.parent >= 0 ? sk.bones[b.parent].pos : [0, 0, 0];
    bones[i].position.set(b.pos[0] - pp[0], b.pos[1] - pp[1], b.pos[2] - pp[2]);
    if (b.parent >= 0) bones[b.parent].add(bones[i]);
  });
  group.add(bones[0]);
  group.updateMatrixWorld(true);                         // Skeleton 的逆绑定矩阵取自此刻的世界矩阵
  const skeleton = new SkeletonCls(bones), meshes = [];
  for (const p of data.parts) {
    const mesh = new SkinnedMeshCls(toGeometry(THREE, p, { skinned: true }), makeMaterial(THREE, { ...p.material, vertexColors: !!p.colors }, opts));
    mesh.name = p.name; mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
    if (p.cloth) mesh.userData.cloth = p.cloth;          // 布料网格：rows/cols/pin 行，供后续 verlet 接管
    group.add(mesh);
    if (mesh.bind) mesh.bind(skeleton);
    meshes.push(mesh);
  }
  const boneByName = (n) => bones[sk.index[n]];
  let weapon = null;
  if (data.weapon) {
    const bone = boneByName(data.weapon.bone), base = new THREE.Object3D(), tip = new THREE.Object3D();
    base.name = 'weaponBase'; tip.name = 'weaponTip';
    base.position.set(...data.weapon.base); tip.position.set(...data.weapon.tip); bone.add(base); bone.add(tip);
    weapon = { name: data.weapon.name, object: bone, base, tip, length: data.weapon.length };
  }
  /** 把胶囊写入 out（可复用同一数组）：[{a:Vector3, b:Vector3, r, tag}]，世界坐标 */
  function hurtCapsules(out = []) {
    group.updateMatrixWorld(true);
    data.capsules.forEach((c, i) => {
      const e = out[i] ?? (out[i] = { a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0, tag: '' });
      boneByName(c.a).localToWorld(e.a.set(0, 0, 0));
      boneByName(c.b).localToWorld(e.b.set(...(c.bOff ?? [0, 0, 0])));
      e.r = c.r; e.tag = c.tag;
    });
    out.length = data.capsules.length;
    return out;
  }
  function dispose() { for (const m of meshes) { m.geometry.dispose(); m.material.dispose?.(); } }
  return { group, root: bones[0], bones, skeleton, boneByName, meshes, weapon, hurtCapsules, dispose, data };
}

/** 合并烘焙后的静态角色（bakeCharacter 的结果）：不带骨骼，每个桶一个 Mesh，共 2~3 次绘制。静止姿态/骑马坐姿均可 */
export function createStaticCharacter(THREE, baked, opts = {}) {
  const group = new THREE.Group();
  group.name = `character:${baked.kind}`;
  const meshes = baked.buckets.map((b) => {
    const mesh = new THREE.Mesh(toGeometry(THREE, b.mesh), makeMaterial(THREE, { ...b.material, vertexColors: true }, opts));
    mesh.name = b.name; mesh.castShadow = opts.castShadow ?? true; mesh.receiveShadow = !!opts.receiveShadow;
    group.add(mesh);
    return mesh;
  });
  function dispose() { for (const m of meshes) { m.geometry.dispose(); m.material.dispose?.(); } }
  return { group, meshes, dispose, baked };
}

/** 地形：单个 Mesh，顶点色=远景反照率；frustumCulled=false（BIBLE §4.2） */
export function createTerrainMesh(THREE, terrain, opts = {}) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(terrain.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(terrain.normals, 3));
  if (terrain.colors) g.setAttribute('color', new THREE.BufferAttribute(terrain.colors, 3));
  g.setIndex(new THREE.BufferAttribute(terrain.indices, 1));
  const mat = opts.material ?? new THREE.MeshStandardMaterial({ vertexColors: !!terrain.colors, roughness: 0.92, metalness: 0 });
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'terrain'; mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = !!opts.castShadow;
  return mesh;
}

/** 岩石：每个原型一个 InstancedMesh（hi 档几何）；返回 { group, meshes, loGeometries } 以便自行做 LOD 切换 */
export function createRocks(THREE, protos, placement, opts = {}) {
  const group = new THREE.Group(), meshes = [], loGeometries = protos.map((p) => toGeometry(THREE, p.lo));
  group.name = 'rocks';
  const mat = opts.material ?? new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
  if (!opts.material) mat.color.setRGB(0.18, 0.17, 0.155);
  protos.forEach((p) => {
    const list = placement.instances.filter((r) => r.proto === p.id);
    if (!list.length) return;
    const im = new THREE.InstancedMesh(toGeometry(THREE, p.hi), mat, list.length);
    list.forEach((r, i) => im.setMatrixAt(i, new THREE.Matrix4().fromArray(r.matrix)));
    im.instanceMatrix.needsUpdate = true; im.frustumCulled = false; im.castShadow = true; im.receiveShadow = true; im.name = `rock${p.id}`; im.userData.protoId = p.id;
    group.add(im); meshes.push(im);
  });
  return { group, meshes, loGeometries };
}

/** 远山环带：背景几何，不吃雾、不写深度，越远越先画（renderOrder 越小）。需要时由你调整与天空的绘制顺序 */
export function createMountains(THREE, rings, opts = {}) {
  const group = new THREE.Group();
  group.name = 'mountains';
  rings.forEach((m) => {
    // lit=true：用 buildMountainRings({bake:false}) 的纯反照率，交给场景灯光与雾（昼夜会自动跟随）；否则用烘焙好的无光照材质
    const mat = opts.lit ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, side: THREE.DoubleSide })
      : new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, depthWrite: false, side: THREE.FrontSide });
    const mesh = new THREE.Mesh(toGeometry(THREE, m), mat);
    mesh.name = `mountain${m.layer}`; mesh.frustumCulled = false; mesh.renderOrder = -100 - m.layer;
    group.add(mesh);
  });
  return group;
}

/** 便捷组合：给定 makeGround / buildTerrain / placeRocks / buildMountainRings 的结果，一次生成整个环境 */
export function createWorldObjects(THREE, { terrain, protos, placement, rings }, opts = {}) {
  const group = new THREE.Group(); group.name = 'world';
  const out = { group };
  if (terrain) group.add((out.terrain = createTerrainMesh(THREE, terrain, opts.terrain)));
  if (protos && placement) { out.rocks = createRocks(THREE, protos, placement, opts.rocks); group.add(out.rocks.group); }
  if (rings) group.add((out.mountains = createMountains(THREE, rings, opts.mountains)));
  return out;
}

/** 1. 程序化呼吸与微动 (Procedural Idle) */
export function updateProceduralIdle(character, delta, isMoving = false, time = 0) {
  if (!character || !character.boneByName) return;
  const spine1 = character.boneByName('spine1');
  const spine2 = character.boneByName('spine2');
  const chest = character.boneByName('chest');
  const head = character.boneByName('head');
  const upperArm_L = character.boneByName('upperArm_L');
  const upperArm_R = character.boneByName('upperArm_R');
  const foreArm_L = character.boneByName('foreArm_L');
  const foreArm_R = character.boneByName('foreArm_R');
  const hand_L = character.boneByName('hand_L');
  const hand_R = character.boneByName('hand_R');
  const thigh_L = character.boneByName('thigh_L');
  const thigh_R = character.boneByName('thigh_R');
  const shin_L = character.boneByName('shin_L');
  const shin_R = character.boneByName('shin_R');

  if (isMoving) {
    return;
  }

  const breathFreq = 2.2;
  const breathPhase = time * breathFreq;
  const breathAmp = 0.035;

  if (spine1) spine1.rotation.x = Math.sin(breathPhase) * (breathAmp * 0.4);
  if (spine2) spine2.rotation.x = Math.sin(breathPhase + 0.3) * (breathAmp * 0.6);
  if (chest) chest.rotation.x = Math.sin(breathPhase + 0.6) * breathAmp;

  if (head) {
    const headRoll = Math.sin(time * 0.8) * 0.02;
    const headYaw = Math.sin(time * 0.5) * 0.04 + (Math.sin(time * 1.7) > 0.95 ? (Math.sin(time * 12) * 0.05) : 0);
    const headPitch = -Math.sin(breathPhase + 0.9) * (breathAmp * 0.5);
    head.rotation.set(headPitch, headYaw, headRoll);
  }

  // 手臂与腿部微动
  if (upperArm_L) upperArm_L.rotation.z = Math.sin(time * 1.1) * 0.02;
  if (upperArm_R) upperArm_R.rotation.z = -Math.sin(time * 1.1) * 0.02;
  if (foreArm_L) foreArm_L.rotation.x = 0.05 + Math.sin(breathPhase) * 0.02;
  if (foreArm_R) foreArm_R.rotation.x = 0.05 + Math.sin(breathPhase + 0.3) * 0.02;
  if (hand_L) hand_L.rotation.y = Math.sin(time * 1.5) * 0.03;
  if (hand_R) hand_R.rotation.y = -Math.sin(time * 1.5) * 0.03;

  if (thigh_L) thigh_L.rotation.x = Math.sin(time * 0.7) * 0.01;
  if (thigh_R) thigh_R.rotation.x = -Math.sin(time * 0.7) * 0.01;
  if (shin_L) shin_L.rotation.x = Math.abs(Math.sin(time * 0.7)) * 0.01;
  if (shin_R) shin_R.rotation.x = Math.abs(Math.cos(time * 0.7)) * 0.01;
}

/** 动态全身体肢体动作 (全身步态：大腿、小腿、脚部、脚尖、上臂、前臂、手部及躯干/胯部反向扭转) */
export function updateCharacterLocomotion(character, delta, isMoving, speed = 4, time = 0) {
  if (!character || !character.boneByName) return;

  const pelvis = character.boneByName('pelvis');
  const spine1 = character.boneByName('spine1');
  const spine2 = character.boneByName('spine2');
  const chest = character.boneByName('chest');
  const neck = character.boneByName('neck');
  const head = character.boneByName('head');

  const thigh_L = character.boneByName('thigh_L');
  const thigh_R = character.boneByName('thigh_R');
  const shin_L = character.boneByName('shin_L');
  const shin_R = character.boneByName('shin_R');
  const foot_L = character.boneByName('foot_L');
  const foot_R = character.boneByName('foot_R');
  const toe_L = character.boneByName('toe_L');
  const toe_R = character.boneByName('toe_R');

  const clavicle_L = character.boneByName('clavicle_L');
  const clavicle_R = character.boneByName('clavicle_R');
  const upperArm_L = character.boneByName('upperArm_L');
  const upperArm_R = character.boneByName('upperArm_R');
  const foreArm_L = character.boneByName('foreArm_L');
  const foreArm_R = character.boneByName('foreArm_R');
  const hand_L = character.boneByName('hand_L');
  const hand_R = character.boneByName('hand_R');

  if (!isMoving) {
    [pelvis, spine1, spine2, chest, neck, head,
     thigh_L, thigh_R, shin_L, shin_R, foot_L, foot_R, toe_L, toe_R,
     clavicle_L, clavicle_R, upperArm_L, upperArm_R, foreArm_L, foreArm_R, hand_L, hand_R].forEach(b => {
      if (b && b.rotation) b.rotation.set(0, 0, 0);
    });
    return;
  }

  const strideFreq = Math.max(3.8, speed * 2.0);
  const phase = time * strideFreq;

  // 胯部左右倾斜与上下起伏
  const swayAmp = 0.08;
  const bounceAmp = 0.04;
  if (pelvis) {
    pelvis.rotation.z = Math.sin(phase) * swayAmp;
    pelvis.rotation.y = Math.cos(phase) * 0.06;
    if (pelvis.position) pelvis.position.y = Math.abs(Math.sin(phase * 2)) * bounceAmp;
  }

  // 下肢动作：大腿屈伸、小腿弯曲、脚背倾斜、脚尖翻折
  const thighAmp = Math.min(0.85, 0.35 + speed * 0.1);
  if (thigh_L) thigh_L.rotation.x = Math.sin(phase) * thighAmp;
  if (thigh_R) thigh_R.rotation.x = -Math.sin(phase) * thighAmp;

  if (shin_L) shin_L.rotation.x = Math.max(0, Math.sin(phase + Math.PI * 0.25)) * 0.95;
  if (shin_R) shin_R.rotation.x = Math.max(0, -Math.sin(phase + Math.PI * 0.25)) * 0.95;

  if (foot_L) foot_L.rotation.x = -Math.sin(phase) * 0.35;
  if (foot_R) foot_R.rotation.x = Math.sin(phase) * 0.35;

  if (toe_L) toe_L.rotation.x = Math.max(0, Math.sin(phase - Math.PI * 0.2)) * 0.25;
  if (toe_R) toe_R.rotation.x = Math.max(0, -Math.sin(phase - Math.PI * 0.2)) * 0.25;

  // 脊柱与胸膛反向反扭
  if (spine1) spine1.rotation.y = -Math.sin(phase) * 0.12;
  if (chest) chest.rotation.y = -Math.sin(phase) * 0.08;

  // 锁骨与肩部动作
  if (clavicle_L) clavicle_L.rotation.z = -Math.sin(phase) * 0.05;
  if (clavicle_R) clavicle_R.rotation.z = Math.sin(phase) * 0.05;

  // 上肢动作：上臂前后摆动、前臂自然弯曲、手腕摆动
  const armAmp = Math.min(0.7, 0.25 + speed * 0.08);
  if (upperArm_L) upperArm_L.rotation.x = -Math.sin(phase) * armAmp;
  if (upperArm_R) upperArm_R.rotation.x = Math.sin(phase) * armAmp;

  if (foreArm_L) foreArm_L.rotation.x = 0.25 + Math.max(0, -Math.sin(phase)) * 0.45;
  if (foreArm_R) foreArm_R.rotation.x = 0.25 + Math.max(0, Math.sin(phase)) * 0.45;

  if (hand_L) hand_L.rotation.z = Math.sin(phase * 0.5) * 0.12;
  if (hand_R) hand_R.rotation.z = -Math.sin(phase * 0.5) * 0.12;

  if (head) head.rotation.y = Math.sin(phase) * 0.04;
}

/** 2. 骑乘状态动力学同步 */
export function updateRiderDynamics(riderGroup, saddleObject, delta, dampFactor = 12) {
  if (!riderGroup || !saddleObject) return;
  const targetPos = saddleObject.position;
  if (!riderGroup.userData.currentRidePos) {
    riderGroup.userData.currentRidePos = targetPos.clone ? targetPos.clone() : { x: targetPos.x || 0, y: targetPos.y || 0, z: targetPos.z || 0 };
  }
  const cur = riderGroup.userData.currentRidePos;
  const f = Math.min(1, delta * dampFactor);
  cur.x += ((targetPos.x || 0) - cur.x) * f;
  cur.y += ((targetPos.y || 0) - cur.y) * f;
  cur.z += ((targetPos.z || 0) - cur.z) * f;

  if (riderGroup.position.copy) {
    riderGroup.position.copy(cur);
  } else {
    Object.assign(riderGroup.position, cur);
  }
}

/** 3. 布料与毛发物理仿真 (Verlet Integration) */
export class VerletClothSimulator {
  constructor(mesh, clothMeta, WIND_DIR = [0.8, 0, 0.6]) {
    this.mesh = mesh;
    this.clothMeta = clothMeta;
    this.WIND_DIR = WIND_DIR;
    this.rows = clothMeta.rows || 6;
    this.cols = clothMeta.cols || 1;
    this.pinRow = clothMeta.pin ?? 0;

    const posAttr = mesh.geometry.getAttribute('position');
    this.count = posAttr.count;
    this.oldPos = new Float32Array(posAttr.array);
    this.originalPos = new Float32Array(posAttr.array);
  }

  update(delta, characterVelocity = [0, 0, 0]) {
    if (!this.mesh || !this.mesh.geometry) return;
    const posAttr = this.mesh.geometry.getAttribute('position');
    const p = posAttr.array;
    const dt2 = Math.min(delta, 0.05) ** 2;

    let localVel = characterVelocity;
    if (this.mesh.worldToLocal) {
      const v = new this.mesh.position.constructor(characterVelocity[0], characterVelocity[1], characterVelocity[2]);
      localVel = [v.x, v.y, v.z];
    }

    const gravity = [0, -9.8, 0];
    const wind = this.WIND_DIR;
    const inertia = [-localVel[0] * 0.5, -localVel[1] * 0.5, -localVel[2] * 0.5];

    const W = this.cols + 1;
    for (let r = 0; r <= this.rows; r++) {
      if (r === this.pinRow) continue;
      for (let c = 0; c <= this.cols; c++) {
        const i = (r * W + c) * 3;
        const vx = (p[i] - this.oldPos[i]) * 0.95;
        const vy = (p[i + 1] - this.oldPos[i + 1]) * 0.95;
        const vz = (p[i + 2] - this.oldPos[i + 2]) * 0.95;

        this.oldPos[i] = p[i];
        this.oldPos[i + 1] = p[i + 1];
        this.oldPos[i + 2] = p[i + 2];

        const ax = gravity[0] + wind[0] * 2.0 + inertia[0];
        const ay = gravity[1] + wind[1] * 2.0 + inertia[1];
        const az = gravity[2] + wind[2] * 2.0 + inertia[2];

        p[i] += vx + ax * dt2;
        p[i + 1] += vy + ay * dt2;
        p[i + 2] += vz + az * dt2;
      }
    }

    // Constraint satisfaction (distance constraints)
    for (let iteration = 0; iteration < 3; iteration++) {
      for (let r = 0; r <= this.rows; r++) {
        for (let c = 0; c <= this.cols; c++) {
          const idx = r * W + c;
          if (r > 0) {
            this._satisfyDistance(idx, (r - 1) * W + c);
          }
          if (c > 0) {
            this._satisfyDistance(idx, r * W + (c - 1));
          }
        }
      }
    }

    posAttr.needsUpdate = true;
    if (this.mesh.geometry.computeVertexNormals) {
      this.mesh.geometry.computeVertexNormals();
    }
  }

  _satisfyDistance(i1, i2) {
    const p = this.mesh.geometry.getAttribute('position').array;
    const idx1 = i1 * 3, idx2 = i2 * 3;
    const dx = p[idx2] - p[idx1];
    const dy = p[idx2 + 1] - p[idx1 + 1];
    const dz = p[idx2 + 2] - p[idx1 + 2];
    const dist = Math.hypot(dx, dy, dz) || 1e-6;

    const origDx = this.originalPos[idx2] - this.originalPos[idx1];
    const origDy = this.originalPos[idx2 + 1] - this.originalPos[idx1 + 1];
    const origDz = this.originalPos[idx2 + 2] - this.originalPos[idx1 + 2];
    const restLen = Math.hypot(origDx, origDy, origDz) || 1e-6;

    const diff = (dist - restLen) / dist;
    const r1 = Math.floor(i1 / (this.cols + 1));
    const r2 = Math.floor(i2 / (this.cols + 1));

    const pinned1 = (r1 === this.pinRow);
    const pinned2 = (r2 === this.pinRow);

    if (!pinned1 && !pinned2) {
      p[idx1] += dx * 0.5 * diff;
      p[idx1 + 1] += dy * 0.5 * diff;
      p[idx1 + 2] += dz * 0.5 * diff;
      p[idx2] -= dx * 0.5 * diff;
      p[idx2 + 1] -= dy * 0.5 * diff;
      p[idx2 + 2] -= dz * 0.5 * diff;
    } else if (!pinned1) {
      p[idx1] += dx * diff;
      p[idx1 + 1] += dy * diff;
      p[idx1 + 2] += dz * diff;
    } else if (!pinned2) {
      p[idx2] -= dx * diff;
      p[idx2 + 1] -= dy * diff;
      p[idx2 + 2] -= dz * diff;
    }
  }
}
