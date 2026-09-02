import { describe, expect, it } from 'vitest';
import {
  createChunks,
  getFileCategory,
  isSupported,
  locateEvidenceInDocument,
  needsOcr,
  parseDocument,
} from '../../src/lib/document/parser';
import {
  highlightEvidenceInHtml,
  sanitizeHighlightedHtml,
} from '../../src/lib/document/highlighter';

describe('document parsing and evidence location', () => {
  it('classifies file types case-insensitively', () => {
    expect(needsOcr('PNG')).toBe(true);
    expect(needsOcr('pdf')).toBe(false);
    expect(isSupported('DOCX')).toBe(true);
    expect(isSupported('exe')).toBe(false);
    expect(getFileCategory('md')).toBe('text');
    expect(getFileCategory('PDF')).toBe('document');
    expect(getFileCategory('jpeg')).toBe('image');
    expect(getFileCategory('bin')).toBe('unknown');
  });

  it('parses text safely with line and block offsets', async () => {
    const text = 'first <script>\nsecond secret\n\nthird';
    const parsed = await parseDocument(Buffer.from(text), 'txt');

    expect(parsed.extractedText).toBe(text);
    expect(parsed.previewHtml).toContain('&lt;script&gt;');
    expect(parsed.previewHtml).not.toContain('<script>');
    expect(parsed.plainLines).toHaveLength(4);
    expect(parsed.plainLines[1]).toMatchObject({
      lineNumber: 2,
      text: 'second secret',
      startOffset: 15,
      endOffset: 28,
    });
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.metadata).toMatchObject({ fileType: 'txt', lineCount: 4, hasTables: false });
  });

  it('creates bounded chunks and preserves global evidence offsets', async () => {
    const text = 'first line\nsecond secret line\n\nthird paragraph is deliberately longer.';
    const parsed = await parseDocument(Buffer.from(text), 'txt');
    const chunks = createChunks(text, { maxChunkSize: 32, overlapSize: 0 });
    const evidenceChunk = chunks.find((chunk) => chunk.content.includes('secret'));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, index) => index));
    expect(evidenceChunk).toBeDefined();

    const location = locateEvidenceInDocument({
      evidence: 'secret',
      chunk: evidenceChunk!,
      plainLines: parsed.plainLines,
    });
    expect(location).toEqual({
      lineNumber: 2,
      startOffset: text.indexOf('secret'),
      endOffset: text.indexOf('secret') + 'secret'.length,
      located: true,
    });
  });

  it('reports empty or absent evidence as not located', () => {
    const chunk = {
      index: 0,
      content: 'visible text',
      startLine: 1,
      endLine: 1,
      startOffset: 0,
      endOffset: 12,
    };

    expect(locateEvidenceInDocument({ evidence: '', chunk, plainLines: [] }).located).toBe(false);
    expect(locateEvidenceInDocument({ evidence: 'missing', chunk, plainLines: [] }).located).toBe(false);
  });

  it('uses exact source slices for hard boundaries and overlap', () => {
    const text = '0123456789abcdefghij';
    const chunks = createChunks(text, { maxChunkSize: 10, overlapSize: 2 });

    expect(chunks.map(({ content, startOffset, endOffset }) => ({
      content,
      startOffset,
      endOffset,
    }))).toEqual([
      { content: '0123456789', startOffset: 0, endOffset: 10 },
      { content: '89abcdefgh', startOffset: 8, endOffset: 18 },
      { content: 'ghij', startOffset: 16, endOffset: 20 },
    ]);
    for (const chunk of chunks) {
      expect(chunk.content).toBe(text.slice(chunk.startOffset, chunk.endOffset));
    }
  });

  it('rejects chunk settings that cannot make forward progress', () => {
    expect(() => createChunks('text', { maxChunkSize: 0 })).toThrow(RangeError);
    expect(() => createChunks('text', { maxChunkSize: 10, overlapSize: 10 })).toThrow(RangeError);
    expect(() => createChunks('text', { maxChunkSize: 10, overlapSize: -1 })).toThrow(RangeError);
  });

  it('renders markdown formatting without executing embedded HTML', async () => {
    const parsed = await parseDocument(Buffer.from('# Title\n**bold** <script>alert(1)</script>'), 'md');

    expect(parsed.previewHtml).toContain('<h1>Title</h1>');
    expect(parsed.previewHtml).toContain('<strong>bold</strong>');
    expect(parsed.previewHtml).toContain('&lt;script&gt;');
  });
});

describe('document evidence highlighting', () => {
  it('highlights text nodes with masked evidence and tracks missing findings', () => {
    const result = highlightEvidenceInHtml({
      previewHtml: '<p>Account alice@example.com is exposed.</p>',
      findings: [
        {
          id: 'finding-email',
          evidence: ['alice@example.com'],
          maskedEvidence: ['a***@example.com'],
          severity: 'high',
          locationStatus: 'located',
        },
        {
          id: 'finding-missing',
          evidence: ['not present'],
          maskedEvidence: ['not present'],
          severity: 'low',
          locationStatus: 'not_found',
        },
      ],
    });

    expect(result.highlightCount).toBe(1);
    expect(result.notFoundFindings).toEqual(['finding-missing']);
    expect(result.highlightedHtml).toContain('doc-risk-high');
    expect(result.highlightedHtml).toContain('data-finding-id="finding-email"');
    expect(result.highlightedHtml).toContain('a***@example.com');
    expect(result.highlightedHtml).not.toContain('alice@example.com');
  });

  it('sanitizes active content while preserving approved highlight attributes', () => {
    const sanitized = sanitizeHighlightedHtml(
      '<script>alert(1)</script><mark class="doc-risk-high" data-finding-id="f1" onclick="alert(2)">safe</mark><a href="javascript:alert(3)">link</a>',
    );

    expect(sanitized).not.toContain('<script');
    expect(sanitized).not.toContain('onclick');
    expect(sanitized).not.toContain('javascript:');
    expect(sanitized).toContain('class="doc-risk-high"');
    expect(sanitized).toContain('data-finding-id="f1"');
  });
});
