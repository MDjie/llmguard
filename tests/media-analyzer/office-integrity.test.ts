import {describe,it,expect} from 'vitest';
import {officeCrc32,validateOfficeExternalReferences} from '../../services/media-analyzer/src/office';
describe('Office integrity and passive references',()=>{
 it('calculates the standard CRC32 independently of ZIP metadata',()=>{
  expect(officeCrc32(Buffer.from('123456789'))).toBe(0xcbf43926);
 });
 it('accepts inert hyperlinks but rejects external content and entity declarations',()=>{
  const rel=(type:string,target:string)=>`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}" TargetMode="External"/></Relationships>`;
  expect(()=>validateOfficeExternalReferences(rel('hyperlink','https://example.com'))).not.toThrow();
  expect(()=>validateOfficeExternalReferences(rel('image','https://example.com/a.png'))).toThrow('ANALYZER_OFFICE_EXTERNAL_CONTENT');
  expect(()=>validateOfficeExternalReferences(rel('hyperlink','file:///etc/passwd'))).toThrow('ANALYZER_OFFICE_EXTERNAL_CONTENT');
  expect(()=>validateOfficeExternalReferences('<!DOCTYPE a [<!ENTITY x SYSTEM "https://example.com">]><a>&x;</a>')).toThrow();
 });
 it('allows ODF web links without allowing a remote image',()=>{
  const node=(name:string)=>`<${name} xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://example.com"/>`;
  expect(()=>validateOfficeExternalReferences(node('text:a'))).not.toThrow();
  expect(()=>validateOfficeExternalReferences(node('draw:image'))).toThrow();
 });
});
