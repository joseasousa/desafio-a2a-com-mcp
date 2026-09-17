import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { McpServer, createMcpHandler, createRequestStateCodec, inputRequired, ProtocolError } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';

type Args = { sala: string; inicio: string; fim: string; responsavel: string };
type Reserva = Args & { id: string };
type Sala = { id: string; nome: string; capacidade: number; recursos: string[] };
type State = { method: string; tool: string; args: Args; key: string; alternatives: string[] };
const secret = process.env.REQUEST_STATE_SECRET ?? '';
if (!/^(?:[a-fA-F0-9]{2}){32,}$/.test(secret)) throw new Error('REQUEST_STATE_SECRET deve ser hexadecimal com pelo menos 32 bytes');
const codec = createRequestStateCodec<State>({ key: Buffer.from(secret, 'hex'), ttlSeconds: 600 });
const salas: Sala[] = JSON.parse(readFileSync('dados/salas.json', 'utf8'));
const iniciais: Reserva[] = JSON.parse(readFileSync('dados/reservas.json', 'utf8'));
const criadas: Reserva[] = [];
const politica = readFileSync('dados/politica-de-uso.md', 'utf8');
const versao = politica.split('\n')[0].replace(/^versao:\s*/, '');
const intervalo = z.object({ sala: z.string(), inicio: z.string(), fim: z.string() });
const argumentos = intervalo.extend({ responsavel: z.string() });
function result(data: Record<string, unknown>, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data, isError };
}
function failure(message: string) {
  return { content: [{ type: 'text' as const, text: message }], structuredContent: { erro: message }, isError: true };
}
function validate(a: z.infer<typeof intervalo>): string | undefined {
  if (!salas.some(s => s.id === a.sala)) return `Sala inexistente: ${a.sala}`;
  const start = Date.parse(a.inicio), end = Date.parse(a.fim);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 'Intervalo invalido: fim deve ser posterior a inicio';
  if (end - start > 7200000) return 'Duracao acima do limite: a politica permite no maximo 2 horas';
  const localStart = new Date(start - 10800000), localEnd = new Date(end - 10800000);
  const hour = (d: Date) => d.getUTCHours() + d.getUTCMinutes()/60 + d.getUTCSeconds()/3600 + d.getUTCMilliseconds()/3600000;
  if (localStart.toISOString().slice(0,10) !== localEnd.toISOString().slice(0,10) || hour(localStart) < 8 || hour(localEnd) > 20)
    return 'Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00';
}
function conflicts(a: z.infer<typeof intervalo>) {
  return [...iniciais, ...criadas].filter(r => r.sala === a.sala && Date.parse(a.inicio) < Date.parse(r.fim) && Date.parse(r.inicio) < Date.parse(a.fim));
}
function book(a: Args) {
  const id = `res-${String(iniciais.length + criadas.length + 1).padStart(4,'0')}`;
  criadas.push({ id, ...a });
  return result({ reserva: id, reservado: true, ...a, politica: versao, motivo: null });
}
const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'central-de-salas', version: '1.0.0' }, { requestState: { verify: codec.verify }, inputRequired: { legacyShim: false } });
  server.registerTool('listar_salas', { description: 'Lista salas', inputSchema: z.object({}), outputSchema: z.object({ salas: z.array(z.object({ id:z.string(),nome:z.string(),capacidade:z.number().int(),recursos:z.array(z.string()) })) }) }, async () => result({ salas }));
  server.registerTool('consultar_disponibilidade', { description: 'Consulta disponibilidade', inputSchema: intervalo, outputSchema: z.object({sala:z.string(),livre:z.boolean(),conflitos:z.array(z.object({id:z.string(),inicio:z.string(),fim:z.string(),responsavel:z.string()}))}) }, async a => {
    const error = validate(a); if (error) return failure(error);
    const encontrados = conflicts(a).map(({sala, ...r}) => r);
    return result({ sala: a.sala, livre: encontrados.length === 0, conflitos: encontrados });
  });
  server.registerTool('reservar_sala', { description: 'Reserva uma sala', inputSchema: argumentos, outputSchema: z.object({reservado:z.boolean(),reserva:z.string().nullable().optional(),sala:z.string().nullable().optional(),inicio:z.string().nullable().optional(),fim:z.string().nullable().optional(),responsavel:z.string().nullable().optional(),politica:z.string().nullable().optional(),motivo:z.string().nullable().optional()}) }, async (incoming, ctx) => {
    const state = ctx.mcpReq.requestState<State>();
    if (state) {
      if (state.method !== 'tools/call' || state.tool !== 'reservar_sala') throw new ProtocolError(-32602, 'Estado vinculado a outra operacao');
      const response = ctx.mcpReq.inputResponses?.[state.key] as {action?:string;content?:Record<string,unknown>} | undefined;
      if (!response || !('action' in response)) throw new ProtocolError(-32602, 'Resposta ausente');
      if (response.action === 'decline' || response.action === 'cancel') return result({ reservado: false, motivo: 'recusado' });
      const choice = response.content?.sala;
      if (response.action !== 'accept' || typeof choice !== 'string' || !state.alternatives.includes(choice)) throw new ProtocolError(-32602, 'Alternativa invalida');
      const a = { ...state.args, sala: choice };
      const error = validate(a); if (error) return failure(error);
      if (conflicts(a).length) return failure('Sem alternativas disponiveis no intervalo');
      return book(a);
    }
    if (ctx.mcpReq.inputResponses) throw new ProtocolError(-32602, 'requestState obrigatorio no retry');
    const error = validate(incoming); if (error) return failure(error);
    if (!conflicts(incoming).length) return book(incoming);
    const capacidade = salas.find(s => s.id === incoming.sala)!.capacidade;
    const alternatives = salas.filter(s => s.capacidade >= capacidade && !conflicts({ ...incoming, sala:s.id }).length).sort((a,b) => a.capacidade-b.capacidade || a.id.localeCompare(b.id)).slice(0,3).map(s=>s.id);
    if (!alternatives.length) return failure('Sem alternativas disponiveis no intervalo');
    const key = randomUUID();
    return inputRequired({ inputRequests: { [key]: inputRequired.elicit({ message:'A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.', requestedSchema: { type:'object', properties:{ sala:{type:'string',enum:alternatives} }, required:['sala'] } }) }, requestState: await codec.mint({method:'tools/call',tool:'reservar_sala',args:incoming,key,alternatives}) });
  });
  server.registerResource('politica', 'politica://uso', { mimeType:'text/markdown' }, async uri => ({ contents:[{ uri:uri.href,mimeType:'text/markdown',text:politica }] }));
  return server;
}, { legacy:'reject' });
const nodeHandler = toNodeHandler(handler);
createServer(async (req,res) => {
  if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
  try {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    console.error(JSON.stringify({ method:body?.method, id:body?.id, traceparent:body?.params?._meta?.traceparent }));
    if (body?.params?.requestState && (body.method !== 'tools/call' || body.params.name !== 'reservar_sala')) {
      res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:body.id,error:{code:-32602,message:'Estado vinculado a outra operacao'}})); return;
    }
    await nodeHandler(req,res,body);
  } catch { res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}})); }
}).listen(Number(process.env.MCP_PORT ?? 7301), () => console.error('MCP pronto'));
