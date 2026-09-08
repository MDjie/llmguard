
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const ts=require(require.resolve('typescript',{paths:[process.cwd()]}));
const root=process.cwd(),records=[];
function moduleOf(rel,names,extra=''){
 const raw=fs.readFileSync(path.join(root,rel),'utf8');
 const sf=ts.createSourceFile(rel,raw,ts.ScriptTarget.Latest,true);
 const kept=sf.statements.filter(s=>!ts.isImportDeclaration(s) && (!names ||
  (s.name && names.includes(s.name.text)) ||
  (ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>ts.isIdentifier(d.name)&&names.includes(d.name.text)))));
 const source=kept.map(s=>s.getText(sf)).join('\n')+'\n'+extra;
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports={};vm.runInNewContext(js,{exports,Buffer,performance},{timeout:5000,filename:rel});
 records.push({path:rel,sha256:crypto.createHash('sha256').update(raw).digest('hex'),extractedSymbols:names??'all non-import declarations'});
 return exports;
}
const action=moduleOf('src/lib/guard-engine-v2/action-constraints.ts',null);
const session=moduleOf('src/lib/guard-engine-v2/session-context.ts',['ACTION_RANK','sessionObservation','chooseSessionDecision']);
const state=moduleOf('src/lib/secure-memory/session-risk-state.ts',['ACTION_RANK','applySessionRiskControl']);
const dag=moduleOf('src/lib/guard-engine-v2/dag.ts',['shouldRun'],'export { shouldRun };');
const norm=moduleOf('src/lib/guard-engine-v2/normalization.ts',null);
const decision=a=>({contractVersion:'1.0',decisionId:'synthetic-'+a,traceId:'synthetic',action:a,riskLevel:'HIGH',observations:[],policyPath:[],bundleId:'synthetic',latencyMs:1,degradationReasons:[]});
const expected=action.combineActionConstraints(['REQUIRE_REVIEW','SAFE_RESPONSE']).action;
const chosen=session.chooseSessionDecision(decision('REQUIRE_REVIEW'),decision('SAFE_RESPONSE'));
const applied=state.applySessionRiskControl(decision('REQUIRE_REVIEW'),{state:'ESCALATED',enhancedDetection:true,concurrencyPercent:50,minimumAction:'SAFE_RESPONSE',reasonCodes:['SYNTHETIC']});
const parent=[{status:'MATCH',observations:[{status:'MATCH',decisionRole:'CANDIDATE',score:.94,reasonCode:'SYNTHETIC'}]}];
const n=norm.normalizeWithBudget('base64: aGVsbG8gd29ybGQ=',{maxViews:1},()=>0);
const result={
kind:'architecture-isolated-function-probes',scope:'Exact AST-extracted current source functions; no DB, gateway, model or production request. Synthetic fixtures only.',
head:require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
sources:records,
probes:[
{id:'ARCH-SESSION-MERGE',sharedConstraint:expected,actual:chosen.action,defectReproduced:expected==='REQUIRE_REVIEW'&&chosen.action==='SAFE_RESPONSE'},
{id:'ARCH-SESSION-CONTROL',sharedConstraint:expected,actual:applied.action,defectReproduced:expected==='REQUIRE_REVIEW'&&applied.action==='SAFE_RESPONSE'},
{id:'ARCH-DAG-CANDIDATE-SKIP',parentRole:'CANDIDATE',parentScore:.94,blockThreshold:.8,actualShouldRun:dag.shouldRun({runCondition:'WHEN_NO_BLOCKING_MATCH'},parent,.8),defectReproduced:dag.shouldRun({runCondition:'WHEN_NO_BLOCKING_MATCH'},parent,.8)===false},
{id:'ARCH-NORMALIZATION-LIMIT',configuredMaxViews:1,actualViewCount:n.views.length,returnedFields:Object.keys(n),partialFieldPresent:['complete','coverage','truncated','stopReason','reasonCodes'].some(k=>k in n),defectReproduced:n.views.length===1&&!['complete','coverage','truncated','stopReason','reasonCodes'].some(k=>k in n)}
]};
if(!result.probes.every(p=>p.defectReproduced))throw Error('BASELINE_PROBE_EXPECTATION_CHANGED');
const outputDir=path.join(root,'.artifact-build','detection-architecture-probe-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(outputDir,{recursive:true});
fs.writeFileSync(path.join(outputDir,'architecture-probe-results.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({outputDir}));
console.log(JSON.stringify({probes:result.probes,allBaselineConditionsReproduced:true}));
