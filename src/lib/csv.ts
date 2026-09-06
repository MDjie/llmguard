/**
 * CSV 单元格序列化（RFC 4180）：
 * - 内部双引号双写转义；
 * - 以 =、+、-、@、Tab、CR 开头的单元格加前缀单引号，
 *   防止导出文件在 Excel/WPS 中打开时被当作公式执行（CSV 公式注入）。
 */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}
