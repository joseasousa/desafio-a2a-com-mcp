# A Ponte em TypeScript

## Como rodar

Requisitos: Node.js 20 ou superior, npm e Python 3.10 ou superior. Execute na raiz do projeto:

```bash
git clone https://github.com/joseasousa/desafio-a2a-com-mcp.git
cd desafio-a2a-com-mcp
npm ci
npm run build
```

No terminal do MCP, gere e exporte a chave externa (guarde o mesmo valor para reiniciar o processo):

```bash
export REQUEST_STATE_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
npm run start:mcp
```

Em outro terminal, na mesma raiz:

```bash
npm run start:agente
```

Em um terceiro terminal:

```bash
python3 validador/validar.py --agente http://localhost:7300 --mcp http://localhost:7301
```

Reinicie os dois processos antes de cada execução do validador, preservando a chave MCP quando quiser retomar um pedido anterior. As reservas criadas alteram a disponibilidade.

`npm test` compila e executa o validador intacto com processos novos, além dos testes de restart com a mesma chave, expiração, adulteração, vínculo à operação, argumentos divergentes, headers incompatíveis, cancelamento, ausência de alternativas, limites de horário, instantes UTC equivalentes e intervalos adjacentes. Também verifica trace-id, descoberta anterior à chamada, ids distintos, isolamento de Tasks, erros A2A e consulta durante execução com MCP controlado. Deixe as portas 7300, 7301, 7390, 7391 e 7392 livres.

Configuração opcional: `MCP_PORT` (7301), `AGENTE_PORT` (7300), `MCP_URL` (http://localhost:7301/mcp) e `A2A_URL` (URL pública anunciada no card). O agente publica `/.well-known/agent-card.json` e aceita JSON-RPC em `/a2a`; o MCP atende `/mcp`.

Pedido: `reservar sala=<id> inicio=<iso8601> fim=<iso8601> responsavel=<nome>`. Continuação na mesma Task: `escolha=<id>` ou `escolha=recusar`.

## Onde a ponte acontece

Em [agente/index.ts](agente/index.ts), `execute` descobre a tool e valida os argumentos usando seu schema, lê a versão do resource e chama o cliente MCP oficial com `allowInputRequired: true`. O ramo `isInputRequiredResult` guarda privadamente o token, a chave da pergunta e as alternativas; `pause` traduz a resposta em `TASK_STATE_INPUT_REQUIRED` e na linha `alternativas: <ids>`. Na continuação, `dispatch` verifica a escolha e chama `execute`, que repete os argumentos originais com `inputResponses` e ecoa o token sem decodificá-lo. O SDK atribui um id novo. A serialização usa somente `task.public`; o token nunca entra em mensagens, histórico ou artifacts A2A. O trace context fica ligado à Task e acompanha descoberta, resource e chamada.

## Decisões técnicas

Dois processos separados em TypeScript ESM, compilados com tsc. MCP usa `McpServer`, `createMcpHandler` e `toNodeHandler` oficiais, versão 2.0.0, com caminho legado rejeitado e metadados/capabilities validados por request. O SDK espelha e valida os headers. A2A v1.0 usa HTTP nativo, validação explícita, SendMessage e GetTask, sem streaming, push, autenticação ou LLM. O cliente mantém `autoFulfill: false` para permitir a pausa A2A.

[servidor-mcp/index.ts](servidor-mcp/index.ts) usa `createRequestStateCodec`: HMAC-SHA256 com expiração de 600 segundos. `REQUEST_STATE_SECRET` deve representar pelo menos 32 bytes em hexadecimal; valor inválido interrompe a inicialização. O payload selado contém método, tool, argumentos originais, chave da pergunta e alternativas. A verificação ocorre antes da entrada no handler; o retry usa os argumentos selados e confere novamente a disponibilidade. O token é assinado, não cifrado, e não contém segredos. Não há armazenamento de pedidos pausados no MCP. Consulte a [documentação oficial do codec](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/input-required.md).

Tasks ficam em um Map em memória no agente, com estado público separado do contexto privado. Estados terminais são definitivos. Tasks e reservas novas não sobrevivem ao restart; o token MCP sobrevive com a mesma chave até expirar. As reservas originais e a política são lidas dos arquivos intactos; só as reservas novas são mantidas em memória. As validações comparam instantes e aplicam a janela no fuso fixo -03:00; intervalos adjacentes são permitidos. Alternativas são calculadas exclusivamente no servidor por capacidade e id. Mesma entrada e mesmo estado inicial produzem o mesmo comportamento; reservas anteriores alteram esse estado.

## Saída do validador

Última execução com processos recém-iniciados, código de saída 0:

```text
trace-id desta execucao: 206601c321dc27299bbafe7371bb828a
procure esse valor no stderr do servidor MCP para conferir a propagacao do traceparent.

PASS 01 tools/list traz as tres tools
PASS 02 toda tool tem inputSchema de objeto
PASS 03 listar_salas devolve structuredContent e o mesmo JSON em texto
PASS 04 _meta sem protocolVersion devolve -32602 e HTTP 400
PASS 05 _meta sem clientCapabilities devolve -32602 e HTTP 400
PASS 06 tool inexistente e recusada, por -32602 ou por isError
PASS 07 resources/read de politica://uso devolve a politica
PASS 08 resources/read de URI inexistente devolve -32602
PASS 09 sala inexistente devolve isError com a mensagem exata
PASS 10 fora da janela devolve isError com a mensagem exata
PASS 11 duracao acima de 2h devolve isError com a mensagem exata
PASS 12 intervalo invertido devolve isError com a mensagem exata
PASS 13 conflito devolve input_required com inputRequests e requestState
PASS 14 a elicitation e form mode e oferece as alternativas na ordem certa
PASS 15 conflito sem a capability elicitation devolve -32021 e HTTP 400
PASS 16 retry com inputResponses e requestState conclui a reserva
PASS 17 requestState adulterado e rejeitado com -32602
PASS 18 argumentos adulterados no retry nao tomam efeito
PASS 19 recusa conclui sem reservar e sem isError
PASS 20 conflito sem alternativa possivel devolve isError com a mensagem exata

PASS 21 agent card responde 200 no well-known com JSON
PASS 22 o card declara a interface JSON-RPC com url e versao 1.0
PASS 23 o card declara a skill reservar-sala
PASS 24 SendMessage com sala livre conclui a Task
PASS 25 o artifact chama reserva e traz a versao da politica
PASS 26 GetTask devolve id, contextId e estado corrente
PASS 27 SendMessage com sala ocupada pausa a Task
PASS 28 a Task pausada lista as alternativas na ordem certa
PASS 29 escolha fora do enum mantem a Task pausada
PASS 30 a continuacao conclui a Task na sala escolhida
PASS 31 SendMessage em Task terminal e recusado
PASS 32 a recusa termina a Task em CANCELED
PASS 33 duas Tasks pausadas ao mesmo tempo concluem cada uma com a sua reserva
PASS 34 nenhuma resposta A2A carrega o requestState
PASS 35 sala inexistente termina a Task em FAILED com a mensagem da tool
PASS 36 o agente e deterministico: o mesmo pedido produz a mesma pausa

resumo: 36 passaram, 0 falharam, de 36 verificacoes

```
