import json,sqlite3,itertools,sys
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')
root=Path('.artifact-build/eval-three-db4a31b-20260908-104343')
candidate=Path('.artifact-build/detection-repair-completion-20260908/candidate-final')
out=Path('输出/测试报告/2026-09-08/detection-repair-completion-v1')
db=sqlite3.connect(':memory:')
db.execute('create table sample(ord integer, dataset text, role text, hash text, label integer, blank integer, oldfault integer, newfault integer, oldblock integer, newblock integer)')
db.execute('create table training(dataset text, role text, hash text, primary key(dataset,role,hash))')
meta={};ordinal=0
def rows(p):
 with p.open(encoding='utf-8') as stream:
  for line in stream:yield json.loads(line)
for batch in [1,2,3]:
 for r in rows(root/f'input/batch-{batch}.jsonl'):
  ordinal+=1
  if r['split']=='train':
   db.execute('insert or ignore into training values(?,?,?)',(r['dataset'],r['role'],r['normalizedTextSha256']))
  if r['split']=='test' and r['labelBasis']=='source_label':
   meta[r['caseId']]=(ordinal,r['dataset'],r['role'],r['normalizedTextSha256'],int(r['expectedRisk']),int(not r['text'].strip()))
def unavailable(r):
 return int(r['status']!='EVALUATED' or bool(r.get('degraded')) or bool(set(r.get('reasonCodes',[])) & {
 'DLP_TRANSFORM_EVIDENCE_MISSING','DLP_TRANSFORM_ENTITY_INVALID','OUTPUT_RECHECK_FAILED','OUTPUT_RECHECK_UNAVAILABLE','OUTPUT_RECHECK_DEADLINE_EXCEEDED'}))
for batch in [1,2,3]:
 for old,new in itertools.zip_longest(rows(root/f'results/batch-{batch}.jsonl'),rows(candidate/f'batch-{batch}.jsonl')):
  assert old and new and old['caseId']==new['caseId']
  if old['caseId'] in meta:
   db.execute('insert into sample values(?,?,?,?,?,?,?,?,?,?)',meta[old['caseId']]+(
    unavailable(old),unavailable(new),int(old.get('action')=='BLOCK' and old.get('confirmedMatchCount',0)>0),
    int(new.get('action')=='BLOCK' and new.get('confirmedMatchCount',0)>0)))
sql='''with ranked as (
 select s.*,row_number() over(partition by dataset,role,hash order by ord) as rn,
 min(label) over(partition by dataset,role,hash) as min_label,
 max(label) over(partition by dataset,role,hash) as max_label from sample s
), eligible as (
 select r.* from ranked r where rn=1 and blank=0 and oldfault=0 and newfault=0 and min_label=max_label
 and not exists(select 1 from training t where t.dataset=r.dataset and t.role=r.role and t.hash=r.hash)
)
select count(*) as scored,sum(label) as positive,sum(1-label) as negative,
 sum(label*oldblock) as old_tp,sum((1-label)*oldblock) as old_fp,
 sum(label*newblock) as new_tp,sum((1-label)*newblock) as new_fp from eligible'''
cursor=db.execute(sql);values=dict(zip([d[0] for d in cursor.description],cursor.fetchone()))
expected=json.loads((out/'paired-analysis.json').read_text(encoding='utf-8'))['groups']['native_test_dedup_train_disjoint']
assert values=={'scored':expected['candidate']['scored'],'positive':expected['candidate']['positive'],'negative':expected['candidate']['negative'],
 'old_tp':expected['baseline']['tp'],'old_fp':expected['baseline']['fp'],'new_tp':expected['candidate']['tp'],'new_fp':expected['candidate']['fp']}
result={'status':'PASS','method':'Independent SQLite window/group anti-join over original and candidate raw JSONL','values':values,'sql':sql}
(out/'independent-sql-verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result['values']))
