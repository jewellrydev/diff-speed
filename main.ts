// Driver for the diff-speed entry: reads every case from
// <MAKEFUN_INPUT_DIR ?? /input>/cases.json, answers each with solve.js's
// run(), and writes the answers as one JSON array to
// <MAKEFUN_OUTPUT_DIR ?? /output>/answers.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// The house baseline runs with V8's incremental marking off; do the same so
// garbage collection stays out of the timed work as much as it can.
setFlagsFromString('--no-incremental-marking');

const { run } = await import('./solve.js');

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const answers = cases.map((c: { input: { old: string; new: string } }) => run(c.input));
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
