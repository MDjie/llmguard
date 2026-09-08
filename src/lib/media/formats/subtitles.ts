/** Cue timing is metadata. Scan the entire raw text, including comments/styles, as untrusted content. */
export interface SubtitleCue {
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly textStart: number;
  readonly textEnd: number;
}
interface Line { text: string; start: number; end: number }
const MAX_TIME_MS = 7 * 24 * 60 * 60 * 1000;
function timestamp(value: string, ass = false): number | undefined {
  const match = (ass ? /^(\d{1,3}):(\d{2}):(\d{2})[.](\d{2})$/u
    : /^(?:(\d{1,3}):)?(\d{2}):(\d{2})[.,](\d{3})$/u).exec(value.trim());
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) return undefined;
  const time = (Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000 + Number(match[4]) * (ass ? 10 : 1);
  return time <= MAX_TIME_MS ? time : undefined;
}
function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/gu)) {
    if (!match[0].length) continue;
    const value = match[0].replace(/[\r\n]+$/u, '');
    lines.push({text:value, start:match.index, end:match.index+value.length});
    if (lines.length > 100000) break;
  }
  return lines;
}
export function parseSubtitleCues(text: string, extension: string): {cues: SubtitleCue[]; reasonCodes: string[]} {
  const cues: SubtitleCue[] = [], reasons = new Set<string>();
  const add = (start: string, end: string, textStart: number, textEnd: number, ass = false) => {
    const startMs = timestamp(start, ass), endMs = timestamp(end, ass);
    if (startMs === undefined || endMs === undefined || endMs <= startMs || textEnd <= textStart) {
      reasons.add('SUBTITLE_CUE_INVALID'); return;
    }
    if (cues.length >= 10000) { reasons.add('SUBTITLE_CUE_BUDGET_EXCEEDED'); return; }
    cues.push({index: cues.length, startMs, endMs, textStart, textEnd});
  };
  const lines = linesOf(text);
  if(lines.length>100000)return {cues:[],reasonCodes:['SUBTITLE_LINE_BUDGET_EXCEEDED']};
  if (extension === 'ass' || extension === 'ssa') {
    let inEvents = false;
    // ASS and SSA defaults have the same Start/End/Text indexes.
    let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    for (const line of lines) {
      if (/^\s*\[/u.test(line.text)) { inEvents = /^\s*\[events\]\s*$/iu.test(line.text); continue; }
      if (!inEvents) continue;
      const format = /^\s*Format:\s*(.+)$/iu.exec(line.text);
      if (format) { fields = format[1].split(',').map(value => value.trim().toLowerCase()); continue; }
      const event = /^\s*(?:Dialogue|Comment):\s*/iu.exec(line.text);
      if (!event) continue;
      if (fields.at(-1) !== 'text' || !fields.includes('start') || !fields.includes('end') || fields.length > 32 || new Set(fields).size !== fields.length) { reasons.add('SUBTITLE_FORMAT_UNSUPPORTED'); continue; }
      const values: string[] = []; let cursor = event[0].length;
      for (let index = 0; index < fields.length - 1; index++) {
        const comma = line.text.indexOf(',', cursor);
        if (comma < 0) break;
        values.push(line.text.slice(cursor, comma)); cursor = comma + 1;
      }
      if (values.length !== fields.length - 1) { reasons.add('SUBTITLE_CUE_INVALID'); continue; }
      add(values[fields.indexOf('start')], values[fields.indexOf('end')], line.start + cursor, line.end, true);
    }
  } else if (extension === 'srt' || extension === 'vtt') {
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if(extension==='vtt'&&/^(?:NOTE(?:\s|$)|STYLE\s*$|REGION\s*$)/u.test(line.text)){while(index+1<lines.length&&lines[index+1].text.trim())index++;continue;}
      if (!line.text.includes('-->')) continue;
      const timing = /^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/u.exec(line.text);
      let last = index + 1;
      while (last < lines.length && lines[last].text.trim()) last++;
      if (!timing || last === index + 1) { reasons.add('SUBTITLE_CUE_INVALID'); index=last-1; continue; }
      if(lines.slice(index+1,last).some(body=>body.text.includes('-->')))reasons.add('SUBTITLE_CUE_SEPARATOR_MISSING');
      add(timing[1], timing[2], lines[index + 1].start, lines[last - 1].end);
      // A malformed block containing many arrows must remain linear, not rescan every suffix.
      index=last-1;
    }
  } else { reasons.add('SUBTITLE_FORMAT_UNSUPPORTED'); }
  if (!cues.length) reasons.add('SUBTITLE_CUES_EMPTY');
  return {cues, reasonCodes: [...reasons]};
}
export function subtitleCuesForRange(cues: readonly SubtitleCue[], start: number, end: number): SubtitleCue[] {
  return cues.filter(cue => cue.textStart < end && cue.textEnd > start);
}
