import { createServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport, isInputRequiredResult } from '@modelcontextprotocol/client';
import { Ajv2020 } from 'ajv/dist/2020.js';

type Args = Record<string,string>;
type Message = { messageId:string; role:string; parts:{text:string}[]; taskId?:string; contextId?:string };
type Task = { id:string; contextId:string; status:{state:string; timestamp:string; message?:Message}; history:Message[]; artifacts:{artifactId:string;name:string;parts:{text:string}[]}[] };
type PrivateTask = { public:Task; args:Args; trace:string; requestState?:string; key?:string; alternatives:string[]; busy:boolean };
const tasks = new Map<string,PrivateTask>();
const terminal = new Set(['TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED']);
const client = new Client({name:'agente-central-de-salas',version:'1.0.0'}, { capabilities:{elicitation:{form:{}}}, versionNegotiation:{mode:{pin:'2026-07-28'}}, inputRequired:{autoFulfill:false} });
const transport = new StreamableHTTPClientTransport(new URL(process.env.MCP_URL ?? 'http://localhost:7301/mcp'));
let connection:Promise<void> | undefined;
const ajv = new Ajv2020({strict:false});
function meta(trace:string) { return { 'io.modelcontextprotocol/protocolVersion':'2026-07-28', 'io.modelcontextprotocol/clientCapabilities':{elicitation:{form:{}}}, traceparent:trace }; }
function change(t:PrivateTask,state:string,text?:string) {
  if (terminal.has(t.public.status.state)) throw new Error('Task terminal');
  const message:Message | undefined = text === undefined ? undefined : {messageId:randomUUID(),role:'ROLE_AGENT',parts:[{text}],taskId:t.public.id,contextId:t.public.contextId};
  t.public.status = {state,timestamp:new Date().toISOString(),...(message ? {message} : {})};
  if (message) t.public.history.push(message);
}
function pause(t:PrivateTask) { change(t,'TASK_STATE_INPUT_REQUIRED',`alternativas: ${t.alternatives.join(', ')}`); }
async function execute(t:PrivateTask,choice?:string) {
  t.busy = true; change(t,'TASK_STATE_WORKING');
  try {
    connection ??= client.connect(transport).catch(e => {connection=undefined;throw e;});
    await connection;
    const discovered = await client.listTools({_meta:meta(t.trace)}, {cacheMode:'bypass'});
    const tool = discovered.tools.find(tool=>tool.name === 'reservar_sala');
    if (!tool) throw new Error('Tool reservar_sala nao descoberta');
    if (!ajv.compile(tool.inputSchema)(t.args)) throw new Error('Argumentos invalidos');
    const resource = await client.readResource({uri:'politica://uso',_meta:meta(t.trace)}, {cacheMode:'bypass'});
    const text = resource.contents.map(c=>'text' in c ? c.text : '').join('\n');
    const version = /^versao:\s*(.+)$/m.exec(text)?.[1];
    if (!version) throw new Error('Versao da politica ausente');
    const retry = choice === undefined ? {} : {requestState:t.requestState!,inputResponses:{[t.key!]:choice === 'recusar' ? {action:'decline' as const} : {action:'accept' as const,content:{sala:choice}}}};
    const outcome = await client.callTool({name:tool.name,arguments:t.args,_meta:meta(t.trace),...retry},{allowInputRequired:true});
    if (isInputRequiredResult(outcome)) {
      const entries = Object.entries(outcome.inputRequests ?? {});
      if (entries.length !== 1 || !outcome.requestState) throw new Error('Pergunta MCP invalida');
      const [key,request] = entries[0];
      if (request.method !== 'elicitation/create' || request.params.mode !== 'form') throw new Error('Elicitation nao suportada');
      const field = request.params.requestedSchema.properties.sala;
      const schema = field as {enum?:string[]; const?:string};
      t.key=key; t.requestState=outcome.requestState; t.alternatives=schema.enum ?? (schema.const ? [schema.const] : []);
      pause(t); return;
    }
    const visible = outcome.content.map(c=>'text' in c ? c.text : '').join(' ');
    if (outcome.isError) { change(t,'TASK_STATE_FAILED',visible); return; }
    const data = outcome.structuredContent as Record<string,unknown> | undefined;
    if (!data) throw new Error('Resultado MCP sem structuredContent');
    if (data.reservado === false) { change(t,'TASK_STATE_CANCELED',String(data.motivo)); return; }
    t.public.artifacts.push({artifactId:randomUUID(),name:'reserva',parts:[{text:JSON.stringify({...data,politica:version})}]});
    change(t,'TASK_STATE_COMPLETED',`Reserva ${data.reserva} confirmada na ${data.sala}.`);
  } catch (e) { change(t,'TASK_STATE_FAILED',e instanceof Error ? e.message : 'Falha MCP'); }
  finally { t.busy=false; if (terminal.has(t.public.status.state)) {t.requestState=undefined;t.key=undefined;t.alternatives=[];} }
}
class RpcError extends Error { constructor(public code:number,message:string) {super(message);} }
function object(value:unknown): value is Record<string,unknown> {return typeof value==='object' && value!==null && !Array.isArray(value);}
function parseMessage(value:unknown):Message {
  if (!object(value) || typeof value.messageId!=='string' || value.role!=='ROLE_USER' || !Array.isArray(value.parts) || !value.parts.length || !value.parts.every(p=>object(p) && typeof p.text==='string') || (value.taskId!==undefined && typeof value.taskId!=='string')) throw new RpcError(-32602,'Mensagem invalida');
  return {messageId:value.messageId,role:'ROLE_USER',parts:value.parts.map(p=>({text:p.text})),...(typeof value.taskId==='string'?{taskId:value.taskId}:{})};
}
function traceContext(value:string|undefined) { return value && /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(value) ? value : `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`; }
async function dispatch(method:string,params:Record<string,unknown>,trace?:string) {
  if (method==='GetTask') {
    if (typeof params.id!=='string') throw new RpcError(-32602,'id obrigatorio');
    const task=tasks.get(params.id); if (!task) throw new RpcError(-32001,'TaskNotFoundError');
    return {task:task.public};
  }
  if (method!=='SendMessage') throw new RpcError(-32004,'UnsupportedOperationError');
  const message=parseMessage(params.message);
  const text=message.parts.map(p=>p.text).join(' ');
  if (message.taskId) {
    const task=tasks.get(message.taskId); if (!task) throw new RpcError(-32001,'TaskNotFoundError');
    if (terminal.has(task.public.status.state) || task.busy || task.public.status.state!=='TASK_STATE_INPUT_REQUIRED') throw new RpcError(-32004,'UnsupportedOperationError');
    task.public.history.push(message);
    const choice=/^escolha=(\S+)$/.exec(text)?.[1];
    if (!choice || (choice!=='recusar' && !task.alternatives.includes(choice))) {pause(task);return {task:task.public};}
    await execute(task,choice); return {task:task.public};
  }
  const parsed=/^reservar sala=(\S+) inicio=(\S+) fim=(\S+) responsavel=(.+)$/.exec(text);
  if (!parsed) throw new RpcError(-32602,'Formato de pedido invalido');
  const task:PrivateTask={public:{id:randomUUID(),contextId:randomUUID(),status:{state:'TASK_STATE_SUBMITTED',timestamp:new Date().toISOString()},history:[message],artifacts:[]},args:{sala:parsed[1],inicio:parsed[2],fim:parsed[3],responsavel:parsed[4]},trace:traceContext(trace),alternatives:[],busy:false};
  tasks.set(task.public.id,task);
  await execute(task); return {task:task.public};
}
const port=Number(process.env.AGENTE_PORT ?? 7300);
const card={name:'Central de Salas',description:'Reserva salas de reuniao da Hill Valley Tech.',version:'1.0.0',supportedInterfaces:[{url:process.env.A2A_URL ?? `http://localhost:${port}/a2a`,protocolBinding:'JSONRPC',protocolVersion:'1.0'}],capabilities:{streaming:false,pushNotifications:false,extendedAgentCard:false},defaultInputModes:['text/plain'],defaultOutputModes:['text/plain'],skills:[{id:'reservar-sala',name:'Reservar sala',description:'Reserva salas e solicita alternativas em caso de conflito.',tags:['salas','agenda']}]};
createServer(async(req,res)=>{
  const respond=(data:unknown,status=200)=>res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(data));
  if(req.method==='GET' && req.url==='/.well-known/agent-card.json') {respond(card);return;}
  if(req.method!=='POST' || req.url!=='/a2a') {respond({error:'Not found'},404);return;}
  let id:unknown=null;
  try {
    const chunks=[];for await(const chunk of req) chunks.push(Buffer.from(chunk));
    let body:unknown;try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{throw new RpcError(-32700,'Invalid JSON');}
    if(!object(body) || body.jsonrpc!=='2.0' || typeof body.method!=='string' || !object(body.params) || !('id' in body)) throw new RpcError(-32600,'Invalid Request');
    id=body.id;
    const result=await dispatch(body.method,body.params,typeof req.headers.traceparent==='string'?req.headers.traceparent:undefined);
    respond({jsonrpc:'2.0',id,result});
  }catch(e){respond({jsonrpc:'2.0',id,error:{code:e instanceof RpcError?e.code:-32603,message:e instanceof RpcError?e.message:'Internal error'}});}
}).listen(port,()=>console.error('Agente pronto'));
