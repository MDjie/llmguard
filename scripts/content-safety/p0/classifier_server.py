"""Loopback-only classifier endpoint for the project's SHADOW classifier protocol."""
import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import torch
from transformers import AutoTokenizer, AutoModelForSequenceClassification
from runtime import calibrated
from model_identity import verify_model_artifact
from prepare_serving import profile_digest


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--model',required=True);parser.add_argument('--profile',required=True);parser.add_argument('--port',type=int,default=58193);args=parser.parse_args()
    folder=Path(args.model);meta=verify_model_artifact(folder)
    profile=json.loads(Path(args.profile).read_text(encoding='utf-8'));config=profile['classifierConfig'];enabled=profile['enabledLabels']
    contract={'baseModelSha256':meta['modelSha256'],'enabledLabels':enabled,'maximumTokens':meta['maximumTokens'],'compute':'fp32_weights_fp16_autocast'}
    if profile['mode']!='SHADOW' or config['mode']!='SHADOW' or profile['inferenceContract']!=contract or config['modelSha256']!=profile_digest(contract) or not enabled or len(set(enabled))!=len(enabled) or not set(enabled)<=set(meta['labels']) or [x['label'] for x in config['labels']]!=enabled:raise ValueError('SERVING_PROFILE_INVALID')
    calibration=json.loads((folder/'calibration.json').read_text(encoding='utf-8'))
    if not torch.cuda.is_available():raise ValueError('CUDA_REQUIRED_FOR_FP16_CLASSIFIER')
    torch.set_num_threads(2)
    tokenizer=AutoTokenizer.from_pretrained(folder/'weights',local_files_only=True)
    model=AutoModelForSequenceClassification.from_pretrained(folder/'weights',local_files_only=True).to('cuda').eval()
    identity={'id':config['modelId'],'version':config['modelVersion'],'sha256':config['modelSha256'],'quantization':'FP16'}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):pass
        def respond(self,status,body):
            data=json.dumps(body,ensure_ascii=False,allow_nan=False).encode('utf-8')
            self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        def do_GET(self):
            if self.path=='/health':self.respond(200,{'status':'ready','mode':'SHADOW','model':identity})
            else:self.respond(404,{'error':'NOT_FOUND'})
        def do_POST(self):
            if self.path!='/classify':self.respond(404,{'error':'NOT_FOUND'});return
            try:
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=1048576:self.respond(413,{'error':'REQUEST_SIZE_LIMIT'});return
                body=json.loads(self.rfile.read(size));items=body['items']
                if body.get('model')!=identity or body.get('operation')!='classify' or body.get('schemaVersion')!='1.0':
                    self.respond(400,{'error':'MODEL_OR_PROTOCOL_IDENTITY_MISMATCH'});return
                if not 1<=len(items)<=32 or len({i['id'] for i in items})!=len(items):raise ValueError('ITEMS_INVALID')
                if any(not isinstance(i.get('text'),str) or not isinstance(i.get('id'),str) or len(i['id'])>256 or len(i['text'])>32000 for i in items):raise ValueError('ITEMS_INVALID')
                encoded=tokenizer([i['text'] for i in items],padding=True,return_tensors='pt')
                if encoded['input_ids'].shape[1]>meta['maximumTokens']:
                    self.respond(422,{'error':'CLASSIFIER_WINDOW_REQUIRED','maximumTokens':meta['maximumTokens']});return
                with torch.inference_mode(), torch.autocast('cuda',dtype=torch.float16):logits=model(**encoded.to('cuda')).logits.float().cpu().numpy()
                predicted=[{'id':row['id'],'labels':[{'label':label,'confidence':float(calibrated(logits[n,i],calibration[label]['parameters']))}
                    for i,label in enumerate(meta['labels']) if label in enabled]} for n,row in enumerate(items)]
                self.respond(200,{'modelId':config['modelId'],'modelVersion':config['modelVersion'],'modelSha256':config['modelSha256'],'items':predicted})
            except (ValueError,KeyError,TypeError):self.respond(400,{'error':'INVALID_CLASSIFICATION_REQUEST'})
            except Exception:self.respond(500,{'error':'CLASSIFIER_EXECUTION_ERROR'})
    server=HTTPServer(('127.0.0.1',args.port),Handler)
    print(json.dumps({'status':'READY','host':'127.0.0.1','port':args.port,'modelId':meta['modelId'],'mode':'SHADOW'}),flush=True)
    try:server.serve_forever()
    finally:server.server_close()
if __name__=='__main__':main()
