// marked-faster driver.
//
// The grading harness runs `node main.ts` with the case set at
// /input/cases.json (a JSON array of { id, markdown }). Every case is
// rendered on its own through parse() from ./parse.js and the resulting
// HTML strings are written, in the same order, to /output/html.json.
// When run outside the harness container the MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR environment variables can point at local folders.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as { id: string; markdown: string }[];

const rendered: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  rendered[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
