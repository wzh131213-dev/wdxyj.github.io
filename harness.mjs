// 极简测试助手（零依赖）：test / section / near / done
import assert from 'node:assert/strict';
let pass = 0, fail = 0; const fails = [];
export const section = (t) => console.log(`\n■ ${t}`);
export function test(name, fn) {
  const t = performance.now();
  try { const note = fn(); pass++; console.log(`  ✓ ${name}${note ? '  — ' + note : ''}  (${(performance.now() - t).toFixed(0)} ms)`); }
  catch (e) { fail++; fails.push(name); console.log(`  ✗ ${name}\n      ${String(e.message).split('\n')[0]}`); }
}
export const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} ≉ ${b} (±${tol})`);
export function done(label = '') { console.log(`\n${fail ? '✗' : '✓'} ${label}通过 ${pass} / ${pass + fail}${fail ? `；失败：${fails.join(' | ')}` : ''}`); process.exitCode = fail ? 1 : 0; }
