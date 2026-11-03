#!/usr/bin/env python3
"""integrate.py — 把 xiyou-*.js 六个模块打成一个 XM 包，并接入原游戏单文件 HTML。

用法：python3 integrate.py <原游戏.html> <输出.html> [--script-out 路径.mjs]
做的事：
  1. 打包：按依赖顺序合并 core / world / character / motion / fx / three，去掉模块间的 import/export，
     检查顶层名字无冲突，导出对象 XM（glue 里用到的 XM.xxx 必须都存在）。
  2. 在原脚本 import THREE 之后插入 glue.js（接入层）。
  3. 原代码最少改动（每处锚点必须恰好命中一次，否则报错退出）。
  4. <script type="module"> 前插入 importmap，让动态加载的 three/examples 后期模块能解析 'three'。
"""
import re, sys, pathlib

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
MODS = ['xiyou-core.js', 'xiyou-world.js', 'xiyou-character.js', 'xiyou-motion.js', 'xiyou-fx.js', 'xiyou-three.js']
THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js'
EXAMPLES_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/'


def bundle():
    parts, exported, declared = [], [], {}
    for name in MODS:
        src = (ROOT / name).read_text(encoding='utf-8')
        # 1) 去掉 import（可多行）；模块间只允许具名导入
        def drop_import(m):
            if '* as' in m.group(0):
                raise SystemExit(f'{name}: 不支持 import * as（{m.group(0)[:60]}）')
            return ''
        src = re.sub(r"^import\s+[^;]*?from\s+'[^']+';\s*\n", drop_import, src, flags=re.M | re.S)
        # 2) export 列表与 export 声明
        for m in re.finditer(r"^export\s*\{([^}]*)\};?\s*$", src, flags=re.M):
            for item in m.group(1).split(','):
                item = item.strip()
                if not item:
                    continue
                if ' as ' in item:
                    raise SystemExit(f'{name}: 不支持 export {{ a as b }}')
                exported.append(item)
        src = re.sub(r"^export\s*\{[^}]*\};?\s*$", '', src, flags=re.M)
        for m in re.finditer(r"^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)", src, flags=re.M):
            exported.append(m.group(1))
        src = re.sub(r"^export\s+(?=(?:async\s+)?(?:function|const|let|class)\b)", '', src, flags=re.M)
        if re.search(r"^export\s+default", src, flags=re.M):
            raise SystemExit(f'{name}: 不支持 export default')
        # 3) 顶层名字冲突检查
        for m in re.finditer(r"^(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)", src, flags=re.M):
            n = m.group(1)
            if n in declared:
                raise SystemExit(f'顶层名字冲突：{n}（{declared[n]} 与 {name}）')
            declared[n] = name
        parts.append(f'// ───── {name} ─────\n{src.strip()}\n')
    missing = [n for n in exported if n not in declared]
    if missing:
        raise SystemExit(f'导出了未声明的名字：{missing}')
    uniq = list(dict.fromkeys(exported))
    body = '\n'.join(parts)
    return '(function () {\n' + body + '\nreturn { ' + ', '.join(uniq) + ' };\n})()', set(uniq)


def replace_once(code, old, new, label):
    n = code.count(old)
    if n != 1:
        raise SystemExit(f'锚点 [{label}] 命中 {n} 次（应为 1）：{old[:70]!r}')
    return code.replace(old, new)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    src_html, out_html = args[0], args[1]
    script_out = None
    if '--script-out' in sys.argv:
        script_out = sys.argv[sys.argv.index('--script-out') + 1]
    html = pathlib.Path(src_html).read_text(encoding='utf-8')
    tag = '<script type="module">'
    a = html.index(tag) + len(tag)
    b = html.rindex('</script>')
    code = html[a:b]

    xm, names = bundle()
    glue = (HERE / 'glue.js').read_text(encoding='utf-8')
    used = set(re.findall(r'\bXM\.([A-Za-z_$][\w$]*)', glue))
    absent = sorted(used - names)
    if absent:
        raise SystemExit(f'glue 用到了 XM 里不存在的导出：{absent}')
    glue = glue.replace('__XM_BUNDLE__', xm)

    # ── 1) 旧实现改名（新实现在 glue 里同名接管，出错时回退调用 *Legacy）
    for old, new in [
        ('    function terrainHeight(x, z) {', '    function terrainHeightLegacy(x, z) {'),
        ('    function createTerrain() {', '    function createTerrainLegacy() {'),
        ('    function terrainSurfaceHeight(x, z) {', '    function terrainSurfaceHeightLegacy(x, z) {'),
        ('    function createRock(x, z, scale = 1) {', '    function createRockLegacy(x, z, scale = 1) {'),
        ('    function createCharacterFigure(character, scale = 1) {', '    function createCharacterFigureLegacy(character, scale = 1) {'),
        ('    function updateDayNight(delta) {', '    function updateDayNightLegacy(delta) {'),
        ('    function animatePlayerModel(delta, moving) {', '    function animatePlayerModelLegacy(delta, moving) {'),
    ]:
        code = replace_once(code, old, new, new.strip()[:40])

    # ── 2) 骑手：按新模型的座高落座
    code = replace_once(code, '        }, 0.92);\n        rider.position.set(0, 1.62, 0);',
                        '        }, 0.92, { ride: true });\n        rider.position.set(0, rider.userData.rideY !== undefined ? rider.userData.rideY : 1.62, 0);', 'setPlayerRider')
    # ── 3) 每局世界生成前重建地形栅格（种子相同则地形相同）
    code = replace_once(code, '        rngState = rngSeed;\n', '        rngState = rngSeed;\n        rebuildGround(rngSeed);\n', 'rebuildGround')
    # ── 4) 白龙马：髋/膝两段腿（出错或关闭时 xmBuildHorseLeg 内部回退成旧的单根圆柱）
    old_legs = ('''        for (const side of [-1, 1]) {
            for (const front of [-1, 1]) {
                const leg = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.10, 0.14, 1.35, 5),
                    legMaterial
                );
                leg.position.set(front * 0.55, 0.78, side * 0.42);
                leg.castShadow = true;
                mount.add(leg);
                mount.userData.legs.push(leg);
            }
        }
''')
    new_legs = ('''        for (const side of [-1, 1]) {
            for (const front of [-1, 1]) {
                mount.add(xmBuildHorseLeg(mount, front, side, legMaterial));
            }
        }
''')
    code = replace_once(code, old_legs, new_legs, 'horseLegs')
    # ── 5) 光影初始化（场景与灯光创建之后立刻）
    code = replace_once(code, '    scene.add(worldGroup);\n', '    scene.add(worldGroup);\n    xmSetupFX();\n', 'xmSetupFX')
    # ── 6) 渲染入口：后期管线 / 直渲 二选一
    code = replace_once(code, '            updateOpening(delta);\n            renderer.render(scene, camera);', '            updateOpening(delta);\n            xmRender();', 'renderOpening')
    code = replace_once(code, '        renderer.render(\n            scene,\n            camera\n        );', '        xmRender();', 'renderMain')
    # ── 7) 每帧：待机/布料/发丝更新（在同伴移动之后）
    code = replace_once(code, '        updateCompanions(delta);\n        updateOtherParties(delta);', '        updateCompanions(delta);\n        xmUpdateFigures(delta);\n        updateOtherParties(delta);', 'xmUpdateFigures')
    # ── 8) 重建队伍时释放旧模型
    code = replace_once(code, '            npcGroup.remove(npcGroup.children[i]);', '            xmDisposeFigure(npcGroup.children[i]);\n            npcGroup.remove(npcGroup.children[i]);', 'disposeFigures')
    # ── 9) 设置按钮 = 画质切换
    code = replace_once(code, '        b.textContent = "设置（敬请期待）";', '        b.textContent = xmCycleQuality();', 'settingsButton')
    # ── 10) 自发光提亮（让灯笼/灵气资源/路标在泛光里发亮；泛光关闭时 xmGlow 原样返回）
    code = replace_once(code, 'emissive: 0xff5a1a, emissiveIntensity: 0.8 })', 'emissive: 0xff5a1a, emissiveIntensity: xmGlow(0.8, 6) })', 'lampGlow')
    code = replace_once(code, 'emissiveIntensity: type === "spirit" ? 0.25 : 0.04', 'emissiveIntensity: xmGlow(type === "spirit" ? 0.25 : 0.04, 14)', 'resourceGlow')
    code = replace_once(code, '                emissiveIntensity: 0.8\n', '                emissiveIntensity: xmGlow(0.8, 6)\n', 'markerGlow')

    # ── 插入接入层（紧跟 import THREE）
    imp = f'    import * as THREE from "{THREE_URL}";\n'
    code = replace_once(code, imp, imp + '\n' + glue, 'glue')

    importmap = ('<script type="importmap">\n{\n    "imports": {\n        "three": "%s",\n        "three/addons/": "%s"\n    }\n}\n</script>\n\n' % (THREE_URL, EXAMPLES_URL))
    out = html[:html.index(tag)] + importmap + tag + code + html[b:]
    pathlib.Path(out_html).write_text(out, encoding='utf-8')
    if script_out:
        pathlib.Path(script_out).write_text(code, encoding='utf-8')
    print(f'OK  XM 包 {len(xm)//1024} KB，glue {len(glue)//1024} KB，输出 {len(out)//1024} KB；导出 {len(names)} 个名字，锚点全部命中')


if __name__ == '__main__':
    main()
