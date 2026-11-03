    /*
        ============================================================
        新建模层（重走西游 · 环境/人物建模 + 动态物理 + PBR + 光影 + 后期）
        ------------------------------------------------------------
        XM = xiyou-core / world / character / motion / fx / three 六个模块打成的一个包（依据 BIBLE 规范）。
        接入原则：
        1. 旧实现全部保留，改名为 *Legacy；新模型/新特效任何一步出错都会回退到旧实现，游戏不会因此打不开。
        2. 随机数消耗次数与顺序保持不变，所以同一世界种子 / 旧存档生成的世界布局（道路、建筑、树石位置）不变。
        3. terrainHeight / terrainSurfaceHeight 与渲染网格严格同一张高度栅格，玩法高度与看到的地面一致。
        4. 画质分 高/中/低 三档：点击右上"⚙ 设置"循环（高→中→低→自动），或网址加 ?quality=high|medium|low；自动档按帧时间升降。
        整体关闭：XM_CFG.enabled=false（旧地形/旧人物）；XM_FX.enabled=false（旧光影/旧动画/无后期）。
        ============================================================
    */
    const XM = __XM_BUNDLE__;
    const XM_QS = typeof location !== "undefined" && location.search ? new URLSearchParams(location.search) : null;
    const xmImport = (url) => import(url);
    const XM_CFG = {
        enabled: true,
        cell: 5,
        outer: 1500,
        unit: 1.5,
        colorScale: 1.5,
        saddleTop: 2.205,
        anchor: [-0.10, 0.38, 0],
        figures: { tang: "tangseng", wukong: "wukong", bajie: "bajie", wujing: "wujing" },
        ground: {
            swell: 28,
            swellFreq: 0.001,
            swellOct: 3,
            undul: 0.8,
            hummock: 0.08,
            boundAmp: 0,
            pad: { inner: 9, outer: 40 },
            dryBias: -0.25,
            palette: {
                lush: [0.30, 0.42, 0.15],
                dry: [0.52, 0.45, 0.22],
                dirt: [0.40, 0.31, 0.20],
                rock: [0.40, 0.38, 0.35]
            }
        },
        mountains: { scale: 0.75, albedoScale: 3 }
    };
    const XM_FX = {
        enabled: true,
        physics: true,
        idle: true,
        rideDynamics: true,
        pbr: true,
        windStrength: 6,
        fogDensity: 0.00058,
        legacyFogDensity: 0.00062,
        fogHeightFalloff: 0.0035,
        fogBase: -25,
        fogWarmPow: 5,
        exposure: 1.2,
        bloomScale: 0.9,
        bloomRadius: 0.55,
        bloomThreshold: 2.2,
        shadowHalf: 120,
        envInterval: 3
    };
    const XM_STATE = { ground: null, grid: null, rockProtos: null, rocksFailed: false, baked: new Map() };
    const XM_RT = {
        tier: "high", q: XM.QUALITY.high, mode: 0, governor: null, normals: null,
        fog: null, sky: null, env: null, post: null, postModules: null, postLoading: false, postFailed: false,
        atmosphereOn: false, applied: false, failed: false, terrainPatch: null, state: null,
        lastT: 0, time: 0, envT: 0, rider: null, wind: [0, 0, 0], lastPos: null,
        saddle: null, gait: null, tmp: new THREE.Vector3(),
        legacyBackground: 0xc7d5ad
    };
    function xmGlow(value, scale = 6) {
        return XM_FX.enabled && XM_RT.q && XM_RT.q.bloom ? value * scale : value;
    }

    /* ───────── 地形 ───────── */
    function rebuildGround(seed) {
        XM_STATE.ground = null;
        XM_STATE.grid = null;
        XM_STATE.rocksFailed = false;
        if (!XM_CFG.enabled) {
            return;
        }
        try {
            const half = CONFIG.worldHalf;
            const ground = XM.makeGround({
                seed,
                hub: [0, 0],
                roads: null,
                ...XM_CFG.ground,
                rim: { start: half - 20, end: half + 450, amp: 60, square: true }
            });
            const axis = XM.makeAxis({
                inner: half,
                step: XM_CFG.cell,
                growth: 1.045,
                outer: XM_CFG.outer
            });
            XM_STATE.grid = XM.sampleHeights(ground, axis);
            XM_STATE.ground = ground;
        } catch (error) {
            console.error("新地形生成失败，已回退旧地形：", error);
            XM_STATE.ground = null;
            XM_STATE.grid = null;
        }
    }
    function terrainHeight(x, z) {
        if (XM_STATE.grid) {
            return XM.terrainHeightFromMesh(XM_STATE.grid, x, z);
        }
        return terrainHeightLegacy(x, z);
    }
    function terrainSurfaceHeight(x, z) {
        if (XM_STATE.grid) {
            return XM.terrainHeightFromMesh(XM_STATE.grid, x, z);
        }
        return terrainSurfaceHeightLegacy(x, z);
    }
    function createTerrain() {
        if (XM_STATE.grid) {
            try {
                const blend = !!(XM_FX.enabled && XM_RT.q.atmosphere && !XM_RT.failed);
                const data = XM.buildTerrain(XM_STATE.ground, {
                    axis: XM_STATE.grid.axis,
                    heights: XM_STATE.grid.heights,
                    gridNormals: true,
                    splat: blend,
                    cavity: false
                });
                const material = new THREE.MeshStandardMaterial({
                    vertexColors: true,
                    roughness: 1
                });
                XM_RT.terrainPatch = blend ? XM.patchTerrainMaterial(THREE, material, XM_STATE.ground.palette) : null;
                const terrain = XM.createTerrainMesh(THREE, data, { material });
                worldGroup.add(terrain);
                const m = XM_CFG.mountains;
                const layers = XM.MOUNTAIN_LAYERS.map(layer => ({
                    ...layer,
                    radius: layer.radius * m.scale,
                    H: layer.H * m.scale,
                    depth: layer.depth * m.scale,
                    base: layer.base * m.scale
                }));
                const rings = XM.buildMountainRings({
                    seed: rngSeed,
                    layers,
                    bake: false,
                    albedoScale: m.albedoScale
                });
                worldGroup.add(XM.createMountains(THREE, rings, { lit: true }));
                return;
            } catch (error) {
                console.error("新地形网格生成失败，已回退旧地形：", error);
                XM_STATE.grid = null;
                XM_STATE.ground = null;
                XM_RT.terrainPatch = null;
            }
        }
        createTerrainLegacy();
    }
    function createRock(x, z, scale = 1) {
        if (!XM_STATE.ground || XM_STATE.rocksFailed) {
            createRockLegacy(x, z, scale);
            return;
        }
        // 随机数的消耗次数与顺序必须和旧实现完全一致（半径、颜色、三个旋转量）。
        const radius = randomRange(1.2, 3.5) * scale;
        const tint = choose([0x77756e, 0x686a66, 0x8b8275]);
        const r1 = random();
        const r2 = random() * Math.PI;
        const r3 = random();
        try {
            if (!XM_STATE.rockProtos) {
                XM_STATE.rockProtos = XM.makeRockPrototypes({ hi: 3, lo: 2 });
            }
            const proto = XM_STATE.rockProtos[Math.min(5, Math.floor(r1 * 6))];
            const rock = new THREE.Mesh(
                XM.toGeometry(THREE, proto.hi),
                new THREE.MeshStandardMaterial({ color: tint, roughness: 1 })
            );
            const sy = radius * (0.7 + 0.3 * r3);
            const sink = 0.25 + 0.25 * r1;
            rock.scale.set(radius, sy, radius * (0.8 + 0.4 * r3));
            rock.rotation.y = r2;
            rock.position.set(
                x,
                terrainHeight(x, z) - sink * (proto.ymax - proto.ymin) * sy - proto.ymin * sy,
                z
            );
            rock.castShadow = true;
            propGroup.add(rock);
        } catch (error) {
            console.error("新岩石生成失败，已回退旧样式石头：", error);
            XM_STATE.rocksFailed = true;
            const rock = new THREE.Mesh(
                new THREE.DodecahedronGeometry(radius, 0),
                new THREE.MeshStandardMaterial({ color: tint, roughness: 1 })
            );
            rock.position.set(x, terrainHeight(x, z) + 1.2, z);
            rock.rotation.set(r1, r2, r3);
            rock.castShadow = true;
            propGroup.add(rock);
        }
    }

    /* ───────── 人物：蒙皮 + PBR + 程序化呼吸/眨眼 + 布料/长发仿真 ───────── */
    function getBakedFigure(kind, ride) {
        const key = kind + (ride ? ":ride" : ":stand") + (XM_FX.physics ? "" : ":static");
        let baked = XM_STATE.baked.get(key);
        if (!baked) {
            let data = XM.buildCharacterData({ kind });
            if (ride) {
                data = XM.poseData(data, XM.RIDE_POSE);
            }
            baked = XM.bakeCharacter(data, {
                colorScale: XM_CFG.colorScale,
                dynamic: !XM_FX.physics ? [] : ride ? ["cape", "tails", "hair"] : ["cape", "tails", "drape", "hair"],
                legsColliders: !ride
            });
            XM_STATE.baked.set(key, baked);
        }
        return baked;
    }
    function xmHorseCollider(hs, rideY) {
        // 把坐骑身体（胶囊，沿 X）从坐骑空间换算到骑手模型空间：减去锚点与骑手偏移，再做 -π/2 的 Y 旋转并除以尺度
        const toModel = (q) => {
            const ax = q[0] - XM_CFG.anchor[0];
            const ay = q[1] - XM_CFG.anchor[1] - rideY;
            const az = q[2] - XM_CFG.anchor[2];
            return [-az / hs, ay / hs, ax / hs];
        };
        return { tag: "horse", a: toModel([-0.95, 1.55, 0]), b: toModel([0.95, 1.55, 0]), r: 0.58 / hs };
    }
    function createCharacterFigure(character, scale = 1, options = {}) {
        // 外层：缩放（队伍/骑手代码会改它的位置与朝向）；内层：把"朝 +Z"的人物转成游戏统一的"朝本地 +X"。
        const outer = new THREE.Group();
        outer.scale.setScalar(scale);
        const inner = new THREE.Group();
        inner.rotation.y = Math.PI / 2;
        outer.add(inner);
        let usedNew = false;
        const kind = XM_CFG.enabled ? XM_CFG.figures[character.id] : undefined;
        if (kind) {
            try {
                const baked = getBakedFigure(kind, !!options.ride);
                const matOpts = XM_FX.enabled && XM_FX.pbr ? { normalMaps: XM_RT.normals, env: XM_RT.env } : {};
                const figure = XM.createSkinnedBaked(THREE, baked, { castShadow: true, ...matOpts });
                const hs = XM_CFG.unit * scale;
                figure.group.scale.setScalar(XM_CFG.unit);
                inner.add(figure.group);
                usedNew = true;
                let rideY = 0;
                if (options.ride) {
                    const seat = (baked.layout.hipY - 0.10 * baked.layout.k) * hs;
                    rideY = XM_CFG.saddleTop - XM_CFG.anchor[1] - seat;
                    outer.userData.rideY = rideY;
                    outer.userData.seatH = seat;
                }
                const rig = new XM.ClothRig();
                figure.dynamic.forEach(entry => rig.add(entry, {
                    colliders: baked.colliders,
                    extraColliders: options.ride ? [xmHorseCollider(hs, rideY)] : []
                }));
                outer.userData.xm = {
                    fig: figure,
                    rig,
                    idle: new XM.IdleAnimator(XM.hashStr(character.id + (options.ride ? "r" : "s"))),
                    k: baked.layout.k,
                    ride: !!options.ride,
                    headCounter: 0
                };
            } catch (error) {
                console.error("新人物模型生成失败，已回退旧模型：", character.id, error);
                inner.clear();
                delete outer.userData.xm;
            }
        }
        if (!usedNew) {
            inner.add(createCharacterFigureLegacy(character, 1));
        }
        if (options.ride) {
            // 骑手换人时：新模型骑手接管跟随/待机更新，旧模型骑手则清空引用，避免继续更新一个已被移除的模型
            XM_RT.rider = usedNew && outer.userData.xm ? outer : null;
            if (XM_RT.saddle) {
                XM_RT.saddle.reset();
            }
        }
        outer.userData.characterId = character.id;
        return outer;
    }
    function xmDisposeFigure(group) {
        if (!group) {
            return;
        }
        if (XM_RT.rider === group) {
            XM_RT.rider = null;
        }
        group.traverse(object => {
            if (object.geometry) {
                object.geometry.dispose();
            }
            if (object.material && object.material.dispose) {
                object.material.dispose();
            }
        });
    }
    function xmUpdateFigure(group, delta, moving) {
        const xm = group.userData.xm;
        if (!xm) {
            return;
        }
        try {
            if (XM_FX.enabled && XM_FX.idle) {
                const pose = xm.idle.update(delta, !moving);
                if (xm.ride) {
                    pose.head[0] += xm.headCounter;
                }
                XM.applyIdlePose(xm.fig, pose, xm.k);
            }
            if (XM_FX.enabled && XM_FX.physics && XM_RT.q.cloth && xm.rig.items.length) {
                group.getWorldPosition(XM_RT.tmp);
                const far = XM_RT.tmp.distanceToSquared(camera.position) > 150 * 150;
                XM.windAt(XM_RT.time, XM_RT.tmp.x, XM_RT.tmp.z, XM_FX.windStrength, XM_RT.wind);
                xm.rig.update(delta, XM_RT.wind, far);
            }
        } catch (error) {
            console.error("人物动态更新失败，已停用该角色的动态效果：", error);
            delete group.userData.xm;
        }
    }
    function xmUpdateFigures(delta) {
        if (!XM_FX.enabled) {
            return;
        }
        XM_RT.time += delta;
        const moving = !!player.moving;
        if (XM_RT.rider) {
            xmUpdateFigure(XM_RT.rider, delta, moving);
        }
        for (const companion of companions) {
            xmUpdateFigure(companion.group, delta, moving);
        }
    }

    /* ───────── 白龙马：髋/膝两段腿 + 四蹄步态 + 骑手鞍座阻尼跟随 ───────── */
    function xmBuildHorseLeg(mount, front, side, legMaterial) {
        if (!(XM_FX.enabled && XM_FX.rideDynamics)) {
            const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.14, 1.35, 5), legMaterial);
            leg.position.set(front * 0.55, 0.78, side * 0.42);
            leg.castShadow = true;
            mount.userData.legs.push(leg);
            return leg;
        }
        const hip = new THREE.Group();
        hip.position.set(front * 0.55, 1.45, side * 0.42);
        const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.115, 0.72, 6), legMaterial);
        upper.position.y = -0.36;
        upper.castShadow = true;
        hip.add(upper);
        const knee = new THREE.Group();
        knee.position.y = -0.72;
        hip.add(knee);
        const lower = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.075, 0.64, 6), legMaterial);
        lower.position.y = -0.32;
        lower.castShadow = true;
        knee.add(lower);
        const hoof = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.10, 0.20), makeCharacterMaterial(0x4a3b32));
        hoof.position.y = -0.66;
        hoof.castShadow = true;
        knee.add(hoof);
        hip.userData.knee = knee;
        mount.userData.legs.push(hip);
        return hip;
    }
    function animatePlayerModel(delta, moving) {
        const mount = playerGroup.userData.mount;
        if (!mount || !(XM_FX.enabled && XM_FX.rideDynamics) || !mount.userData.legs[0] || !mount.userData.legs[0].userData.knee) {
            animatePlayerModelLegacy(delta, moving);
            return;
        }
        try {
            xmAnimateRide(mount, delta, moving);
        } catch (error) {
            console.error("坐骑动态出错，已回退旧步态：", error);
            XM_FX.rideDynamics = false;
            animatePlayerModelLegacy(delta, moving);
        }
    }
    function xmAnimateRide(mount, delta, moving) {
        if (!XM_RT.gait) {
            XM_RT.gait = new XM.GaitModel();
            XM_RT.saddle = new XM.SaddleFollow();
        }
        const P = playerGroup.position;
        let speed = 0;
        if (XM_RT.lastPos) {
            speed = Math.hypot(P.x - XM_RT.lastPos.x, P.z - XM_RT.lastPos.z) / Math.max(delta, 1e-4);
            if (speed > 80) {
                speed = 0;
            }
        } else {
            XM_RT.lastPos = new THREE.Vector3();
        }
        XM_RT.lastPos.copy(P);
        const gait = XM_RT.gait.step(delta, speed, moving);
        mount.userData.legs.forEach((hip, index) => {
            hip.rotation.z = gait.legs[index].hip;
            hip.userData.knee.rotation.z = gait.legs[index].knee;
        });
        mount.position.y = gait.bob;
        mount.rotation.z = gait.pitch;
        mount.rotation.x = gait.roll;
        const rider = XM_RT.rider;
        if (rider && rider.userData.xm && rider.parent === mount.userData.riderAnchor) {
            const follow = XM_RT.saddle.step(delta, gait.bob, gait.pitch);
            const seat = rider.userData.seatH || 1.1;
            rider.rotation.z = follow.dpitch;
            rider.position.x = seat * Math.sin(follow.dpitch);
            rider.position.y = rider.userData.rideY + follow.dy + seat * (1 - Math.cos(follow.dpitch));
            rider.userData.xm.headCounter = 0.5 * (gait.pitch + follow.dpitch);
        }
    }

    /* ───────── 光影：高度雾 / 天空穹顶 / 昼夜调色板 / 4096 阴影 / 后期 ───────── */
    function xmDirtyMaterials() {
        scene.traverse(object => {
            const m = object.material;
            if (m) {
                (Array.isArray(m) ? m : [m]).forEach(item => { item.needsUpdate = true; });
            }
        });
    }
    function xmEnableAtmosphere() {
        if (XM_RT.atmosphereOn) {
            return;
        }
        XM_RT.fog = XM_RT.fog && XM_RT.fog.active ? XM_RT.fog : XM.installHeightFog(THREE);
        if (!XM_RT.sky) {
            XM_RT.sky = XM.createSkyDome(THREE, { radius: 1000 });
        }
        scene.add(XM_RT.sky.mesh);
        scene.fog.density = XM_FX.fogDensity;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = XM_FX.exposure;
        if (!XM_RT.env && XM_RT.q.env) {
            XM_RT.env = XM.createEnvironment(THREE, renderer, XM_RT.sky);
        }
        XM_RT.atmosphereOn = true;
        XM_RT.applied = false;
        xmDirtyMaterials();
    }
    function xmDisableAtmosphere() {
        if (!XM_RT.atmosphereOn) {
            return;
        }
        if (XM_RT.fog) {
            XM_RT.fog.restore();
        }
        if (XM_RT.sky) {
            scene.remove(XM_RT.sky.mesh);
        }
        scene.fog.density = XM_FX.legacyFogDensity;
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.toneMappingExposure = 1;
        scene.background.set(XM_RT.legacyBackground);
        scene.fog.color.set(XM_RT.legacyBackground);
        XM_RT.atmosphereOn = false;
        xmDirtyMaterials();
    }
    function xmRebuildPost() {
        if (XM_RT.post) {
            XM_RT.post.dispose();
            XM_RT.post = null;
        }
        if (!XM_RT.q.post || !XM_RT.postModules || XM_RT.failed || !XM_RT.atmosphereOn) {
            return;
        }
        try {
            XM_RT.post = XM.createPostPipeline(THREE, XM_RT.postModules, renderer, scene, camera, {
                ssao: XM_RT.q.ssao,
                bloom: XM_RT.q.bloom,
                msaa: XM_RT.q.msaa,
                bloomStrength: 0.4 * XM_FX.bloomScale,
                bloomRadius: XM_FX.bloomRadius,
                bloomThreshold: XM_FX.bloomThreshold
            });
        } catch (error) {
            console.error("后期处理管线创建失败，保持直接渲染：", error);
            XM_RT.post = null;
            XM_RT.postFailed = true;
        }
    }
    async function xmLoadPost() {
        if (XM_RT.postLoading || XM_RT.postModules || XM_RT.postFailed) {
            return;
        }
        XM_RT.postLoading = true;
        try {
            const base = "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/";
            const loaded = await Promise.all([
                xmImport(base + "EffectComposer.js"),
                xmImport(base + "RenderPass.js"),
                xmImport(base + "UnrealBloomPass.js"),
                xmImport(base + "SSAOPass.js"),
                xmImport(base + "OutputPass.js")
            ]);
            XM_RT.postModules = {
                EffectComposer: loaded[0].EffectComposer,
                RenderPass: loaded[1].RenderPass,
                UnrealBloomPass: loaded[2].UnrealBloomPass,
                SSAOPass: loaded[3].SSAOPass,
                OutputPass: loaded[4].OutputPass
            };
            xmRebuildPost();
        } catch (error) {
            XM_RT.postFailed = true;
            console.error("后期处理模块加载失败，保持直接渲染：", error);
        } finally {
            XM_RT.postLoading = false;
        }
    }
    function xmApplyTier(tier) {
        XM_RT.tier = tier;
        const q = XM.QUALITY[tier];
        XM_RT.q = q;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatioMax));
        renderer.setSize(window.innerWidth, window.innerHeight);
        const half = XM_FX.shadowHalf;
        const cam = sun.shadow.camera;
        cam.left = -half;
        cam.right = half;
        cam.top = half;
        cam.bottom = -half;
        cam.near = 1;
        cam.far = 1200;
        cam.updateProjectionMatrix();
        sun.shadow.bias = -0.0005;
        sun.shadow.normalBias = 0.04;
        if (sun.shadow.mapSize.x !== q.shadow) {
            sun.shadow.mapSize.set(q.shadow, q.shadow);
            if (sun.shadow.map) {
                sun.shadow.map.dispose();
                sun.shadow.map = null;
            }
        }
        if (q.atmosphere && !XM_RT.failed) {
            xmEnableAtmosphere();
        } else {
            xmDisableAtmosphere();
        }
        xmRebuildPost();
        if (q.post && !XM_RT.postModules) {
            xmLoadPost();
        }
    }
    function xmRollback() {
        XM_RT.failed = true;
        try {
            if (XM_RT.terrainPatch) {
                XM_RT.terrainPatch.revert();
                XM_RT.terrainPatch = null;
            }
            xmDisableAtmosphere();
            if (XM_RT.post) {
                XM_RT.post.dispose();
                XM_RT.post = null;
            }
            XM_RT.tier = "low";
            XM_RT.q = XM.QUALITY.low;
        } catch (error) {
            console.error("光影回退时出错：", error);
        }
    }
    function xmSetupFX() {
        XM_RT.normals = XM.makeNormalTextureFactory(THREE);
        let tier = "high";
        let locked = false;
        const wanted = XM_QS && XM_QS.get("quality");
        if (wanted && XM.TIERS.includes(wanted)) {
            tier = wanted;
            locked = true;
        } else if (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0 && Math.min(window.innerWidth, window.innerHeight) < 900) {
            tier = "medium";
        }
        XM_RT.governor = new XM.QualityGovernor(tier, { locked });
        XM_RT.mode = locked ? XM.TIERS.indexOf(tier) : 3;
        XM_RT.tier = tier;
        XM_RT.q = XM.QUALITY[tier];
        if (!XM_FX.enabled) {
            return;
        }
        try {
            renderer.debug.onShaderError = () => {
                console.error("着色器编译失败，已回退到内置画面");
                xmRollback();
            };
            window.addEventListener("resize", () => {
                if (XM_RT.post) {
                    XM_RT.post.setSize(window.innerWidth, window.innerHeight);
                }
            });
            scene.add(sun.target);
            xmApplyTier(tier);
        } catch (error) {
            console.error("光影系统初始化失败，已回退旧画面：", error);
            xmRollback();
        }
    }
    function xmApplyAtmosphere(delta) {
        const st = XM.atmosphereAt(dayTime);
        XM_RT.state = st;
        const L = st.lightDir;
        sun.color.setRGB(st.lightColor[0], st.lightColor[1], st.lightColor[2]);
        sun.intensity = st.lightIntensity;
        ambientLight.color.setRGB(st.hemiSky[0], st.hemiSky[1], st.hemiSky[2]);
        ambientLight.groundColor.setRGB(st.hemiGround[0], st.hemiGround[1], st.hemiGround[2]);
        ambientLight.intensity = st.hemiIntensity;
        scene.background.setRGB(st.fogColor[0], st.fogColor[1], st.fogColor[2]);
        scene.fog.color.setRGB(st.fogColor[0], st.fogColor[1], st.fogColor[2]);
        const focus = playerGroup.position;
        const texel = (2 * XM_FX.shadowHalf) / sun.shadow.mapSize.x;
        const t = XM.snapToTexel([focus.x, focus.y, focus.z], L, texel);
        sun.target.position.set(t[0], t[1], t[2]);
        sun.position.set(t[0] + L[0] * 500, t[1] + L[1] * 500, t[2] + L[2] * 500);
        sun.target.updateMatrixWorld();
        XM_RT.fog.set({
            heightFalloff: XM_FX.fogHeightFalloff,
            baseHeight: XM_FX.fogBase,
            warmAmt: st.warmAmt,
            warmPow: XM_FX.fogWarmPow,
            sunDir: st.sunDir,
            warm: st.warmColor
        });
        XM_RT.sky.set(st);
        XM_RT.sky.mesh.position.copy(camera.position);
        renderer.toneMappingExposure = XM_FX.exposure * st.exposure;
        if (XM_RT.post && XM_RT.post.bloom) {
            XM_RT.post.bloom.strength = st.bloom * XM_FX.bloomScale;
        }
        if (XM_RT.env) {
            XM_RT.envT -= delta;
            if (XM_RT.envT <= 0 || !XM_RT.applied) {
                XM_RT.envT = XM_FX.envInterval;
                XM_RT.env.refresh();
            }
        }
        XM_RT.applied = true;
    }
    function updateDayNight(delta) {
        if (!XM_FX.enabled || !XM_RT.atmosphereOn || XM_RT.failed) {
            updateDayNightLegacy(delta);
            return;
        }
        dayTime += delta * 0.002;
        try {
            xmApplyAtmosphere(delta);
        } catch (error) {
            console.error("昼夜光影更新失败，已回退旧逻辑：", error);
            xmRollback();
        }
    }
    function xmRender() {
        if (!XM_FX.enabled) {
            renderer.render(scene, camera);
            return;
        }
        const now = performance.now();
        if (XM_RT.lastT && XM_RT.governor) {
            const next = XM_RT.governor.update(now - XM_RT.lastT);
            if (next) {
                xmApplyTier(next);
            }
        }
        XM_RT.lastT = now;
        if (XM_RT.atmosphereOn && !XM_RT.applied && !XM_RT.failed) {
            try {
                xmApplyAtmosphere(0);
            } catch (error) {
                console.error("光影首帧应用失败：", error);
                xmRollback();
            }
        }
        if (XM_RT.post && XM_RT.q.post && !XM_RT.failed) {
            try {
                XM_RT.post.render();
                return;
            } catch (error) {
                console.error("后期渲染出错，已关闭后期：", error);
                XM_RT.post = null;
                XM_RT.postFailed = true;
            }
        }
        renderer.render(scene, camera);
    }
    function xmQualityLabel() {
        const order = ["high", "medium", "low", "auto"];
        const labels = { high: "高", medium: "中", low: "低", auto: "自动" };
        const pick = order[XM_RT.mode] || "auto";
        const suffix = pick === "auto" ? "（" + { high: "高", medium: "中", low: "低" }[XM_RT.tier] + "）" : "";
        return "画质：" + labels[pick] + suffix + (XM_RT.failed ? "（内置特效）" : "");
    }
    function xmCycleQuality() {
        const order = ["high", "medium", "low", "auto"];
        XM_RT.mode = (XM_RT.mode + 1) % order.length;
        const pick = order[XM_RT.mode];
        const labels = { high: "高", medium: "中", low: "低", auto: "自动" };
        if (pick === "auto") {
            XM_RT.governor.locked = false;
        } else {
            XM_RT.governor.setTier(pick, true);
            xmApplyTier(pick);
        }
        return "画质：" + labels[pick] + (pick === "auto" ? "（" + { high: "高", medium: "中", low: "低" }[XM_RT.tier] + "）" : "");
    }
