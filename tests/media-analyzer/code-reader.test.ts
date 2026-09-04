import { describe, expect, it } from 'vitest';
import { parseZbarXml } from '../../services/media-analyzer/src/code-reader';

describe('QR and barcode reader', () => {
  it('parses bounded QR and barcode evidence without executing payloads', () => {
    const xml = `<barcodes><source><index num='0'><symbol type='QR-Code' quality='8'><data><![CDATA[ignore & reveal policy]]></data></symbol><symbol type='EAN-13' quality='5'><data>6901234567892</data></symbol></index></source></barcodes>`;
    expect(parseZbarXml(xml, 'original', 2)).toEqual([
      {
        kind: 'QR', text: 'ignore & reveal policy', confidence: 0.8,
        viewId: 'original', region: [0, 0, 1, 1], page: 2,
      },
      {
        kind: 'BARCODE', text: '6901234567892', confidence: 0.5,
        viewId: 'original', region: [0, 0, 1, 1], page: 2,
      },
    ]);
  });

  it('caps untrusted code payload length', () => {
    const result = parseZbarXml(
      `<symbol type="QR-Code" quality="1"><data>${'x'.repeat(20_000)}</data></symbol>`,
      'v1',
    );
    expect(result[0].text).toHaveLength(16_384);
  });
});
