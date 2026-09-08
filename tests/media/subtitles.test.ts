import {describe, expect, it} from 'vitest';
import {parseSubtitleCues, subtitleCuesForRange} from '@/lib/media/formats/subtitles';
describe('standalone subtitle source timing', () => {
 it('preserves exact UTF16 offsets with CRLF and supplementary characters', () => {
  const text='1\r\n00:00:01,020 --> 00:00:03,400\r\n你好😀\r\n第二行\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,000\r\n结束';
  const parsed=parseSubtitleCues(text,'srt');
  expect(parsed.reasonCodes).toEqual([]); expect(parsed.cues).toHaveLength(2);
  const cue=parsed.cues[0]; expect(text.slice(cue.textStart,cue.textEnd)).toBe('你好😀\r\n第二行');
  expect([cue.startMs,cue.endMs]).toEqual([1020,3400]);
  expect(subtitleCuesForRange(parsed.cues,cue.textStart+2,cue.textStart+4)).toEqual([cue]);
  expect(subtitleCuesForRange(parsed.cues,0,1)).toEqual([]);
 });
 it('accepts WebVTT identifiers/settings and overlapping cue windows', () => {
  const parsed=parseSubtitleCues('WEBVTT\n\nlabel\n00:01.000 --> 00:03.000 align:start\nhello\n\n00:02.000 --> 00:04.000\nworld','vtt');
  expect(parsed.reasonCodes).toEqual([]);expect(parsed.cues.map(cue=>cue.startMs)).toEqual([1000,2000]);
 });
 it('maps ASS and SSA comments/dialogue, preserving text commas and override tags as data', () => {
  for(const extension of ['ass','ssa']){
   const text='[Events]\nFormat: Start, End, Text\nDialogue: 0:00:01.20,0:00:03.45,{\\b1}hello, world\\Nnext\nComment: 0:00:04.00,0:00:05.00,untrusted';
   const parsed=parseSubtitleCues(text,extension);expect(parsed.reasonCodes).toEqual([]);
   expect(parsed.cues).toHaveLength(2);expect(parsed.cues[0].startMs).toBe(1200);
   expect(text.slice(parsed.cues[0].textStart,parsed.cues[0].textEnd)).toBe('{\\b1}hello, world\\Nnext');
  }
 });
 it('does not repeatedly interpret arrows inside a malformed cue body',()=>{
  const text='00:00:01,000 --> 00:00:02,000\n'+Array.from({length:10000},()=> '00:00:03,000 --> 00:00:04,000').join('\n');
  const result=parseSubtitleCues(text,'srt');expect(result.cues).toHaveLength(1);expect(result.reasonCodes).toContain('SUBTITLE_CUE_SEPARATOR_MISSING');
 });
 it('reports malformed timestamps instead of claiming complete timing coverage', () => {
  const parsed=parseSubtitleCues('1\n00:60:00,000 --> 00:00:00,000\ntext','srt');
  expect(parsed.cues).toEqual([]);expect(parsed.reasonCodes).toContain('SUBTITLE_CUE_INVALID');
 });
 it('rejects ambiguous ASS field ordering and retains missing-cue diagnostics', () => {
  expect(parseSubtitleCues('[Events]\nFormat: Text, Start, End\nDialogue: a,b,0:00:01.00,0:00:02.00','ass').reasonCodes).toContain('SUBTITLE_FORMAT_UNSUPPORTED');
  expect(parseSubtitleCues('raw text with no timing','vtt').reasonCodes).toContain('SUBTITLE_CUES_EMPTY');
 });
});
