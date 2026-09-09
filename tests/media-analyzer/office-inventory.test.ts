import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {officeCrc32,inspectOfficeZip,officePackageInventory} from '../../services/media-analyzer/src/office';
function zip(items:Array<[string,Buffer]>){
 const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
 for(const [name,data] of items){
  const label=Buffer.from(name),crc=officeCrc32(data),header=Buffer.alloc(30),directory=Buffer.alloc(46);
  header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(label.length,26);
  directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt32LE(crc,16);directory.writeUInt32LE(data.length,20);directory.writeUInt32LE(data.length,24);directory.writeUInt16LE(label.length,28);directory.writeUInt32LE(offset,42);
  local.push(header,label,data);central.push(directory,label);offset+=header.length+label.length+data.length;
 }
 const c=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(items.length,8);end.writeUInt16LE(items.length,10);end.writeUInt32LE(c.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...local,c,end]);
}
const document: [string,Buffer]=['word/document.xml',Buffer.from('<document/>')];
describe('inert Office member inventory',()=>{
 it('retains exact hashes for hidden media without claiming analysis',()=>{
  const image=Buffer.from('synthetic hidden image'),body=zip([document,['word/media/hidden.png',image]]);
  const result=officePackageInventory(body,'docx');
  expect(result.unresolved).toEqual([{containerPath:'word/media/hidden.png',sha256:createHash('sha256').update(image).digest('hex'),sizeBytes:image.length,kind:'MEDIA',execution:'FORBIDDEN'}]);
  expect(result.nativeCoverageClaimed).toBe(false);expect(inspectOfficeZip(body,'docx')).toHaveLength(1);
 });
 it('enumerates active and embedded bytes but still forbids their rendering',()=>{
  const body=zip([document,['word/vbaProject.bin',Buffer.from('inert')],['word/embeddings/oleObject1.bin',Buffer.from('inert')]]);
  expect(officePackageInventory(body,'docx').unresolved.map(item=>item.kind)).toEqual(['ACTIVE_CONTENT','EMBEDDED_OBJECT']);
  expect(()=>inspectOfficeZip(body,'docx')).toThrow('ACTIVE_CONTENT');
 });
 it('rejects damaged member CRC and traversal paths',()=>{
  const damaged=zip([document]);damaged[30+Buffer.byteLength(document[0])]^=1;
  expect(()=>officePackageInventory(damaged,'docx')).toThrow('CHECKSUM');
  expect(()=>officePackageInventory(zip([document,['../hidden.png',Buffer.from('x')]]),'docx')).toThrow('PATH');
 });
 it('rejects expanded-size budget before parsing a member',()=>{
  const body=zip([document]);const central=body.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));body.writeUInt32LE(33*1024*1024,central+24);
  expect(()=>officePackageInventory(body,'docx')).toThrow('EXPANSION_LIMIT');
 });
});
