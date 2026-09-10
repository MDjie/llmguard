"""GPU fine-tuning of a Chinese encoder; source-label experiments remain SHADOW only."""
from __future__ import annotations
import argparse
import csv
import json
from pathlib import Path
import random
import time
import numpy as np
import torch
from transformers import AutoTokenizer, AutoModelForSequenceClassification
from model_identity import verify_model_artifact
from runtime import ROOT, digest, normalized, group, split, write_json, fit_platt, calibrated, confusion, threshold_for_recall

SUBJECTS = ['偏见歧视','淫秽色情','财产隐私','心理健康','违法犯罪','脏话侮辱','身体伤害','政治错误','道德伦理','变体词']
LABELS = ['cs_' + str(i) for i in range(10)] + ['toxiccn_toxicity']
RISKS = ['CN.A2.09','adult_content','PRIVACY.PII','HARM.SELF_HARM','illegal_content','CN.A4.03',
         'HARM.VIOLENT_CRIME','sensitive_compliance','CN.A4.07','sensitive_compliance','CN.A4.03']


def dataset():
    cs = ROOT/'eval-data/chinesesafe/test.jsonl'; tc = ROOT/'eval-data/toxiccn/ToxiCN_1.0.csv'
    grouped = {}; conflicts = set(); source_count = 0
    def add(text, targets, mask, source_id):
        nonlocal source_count
        source_count += 1
        if not normalized(text): return
        g = group(text)
        if g not in grouped: grouped[g] = dict(text=text, targets=targets, mask=mask, group=g, split=split(text), sources=[source_id])
        else:
            previous=grouped[g]
            if any(a and b and x != y for a,b,x,y in zip(previous['mask'],mask,previous['targets'],targets)): conflicts.add(g)
            previous['targets']=[max(a,b) for a,b in zip(previous['targets'],targets)]
            previous['mask']=[max(a,b) for a,b in zip(previous['mask'],mask)]
            previous['sources'].append(source_id)
    for i,line in enumerate(cs.read_text(encoding='utf-8').splitlines()):
        r=json.loads(line); targets=[0.]*11
        if r['label']=='违规': targets[SUBJECTS.index(r['subject'])]=1.
        elif r['label']!='不违规': raise ValueError('UNKNOWN_SOURCE_LABEL')
        add(r['text'],targets,[1.]*10+[0.], 'chinesesafe:'+str(i+1))
    for i,r in enumerate(csv.DictReader(tc.open(encoding='utf-8-sig'))):
        add(r['content'],[0.]*10+[float(r['toxic'])],[0.]*10+[1.], 'toxiccn:'+str(i+1))
    rows=[r for g,r in sorted(grouped.items()) if g not in conflicts]
    return rows, {'files':{str(p.relative_to(ROOT)):digest(p) for p in [cs,tc]},'sourceRows':source_count,
                  'uniqueGroups':len(rows),'conflictingGroups':len(conflicts),'splitMethod':'normalized_exact_group_hash_70_15_15',
                  'nearDuplicateFamilyAuditComplete':False,'sourceLabelsArePolicyGold':False}


def tensors(tokenizer, rows, device, maximum):
    batch=tokenizer([r['text'] for r in rows],truncation=True,padding=True,max_length=maximum,return_tensors='pt')
    return {k:v.to(device) for k,v in batch.items()}


def score(model, tokenizer, rows, args):
    model.eval(); outputs=[]
    with torch.inference_mode():
        for start in range(0,len(rows),args.batch_size):
            inputs=tensors(tokenizer,rows[start:start+args.batch_size],'cuda',args.max_length)
            with torch.autocast('cuda',dtype=torch.float16): logits=model(**inputs).logits
            outputs.append(logits.float().cpu().numpy())
    return np.concatenate(outputs)


def train(args):
    if not torch.cuda.is_available(): raise ValueError('CUDA_REQUIRED_FOR_ENCODER_TRAINING')
    torch.set_num_threads(4);random.seed(42);np.random.seed(42);torch.manual_seed(42);torch.cuda.manual_seed_all(42)
    rows,source=dataset(); partitions={s:[r for r in rows if r['split']==s] for s in ['development','calibration','test']}
    out=Path(args.out);out.mkdir(parents=True,exist_ok=False)
    base=Path(args.base); base_hashes={p.name:digest(p) for p in base.iterdir() if p.is_file()}
    tokenizer=AutoTokenizer.from_pretrained(base,local_files_only=True)
    model=AutoModelForSequenceClassification.from_pretrained(base,local_files_only=True,num_labels=len(LABELS),
          id2label={i:l for i,l in enumerate(LABELS)},label2id={l:i for i,l in enumerate(LABELS)},problem_type='multi_label_classification').to('cuda')
    optimizer=torch.optim.AdamW(model.parameters(),lr=2e-5,weight_decay=.01)
    scaler=torch.amp.GradScaler('cuda');train_rows=partitions['development'];steps=0;started=time.time()
    y=np.asarray([r['targets'] for r in train_rows]);mask=np.asarray([r['mask'] for r in train_rows]);positives=(y*mask).sum(axis=0)
    positive_weights=torch.tensor(np.minimum(5.,((1-y)*mask).sum(axis=0)/np.maximum(positives,1)),dtype=torch.float32,device='cuda')
    total_steps=args.epochs*int(np.ceil(len(train_rows)/args.batch_size))
    from transformers import get_linear_schedule_with_warmup
    scheduler=get_linear_schedule_with_warmup(optimizer,int(.06*total_steps),total_steps)
    for epoch in range(args.epochs):
        random.Random(42+epoch).shuffle(train_rows);model.train();loss_sum=0.
        for start in range(0,len(train_rows),args.batch_size):
            batch=train_rows[start:start+args.batch_size];inputs=tensors(tokenizer,batch,'cuda',args.max_length)
            targets=torch.tensor([r['targets'] for r in batch],dtype=torch.float32,device='cuda')
            masks=torch.tensor([r['mask'] for r in batch],dtype=torch.float32,device='cuda')
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast('cuda',dtype=torch.float16):
                logits=model(**inputs).logits
                losses=torch.nn.functional.binary_cross_entropy_with_logits(logits,targets,pos_weight=positive_weights,reduction='none')
                loss=(losses*masks).sum()/masks.sum()
            if not torch.isfinite(loss): raise ValueError('NONFINITE_TRAINING_LOSS')
            scaler.scale(loss).backward();scaler.unscale_(optimizer);torch.nn.utils.clip_grad_norm_(model.parameters(),1.)
            scaler.step(optimizer);scaler.update();scheduler.step();steps+=1;loss_sum+=float(loss.detach())
            if steps%100==0:
                progress={'status':'TRAINING','epoch':epoch+1,'steps':steps,'totalSteps':total_steps,'elapsedSeconds':round(time.time()-started),'loss':float(loss.detach())}
                write_json(out/'progress.json',progress);print(json.dumps(progress),flush=True)
        print(json.dumps({'epochComplete':epoch+1,'meanBatchLoss':loss_sum/int(np.ceil(len(train_rows)/args.batch_size))}),flush=True)
    cal_rows=partitions['calibration'];test_rows=partitions['test']
    cal_logits=score(model,tokenizer,cal_rows,args);test_logits=score(model,tokenizer,test_rows,args)
    calibration={};metrics={};np.savez_compressed(out/'raw-logits.npz',calibration=cal_logits,test=test_logits)
    from sklearn.metrics import roc_auc_score
    for i,label in enumerate(LABELS):
        ci=[j for j,r in enumerate(cal_rows) if r['mask'][i]];ti=[j for j,r in enumerate(test_rows) if r['mask'][i]]
        cy=np.array([cal_rows[j]['targets'][i] for j in ci]);ty=np.array([test_rows[j]['targets'][i] for j in ti])
        params=fit_platt(cal_logits[ci,i],cy);selection=threshold_for_recall(cy,calibrated(cal_logits[ci,i],params))
        probabilities=calibrated(test_logits[ti,i],params)
        calibration[label]={'parameters':params,**selection}
        metrics[label]={'sourceSubject':SUBJECTS[i] if i<10 else 'ToxiCN toxicity','riskMappingIsProvisional':True,
                        'test':confusion(ty,probabilities,selection['threshold']),'auc':float(roc_auc_score(ty,test_logits[ti,i])),
                        'rawUniqueScores':len(set(map(float,test_logits[ti,i]))),'testSupport':len(ti)}
    model.save_pretrained(out/'weights',safe_serialization=True);tokenizer.save_pretrained(out/'weights')
    write_json(out/'calibration.json',calibration)
    model_files={p.name:digest(p) for p in (out/'weights').iterdir() if p.is_file()};model_files['calibration.json']=digest(out/'calibration.json')
    import hashlib
    identity='sha256:'+hashlib.sha256(json.dumps(model_files,sort_keys=True).encode()).hexdigest()
    manifest={'kind':'P0_CHINESE_MACBERT_MULTILABEL','modelId':'p0-chinese-macbert-content','modelVersion':'1.0','modelSha256':identity,
              'baseFiles':base_hashes,'modelFiles':model_files,'source':source,'splitCounts':{k:len(v) for k,v in partitions.items()},
              'labels':LABELS,'epochs':args.epochs,'steps':steps,'maximumTokens':args.max_length,'gpu':torch.cuda.get_device_name(),
              'elapsedSeconds':round(time.time()-started),'metrics':metrics,'productionEligible':False,'independentApproval':False,
              'sourceLabelModelNotPolicyAdjudicator':True,'earlierFullChineseSafeBenchmarkNoLongerIndependentForThisModel':True,
              'sourceModelLicense':'Apache-2.0; see pinned source-lock.json','sourceDataLicenseReviewPending':True}
    if any(digest(ROOT/p)!=h for p,h in source['files'].items()):raise ValueError('TRAINING_DATA_CHANGED')
    write_json(out/'manifest.json',manifest)
    with (out/'split-manifest.jsonl').open('w',encoding='utf-8') as f:
        for r in rows:f.write(json.dumps({k:r[k] for k in ['group','split','sources','targets','mask']},ensure_ascii=False)+'\n')
    config=dict(detectorId='p0-chinese-content',detectorVersion='1.0',modelId=manifest['modelId'],modelVersion='1.0',modelSha256=identity,
          quantization='FP16',baseUrl='http://127.0.0.1:58193',path='/classify',providerType='custom',mode='SHADOW',failurePolicy='DEGRADE',timeoutMs=10000,
          batchSize=16,maximumRequestBytes=1048576,maximumResponseBytes=1048576,temperature=1,
          labels=[dict(label=l,riskType=RISKS[i],severity='MEDIUM',threshold=calibration[l]['threshold']) for i,l in enumerate(LABELS)])
    write_json(out/'classifier-shadow-config.json',config)
    write_json(out/'progress.json',{'status':'COMPLETE','steps':steps,'elapsedSeconds':round(time.time()-started)})
    print(json.dumps({'status':'COMPLETE','metrics':metrics},ensure_ascii=False),flush=True)


def predict(args):
    folder=Path(args.model);meta=verify_model_artifact(folder);cal=json.loads((folder/'calibration.json').read_text(encoding='utf-8'))
    for name,expected in meta['modelFiles'].items():
        file=folder/name if name=='calibration.json' else folder/'weights'/name
        if digest(file)!=expected:raise ValueError('MODEL_HASH_MISMATCH')
    tokenizer=AutoTokenizer.from_pretrained(folder/'weights',local_files_only=True)
    model=AutoModelForSequenceClassification.from_pretrained(folder/'weights',local_files_only=True).to('cuda' if torch.cuda.is_available() else 'cpu').eval()
    payload=json.loads(Path(args.input).read_text(encoding='utf-8'));items=payload['items']
    expected={'id':meta['modelId'],'version':meta['modelVersion'],'sha256':meta['modelSha256'],'quantization':'FP16'}
    if payload.get('model')!=expected:raise ValueError('REQUEST_MODEL_IDENTITY_MISMATCH')
    if not 1<=len(items)<=32 or len({x['id'] for x in items})!=len(items):raise ValueError('ITEMS_INVALID')
    if any(len(tokenizer.encode(i['text'],add_special_tokens=True))>meta['maximumTokens'] for i in items):raise ValueError('CLASSIFIER_WINDOW_REQUIRED')
    device=next(model.parameters()).device
    batch=tokenizer([i['text'] for i in items],padding=True,return_tensors='pt').to(device)
    if device.type != 'cuda':raise ValueError('CUDA_REQUIRED_FOR_FP16_CLASSIFIER')
    with torch.inference_mode(), torch.autocast('cuda',dtype=torch.float16):logits=model(**batch).logits.float().cpu().numpy()
    output=[{'id':r['id'],'labels':[{'label':l,'confidence':float(calibrated(logits[n,i],cal[l]['parameters']))} for i,l in enumerate(LABELS)]} for n,r in enumerate(items)]
    write_json(args.out,{'modelId':meta['modelId'],'modelVersion':meta['modelVersion'],'modelSha256':meta['modelSha256'],'items':output})


def main():
    parser=argparse.ArgumentParser();sub=parser.add_subparsers(dest='command',required=True)
    p=sub.add_parser('train');p.add_argument('--base',required=True);p.add_argument('--out',required=True);p.add_argument('--epochs',type=int,default=2)
    p.add_argument('--batch-size',type=int,default=24);p.add_argument('--max-length',type=int,default=256);p.set_defaults(run=train)
    p=sub.add_parser('predict');p.add_argument('--model',required=True);p.add_argument('--input',required=True);p.add_argument('--out',required=True);p.set_defaults(run=predict)
    args=parser.parse_args();args.run(args)
if __name__=='__main__':main()
