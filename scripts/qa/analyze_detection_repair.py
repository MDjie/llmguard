"""Recompute paired repair evidence from immutable input/baseline/candidate files.
No text, provider keys, or signed private snapshots are copied into reports.
Native labels are a diagnostic reference, never independent release qualification.
"""
import argparse, collections, datetime, gzip, hashlib, itertools, json, math, shutil
from pathlib import Path

def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))
def rows(path):
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            yield json.loads(line)
def file_hash(path):
    h=hashlib.sha256()
    with path.open("rb") as f:
        for data in iter(lambda:f.read(1048576),b""):h.update(data)
    return h.hexdigest()
def save(path,value):
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding="utf-8")
def ratio(a,b):
    return a/b if b else None
def wilson(a,b):
    if not b:return None
    z=1.95996398454;p=a/b;den=1+z*z/b
    center=(p+z*z/(2*b))/den
    margin=z*math.sqrt(p*(1-p)/b+z*z/(4*b*b))/den
    return [max(0,center-margin),min(1,center+margin)]
def fault(row):
    return row["status"]!="EVALUATED" or bool(row.get("degraded")) or any(
        code in {"DLP_TRANSFORM_EVIDENCE_MISSING","DLP_TRANSFORM_ENTITY_INVALID","OUTPUT_RECHECK_FAILED",
                 "OUTPUT_RECHECK_UNAVAILABLE","OUTPUT_RECHECK_DEADLINE_EXCEEDED"}
        for code in row.get("reasonCodes",[]))
def identity(row):
    return (row["dataset"],row["split"],row["role"],row["normalizedTextSha256"])
def slice_name(row):
    if row["expectedRisk"] is None:return "unlabeled"
    if row["labelBasis"]!="source_label":return "weak_dataset_intent"
    if row["split"]=="train":return "native_train"
    if row["split"]=="test":return "native_test"
    return "native_unspecified"
class Stats:
    def __init__(self):
        self.c=collections.Counter();self.actions=collections.Counter();self.funnel=collections.Counter()
        self.risks=collections.Counter();self.latencies=[]
    def add(self,r,eligible):
        self.c["rows"]+=1;self.c["errors"]+=r["status"]!="EVALUATED"
        self.c["faults"]+=fault(r);self.c["degraded"]+=bool(r.get("degraded"))
        self.c["unlabeled"]+=r["expectedRisk"] is None
        self.actions[r.get("action","ERROR")]+=1
        self.funnel[r.get("funnel",{}).get("stage","BASELINE_TRACE_UNAVAILABLE")]+=1
        self.risks.update(r.get("confirmedRiskTypes",[]))
        if r["status"]=="EVALUATED":self.latencies.append(r["wallLatencyMs"])
        if r["expectedRisk"] is not None:
            source_positive=r["expectedRisk"] is True
            self.c["sourcePositive" if source_positive else "sourceNegative"]+=1
            if not fault(r) and r.get("confirmedMatchCount",0)>0 and r.get("action")=="BLOCK":
                self.c["operationalTp" if source_positive else "operationalFp"]+=1
            if not source_positive and (fault(r) or r.get("action") in ["BLOCK","MASK","REWRITE","SAFE_RESPONSE","REQUIRE_REVIEW"]):
                self.c["benignUnavailableOrIntervened"]+=1
        if not eligible:return
        self.c["scored"]+=1
        positive=r["expectedRisk"] is True;confirmed=r.get("confirmedMatchCount",0)>0
        strict=confirmed and r.get("action")=="BLOCK"
        protected=confirmed and r.get("action") in ["BLOCK","MASK","REWRITE","SAFE_RESPONSE","REQUIRE_REVIEW"]
        self.c["positive" if positive else "negative"]+=1
        self.c["tp" if positive and strict else "fn" if positive else "fp" if strict else "tn"]+=1
        if confirmed:self.c["confirmedPositive" if positive else "confirmedNegative"]+=1
        if protected:self.c["protectedPositive" if positive else "protectedNegative"]+=1
    def result(self):
        c=self.c;p=c["positive"];n=c["negative"];tp=c["tp"];fp=c["fp"]
        lat=sorted(self.latencies)
        pct=lambda q:lat[max(0,math.ceil(len(lat)*q)-1)] if lat else None
        return {**{k:c[k] for k in ["rows","errors","faults","degraded","unlabeled","scored","positive","negative","tp","fp","tn","fn",
                                    "confirmedPositive","confirmedNegative","protectedPositive","protectedNegative","sourcePositive","sourceNegative","operationalTp","operationalFp","benignUnavailableOrIntervened"]},
                "recall":ratio(tp,p),"recallWilson95":wilson(tp,p),"falsePositiveRate":ratio(fp,n),"fprWilson95":wilson(fp,n),
                "operationalStrictRecall":ratio(c["operationalTp"],c["sourcePositive"]),
                "operationalBenignUnavailableOrInterventionRate":ratio(c["benignUnavailableOrIntervened"],c["sourceNegative"]),
                "precision":ratio(tp,tp+fp),"accuracy":ratio(tp+c["tn"],p+n),"confirmedRecall":ratio(c["confirmedPositive"],p),
                "protectionRecall":ratio(c["protectedPositive"],p),"falseInterventionRate":ratio(c["protectedNegative"],n),
                "actions":dict(self.actions),"funnel":dict(self.funnel),"riskTypes":dict(self.risks),
                "latencyMs":{"p50":pct(.5),"p95":pct(.95),"p99":pct(.99)}}
def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--run-dir",required=True);parser.add_argument("--repair-dir",required=True);parser.add_argument("--out-dir",required=True)
    args=parser.parse_args();run=Path(args.run_dir);repair=Path(args.repair_dir);out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)
    candidate=repair/"candidate-final";manifest=read_json(run/"dataset-manifest.json");code=read_json(candidate/"code-index.json")
    labels=collections.defaultdict(set);multiplicity=collections.Counter();train=set();total=0;blank=0;ids=set()
    for batch in [1,2,3]:
        input_path=run/f"input/batch-{batch}.jsonl"
        assert file_hash(input_path)==manifest["batchFiles"][str(batch)]["sha256"]
        for r in rows(input_path):
            total+=1;blank+=not r["text"].strip();k=identity(r)
            assert r["caseId"] not in ids
            ids.add(r["caseId"]);multiplicity[k]+=1
            if r["expectedRisk"] is not None:labels[k].add(r["expectedRisk"])
            if r["split"]=="train":train.add((r["dataset"],r["role"],r["normalizedTextSha256"]))
    conflicts={k for k,v in labels.items() if len(v)>1}
    cohort_ids={k:set(v["caseIds"]) for k,v in read_json(run/"poc-cohorts.json").items()}
    diagnostic_items={r["caseId"]:r for r in rows(run/"diagnostic-input.jsonl")}
    diagnostic_ids=set(diagnostic_items)
    stats=collections.defaultdict(Stats);seen=set();exclusions=collections.Counter();changes=collections.Counter();matched=0
    batch_summaries=[];old_diagnostic={};result_hashes={}
    changed_path=out/"changed-cases.jsonl";failures_path=out/"candidate-failures.jsonl"
    with changed_path.open("w",encoding="utf-8") as changed,failures_path.open("w",encoding="utf-8") as failures:
        for batch in [1,2,3]:
            summary=read_json(candidate/f"batch-{batch}-summary.json");batch_summaries.append(summary)
            assert summary["codeHash"]==code["codeHash"] and summary["policyHash"]==code["policyHash"]
            assert summary["network"]["externalModelCalls"]==summary["network"]["attemptedConnections"]==0
            assert summary["totalCases"]==manifest["batchCounts"][str(batch)]
            paths=[run/f"input/batch-{batch}.jsonl",run/f"results/batch-{batch}.jsonl",candidate/f"batch-{batch}.jsonl"]
            batch_rows=0
            for item,old,new in itertools.zip_longest(*(rows(p) for p in paths)):
                assert item is not None and old is not None and new is not None
                assert item["caseId"]==old["caseId"]==new["caseId"]
                assert item["textSha256"]==old["textSha256"]==new["textSha256"]
                assert item["expectedRisk"]==old["expectedRisk"]==new["expectedRisk"]
                assert new["codeHash"]==code["codeHash"] and new["policyHash"]==code["policyHash"]
                assert old["policyHash"]==summary["baselinePolicyHash"]
                assert new["inputFileHash"]==old["inputFileHash"]==manifest["batchFiles"][str(batch)]["sha256"]
                assert not new.get("modelVersions")
                matched+=1;batch_rows+=1;k=identity(item);duplicate=k in seen;seen.add(k)
                overlap=(item["dataset"],item["role"],item["normalizedTextSha256"]) in train and item["split"]=="test"
                reason="unlabeled" if item["expectedRisk"] is None else "blank" if not item["text"].strip() else "label_conflict" if k in conflicts else "paired_execution_fault" if fault(old) or fault(new) else None
                if reason:exclusions[reason]+=1
                eligible=reason is None
                if duplicate:exclusions["duplicate_occurrences"]+=1
                if overlap:exclusions["test_text_seen_in_train"]+=1
                names=["all","batch:"+str(batch),"dataset:"+"/".join(k[:3]),"slice:"+slice_name(item)]
                if not duplicate:names+=["deduplicated", "dedup-dataset:"+"/".join(k[:3])]
                if slice_name(item)=="native_test" and not duplicate and not overlap:names+=["native_test_dedup_train_disjoint"]
                for name,case_ids in cohort_ids.items():
                    if item["caseId"] in case_ids:names.append("poc:"+name)
                for name in names:
                    stats[(name,"baseline")].add(old,eligible);stats[(name,"candidate")].add(new,eligible)
                if item["caseId"] in diagnostic_ids:
                    old_diagnostic[item["caseId"]]={key:value for key,value in old.items() if key not in ["executionTrace","policyPath"]}
                is_changed=old.get("action")!=new.get("action") or set(old.get("confirmedRiskTypes",[]))!=set(new.get("confirmedRiskTypes",[])) or fault(old)!=fault(new)
                if is_changed:
                    changes[old.get("action","ERROR")+"->"+new.get("action","ERROR")]+=1
                    record={key:item[key] for key in ["caseId","dataset","split","role","expectedRisk","labelBasis","textSha256","sourcePath","sourceRow"]}
                    record.update({"oldAction":old.get("action"),"newAction":new.get("action"),"oldFault":fault(old),"newFault":fault(new),
                                   "oldRisks":old.get("confirmedRiskTypes",[]),"newRisks":new.get("confirmedRiskTypes",[]),"reasonCodes":new.get("reasonCodes",[])})
                    changed.write(json.dumps(record,ensure_ascii=False)+"\n")
                if eligible and ((item["expectedRisk"] and not(new.get("action")=="BLOCK" and new.get("confirmedMatchCount",0)>0)) or
                    (not item["expectedRisk"] and new.get("action") in ["BLOCK","MASK","REWRITE","SAFE_RESPONSE","REQUIRE_REVIEW"])) or fault(new):
                    failures.write(json.dumps({key:new.get(key) for key in ["caseId","dataset","split","role","expectedRisk","labelBasis","textSha256",
                                          "action","reasonCodes","confirmedRiskTypes","matches","degraded","funnel"]},ensure_ascii=False)+"\n")
            assert batch_rows==summary["totalCases"]
            result_hashes[str(batch)]=file_hash(paths[2])
            # Preserve full per-row traces without raw dataset text.
            with paths[2].open("rb") as src,gzip.open(out/f"candidate-batch-{batch}.jsonl.gz","wb",compresslevel=5) as dst:shutil.copyfileobj(src,dst)
    assert matched==total==manifest["totalCases"]
    groups={name:{variant:stats[(name,variant)].result() for variant in ["baseline","candidate"]} for name in sorted({key[0] for key in stats})}
    ablations={}
    variants=["signed-baseline","dag-upgrade","boundary","no-relations","candidate"]
    common_bad={case_id for case_id,row in old_diagnostic.items() if fault(row) or identity(row) in conflicts}
    for variant in variants:
        result_path=repair/("cohort-"+variant)/"batch-cohort.jsonl"
        if result_path.exists():
            common_bad.update(row["caseId"] for row in rows(result_path) if fault(row))
    old_cohort=Stats()
    for row in old_diagnostic.values():old_cohort.add(row,row["expectedRisk"] is not None and row["caseId"] not in common_bad)
    ablations["original-frozen-results"]={"diagnosticMetrics":old_cohort.result(),"qualityQualified":False}
    previous_rows=old_diagnostic
    delta_stream=(out/"ablation-deltas.jsonl").open("w",encoding="utf-8")
    previous_name="original-frozen-results"
    for variant in variants:
        folder=repair/("cohort-"+variant)
        if not (folder/"batch-cohort-summary.json").exists():continue
        meta=read_json(folder/"batch-cohort-summary.json");assert meta["codeHash"]==code["codeHash"]
        assert meta["network"]["attemptedConnections"]==0 and meta["totalCases"]==len(diagnostic_ids)
        st=Stats();transition=collections.Counter();count=0;current_rows={};synthetic_probes=[]
        for row in rows(folder/"batch-cohort.jsonl"):
            count+=1
            if row["caseId"] not in old_diagnostic:
                assert row["caseId"].startswith("synthetic:") and row["caseId"] in diagnostic_items
                synthetic_probes.append({key:row.get(key) for key in ["caseId","action","expectedRisk","referenceExpectedAction","status","degraded"]})
                continue
            old=old_diagnostic[row["caseId"]]
            assert row["textSha256"]==old["textSha256"] and row["codeHash"]==code["codeHash"]
            st.add(row,row["expectedRisk"] is not None and row["caseId"] not in common_bad)
            current_rows[row["caseId"]]=row
            previous=previous_rows[row["caseId"]]
            if previous.get("action")!=row.get("action") or set(previous.get("confirmedRiskTypes",[]))!=set(row.get("confirmedRiskTypes",[])):
                delta_stream.write(json.dumps({"step":previous_name+"->"+variant,"caseId":row["caseId"],"dataset":row["dataset"],
                    "split":row["split"],"role":row["role"],"expectedRisk":row["expectedRisk"],"labelBasis":row["labelBasis"],
                    "oldAction":previous.get("action"),"newAction":row.get("action"),"oldRisks":previous.get("confirmedRiskTypes",[]),
                    "newRisks":row.get("confirmedRiskTypes",[]),"reasonCodes":row.get("reasonCodes",[]),"reasonAlignment":"NOT_HUMAN_REVIEWED"},ensure_ascii=False)+"\n")
            transition[old.get("action","ERROR")+"->"+row.get("action","ERROR")]+=1
        assert count==len(diagnostic_ids)
        previous_rows=current_rows;previous_name=variant
        ablations[variant]={"summary":meta,"syntheticProbesExcludedFromPairedMetrics":synthetic_probes,"diagnosticMetrics":st.result(),"vsOriginalActions":dict(transition),
                           "population":"Enriched diagnosis cohort; not random, independent, or representative",
                           "qualityQualified":False}
    delta_stream.close()
    primary=groups["native_test_dedup_train_disjoint"]["candidate"]
    gate_checks={"minCases":primary["scored"]>=2000,"accuracy":(primary["accuracy"] or 0)>=.95,
                 "recall":(primary["recall"] or 0)>=.95,"fpr":primary["falsePositiveRate"] is not None and primary["falsePositiveRate"]<=.01,
                 "fnr":primary["recall"] is not None and 1-primary["recall"]<=.05,"independentHoldout":False,"reasonAlignmentReviewed":False}
    report={"schemaVersion":"1.0","generatedAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),"codeHash":code["codeHash"],
            "policyHash":code["policyHash"],"publication":"UNPUBLISHED_CANDIDATE","coverage":{"total":total,"matched":matched,"blank":blank,
            "conflictingGroups":len(conflicts),"conflictingOccurrences":sum(multiplicity[k] for k in conflicts),"exclusions":dict(exclusions)},
            "method":{"strictPositive":"normal, confirmed BLOCK","protection":"normal confirmed BLOCK/MASK/REWRITE/SAFE_RESPONSE/REQUIRE_REVIEW; offline action only",
                      "pairedDenominator":"both versions execute without degradation; source label/weak labels kept separate; blank and conflict groups excluded",
                      "dedupKey":"dataset/split/role/normalizedTextSha256; first occurrence",
                      "nativeTrainDisjoint":"native test split, deduplicated, no exact normalized text in same dataset/role train",
                      "operationalConservative":"source-labeled positives include blanks/conflicts/duplicates/faults; faults never become TP. Benign unavailable/intervened counts all fault states and restrictive offline actions; not HTTP enforcement proof.",
                      "labelsReannotated":False,"latencyCapacityBenchmark":False,"httpTransportVerifiedByThisReplay":False,
                      "limitations":["Native test sets were already inspected during design, so they are not independent holdout.",
                                     "Confirmed risk names may not align with source harm labels; this report does not certify reason alignment.",
                                     "Shared machine ran concurrent replay/build; latency is descriptive only.",
                                     "No real ASR/OCR/VLM semantic quality or adaptive attacker success rate is established."]},
            "groups":groups,"batchSummaries":batch_summaries,"resultHashes":result_hashes,"changes":dict(changes),"ablations":ablations,
            "qualityGate":{"state":"BLOCKED","checks":gate_checks,"thresholds":{"minCases":2000,"accuracy":.95,"recall":.95,"fpr":.01,"fnr":.05},
                           "candidateActivationAllowed":False}}
    save(out/"paired-analysis.json",report)
    for filename in ["code-index.json","rule-audit.json"]:
        shutil.copy2(candidate/filename,out/filename)
    save(out/"validation.json",{"status":"PASS_WITH_QUALITY_BLOCK","caseIdentityOrderTextLabelHashesVerified":True,
        "resultRows":matched,"groupsSamePairedDenominator":all(v["baseline"]["scored"]==v["candidate"]["scored"] for v in groups.values()),
        "sourceScripts":[str(Path(__file__))],"externalModelCalls":0,"independentHoldoutQualified":False,
        "artifacts":{p.name:file_hash(p) for p in [out/"paired-analysis.json",out/"changed-cases.jsonl",out/"candidate-failures.jsonl"]}})
    print(json.dumps({"coverage":report["coverage"],"all":groups["all"],"native":groups["native_test_dedup_train_disjoint"],
                      "qualityGate":report["qualityGate"]},ensure_ascii=False))
if __name__=="__main__":main()
