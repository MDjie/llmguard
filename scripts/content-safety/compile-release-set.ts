import { compileReleaseSet } from '../../src/lib/policy-governance/release-set';
import { options,required,jsonFile,writeArtifact,fail } from './optimization-cli';
async function main(){const args=options(['manifest','out']);if(args.help){console.log('pnpm lexicon:compile-release-set --manifest <reviewed-conversion.json> --out <new-release-set.json>');return;}
  const result=compileReleaseSet(await jsonFile(required(args.manifest,'manifest')));await writeArtifact(required(args.out,'out'),result);console.log(JSON.stringify({digest:result.releaseSetDigest,terms:result.termCount,shards:result.shards.length,activationStatus:result.activationStatus}));}
main().catch(fail);
