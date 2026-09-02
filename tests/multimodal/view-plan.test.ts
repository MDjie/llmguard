import { describe, expect, it } from 'vitest';
import { createImageViewPlan } from '../../src/lib/multimodal';

describe('image confusion view plan', () => {
  it('is bounded and covers rotation, contrast, binarization, denoise and local tiles', () => {
    const views = createImageViewPlan();
    expect(views.length).toBeLessThanOrEqual(16);
    expect(new Set(views.map((item) => item.id)).size).toBe(views.length);
    expect(views.map((item) => item.transform)).toEqual(expect.arrayContaining([
      'decode_exif', 'rotate', 'grayscale', 'contrast', 'adaptive_threshold', 'median_denoise', 'tile',
    ]));
    expect(views.filter((item) => item.transform === 'rotate').map((item) => item.parameters.degrees))
      .toEqual([90, 180, 270]);
    expect(views.filter((item) => item.transform === 'tile').every(
      (item) => item.coordinateMapping === 'tile_offset',
    )).toBe(true);
  });
});
