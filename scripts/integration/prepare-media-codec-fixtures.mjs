import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import coordinates from '../../src/lib/evidence/coordinate-mapping.ts';
const {inverseRotation,mapRegion,tileMapping}=coordinates;
const directory=path.resolve('.artifact-build/v11-continuation-20260908/codec-fixtures');mkdirSync(directory,{recursive:true});
const image=execFileSync('docker',['image','inspect','--format','{{.Id}}','guardllm-r0-media-analyzer:latest'],{encoding:'utf8',windowsHide:true}).trim();assert.match(image,/^sha256:[a-f0-9]{64}$/);
function tool(command,args){return execFileSync('docker',['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,noexec,nosuid,size=32m','--mount','type=bind,source='+directory+',target=/fixtures','--entrypoint',command,image,...args],{windowsHide:true,maxBuffer:4*1024*1024});}
function generate(args){tool('ffmpeg',['-v','error','-nostdin','-y',...args]);}
generate(['-f','lavfi','-i','testsrc=size=101x99:rate=1','-frames:v','1','-pix_fmt','rgb24','/fixtures/image.png']);
generate(['-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=0.3','-ac','1','-c:a','pcm_s16le','/fixtures/audio.wav']);
generate(['-f','lavfi','-i','testsrc=size=64x64:rate=10:duration=0.3','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','/fixtures/video.mp4']);
const probe=name=>JSON.parse(tool('ffprobe',['-v','error','-show_entries','stream=codec_name,width,height,sample_rate,channels:format=duration','-of','json','/fixtures/'+name]).toString('utf8'));
const metadata={image:probe('image.png'),audio:probe('audio.wav'),video:probe('video.mp4')};assert.equal(metadata.image.streams[0].width,101);assert.equal(metadata.image.streams[0].height,99);assert.equal(metadata.audio.streams[0].codec_name,'pcm_s16le');assert.equal(metadata.video.streams[0].codec_name,'h264');
const pixels=name=>tool('ffmpeg',['-v','error','-nostdin','-i','/fixtures/'+name,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
const original=pixels('image.png'),checks=[];
for(const [degrees,filter] of [[90,'transpose=1'],[180,'hflip,vflip'],[270,'transpose=2']]){
 const name='rotate-'+degrees+'.png';generate(['-i','/fixtures/image.png','-vf',filter,'-frames:v','1', '/fixtures/'+name]);const info=probe(name).streams[0],transformed=pixels(name);
 for(const [x,y] of [[0,0],[Math.floor(info.width/2),Math.floor(info.height/2)],[info.width-1,info.height-1]]){
  const [sx,sy]=mapRegion([(x+0.5)/info.width,(y+0.5)/info.height,(x+0.5)/info.width,(y+0.5)/info.height],inverseRotation(degrees));const sourceOffset=(Math.floor(sy*99)*101+Math.floor(sx*101))*3,offset=(y*info.width+x)*3;assert.deepEqual(transformed.subarray(offset,offset+3),original.subarray(sourceOffset,sourceOffset+3));
 }checks.push('actual_rgb_rotation_'+degrees);
}
const tile=tileMapping(101,99,1,1,2,2);generate(['-i','/fixtures/image.png','-vf',`crop=${tile.width}:${tile.height}:${tile.x}:${tile.y}:exact=1`,'-frames:v','1','/fixtures/tile.png']);const cropped=pixels('tile.png');assert.equal(cropped.length,tile.width*tile.height*3);
for(const [x,y] of [[0,0],[tile.width-1,tile.height-1]]){const offset=(y*tile.width+x)*3,sourceOffset=((y+tile.y)*101+x+tile.x)*3;assert.deepEqual(cropped.subarray(offset,offset+3),original.subarray(sourceOffset,sourceOffset+3));}checks.push('actual_rgb_odd_dimension_crop');
const files=Object.fromEntries(['image.png','audio.wav','video.mp4'].map(name=>{const bytes=readFileSync(path.join(directory,name));assert.ok(bytes.length<=1048576);return[name,{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}];}));
writeFileSync(path.join(directory,'verification.json'),JSON.stringify({status:'PASS',image,metadata,files,checks,syntheticOnly:true,realModelQuality:false},null,2));console.log('PASS valid PNG/WAV/MP4 fixtures and four pixel-coordinate checks; synthetic media, no model-quality claim');
