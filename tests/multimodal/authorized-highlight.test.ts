import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { authorizedArchiveHighlights } from '@/lib/evidence/authorized-highlight';
import type { AlertView } from '@/contracts/http/security-alerts';
const text = '😀<script>敏感词</script>', hash = createHash('sha256').update(text).digest('hex');
const alert: Pick<AlertView,'sourceId'|'stage'|'evidence'> = { sourceId: 'step', stage: 'INPUT', evidence: [{ evidenceId:'hit',locationState:'VERIFIED',locations:[{artifactId:'request',sourceDigest:hash,contentVersion:'step',contentPath:'/messages/0/content',mappingVersion:'guard-evidence-location-1',offsetEncoding:'UTF16',textStart:10,textEnd:13,textLength:text.length}]}] };
const content = {messages:[{role:'user',content:text}]};
describe('authorized original evidence highlighting',()=>{
 it('highlights the exact version and preserves markup as text',()=>{const result=authorizedArchiveHighlights(content,{purpose:'MODEL_INPUT',sourceStepId:'step'},'request',[alert]);expect(result[0].parts.map(p=>p.text).join('')).toBe(text);expect(result[0].parts.filter(p=>p.evidenceIds.length).map(p=>p.text).join('')).toBe('敏感词');});
 it('does not project original offsets onto redacted, transformed, another step or opposite direction',()=>{expect(authorizedArchiveHighlights({messages:[{content:'***'}]},{purpose:'MODEL_INPUT'},'request',[alert])).toEqual([]);expect(authorizedArchiveHighlights(content,{purpose:'MODEL_INPUT',sourceStepId:'other'},'request',[alert])).toEqual([]);expect(authorizedArchiveHighlights(content,{purpose:'MODEL_OUTPUT'},'request',[alert])).toEqual([]);expect(authorizedArchiveHighlights(content,{purpose:'MODEL_INPUT'},'other',[alert])).toEqual([]);});
 it('locates the frozen prepared context even when file preparation changed JSON paths',()=>{expect(authorizedArchiveHighlights({kind:'PREPARED_DETECTION_CONTEXT',segments:[{contentPath:'/messages/0/content',sourceDigest:hash,text}]},{purpose:'RECEIVED_INPUT'},'request',[alert])).toHaveLength(1);});
 it('rejects surrogate splits and unsafe path inheritance',()=>{const bad=structuredClone(alert);bad.evidence[0].locations[0].textStart=1;bad.evidence[0].locations[0].textEnd=2;expect(authorizedArchiveHighlights(content,{purpose:'MODEL_INPUT'},'request',[bad])).toEqual([]);bad.evidence[0].locations[0].contentPath='/__proto__/text';expect(authorizedArchiveHighlights(content,{purpose:'MODEL_INPUT'},'request',[bad])).toEqual([]);});
});
