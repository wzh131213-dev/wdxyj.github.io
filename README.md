# 重走西游 · 建模/动态/光影模块（第二轮）

| 文件 | 作用 |
|---|---|
| `xiyou-core.js / -world.js / -character.js` | 噪声与几何、地形/山/岩石、4 个角色（43 骨）与 PBR 分层烘焙 |
| `xiyou-motion.js` | 呼吸·微动·眨眼、白龙马步态、鞍座阻尼跟随、风场、Verlet(PBD) 布料发丝 |
| `xiyou-fx.js` | 昼夜调色板、高度雾/天空/PMREM/地形混合/后期管线、画质自适应、阴影对齐、法线贴图生成 |
| `xiyou-three.js` | 纯数据 → THREE（PBR 材质工厂、蒙皮角色、布料装配） |
| `build/glue.js` + `build/integrate.py` | 接入层 + 打包脚本：`python3 build/integrate.py 原游戏.html index.html` |
| `xiyou*.test.mjs`、`test_all.mjs` | 单元测试（`node test_all.mjs`，84 项） |
| `game_smoke.mjs` | 整局冒烟：`node game_smoke.mjs index.html`（`SABOTAGE=fx|post|cloth|idle|atmos|ride|figure|ground|terrain|rock|all|everything` 做故障注入） |

## 画质与开关
- 右上 `⚙ 设置` 循环：高 → 中 → 低 → 自动；网址 `?quality=high|medium|low` 可锁定。低档 = 接近原画面（无后期/无布料/1024 阴影）。
- 自动档：帧时间持续偏高会降档，持续宽裕会升档。
- 总开关（游戏脚本里）：`XM_CFG.enabled=false` 回到旧地形/旧人物；`XM_FX.enabled=false` 回到旧光影/旧动画/无后期。
- 单项：`XM_FX.physics / idle / rideDynamics / pbr`。
- 调参（都在 `XM_FX`）：`exposure`(1.2) `bloomScale/bloomRadius/bloomThreshold`(0.9/0.55/2.2) `fogDensity`(0.00058) `fogHeightFalloff`(0.0035) `windStrength`(6) `shadowHalf`(120)。
- 任何一步出错（着色器编译失败、后期加载失败、模型生成失败…）都会回退到旧实现并在控制台输出原因。
