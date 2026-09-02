export interface ImageViewPlan {
  readonly id: string;
  readonly transform: string;
  readonly parameters: Readonly<Record<string, number | string | boolean>>;
  readonly coordinateMapping: 'identity' | 'inverse_affine' | 'tile_offset';
}

export function createImageViewPlan(options: { includeTiles?: boolean } = {}): readonly ImageViewPlan[] {
  const views: ImageViewPlan[] = [
    { id: 'original', transform: 'decode_exif', parameters: {}, coordinateMapping: 'identity' },
    ...[90, 180, 270].map((degrees) => ({
      id: `rotate_${degrees}`,
      transform: 'rotate',
      parameters: { degrees },
      coordinateMapping: 'inverse_affine' as const,
    })),
    { id: 'grayscale', transform: 'grayscale', parameters: {}, coordinateMapping: 'identity' },
    { id: 'contrast', transform: 'contrast', parameters: { factor: 1.5 }, coordinateMapping: 'identity' },
    { id: 'threshold', transform: 'adaptive_threshold', parameters: { blockSize: 31 }, coordinateMapping: 'identity' },
    { id: 'denoise', transform: 'median_denoise', parameters: { radius: 1 }, coordinateMapping: 'identity' },
  ];
  if (options.includeTiles !== false) {
    for (let row = 0; row < 2; row += 1) {
      for (let column = 0; column < 2; column += 1) {
        views.push({
          id: `tile_${row}_${column}`,
          transform: 'tile',
          parameters: { row, column, rows: 2, columns: 2, overlap: 0.1 },
          coordinateMapping: 'tile_offset',
        });
      }
    }
  }
  return views;
}
