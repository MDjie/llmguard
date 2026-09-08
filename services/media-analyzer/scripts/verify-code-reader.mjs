/** Build-time runtime check: zbar must decode PNG, not merely exist on PATH. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspace = mkdtempSync(join(tmpdir(), 'analyzer-code-reader-'));
try {
  const image = join(workspace, 'blank.png');
  const generated = spawnSync('ffmpeg', [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
    'color=c=white:s=160x100', '-frames:v', '1', '-y', image,
  ], { timeout: 30_000, maxBuffer: 1_048_576 });
  if (generated.error || generated.status !== 0) throw new Error('CODE_READER_FIXTURE_FAILED');
  const decoded = spawnSync('zbarimg', ['--quiet', '--xml', image], {
    timeout: 30_000, maxBuffer: 1_048_576, encoding: 'utf8',
  });
  if (decoded.error || decoded.status !== 4 || !decoded.stdout.includes('</barcodes>')) {
    throw new Error('CODE_READER_PNG_DECODE_UNAVAILABLE');
  }
  console.log('CODE_READER_PNG_DECODE_OK');
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
