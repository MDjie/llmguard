/**
 * 文档解析服务
 * 支持 PDF、DOCX、TXT 等格式的解析
 * 同时生成预览 HTML 和用于检测的纯文本
 */

import mammoth from 'mammoth';
import sanitizeHtml from 'sanitize-html';
import { convertOfficeDocument } from './converter';

// 导出类型
export interface PlainLine {
  lineNumber: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface DocumentBlock {
  blockIndex: number;
  type: 'paragraph' | 'heading' | 'table' | 'list' | 'image_ocr';
  text: string;
  html?: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
}

export interface ParsedDocument {
  extractedText: string;       // 用于检测引擎扫描
  previewHtml?: string;        // 用于页面展示，保留格式
  plainLines: PlainLine[];     // 用于行号显示和风险定位
  blocks: DocumentBlock[];     // 用于分片、段落定位
  metadata: {
    charCount: number;
    lineCount: number;
    hasTables: boolean;
    hasImages: boolean;
    fileType: string;
  };
}

export interface DocumentChunk {
  index: number;
  content: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
}

export interface OcrResult {
  pageNumber: number;
  text: string;
}

// 支持的文件类型
export const SUPPORTED_FILE_TYPES = {
  text: ['txt', 'md', 'json', 'csv', 'xml', 'html', 'css', 'js', 'ts'],
  document: ['pdf', 'docx', 'doc', 'wps', 'ofd', 'odt', 'rtf'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
} as const;

export const ALL_SUPPORTED_TYPES = [
  ...SUPPORTED_FILE_TYPES.text,
  ...SUPPORTED_FILE_TYPES.document,
  ...SUPPORTED_FILE_TYPES.image,
];

/**
 * 判断文件类型是否需要 OCR
 */
export function needsOcr(fileType: string): boolean {
  return (SUPPORTED_FILE_TYPES.image as readonly string[]).includes(fileType.toLowerCase());
}

/**
 * 判断文件类型是否支持
 */
export function isSupported(fileType: string): boolean {
  return (ALL_SUPPORTED_TYPES as readonly string[]).includes(fileType.toLowerCase());
}

/**
 * 获取文件类型分类
 */
export function getFileCategory(fileType: string): 'text' | 'document' | 'image' | 'unknown' {
  const type = fileType.toLowerCase();
  if ((SUPPORTED_FILE_TYPES.text as readonly string[]).includes(type)) return 'text';
  if ((SUPPORTED_FILE_TYPES.document as readonly string[]).includes(type)) return 'document';
  if ((SUPPORTED_FILE_TYPES.image as readonly string[]).includes(type)) return 'image';
  return 'unknown';
}

/**
 * 清洗 HTML，防止 XSS，同时保留基本格式
 */
function sanitizePreviewHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'hr',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'ul', 'ol', 'li',
      'strong', 'b', 'em', 'i', 'u', 's',
      'blockquote', 'pre', 'code',
      'a', 'img',
      'div', 'span',
    ],
    allowedAttributes: {
      a: ['href', 'title'],
      img: ['src', 'alt', 'title'],
      table: ['class'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
      div: ['class'],
      span: ['class'],
    },
    allowedSchemes: ['http', 'https', 'data'],
    transformTags: {
      // 确保表格有基本样式
      table: sanitizeHtml.simpleTransform('table', { class: 'doc-table' }),
    },
  });
}

/**
 * 从纯文本构建 plainLines
 */
function buildPlainLines(text: string): PlainLine[] {
  const lines: PlainLine[] = [];
  const textLines = text.split('\n');
  let currentOffset = 0;

  for (let i = 0; i < textLines.length; i++) {
    const lineText = textLines[i];
    lines.push({
      lineNumber: i + 1,
      text: lineText,
      startOffset: currentOffset,
      endOffset: currentOffset + lineText.length,
    });
    currentOffset += lineText.length + 1; // +1 for newline
  }

  return lines;
}

/**
 * 从纯文本构建 blocks（简单实现，按段落分割）
 */
function buildBlocksFromText(text: string): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  const paragraphs = text.split(/\n\n+/);
  let currentOffset = 0;
  const lines = text.split('\n');
  const lineOffsets: number[] = [];
  let offset = 0;

  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }

  const findLineNumber = (searchOffset: number): number => {
    for (let i = lineOffsets.length - 1; i >= 0; i--) {
      if (lineOffsets[i] <= searchOffset) {
        return i + 1;
      }
    }
    return 1;
  };

  paragraphs.forEach((paragraph, index) => {
    if (paragraph.trim()) {
      const startOffset = currentOffset;
      const endOffset = currentOffset + paragraph.length;
      blocks.push({
        blockIndex: index,
        type: 'paragraph',
        text: paragraph,
        startLine: findLineNumber(startOffset),
        endLine: findLineNumber(endOffset),
        startOffset,
        endOffset,
      });
    }
    currentOffset += paragraph.length + 2; // +2 for paragraph break
  });

  return blocks;
}

/**
 * 解析 TXT 文件
 */
async function parseTxt(buffer: Buffer): Promise<ParsedDocument> {
  const text = buffer.toString('utf-8');
  const plainLines = buildPlainLines(text);
  const blocks = buildBlocksFromText(text);

  return {
    extractedText: text,
    previewHtml: `<pre class="txt-preview">${escapeHtml(text)}</pre>`,
    plainLines,
    blocks,
    metadata: {
      charCount: text.length,
      lineCount: plainLines.length,
      hasTables: false,
      hasImages: false,
      fileType: 'txt',
    },
  };
}

/**
 * 解析 Markdown 文件
 */
async function parseMarkdown(buffer: Buffer): Promise<ParsedDocument> {
  const text = buffer.toString('utf-8');
  const plainLines = buildPlainLines(text);
  const blocks = buildBlocksFromText(text);

  // 简单的 Markdown 转 HTML（保留格式）
  const html = escapeHtml(text)
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');

  return {
    extractedText: text,
    previewHtml: `<div class="md-preview">${html}</div>`,
    plainLines,
    blocks,
    metadata: {
      charCount: text.length,
      lineCount: plainLines.length,
      hasTables: false,
      hasImages: false,
      fileType: 'md',
    },
  };
}

/**
 * 解析 DOCX 文件
 */
async function parseDocx(buffer: Buffer): Promise<ParsedDocument> {
  try {
    // 同时获取 HTML 和纯文本
    const [htmlResult, textResult] = await Promise.all([
      mammoth.convertToHtml({ buffer }),
      mammoth.extractRawText({ buffer }),
    ]);

    const extractedText = textResult.value;
    const rawHtml = htmlResult.value;

    // 清洗 HTML
    const previewHtml = sanitizePreviewHtml(rawHtml);

    // 构建定位信息
    const plainLines = buildPlainLines(extractedText);
    const blocks = buildBlocksFromText(extractedText);

    // 检测是否有表格
    const hasTables = rawHtml.includes('<table');

    return {
      extractedText,
      previewHtml,
      plainLines,
      blocks,
      metadata: {
        charCount: extractedText.length,
        lineCount: plainLines.length,
        hasTables,
        hasImages: false,
        fileType: 'docx',
      },
    };
  } catch (error) {
    console.error('DOCX 解析失败:', error);
    throw new Error('DOCX 文件解析失败，请确保文件格式正确');
  }
}

/**
 * 解析 PDF 文件
 */
async function parsePdf(buffer: Buffer): Promise<ParsedDocument> {
  let parser: import('pdf-parse').PDFParse | null = null;
  try {
    // pdfjs resolves its optional native Canvas adapter at runtime. Keeping this
    // import inside the PDF path preserves lazy loading while making standalone
    // dependency tracing create a resolvable top-level package link.
    await import('@napi-rs/canvas');
    const { PDFParse } = await import('pdf-parse');
    parser = new PDFParse({
      data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
    });
    const data = await parser.getText();
    const extractedText = data.text;

    // 构建定位信息
    const plainLines = buildPlainLines(extractedText);
    const blocks = buildBlocksFromText(extractedText);

    // PDF 文本预览
    const previewHtml = `<div class="pdf-preview"><pre>${escapeHtml(extractedText)}</pre></div>`;

    return {
      extractedText,
      previewHtml,
      plainLines,
      blocks,
      metadata: {
        charCount: extractedText.length,
        lineCount: plainLines.length,
        hasTables: false,
        hasImages: false,
        fileType: 'pdf',
      },
    };
  } catch (error) {
    console.error('PDF parsing failed:', error instanceof Error ? error.name : 'UnknownError');
    throw new Error('PDF 文件解析失败，请确保文件格式正确');
  } finally {
    await parser?.destroy().catch(() => undefined);
  }
}

async function parseConvertedDocument(buffer: Buffer, fileType: string): Promise<ParsedDocument> {
  const extractedText = await convertOfficeDocument(buffer, fileType);
  const plainLines = buildPlainLines(extractedText);
  return {
    extractedText,
    previewHtml: `<div class="converted-preview"><pre>${escapeHtml(extractedText)}</pre></div>`,
    plainLines,
    blocks: buildBlocksFromText(extractedText),
    metadata: {
      charCount: extractedText.length,
      lineCount: plainLines.length,
      hasTables: false,
      hasImages: false,
      fileType,
    },
  };
}

/**
 * HTML 转义
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * 根据文件类型解析文档
 */
export async function parseDocument(
  buffer: Buffer,
  fileType: string,
): Promise<ParsedDocument> {
  const type = fileType.toLowerCase();

  switch (type) {
    case 'txt':
    case 'json':
    case 'csv':
    case 'xml':
    case 'html':
    case 'css':
    case 'js':
    case 'ts':
      return parseTxt(buffer);

    case 'md':
      return parseMarkdown(buffer);

    case 'docx':
      return parseDocx(buffer);

    case 'pdf':
      return parsePdf(buffer);
    case 'doc':
    case 'wps':
    case 'ofd':
    case 'odt':
    case 'rtf':
      return parseConvertedDocument(buffer, type);

    default:
      // 尝试作为文本解析
      try {
        return parseTxt(buffer);
      } catch {
        throw new Error(`不支持的文件类型: ${type}`);
      }
  }
}

/**
 * 将文本按段落和长度分片
 */
export function createChunks(
  text: string,
  options: {
    maxChunkSize?: number;
    overlapSize?: number;
  } = {}
): DocumentChunk[] {
  const { maxChunkSize = 1000, overlapSize = 100 } = options;
  const chunks: DocumentChunk[] = [];

  if (maxChunkSize <= 0) {
    throw new RangeError('maxChunkSize must be greater than zero');
  }
  if (overlapSize < 0 || overlapSize >= maxChunkSize) {
    throw new RangeError('overlapSize must be between zero and maxChunkSize');
  }
  if (text.length === 0) return chunks;

  // 计算行号
  const lines = text.split('\n');
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1; // +1 for newline
  }

  // 查找偏移量对应的行号
  const findLineNumber = (searchOffset: number): number => {
    for (let i = lineOffsets.length - 1; i >= 0; i--) {
      if (lineOffsets[i] <= searchOffset) {
        return i + 1;
      }
    }
    return 1;
  };

  let startOffset = 0;
  while (startOffset < text.length) {
    const hardEnd = Math.min(startOffset + maxChunkSize, text.length);
    let endOffset = hardEnd;

    if (hardEnd < text.length) {
      const candidate = text.slice(startOffset, hardEnd);
      const minimumNaturalBoundary = Math.floor(candidate.length / 2);
      const paragraphBoundary = candidate.lastIndexOf('\n\n');

      if (paragraphBoundary >= minimumNaturalBoundary) {
        endOffset = startOffset + paragraphBoundary + 2;
      } else {
        const sentencePattern = /[。！？.!?](?=\s|$)/g;
        let sentenceBoundary = -1;
        for (const match of candidate.matchAll(sentencePattern)) {
          sentenceBoundary = match.index + match[0].length;
        }
        if (sentenceBoundary >= minimumNaturalBoundary) {
          endOffset = startOffset + sentenceBoundary;
        }
      }
    }

    const content = text.slice(startOffset, endOffset);
    chunks.push({
      index: chunks.length,
      content,
      startLine: findLineNumber(startOffset),
      endLine: findLineNumber(Math.max(startOffset, endOffset - 1)),
      startOffset,
      endOffset,
    });

    if (endOffset >= text.length) break;
    startOffset = endOffset - overlapSize;
  }

  return chunks;
}

/**
 * 在文档中定位证据
 */
export function locateEvidenceInDocument(params: {
  evidence: string;
  chunk: DocumentChunk;
  plainLines: PlainLine[];
}): {
  lineNumber: number | null;
  startOffset: number | null;
  endOffset: number | null;
  located: boolean;
} {
  const { evidence, chunk, plainLines } = params;

  if (!evidence || evidence.trim().length === 0) {
    return {
      lineNumber: null,
      startOffset: null,
      endOffset: null,
      located: false,
    };
  }

  // 在 chunk 中查找 evidence
  const localIndex = chunk.content.indexOf(evidence);

  if (localIndex < 0) {
    return {
      lineNumber: null,
      startOffset: null,
      endOffset: null,
      located: false,
    };
  }

  // 计算全局偏移量
  const startOffset = chunk.startOffset + localIndex;
  const endOffset = startOffset + evidence.length;

  // 查找对应的行号
  const line = plainLines.find(
    l => startOffset >= l.startOffset && startOffset <= l.endOffset
  );

  return {
    lineNumber: line?.lineNumber ?? null,
    startOffset,
    endOffset,
    located: !!line,
  };
}
