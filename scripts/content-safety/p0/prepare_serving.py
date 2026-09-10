"""Select calibration-qualified heads for a reproducible SHADOW-only serving profile."""
import argparse
import hashlib
import json
from pathlib import Path
from model_identity import verify_model_artifact


def profile_digest(contract):
    return 'sha256:' + hashlib.sha256(json.dumps(contract,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--model',required=True);args=parser.parse_args()
    folder=Path(args.model);meta=verify_model_artifact(folder)
    cal=json.loads((folder/'calibration.json').read_text(encoding='utf-8'));spec=json.loads((folder/'classifier-shadow-config.json').read_text(encoding='utf-8'))
    enabled=[label for label in meta['labels'] if cal[label]['targetMetOnCalibration']]
    if not enabled:raise ValueError('NO_CALIBRATION_QUALIFIED_HEADS')
    contract={'baseModelSha256':meta['modelSha256'],'enabledLabels':enabled,'maximumTokens':meta['maximumTokens'],'compute':'fp32_weights_fp16_autocast'}
    spec.update(modelId=meta['modelId']+'-candidate-heads',modelSha256=profile_digest(contract),mode='SHADOW',failurePolicy='DEGRADE',
                labels=[label for label in spec['labels'] if label['label'] in enabled])
    profile={'mode':'SHADOW','baseModelSha256':meta['modelSha256'],'enabledLabels':enabled,'inferenceContract':contract,
             'excludedLabels':[label for label in meta['labels'] if label not in enabled],'classifierConfig':spec,
             'productionEligible':False,'selectionBasis':'calibration_gate_only_not_independent_human_approval'}
    for name,value in [('serving-profile.json',profile),('classifier-shadow-selected.json',spec)]:
        (folder/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'enabledLabels':enabled,'excludedLabels':profile['excludedLabels'],'modelSha256':spec['modelSha256']}))
if __name__=='__main__':main()
