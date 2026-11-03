    /*
        ============================================================
        新建模层（重走西游 · 环境与人物建模）
        ------------------------------------------------------------
        XM = xiyou-core / xiyou-character / xiyou-world / xiyou-three 四个模块打成的一个包（依据 BIBLE 规范）。
        接入原则：
        1. 旧实现全部保留，改名为 *Legacy；新模型任何一步出错都会回退到旧实现，游戏不会因此打不开。
        2. 随机数消耗次数与顺序保持不变，所以同一世界种子 / 旧存档生成的世界布局（道路、建筑、树石位置）不变。
        3. terrainHeight / terrainSurfaceHeight 与渲染网格严格同一张高度栅格，玩法高度与看到的地面一致。
        整体关闭：把 XM_CFG.enabled 改成 false，即回到旧地形与旧人物。
        ============================================================
    */
    const XM = __XM_BUNDLE__;
    const XM_CFG = {
        enabled: true,
        cell: 5,
        outer: 1500,
        unit: 1.5,
        colorScale: 1.5,
        saddleTop: 2.205,
        anchorY: 0.38,
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
    const XM_STATE = { ground: null, grid: null, rockProtos: null, rocksFailed: false, baked: new Map() };
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
                const data = XM.buildTerrain(XM_STATE.ground, {
                    axis: XM_STATE.grid.axis,
                    heights: XM_STATE.grid.heights,
                    gridNormals: true,
                    cavity: false
                });
                const terrain = XM.createTerrainMesh(THREE, data, {
                    material: new THREE.MeshStandardMaterial({
                        vertexColors: true,
                        roughness: 1
                    })
                });
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
    function getBakedFigure(kind, ride) {
        const key = kind + (ride ? ":ride" : ":stand");
        let baked = XM_STATE.baked.get(key);
        if (!baked) {
            let data = XM.buildCharacterData({ kind });
            if (ride) {
                data = XM.poseData(data, XM.RIDE_POSE);
            }
            baked = XM.bakeCharacter(data, { colorScale: XM_CFG.colorScale });
            XM_STATE.baked.set(key, baked);
        }
        return baked;
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
                const figure = XM.createStaticCharacter(THREE, baked, { castShadow: true });
                figure.group.scale.setScalar(XM_CFG.unit);
                inner.add(figure.group);
                usedNew = true;
                if (options.ride) {
                    const seat =
                        (baked.layout.hipY - 0.10 * baked.layout.k) * XM_CFG.unit * scale;
                    outer.userData.rideY = XM_CFG.saddleTop - XM_CFG.anchorY - seat;
                }
            } catch (error) {
                console.error("新人物模型生成失败，已回退旧模型：", character.id, error);
            }
        }
        if (!usedNew) {
            inner.add(createCharacterFigureLegacy(character, 1));
        }
        outer.userData.characterId = character.id;
        return outer;
    }
