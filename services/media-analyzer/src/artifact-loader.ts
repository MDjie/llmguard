import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { appendFile, mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { DocumentImageRequest, MediaMarkRequest, MediaRequest } from './contracts';

type Artifact = DocumentImageRequest['artifact'] | MediaRequest['artifact'] | MediaMarkRequest['artifact'];

function allowedHosts(): ReadonlySet<string> {
  return new Set((process.env.ANALYZER_OBJECT_STORE_HOSTS ?? '')
    .split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function assertObjectUrl(value: string): URL {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('ANALYZER_OBJECT_URL_REJECTED');
  }
  const allowed = allowedHosts();
  if (allowed.size === 0 || !allowed.has(url.hostname.toLowerCase())) {
    throw new Error('ANALYZER_OBJECT_HOST_REJECTED');
  }
  return url;
}

export async function uploadArtifactFile(
  target: { readonly url: string; readonly headers?: Readonly<Record<string, string>>; readonly mediaType: string; readonly maxBytes: number },
  filePath: string,
  signal?: AbortSignal,
): Promise<{ readonly sizeBytes: number; readonly sha256: string }> {
  const file = await stat(filePath);
  if (!file.isFile() || file.size <= 0 || file.size > target.maxBytes) {
    throw new Error('ANALYZER_MARKED_OUTPUT_SIZE_INVALID');
  }
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  const url = assertObjectUrl(target.url);
  await new Promise<void>((resolveUpload, rejectUpload) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'PUT',
      signal,
      headers: {
        ...target.headers,
        'content-type': target.mediaType,
        'content-length': String(file.size),
      },
      timeout: 60_000,
    }, (response) => {
      response.resume();
      response.once('end', () => {
        if ((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300) {
          resolveUpload();
        } else {
          rejectUpload(new Error('ANALYZER_MARKED_OUTPUT_UPLOAD_FAILED'));
        }
      });
    });
    request.once('timeout', () => request.destroy(new Error('ANALYZER_MARKED_OUTPUT_UPLOAD_TIMEOUT')));
    request.once('error', () => rejectUpload(new Error('ANALYZER_MARKED_OUTPUT_UPLOAD_FAILED')));
    createReadStream(filePath).once('error', () => {
      request.destroy(new Error('ANALYZER_MARKED_OUTPUT_READ_FAILED'));
    }).pipe(request);
  });
  return { sizeBytes: file.size, sha256: digest.digest('hex') };
}

export async function withLoadedArtifact<T>(
  artifact: Artifact,
  operation: (inputPath: string, workspace: string) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const workspace = await import('node:fs/promises').then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), 'guard-analyzer-')));
  const verifiedWorkspace = resolve(workspace);
  const inputPath = join(verifiedWorkspace, 'input.bin');
  try {
    await mkdir(verifiedWorkspace, { recursive: true });
    const aggregate = createHash('sha256');
    let aggregateSize = 0;
    const ordered = [...artifact.parts].sort((left, right) => left.partNumber - right.partNumber);
    if (ordered.some((part, index) => part.partNumber !== index + 1)) {
      throw new Error('ANALYZER_PART_MANIFEST_INVALID');
    }
    for (const part of ordered) {
      if (signal?.aborted) throw new Error('ANALYZER_REQUEST_CANCELLED');
      const response = await fetch(assertObjectUrl(part.url), {
        headers: part.headers,
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
          : AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error('ANALYZER_PART_DOWNLOAD_FAILED');
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared !== part.sizeBytes) {
        throw new Error('ANALYZER_PART_SIZE_MISMATCH');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('ANALYZER_PART_DOWNLOAD_FAILED');
      const chunks: Buffer[] = []; let received = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          received += value.byteLength;
          if (received > part.sizeBytes) { await reader.cancel(); throw new Error('ANALYZER_PART_SIZE_MISMATCH'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== part.sizeBytes ||
          createHash('sha256').update(bytes).digest('hex') !== part.sha256) {
        throw new Error('ANALYZER_PART_HASH_MISMATCH');
      }
      aggregate.update(bytes);
      aggregateSize += bytes.length;
      await appendFile(inputPath, bytes, { flag: 'a', mode: 0o600 });
      bytes.fill(0);
    }
    if (aggregateSize !== artifact.sizeBytes ||
        aggregate.digest('hex') !== artifact.sha256) {
      throw new Error('ANALYZER_ARTIFACT_HASH_MISMATCH');
    }
    return await operation(inputPath, verifiedWorkspace);
  } finally {
    if (!verifiedWorkspace.startsWith(resolve(tmpdir()) + '\\') &&
        !verifiedWorkspace.startsWith(resolve(tmpdir()) + '/')) {
      throw new Error('ANALYZER_WORKSPACE_ESCAPE');
    }
    await rm(verifiedWorkspace, { recursive: true, force: true });
  }
}
