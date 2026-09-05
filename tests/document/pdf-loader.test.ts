import { afterEach, describe, expect, it, vi } from 'vitest';

const pdfState = vi.hoisted(() => ({
  constructed: 0,
  getTextCalls: 0,
  destroyCalls: 0,
}));

vi.mock('pdf-parse', () => ({
  PDFParse: class MockPdfParse {
    constructor(_options: unknown) {
      pdfState.constructed += 1;
    }

    async getText(): Promise<{ text: string }> {
      pdfState.getTextCalls += 1;
      return { text: 'Synthetic PDF line' };
    }

    async destroy(): Promise<void> {
      pdfState.destroyCalls += 1;
    }
  },
}));

import { getFileCategory, parseDocument } from '../../src/lib/document/parser';

afterEach(() => {
  pdfState.constructed = 0;
  pdfState.getTextCalls = 0;
  pdfState.destroyCalls = 0;
});

describe('PDF parser lazy runtime boundary', () => {
  it('does not initialize the PDF runtime for non-PDF route operations', () => {
    expect(getFileCategory('docx')).toBe('document');
    expect(pdfState).toEqual({ constructed: 0, getTextCalls: 0, destroyCalls: 0 });
  });

  it('uses the pdf-parse v2 API on demand and always releases the parser', async () => {
    const parsed = await parseDocument(Buffer.from('%PDF-1.7 synthetic'), 'pdf');

    expect(parsed.extractedText).toBe('Synthetic PDF line');
    expect(parsed.metadata).toMatchObject({ fileType: 'pdf', lineCount: 1 });
    expect(pdfState).toEqual({ constructed: 1, getTextCalls: 1, destroyCalls: 1 });
  });
});
