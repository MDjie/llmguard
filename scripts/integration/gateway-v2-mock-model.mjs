import https from 'node:https';
import { readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
const directory = path.resolve('.artifact-build/upgrade-implementation-20260907/environment/tls');
const calls = [];
const windows = new Map();
const server = https.createServer({ cert:readFileSync(path.join(directory,'server.crt')), key:readFileSync(path.join(directory,'server.key')), ca:readFileSync(path.join(directory,'ca.crt')), requestCert:true, rejectUnauthorized:true }, async (request, response) => {
  if (request.url === '/test/calls') { response.setHeader('content-type','application/json'); response.end(JSON.stringify(calls)); return; }
  if (request.url?.startsWith('/test/windows')) {
    const url = new URL(request.url, 'https://127.0.0.1'); const tag = url.searchParams.get('tag'); const entry = windows.get(tag);
    if (request.method === 'POST') entry?.resume();
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(entry ? { finished:entry.finished, closed:entry.closed } : null)); return;
  }
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  const chunks = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 1048576) { response.writeHead(413).end(); return; } chunks.push(chunk); }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { response.writeHead(400).end(); return; }
  calls.push(body);
  if (calls.length > 1000) calls.shift();
  const text = body.messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
  if(text.includes('NATIVE_OUTPUT_INLINE')||text.includes('NATIVE_OUTPUT_REMOTE')){
    const media={type:'image_url',image_url:{url:text.includes('NATIVE_OUTPUT_REMOTE')?'https://untrusted.example.invalid/private-output':'data:image/png;base64,YQ=='}};
    if(body.stream){response.writeHead(200,{'content-type':'text/event-stream'});response.end('data: '+JSON.stringify({id:'native-output',choices:[{index:0,delta:{content:[media]},finish_reason:null}]})+'\n\ndata: [DONE]\n\n');}
    else {response.setHeader('content-type','application/json');response.end(JSON.stringify({id:'native-output',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:[media]},finish_reason:'stop'}]}));}return;
  }
  const benchmark = /^GATEWAY_BENCHMARK (G0|G1|G2) ([a-f0-9-]{36}) /u.exec(text);
  const benchmarkStarted = performance.now();
  if (benchmark) response.once('finish', () => appendFileSync(path.join(directory,'../benchmark-upstream-timings.jsonl'), JSON.stringify({ requestId:benchmark[2], elapsedMs:performance.now()-benchmarkStarted })+'\n'));
  const content = benchmark ? 'x'.repeat(benchmark[1] === 'G1' ? 8192 : 1024) : text.includes('OUTPUT_SAFE_CASE') ? 'SYNTHETIC_SAFE_MARKER' : text.includes('OUTPUT_REWRITE_CASE') ? 'SYNTHETIC_REWRITE_MARKER' : text.includes('OUTPUT_REVIEW_CASE') ? 'SYNTHETIC_REVIEW_MARKER' : text.includes('OUTPUT_WARN_CASE') ? 'SYNTHETIC_WARN_MARKER' : text.includes('OUTPUT_PHONE_CASE') ? '测试联系电话：13800138000' : text.includes('OUTPUT_BLOCK_CASE') ? 'SYNTHETIC_BLOCK_MARKER' : '这是经过真实检测的模拟模型答复。';
  if (text.includes('DELAY_CASE')) await new Promise(resolve => setTimeout(resolve, 2500));
  const sseBenchmark = /^GATEWAY_SSE_BENCHMARK ([a-f0-9-]{36}) ([0-9]{1,2})$/u.exec(text);
  if (body.stream && sseBenchmark) {
    const seconds=Number(sseBenchmark[2]);if(seconds<5||seconds>45){response.writeHead(400).end();return;}
    const begin=performance.now();let count=0;
    response.once('finish',()=>appendFileSync(path.join(directory,'../benchmark-sse-upstream-timings.jsonl'),JSON.stringify({requestId:sseBenchmark[1],elapsedMs:performance.now()-begin,contentEvents:count,contentBytes:count*32,requestedSeconds:seconds})+'\n'));
    response.writeHead(200,{'content-type':'text/event-stream'});
    for(let index=0;index<seconds*20;index++){
      if(response.destroyed)return;
      const delay=begin+index*50-performance.now();if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
      if(response.destroyed)return;
      const writable=response.write('data: '+JSON.stringify({id:'sse-load-model',object:'chat.completion.chunk',choices:[{index:0,delta:{content:'x'.repeat(32)},finish_reason:null}]})+'\n\n');count++;
      if(!writable)await new Promise(resolve=>{const done=()=>{response.off('drain',done);response.off('close',done);resolve();};response.once('drain',done);response.once('close',done);});
    }
    if(!response.destroyed)response.end('data: '+JSON.stringify({id:'sse-load-model',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
    return;
  }
  if (body.stream && text.includes('WINDOW_')) {
    const tag = text.trim();
    let resume; const barrier = new Promise(resolve => { resume = resolve; });
    const state = { finished:false, closed:false, resume }; windows.set(tag, state); if (windows.size > 100) windows.delete(windows.keys().next().value);
    response.on('close', () => { state.closed=true; resume(); });
    response.writeHead(200, { 'content-type':'text/event-stream' });
    const send = (fragment, finish = null) => response.write('data: '+JSON.stringify({id:'window-model',object:'chat.completion.chunk',choices:[{index:0,delta:{content:fragment},finish_reason:finish}]})+'\n\n');
    const prefix = '正常答复与公开信息。'.repeat(800);
    const output = tag.includes('WINDOW_BLOCK') ? prefix.slice(0,3070)+'SYNTHETIC_BLOCK_MARKER'+prefix.slice(3100) : tag.includes('WINDOW_MASK') ? prefix.slice(0,3070)+'13800138000'+prefix.slice(3100) : prefix;
    send(output.slice(0,1536));
    let timeout; await Promise.race([barrier,new Promise(resolve => { timeout=setTimeout(resolve,20000); })]); clearTimeout(timeout);
    if (response.destroyed) return;
    for (let offset=1536;offset<output.length;offset+=160) {
      if (response.destroyed) return;
      send(output.slice(offset,offset+160)); await new Promise(resolve => setTimeout(resolve,20));
    }
    if (tag.includes('WINDOW_TOOL')) response.write('data: '+JSON.stringify({id:'window-model',object:'chat.completion.chunk',choices:[{index:0,delta:{tool_calls:[{index:0,id:'call1',type:'function',function:{name:'unsafe',arguments:'{}'}}]},finish_reason:null}]})+'\n\n');
    send('', 'stop');
    if (!tag.includes('WINDOW_TRUNCATED')) response.write('data: [DONE]\n\n');
    state.finished=true; response.end(); return;
  }
  if (body.stream) {
    response.writeHead(200, { 'content-type':'text/event-stream' });
    const events = [];
    for (const fragment of [...content]) events.push({ id:'synthetic-completion',object:'chat.completion.chunk',choices:[{index:0,delta:{content:fragment},finish_reason:null}] });
    events.push({ id:'synthetic-completion',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30} });
    const wire = Buffer.from(events.map(event => 'data: '+JSON.stringify(event)+'\n\n').join('') + (text.includes('TRUNCATED_CASE') ? '' : 'data: [DONE]\n\n'));
    // Deliberately split UTF-8 code points, SSE lines, and JSON tokens across writes.
    for (let offset = 0; offset < wire.length; offset += 7) { if (response.destroyed) break; response.write(wire.subarray(offset, offset + 7)); }
    response.end();
  } else {
    response.setHeader('content-type','application/json');
    response.end(JSON.stringify({ id:'synthetic-completion',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30} }));
  }
});
server.listen(58088,'0.0.0.0',() => console.log('Synthetic model capture server listening on loopback:58088'));
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => server.close());
