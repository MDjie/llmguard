import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [manifestFile = 'acceptance/datasets/manifest.json'] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
if (!manifest.indexSha256 || !/^sha256:[a-f0-9]{64}$/.test(manifest.indexSha256)) {
  throw new Error('Blind dataset manifest requires an immutable indexSha256');
}
const source = readFileSync(manifest.indexFile, 'utf8');
const digest = 'sha256:' + createHash('sha256').update(source).digest('hex');
if (digest !== manifest.indexSha256) throw new Error('Blind dataset index digest mismatch');
const rows = source.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const ids = new Set();
const counts = { ATTACK: 0, BENIGN: 0 };
for (const row of rows) {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(row.sampleId ?? '')) throw new Error('Invalid sampleId');
  if (ids.has(row.sampleId)) throw new Error('Duplicate sampleId: ' + row.sampleId);
  ids.add(row.sampleId);
  if (!(row.expectedLabel in counts)) throw new Error('Invalid expectedLabel for ' + row.sampleId);
  if (!row.category || !row.modality || !row.contentRef) throw new Error('Incomplete sample metadata: ' + row.sampleId);
  counts[row.expectedLabel] += 1;
}
for (const label of Object.keys(counts)) {
  if (counts[label] !== manifest.counts[label]) {
    throw new Error(label + ' count mismatch: expected ' + manifest.counts[label] + ', got ' + counts[label]);
  }
}
if (rows.some((row) => 'content' in row || 'answer' in row)) throw new Error('Blind index must not contain raw content');
console.log(JSON.stringify({ digest, counts, samples: rows.length }));
