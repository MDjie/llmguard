"""Offline P0 emergency classifiers and calibration. No llm_guard dependency or network."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
from pathlib import Path
import re
import unicodedata

ROOT = Path(__file__).resolve().parents[3]
os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def normalized(text):
    return re.sub(r'[\s\u200b-\u200d\ufeff]', '', unicodedata.normalize('NFKC', text).lower())


def group(text):
    return hashlib.sha256(normalized(text).encode()).hexdigest()


def split(text):
    bucket = int(group(text)[:8], 16) % 20
    return 'development' if bucket < 14 else 'calibration' if bucket < 17 else 'test'


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')


def confusion(y, scores, threshold):
    import numpy as np
    y = np.asarray(y, dtype=int); pred = np.asarray(scores) >= threshold
    tp = int(((y == 1) & pred).sum()); fn = int(((y == 1) & ~pred).sum())
    fp = int(((y == 0) & pred).sum()); tn = int(((y == 0) & ~pred).sum())
    return dict(tp=tp, fn=fn, fp=fp, tn=tn, recall=tp / (tp + fn) if tp + fn else None,
                fnr=fn / (tp + fn) if tp + fn else None, fpr=fp / (fp + tn) if fp + tn else None)


def fit_platt(logits, labels):
    import numpy as np
    from scipy.optimize import minimize
    x = np.asarray(logits, dtype=float); y = np.asarray(labels, dtype=float)
    if not np.isfinite(x).all() or set(y.tolist()) != {0., 1.}:
        raise ValueError('CALIBRATION_REQUIRES_FINITE_SCORES_AND_TWO_CLASSES')
    if np.unique(x).size <= 2:
        raise ValueError('BINARY_OR_CONSTANT_SCORES_CANNOT_BE_CALIBRATED')
    result = minimize(lambda ab: float(np.mean(np.logaddexp(0, ab[0]*x+ab[1]) - y*(ab[0]*x+ab[1]))),
                      [1., 0.], method='L-BFGS-B', bounds=[(.01, 50.), (-30., 30.)])
    if not result.success:
        raise ValueError('CALIBRATION_OPTIMIZATION_FAILED')
    return {'a': float(result.x[0]), 'b': float(result.x[1]), 'method': 'monotone_platt'}


def calibrated(logits, params):
    from scipy.special import expit
    return expit(params['a'] * logits + params['b'])


def threshold_for_recall(y, scores, target=.85, max_fpr=.10):
    import numpy as np
    choices = [(float(t), confusion(y, scores, float(t))) for t in np.linspace(0, 1, 201)]
    feasible = [(t, m) for t, m in choices if m['recall'] is not None and m['recall'] >= target and m['fpr'] is not None and m['fpr'] <= max_fpr]
    if feasible:
        threshold, metrics = min(feasible, key=lambda x: (x[1]['fpr'], x[1]['fn'], -x[0]))
    else:
        threshold, metrics = min(choices, key=lambda x: (10*x[1]['fn'] + x[1]['fp'], x[1]['fn']))
    return {'threshold': threshold, 'calibrationMetrics': metrics, 'targetRecall': target, 'maxFpr': max_fpr,
            'targetMetOnCalibration': bool(feasible), 'fallbackCostFn': 10, 'fallbackCostFp': 1}


def load_rows(kind):
    if kind == 'content':
        file = ROOT / 'eval-data/toxiccn/ToxiCN_1.0.csv'
        source = list(csv.DictReader(file.open(encoding='utf-8-sig')))
        rows = [{'id': str(i+1), 'text': r['content'], 'labels': {'content_toxicity': int(r['toxic'])}}
                for i, r in enumerate(source)]
    else:
        file = ROOT / 'eval-data/toxicchat/toxicchat0124_all.csv'
        source = list(csv.DictReader(file.open(encoding='utf-8-sig')))
        rows = [{'id': r['conv_id'], 'text': r['user_input'], 'labels': {'jailbreaking': int(r['jailbreaking'])}}
                for r in source]
    # Duplicates with conflicting source labels are quarantined, never split across train/test.
    grouped = {}; conflicts = set(); empty = 0
    for row in rows:
        if not normalized(row['text']): empty += 1; continue
        g = group(row['text'])
        if g in grouped and row['labels'] != grouped[g]['labels']: conflicts.add(g)
        else: grouped.setdefault(g, {**row, 'group': g, 'split': split(row['text'])})
    clean = [r for g, r in grouped.items() if g not in conflicts]
    return clean, {'path': str(file.relative_to(ROOT)), 'sha256': digest(file), 'sourceRows': len(rows), 'uniqueRows': len(clean),
                   'conflictingGroups': len(conflicts), 'emptyRows': empty, 'duplicates': len(rows)-len(grouped)-empty,
                   'labelBasis': 'source_toxicity' if kind == 'content' else 'source_jailbreaking_proxy_not_all_prompt_injection'}


def train(args):
    import numpy as np
    import joblib
    import sklearn
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import roc_auc_score, brier_score_loss
    out = Path(args.out); out.mkdir(parents=True, exist_ok=False)
    heads = {}; report = {}; manifest = []
    for kind in ('content', 'injection'):
        rows, source = load_rows(kind); label = next(iter(rows[0]['labels']))
        partitions = {s: [r for r in rows if r['split'] == s] for s in ['development', 'calibration', 'test']}
        for s, data in partitions.items():
            if {r['labels'][label] for r in data} != {0, 1}: raise ValueError('SPLIT_REQUIRES_BOTH_CLASSES:' + s)
        vectorizer = TfidfVectorizer(analyzer='char', ngram_range=(2, 4), min_df=2, max_features=80000,
                                     sublinear_tf=True, strip_accents=None, dtype=np.float64)
        dev = partitions['development']; x = vectorizer.fit_transform([r['text'] for r in dev]); y = [r['labels'][label] for r in dev]
        model = LogisticRegression(C=4., class_weight='balanced', solver='liblinear', random_state=42, max_iter=300)
        model.fit(x, y)
        if model.n_iter_.max() >= 300: raise ValueError('TRAINING_DID_NOT_CONVERGE')
        cal = partitions['calibration']; cy = np.asarray([r['labels'][label] for r in cal])
        margins = model.decision_function(vectorizer.transform([r['text'] for r in cal]))
        platt = fit_platt(margins, cy); scores = calibrated(margins, platt); selection = threshold_for_recall(cy, scores)
        test = partitions['test']; ty = np.asarray([r['labels'][label] for r in test])
        raw = model.decision_function(vectorizer.transform([r['text'] for r in test])); probabilities = calibrated(raw, platt)
        metrics = confusion(ty, probabilities, selection['threshold'])
        heads[label] = dict(vectorizer=vectorizer, model=model, calibration=platt, threshold=selection['threshold'])
        report[kind] = dict(source=source, label=label, splitCounts={s: len(d) for s, d in partitions.items()},
                            calibration=platt, selection=selection, testMetrics=metrics,
                            rawUniqueScores=len(set(map(float, raw))), auc=float(roc_auc_score(ty, raw)),
                            brier=float(brier_score_loss(ty, probabilities)), features=len(vectorizer.vocabulary_),
                            independentPolicyAdjudication=False)
        for row, logit, score in zip(test, raw, probabilities):
            manifest.append(dict(caseId=kind+':'+row['id'], textHash=group(row['text']), split='test', dimension=kind,
                                 label=row['labels'][label], rawLogit=float(logit), calibratedProbability=float(score),
                                 threshold=selection['threshold'], predicted=bool(score >= selection['threshold'])))
        print(json.dumps({'trained': kind, 'testMetrics': metrics, 'uniqueScores': len(set(map(float, raw)))}, ensure_ascii=False), flush=True)
    joblib.dump(heads, out / 'model.joblib')
    sha = digest(out / 'model.joblib')
    metadata = {'schemaVersion':'1.0','modelId':'p0-char-ngram-dual-channel','modelVersion':'1.0','modelSha256':'sha256:'+sha,
                'architecture':'character_tfidf_logistic_regression','isPretrainedEncoder':False,'sklearnVersion':sklearn.__version__,
                'trainingDataUsed':['ToxiCN source toxicity','ToxicChat source jailbreaking'], 'chineseSafeUsedForTraining':False,
                'splitMethod':'normalized_exact_group_hash_70_15_15','nearDuplicateFamilyAuditComplete':False,
                'productionEligible':False,'independentApproval':False, 'mode':'SHADOW',
                'labels':[{ 'label': label, 'threshold': head['threshold']} for label,head in heads.items()], 'channels':report}
    write_json(out / 'manifest.json', metadata)
    with (out / 'heldout-predictions.jsonl').open('w',encoding='utf-8') as f:
        for row in manifest: f.write(json.dumps(row,ensure_ascii=False,allow_nan=False)+'\n')
    # Model response protocol consumed by the existing SemanticClassifierDetector.
    config = dict(detectorId='p0-content-classifier',detectorVersion='1.0',modelId=metadata['modelId'],modelVersion='1.0',modelSha256=metadata['modelSha256'],
                  quantization='FP32',baseUrl='http://127.0.0.1:58193',path='/classify',providerType='custom',mode='SHADOW',failurePolicy='DEGRADE',
                  timeoutMs=5000,batchSize=8,maximumRequestBytes=1048576,maximumResponseBytes=1048576,temperature=1,
                  labels=[dict(label='content_toxicity',riskType='CN.A4.03',severity='MEDIUM',threshold=heads['content_toxicity']['threshold']),
                          dict(label='jailbreaking',riskType='prompt_injection',severity='HIGH',threshold=heads['jailbreaking']['threshold'])])
    write_json(out / 'classifier-shadow-config.json',config)
    write_json(out / 'test-ledger-sha256.json', {'sha256':digest(out/'heldout-predictions.jsonl')})


def predict(args):
    import joblib
    folder=Path(args.model); meta=json.loads((folder/'manifest.json').read_text(encoding='utf-8'))
    if 'sha256:'+digest(folder/'model.joblib') != meta['modelSha256']: raise ValueError('MODEL_HASH_MISMATCH')
    heads=joblib.load(folder/'model.joblib')  # Only the locally generated, hash-bound artifact is supported.
    payload=json.loads(Path(args.input).read_text(encoding='utf-8'))
    if payload.get('model') != {'id':meta['modelId'],'version':meta['modelVersion'],'sha256':meta['modelSha256'],'quantization':'FP32'}: raise ValueError('REQUEST_MODEL_IDENTITY_MISMATCH')
    items=payload['items']
    if not 1 <= len(items) <= 32 or len({i['id'] for i in items}) != len(items): raise ValueError('ITEMS_INVALID')
    if any(not isinstance(i.get('text'),str) or len(i['text'])>32000 for i in items): raise ValueError('TEXT_BUDGET_EXCEEDED')
    output=[{'id':i['id'],'labels':[]} for i in items]
    for label,head in heads.items():
        scores=calibrated(head['model'].decision_function(head['vectorizer'].transform([i['text'] for i in items])),head['calibration'])
        for row,score in zip(output,scores): row['labels'].append({'label':label,'confidence':float(score)})
    write_json(args.out, {'modelId':meta['modelId'],'modelVersion':meta['modelVersion'],'modelSha256':meta['modelSha256'],'items':output})


def raw_scores(args):
    import torch
    from transformers import AutoTokenizer, AutoModelForSequenceClassification
    torch.set_num_threads(args.threads)
    rows,source=load_rows(args.channel); label='content_toxicity' if args.channel=='content' else 'jailbreaking'
    selected=[]
    for expected in (0,1):
        candidates=sorted([r for r in rows if r['labels'][label]==expected],key=lambda r:r['group'])
        selected += candidates[:args.limit//2]
    out=Path(args.out);out.mkdir(parents=True,exist_ok=False)
    model_path=ROOT/'eval-data/models'/('unbiased-toxic-roberta' if args.channel=='content' else 'deberta-prompt-injection-v2')
    tokenizer=AutoTokenizer.from_pretrained(model_path,local_files_only=True)
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    model=AutoModelForSequenceClassification.from_pretrained(model_path,local_files_only=True).to(device).eval()
    all_rows=[]
    for offset in range(0,len(selected),args.batch_size):
        batch=selected[offset:offset+args.batch_size]
        tokens=tokenizer([r['text'] for r in batch],padding=True,truncation=True,max_length=args.max_length,return_tensors='pt')
        tokens = {k:v.to(device) for k,v in tokens.items()}
        with torch.inference_mode(): logits=model(**tokens).logits.float().cpu()
        # Multi-label toxicity uses independent sigmoid; binary injection uses softmax(logits)[INJECTION].
        probabilities=torch.sigmoid(logits) if args.channel=='content' else torch.softmax(logits,dim=-1)
        index=model.config.label2id['toxicity' if args.channel=='content' else 'INJECTION']
        for r,l,p in zip(batch,logits,probabilities):
            margin=float(l[index]) if args.channel=='content' else float(l[index]-l[1-index])
            all_rows.append(dict(caseId=args.channel+':'+r['id'],textHash=r['group'],split=r['split'],label=r['labels'][label],
                                 rawLogits=[float(v) for v in l],rawLogit=margin,rawProbability=float(p[index]),
                                 tokenLimit=args.max_length,possiblyTruncated=len(tokenizer.encode(r['text'],add_special_tokens=True))>args.max_length))
        print(json.dumps({'rawScored':len(all_rows),'expected':len(selected),'channel':args.channel}),flush=True)
    with (out/'scores.jsonl').open('w',encoding='utf-8') as f:
        for row in all_rows:f.write(json.dumps(row,allow_nan=False)+'\n')
    cal=[r for r in all_rows if r['split']=='calibration'];test=[r for r in all_rows if r['split']=='test']
    calibration={'status':'INSUFFICIENT_CLASS_SUPPORT'}
    if all(sum(r['label']==v for r in cal)>=5 and sum(r['label']==v for r in test)>=5 for v in (0,1)):
        import numpy as np
        params=fit_platt([r['rawLogit'] for r in cal],[r['label'] for r in cal])
        selection=threshold_for_recall([r['label'] for r in cal],calibrated(np.array([r['rawLogit'] for r in cal]),params))
        calibration={'status':'FITTED_EXPLORATORY', 'parameters':params,'selection':selection,
                     'testMetrics':confusion([r['label'] for r in test],calibrated(np.array([r['rawLogit'] for r in test]),params),selection['threshold'])}
    write_json(out/'manifest.json',{'kind':'DIRECT_TRANSFORMERS_LOGITS','channel':args.channel,'source':source,'rows':len(all_rows),
               'rawUniqueScores':len({r['rawLogit'] for r in all_rows}),'modelFiles':{p.name:digest(p) for p in model_path.iterdir() if p.is_file()},
               'scoresHash':digest(out/'scores.jsonl'),'calibration':calibration,'productionEligible':False,
               'device':device,'roundingApplied':False,'llmGuardScannerUsed':False,'scope':'binary toxicity or jailbreaking proxy; not general safety labels'})


def main():
    parser=argparse.ArgumentParser(); sub=parser.add_subparsers(dest='command',required=True)
    p=sub.add_parser('train');p.add_argument('--out',required=True);p.set_defaults(run=train)
    p=sub.add_parser('predict');p.add_argument('--model',required=True);p.add_argument('--input',required=True);p.add_argument('--out',required=True);p.set_defaults(run=predict)
    p=sub.add_parser('raw-scores');p.add_argument('--channel',choices=['content','injection'],required=True);p.add_argument('--out',required=True)
    p.add_argument('--limit',type=int,default=256);p.add_argument('--threads',type=int,default=4);p.add_argument('--batch-size',type=int,default=8);p.add_argument('--max-length',type=int,default=256);p.set_defaults(run=raw_scores)
    args=parser.parse_args();args.run(args)


if __name__=='__main__':main()
