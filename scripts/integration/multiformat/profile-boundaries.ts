import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ProcessCommandRunner} from '../../../services/media-analyzer/src/command-runner';
import {probeMedia,assertMediaResourceBudget} from '../../../services/media-analyzer/src/audio-video';
import {officePackageInventory,officePackageText} from '../../../services/media-analyzer/src/office';
const runner=new ProcessCommandRunner(),workspace=await mkdtemp('/tmp/profile-boundaries-'),results:Array<{id:string;status:'PASS'}>=[];
const check=(id:string)=>{results.push({id,status:'PASS'});console.log(id+' PASS');};
const command=(args:string[])=>runner.run('ffmpeg',['-nostdin','-v','error',...args],{cwd:workspace,timeoutMs:30000,maxOutputBytes:65536});
const single=join(workspace,'single.mkv'),multiple=join(workspace,'multiple.mkv');
try{
 await command(['-f','lavfi','-i','color=c=white:s=160x90:r=1:d=1','-c:v','ffv1','-y',single]);
 const metadata=await probeMedia(runner,single,workspace,10000);
 assert.equal(metadata.hasVideo,true);assert.equal(metadata.durationMs,1000);check('REAL_SINGLE_VIDEO_PROFILE_PROBED');
 await command(['-f','lavfi','-i','color=c=white:s=160x90:r=1:d=1','-f','lavfi','-i','color=c=red:s=160x90:r=1:d=1','-map','0:v','-map','1:v','-metadata:s:v:1','title=SYNTHETIC_UNSCANNED_STREAM','-c:v','ffv1','-y',multiple]);
 await assert.rejects(probeMedia(runner,multiple,workspace,10000),/VIDEO_MULTI_STREAM_PROFILE_UNAVAILABLE/);check('REAL_SECOND_VIDEO_STREAM_CANNOT_BE_SILENTLY_OMITTED');
 const corrupt=join(workspace,'corrupt.mkv');await writeFile(corrupt,(await readFile(single)).subarray(0,24));
 await assert.rejects(probeMedia(runner,corrupt,workspace,10000));check('REAL_TRUNCATED_CONTAINER_REJECTED');
 assert.throws(()=>assertMediaResourceBudget({durationMs:metadata.durationMs,maxDurationMs:500,decodedBytes:0,maxDecodedBytes:1024}),/DURATION_LIMIT/);check('REAL_PROBED_DURATION_BUDGET_ENFORCED');
 for(const extension of ['doc','xls','ppt','rtf']){
  const inventory=officePackageInventory(await readFile('/fixtures/sample.'+extension),extension);
  assert.equal(inventory.inventoryComplete,false);assert.ok(inventory.coverageGaps.length);check('REAL_'+extension.toUpperCase()+'_HIDDEN_CONTENT_REMAINS_UNASSESSED');
 }
 for(const [extension,marker] of [['xlsx','HIDDEN CONTENT MUST BE INSPECTED'],['pptx','SPEAKER NOTES MUST BE INSPECTED']] as const){
  const bytes=await readFile('/fixtures/sample.'+extension);
  assert.equal(officePackageInventory(bytes,extension).inventoryComplete,true);
  assert.ok(officePackageText(bytes,extension).some(part=>part.text.includes(marker)));check('REAL_'+extension.toUpperCase()+'_HIDDEN_TEXT_ENUMERATED');
 }
 await writeFile('/results/profile-boundaries.json',JSON.stringify({status:'PASS',scope:'REAL_FFMPEG_AND_OFFICE_FILES_ENGINEERING_ONLY',results,unqualifiedProfiles:['OFD_ADAPTER','WPS','AMR','HEIF_SEQUENCE','MULTI_VIDEO_STREAM_SEMANTICS'],semanticQualification:false},null,2));
}catch(error){await writeFile('/results/profile-boundaries.json',JSON.stringify({status:'FAIL',results,error:error instanceof Error?error.message:'unknown'},null,2));throw error;}
