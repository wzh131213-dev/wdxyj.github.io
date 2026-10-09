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

/** 材质描述 → THREE 材质。opts.materialFactory(spec) 可返回自定义材质（例如你项目里的 patchMaterial）；返回空则走默认 */
export function makeMaterial(THREE, spec, opts = {}) {
  if (opts.materialFactory) { const custom = opts.materialFactory(spec); if (custom) return custom; }
  const physical = spec.kind === 'cloth' && spec.sheen > 0 && THREE.MeshPhysicalMaterial;
  const Cls = physical || THREE.MeshStandardMaterial;
  const mat = new Cls({ roughness: spec.roughness ?? 0.8, metalness: spec.metalness ?? 0, side: spec.side === 'double' ? THREE.DoubleSide : THREE.FrontSide, vertexColors: !!spec.vertexColors });
  mat.color.setRGB(spec.color[0], spec.color[1], spec.color[2]);
  if (physical) { mat.sheen = spec.sheen; mat.sheenColor.setRGB(...spec.sheenColor); mat.sheenRoughness = 0.5; }
  mat.name = spec.kind;
  return mat;
}

/**
 * 角色：骨骼层级 + 每个部件一个 SkinnedMesh（共用同一 Skeleton）。
 * 返回 { group, root, bones, skeleton, boneByName, meshes, weapon, hurtCapsules(out), dispose }。
 * 约定与 CONTRACTS 一致：+Z 朝前、角色左 = +X；静止姿态下骨骼无旋转（动画用相对静止姿态的欧拉偏移）。
 */
export function createCharacter(THREE, data, opts = {}) {
  const sk = data.skeleton, group = new THREE.Group();
  group.name = `character:${data.kind}`;
  const bones = sk.bones.map((b) => { const bone = new THREE.Bone(); bone.name = b.name; return bone; });
  sk.bones.forEach((b, i) => {
    const pp = b.parent >= 0 ? sk.bones[b.parent].pos : [0, 0, 0];
    bones[i].position.set(b.pos[0] - pp[0], b.pos[1] - pp[1], b.pos[2] - pp[2]);
    if (b.parent >= 0) bones[b.parent].add(bones[i]);
  });
  group.add(bones[0]);
  group.updateMatrixWorld(true);                         // Skeleton 的逆绑定矩阵取自此刻的世界矩阵
  const skeleton = new THREE.Skeleton(bones), meshes = [];
  for (const p of data.parts) {
    const mesh = new THREE.SkinnedMesh(toGeometry(THREE, p, { skinned: true }), makeMaterial(THREE, { ...p.material, vertexColors: !!p.colors }, opts));
    mesh.name = p.name; mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
    if (p.cloth) mesh.userData.cloth = p.cloth;          // 布料网格：rows/cols/pin 行，供后续 verlet 接管
    group.add(mesh); mesh.bind(skeleton);
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
