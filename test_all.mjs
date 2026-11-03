// 一键跑全部单元测试：node test_all.mjs
import { spawnSync } from 'node:child_process';
let ok = true;
for (const f of ['xiyou.test.mjs', 'xiyou.motion.test.mjs', 'xiyou.fx.test.mjs']) {
  const r = spawnSync('node', [f], { encoding: 'utf8' }), last = r.stdout.trim().split('\n').filter((l) => /通过 \d+ \/ \d+/.test(l)).pop() ?? r.stderr.slice(0, 200);
  console.log(`${f.padEnd(24)} ${last}`); ok = ok && r.status === 0;
}
process.exitCode = ok ? 0 : 1;
