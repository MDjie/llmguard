import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { compileReviewedConversion, conversionSourceSchema, convertLexiconSources } from '../../src/lib/policy-governance/lexicon-conversion';
import { dictionaryLayerSchema } from '../../src/contracts/http/policy-governance';
import { options,required,jsonFile,writeArtifact } from './optimization-cli';
async function main(){
  const args=options(['manifest','out','conversion','approvals','registry','policy','dictionary','version','layer']);
  if(args.help){console.log('lexicon:convert-reviewed --manifest <sources.json> --out <new-candidates.json>; to compile approved data: --conversion <json> --approvals <signed-decisions.json> --registry <trusted-reviewers.json> --policy <id> --dictionary <id> --version <version> --layer <layer> --out <new-release-set.json>. SQL is parsed, never executed.');return;}
  let result:unknown;
  if(args.conversion){
    const approvals=z.array(z.unknown()).parse(await jsonFile(required(args.approvals,'approvals')));
    result=compileReviewedConversion(await jsonFile(required(args.conversion,'conversion')),approvals,await jsonFile(required(args.registry,'registry')),
      {policyId:required(args.policy,'policy'),dictionaryId:required(args.dictionary,'dictionary'),version:required(args.version,'version'),layer:dictionaryLayerSchema.parse(args.layer)});
  }else{
    const sources=z.array(conversionSourceSchema).min(1).max(100).parse(await jsonFile(required(args.manifest,'manifest')));
    const inputs=[];
    for(const source of sources){const bytes=await readFile(source.path);if(bytes.length>32*1024*1024)throw new Error('SOURCE_SIZE_LIMIT');
      if(createHash('sha256').update(bytes).digest('hex')!==source.sha256)throw new Error('SOURCE_DIGEST_MISMATCH');inputs.push({source,content:bytes.toString('utf8')});}
    result=convertLexiconSources(inputs);
  }
  await writeArtifact(required(args.out,'out'),result);console.log('Conversion artifact written. No database import or production publication.');
}
main().catch(()=>{console.error('LEXICON_CONVERSION_FAILED (source content suppressed)');process.exitCode=2;});
