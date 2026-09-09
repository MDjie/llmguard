import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
const [target,...directories]=process.argv.slice(2);if(!target||!directories.length)throw new Error('Usage: aggregate.mjs <output.json> <run-directory> ...');
const suites=['journeys','repair-workflows','extended','diagnostics','final','evidence-workflow','original-preview-browser','auth-workflows','media-stages'];
const records=new Map(),runs=[];
for(const directory of directories){const out=resolve(directory);const read=name=>existsSync(out+'/'+name+'.json')?JSON.parse(readFileSync(out+'/'+name+'.json','utf8')):null;const identity=read('source-identity'),execution=read('run-result'),unit=read('unit-results');
 runs.push({directory:out,source:identity?.sha256,head:identity?.head,status:execution?.status??'INTERRUPTED',coldRun:execution?.coldRun??false,steps:execution?.steps??[],unit:unit?{passed:unit.numPassedTests,failed:unit.numFailedTests,pending:unit.numPendingTests}:null});
 for(const suite of suites)for(const r of read(suite)?.results??[]){const key=suite+':'+r.id+':'+(r.project??'default');const row=records.get(key)??{testId:r.id,suite,project:r.project??'default',attempts:[]};row.attempts.push({run:out,source:identity?.sha256,status:r.status,error:r.error??r.reason??r.detail?.error,jobStatus:r.jobStatus,action:r.action,outcome:r.outcome});records.set(key,row);}
}
const cases=[...records.values()].map(r=>({...r,latestStatus:r.attempts.at(-1).status,everPassed:r.attempts.some(a=>a.status==='PASS')}));
const counts=Object.fromEntries(['PASS','FAIL','BLOCKED','OBSERVATION'].map(s=>[s,cases.filter(r=>r.latestStatus===s).length]));
writeFileSync(target,JSON.stringify({schemaVersion:1,meaning:'Latest attempts are not a single cold-run pass. Original failures are retained.',singleColdRuns:runs,cases,counts,allPassedInOneRun:runs.some(r=>r.status==='PASS'),qualityQualification:'SEPARATE_GATE'},null,2));console.log(JSON.stringify({counts,runs:runs.map(r=>({directory:r.directory,status:r.status}))}));
