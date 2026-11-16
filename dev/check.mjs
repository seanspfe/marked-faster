// Dev harness: run the practice set through an entry's parse() and compare
// byte for byte with the expected HTML. Usage:
//   node dev/check.mjs [path-to-parse.js] [--time] [--limit N]
// Defaults to ../parse.js relative to this file.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const kit = resolve(here, '..', '..', 'markdown-render-speed-02-kit');

const args = process.argv.slice(2);
const timing = args.includes('--time');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
const limitVal = limitIdx >= 0 ? args[limitIdx + 1] : null;
const parsePath = args.find(a => !a.startsWith('--') && a !== limitVal) ?? join(here, '..', 'parse.js');

const { parse } = await import(pathToFileURL(resolve(parsePath)).href);
const cases = JSON.parse(readFileSync(join(kit, 'practice', 'input', 'cases.json'), 'utf8'));
const expectedDoc = JSON.parse(readFileSync(join(kit, 'practice', 'reference', 'expected.json'), 'utf8'));
const expectedById = new Map(expectedDoc.cases.map(c => [c.id, c.html]));
const expected = cases.map(c => expectedById.get(c.id));

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function showDiff(id, exp, act) {
  const i = firstDiff(exp, act);
  console.log(`--- FAIL ${id} (diff at ${i})`);
  console.log('  input:    ' + JSON.stringify(cases.find(c => c.id === id)?.markdown ?? '').slice(0, 300));
  console.log('  expected: ' + JSON.stringify(exp.slice(Math.max(0, i - 60), i + 120)));
  console.log('  actual:   ' + JSON.stringify(act.slice(Math.max(0, i - 60), i + 120)));
}

const t0 = performance.now();
let pass = 0;
const failures = [];
const n = Math.min(cases.length, limit);
for (let i = 0; i < n; i++) {
  let got;
  try {
    got = parse(cases[i].markdown);
  } catch (err) {
    got = '<<THREW: ' + err.message + '>>';
  }
  if (got === expected[i]) pass++;
  else failures.push([cases[i].id, expected[i], got]);
}
const dt = performance.now() - t0;
console.log(`pass ${pass}/${n} in ${dt.toFixed(1)}ms`);
for (const [id, e, a] of failures.slice(0, 15)) showDiff(id, e, a);
if (timing) {
  const t1 = performance.now();
  for (let i = 0; i < n; i++) parse(cases[i].markdown);
  console.log(`timing run: ${(performance.now() - t1).toFixed(1)}ms for ${n} cases`);
}
