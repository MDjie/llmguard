import { readFileSync, writeFileSync } from 'node:fs';
import { buildFinancialCandidates } from '../../src/lib/policy-governance/financial-library';
const source='data/content-safety/financial/financial-contexts.v1.1.json';
const output='data/content-safety/financial/financial-candidates.v1.1.json';
const packageValue=buildFinancialCandidates(JSON.parse(readFileSync(source,'utf8'))), content=JSON.stringify(packageValue,null,2)+'\n';
if(process.argv.includes('--check')) {if(readFileSync(output,'utf8')!==content)throw new Error('FINANCIAL_CANDIDATE_DRIFT');} else writeFileSync(output,content);
console.log(JSON.stringify({status:'CANDIDATE_STRUCTURE_VALID',terms:packageValue.manifest.entries.length,businessCoverage:packageValue.businessCoverage,publicationState:packageValue.publicationState,qualityState:packageValue.qualityState,globalAllowRules:0}));
