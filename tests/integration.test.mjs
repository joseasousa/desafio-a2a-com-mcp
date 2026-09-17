import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { createRequestStateCodec } from '@modelcontextprotocol/server';
import { createServer } from 'node:http';

const secret = randomBytes(32).toString('hex');
const trace = `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
const meta = {'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{elicitation:{form:{}}},traceparent:trace};
const args = {sala:'sala-garagem',inicio:'2026-11-03T14:00:00-03:00',fim:'2026-11-03T15:00:00-03:00',responsavel:'Doc'};
const delay = ms=>new Promise(r=>setTimeout(r,ms));
function start(file,env={}) {
  const child=spawn(process.execPath,[file],{env:{...process.env,REQUEST_STATE_SECRET:secret,...env},stdio:['ignore','pipe','pipe']});
  child.logs='';child.stderr.on('data',b=>child.logs+=b);
  return child;
}
async function ready(child) {
  for(let i=0;i<100;i++){if(child.logs.includes('pronto'))return;if(child.exitCode!==null)throw new Error(child.logs);await delay(30);}
  throw new Error('Startup timeout');
}
async function stop(child){if(child.exitCode===null && child.signalCode===null){child.kill();await once(child,'exit');}}
async function rpc(url,method,params,headers={}) {
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method,params})});
  return {status:response.status,body:await response.json()};
}
function mcp(method,params,headers={}) {
  return rpc('http://localhost:7301/mcp',method,{...params,_meta:meta},{accept:'application/json, text/event-stream','MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...(params.name||params.uri?{'Mcp-Name':params.name??params.uri}:{}),...headers});
}
function call(a=args,extra={}){return mcp('tools/call',{name:'reservar_sala',arguments:a,...extra});}
function retry(result,action='accept',sala='sala-fusca',a=args){return call(a,{requestState:result.requestState,inputResponses:{[Object.keys(result.inputRequests)[0]]:{action,...(action==='accept'?{content:{sala}}:{})}}});}
test('validador intacto, restart, integridade, politica e logs',async()=>{
  let server=start('dist/servidor-mcp/index.js');const agent=start('dist/agente/index.js');
  try{
    await Promise.all([ready(server),ready(agent)]);
    const validator=spawn('python3',['validador/validar.py']);let output='';validator.stdout.on('data',b=>output+=b);validator.stderr.on('data',b=>output+=b);
    const [code]=await once(validator,'exit');assert.equal(code,0,output);assert.equal((output.match(/^PASS /gm)??[]).length,36);
    writeFileSync('/tmp/a-ponte-validacao.txt',output);
    const validationTrace=/trace-id desta execucao: (\w+)/.exec(output)[1];assert.ok(server.logs.includes(validationTrace));
    const log=server.logs.split('\n').filter(l=>l.startsWith('{')).map(JSON.parse);
    assert.ok(log.findIndex(l=>l.method==='tools/list')<log.findIndex(l=>l.method==='tools/call'));
    assert.equal(new Set(log.map(l=>l.id)).size,log.length);assert.ok(!server.logs.includes('requestState'));
    await stop(server);server=start('dist/servidor-mcp/index.js');await ready(server);
    const paused=(await call()).body.result;assert.equal(paused.resultType,'input_required');
    await stop(server);server=start('dist/servidor-mcp/index.js');await ready(server);
    const resumed=await retry(paused,'accept','sala-fusca',{...args,responsavel:'Biff',inicio:'2026-11-03T10:00:00-03:00'});
    assert.equal(resumed.body.result.structuredContent.responsavel,'Doc');assert.equal(resumed.body.result.structuredContent.inicio,args.inicio);
    const next=(await call()).body.result;assert.equal((await retry(next,'cancel')).body.result.structuredContent.reservado,false);
    assert.equal((await retry({...next,requestState:next.requestState.slice(0,-6)+'AAAAAA'})).body.error.code,-32602);
    assert.equal((await mcp('tools/call',{name:'listar_salas',arguments:{},requestState:next.requestState})).body.error.code,-32602);
    const mismatch=await mcp('tools/list',{}, {'Mcp-Method':'tools/call'});assert.equal(mismatch.status,400);assert.equal(mismatch.body.error.code,-32020);
    const codec=createRequestStateCodec({key:Buffer.from(secret,'hex'),ttlSeconds:600});
    const originalNow=Date.now;let expired;
    try{Date.now=()=>originalNow()-601000;expired=await codec.mint({method:'tools/call',tool:'reservar_sala',args,key:'x',alternatives:['sala-mirante']});}finally{Date.now=originalNow;}
    assert.equal((await call(args,{requestState:expired,inputResponses:{x:{action:'cancel'}}})).body.error.code,-32602);
    const range=(sala,inicio,fim)=>({...args,sala,inicio:`2026-11-04T${inicio}:00-03:00`,fim:`2026-11-04T${fim}:00-03:00`});
    assert.equal((await call(range('sala-aquario','08:00','10:00'))).body.result.structuredContent.reservado,true);
    assert.equal((await call(range('sala-aquario','10:00','11:00'))).body.result.structuredContent.reservado,true);
    assert.equal((await call(range('sala-aquario','18:00','20:00'))).body.result.structuredContent.reservado,true);
    assert.ok((await call(range('sala-aquario','19:00','20:01'))).body.result.isError);
    const utc={...range('sala-porao','08:00','09:00'),inicio:'2026-11-04T11:00:00Z',fim:'2026-11-04T12:00:00Z'};
    assert.equal((await call(utc)).body.result.structuredContent.reservado,true);
    await call(range('sala-mirante','12:00','13:00'));assert.match((await call(range('sala-mirante','12:00','13:00'))).body.result.content[0].text,/Sem alternativas/);
    const notFound=await rpc('http://localhost:7300/a2a','GetTask',{id:'unknown'});assert.equal(notFound.body.error.code,-32001);
    const invalid=start('dist/servidor-mcp/index.js',{REQUEST_STATE_SECRET:'bad'});const [invalidCode]=await once(invalid,'exit');assert.notEqual(invalidCode,0);
  }finally{await Promise.all([stop(server),stop(agent)]);}
});

test('GetTask mostra WORKING enquanto MCP aguarda',async()=>{
  let release;const gate=new Promise(r=>release=r);let taskId;let reached;const called=new Promise(r=>reached=r);
  const mock=createServer(async(req,res)=>{
    const chunks=[];for await(const b of req)chunks.push(b);const body=JSON.parse(Buffer.concat(chunks));
    if(body.method==='tools/call'){reached();await gate;}
    const result=body.method==='tools/list'?{tools:[{name:'reservar_sala',inputSchema:{type:'object'}}]}:body.method==='resources/read'?{contents:[{uri:'politica://uso',text:'versao: 2026-11-01',mimeType:'text/markdown'}]}:{isError:false,content:[],structuredContent:{reservado:true,reserva:'r',sala:'sala-garagem'}};
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{resultType:'complete',ttlMs:0,cacheScope:'private',...result}}));
  });
  await new Promise(r=>mock.listen(7391,r));
  // A paused task exposes its identity before a continuation starts working.
  let real=start('dist/servidor-mcp/index.js',{MCP_PORT:'7392'});let agent=start('dist/agente/index.js',{AGENTE_PORT:'7390',MCP_URL:'http://localhost:7392/mcp'});
  try{
    await Promise.all([ready(real),ready(agent)]);
    const send=(text,id)=>rpc('http://localhost:7390/a2a','SendMessage',{message:{messageId:randomUUID(),role:'ROLE_USER',parts:[{text}],...(id?{taskId:id}:{})}});
    const pause=(await send(`reservar sala=${args.sala} inicio=${args.inicio} fim=${args.fim} responsavel=Doc`)).body.result.task;taskId=pause.id;
    // Route the already connected client to a controlled MCP at the same address.
    await stop(real);await new Promise(r=>mock.close(r));await new Promise(r=>mock.listen(7392,r));
    const running=send('escolha=sala-fusca',taskId);await Promise.race([called,running.then(r=>{throw new Error(JSON.stringify(r));}),delay(3000).then(()=>{throw new Error('MCP mock timeout '+agent.logs);})]);
    const state=(await rpc('http://localhost:7390/a2a','GetTask',{id:taskId})).body.result.task;
    assert.equal(state.status.state,'TASK_STATE_WORKING');assert.ok(!JSON.stringify(state).includes('requestState'));
    release();assert.equal((await running).body.result.task.status.state,'TASK_STATE_COMPLETED');
  }finally{release();await Promise.all([stop(real),stop(agent)]);mock.closeAllConnections();await new Promise(r=>mock.close(r));}
});
