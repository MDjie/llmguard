// Compatibility entry point. Raw candidates are isolated; the master lexicon is never mutated.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
const entry = fileURLToPath(new URL('./toxiccn-import.ts', import.meta.url));
const result = spawnSync(process.execPath, [tsx, entry, ...process.argv.slice(2)], { stdio: 'inherit', shell: false, windowsHide: true });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
