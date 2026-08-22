# Auditoria e melhorias — Estimativa Ágil

Revisão do site publicado em
`https://salaleadtime.github.io/teste01/docs/`, com foco no que muda quando a
sala é **compartilhada por várias pessoas ao mesmo tempo**.

Resumo: **13 bugs corrigidos**, **isolamento por squad** (histórico, votos e resultado), **3 riscos de segurança** que dependem de uma
ação sua no console do Firebase, **novas regras de consenso** na apuração e uma
revisão de layout (tema escuro, celular, acessibilidade).

Os testes de regressão passaram de 5 para 14 casos (`npm run test:xss`).

---

## 1. Bugs corrigidos

### 1.1 XSS armazenado pela coluna "Data" do Excel importado — **crítico**

`renderHistoryEntriesToContainer()` escapava story, squad, nomes e recado, mas
interpolava `entry.date` cru:

```js
<span class="history-date">${entry.date}</span>
```

Esse campo vem de `String(row['Data'])` na importação de planilha e vai direto
para o Firebase. Uma planilha com `<img src=x onerror=...>` na coluna Data
executava script **no navegador de todo mundo que abrisse o histórico** — SM e
Tech Leads. Corrigido com `escHtml()`. Coberto pelo teste 6.

### 1.2 XSS pelo resumo da rodada — **alto**

`renderSummary()` interpolava o voto predominante e as horas sem escape. Os
valores das cartas são digitados pelo SM em Configurações → Cartas, ou seja,
entrada de usuário que chega a todos os participantes. Corrigido. Teste 7.

Aproveitei para incluir `'` (aspa simples) no `escHtml()`.

### 1.3 Horas do resultado saíam do baralho errado — **alto**

O maior bug funcional. As cartas são configuráveis **por squad**
(`squadOverrides`), mas o rodapé, o resumo e o **histórico gravado** calculavam
as horas com `effectiveSettings()` — o baralho de **quem estava olhando a tela**,
não de quem votou.

Na prática: o Squad Alpha configura `1 = 40h`, o SM (sem squad) usa o padrão
`1 = 2h`. O Alpha vota 1, e o relatório — inclusive o Excel exportado — registra
**2h em vez de 40h**. As linhas individuais da tabela estavam certas
(`effectiveFor(p.squad)`), então o rodapé contradizia a própria tabela acima
dele.

Corrigido com `hoursForVote(vote, voters)`, que resolve as horas pelo squad de
quem votou. Aplicado nos três pontos. Teste 8.

### 1.4 "Revelar Votos" liberava antes de o Tech Lead votar — **médio**

```js
const voters = participants.filter(p => p.role !== 'master'
  && p.role !== 'observer' && p.role !== 'tech-lead');
```

O TL estava fora do cálculo de `allVoted`, mas o voto dele **entra na moda** e
aparece na coluna de desenvolvedores. O botão liberava com o TL ainda votando —
e se o SM revelasse nesse instante, a estimativa fechava sem ele. Teste 9.

### 1.5 A sessão travava se alguém não votasse — **médio**

"Revelar Votos" só habilitava com 100% dos votos. Bastava uma pessoa fechar a
aba no meio da rodada para o SM não conseguir revelar nem concluir a história —
a saída era reiniciar a rodada e perder os votos já dados.

Agora o botão mostra o progresso (`👁 Revelar Votos (3/5)`), fica em âmbar
enquanto falta gente, habilita com pelo menos 1 voto e **pede confirmação**
quando ainda há votos pendentes.

### 1.6 O voto sumia da tela ao dar F5 — **médio**

`myVote` só existia em memória. Recarregando a página no meio da rodada, o voto
continuava salvo no Firebase, mas a carta aparecia sem seleção e a mensagem
"voto registrado" desaparecia. As pessoas votavam de novo achando que tinham
perdido o voto. Agora o voto é reidratado do Firebase na reconexão, para Dev, TL
e QA.

### 1.7 QA não conseguia corrigir a estimativa — **médio**

Dev e TL trocavam de carta à vontade até a revelação; o QA ficava travado no
primeiro número (`input.disabled = true`). Regra agora é a mesma para todos:
**voto é mutável até o reveal**. O botão passa a "Atualizar" depois do primeiro
envio.

### 1.8 Excluir uma rodada apagava outra junto — **médio**

`deleteHistoryEntry()` marcava `_deleted` em **todas** as entradas com a mesma
assinatura `date|story`, enquanto a edição usava `_firebaseKey`. Duas
reestimativas da mesma história no mesmo minuto (cenário normal: rodada,
discussão, nova rodada) compartilham essa assinatura — excluir uma levava a
outra. Agora a exclusão usa a chave do Firebase; a varredura por assinatura só
sobrou como fallback para entradas legadas. Teste 11.

### 1.9 "Limpar tudo" apagava o histórico da sala sem confirmar — **médio**

Um clique acidental em 🗑 Limpar tudo destruía o histórico inteiro da sala, para
todos, sem confirmação e sem desfazer. Agora confirma, informa quantas rodadas
serão perdidas e sugere exportar antes.

### 1.10 `?s=` aceitava qualquer squad e squad era opcional — **médio**

`mySquad = urlSquad || ...` entrava direto sem validação: `?r=sala&s=Inventado`
criava um squad fantasma no Firebase e no histórico. E, com squads cadastrados,
entrar sem escolher squad caía no baralho global — misturando o resultado.

Agora o squad é validado contra os squads da sala e **é obrigatório quando a
sala tem squads cadastrados**.

### 1.11 `calcMode` dependia de `parseFloat(null)` e da ordem das chaves

```js
const wins = count > maxFreq || (count === maxFreq && parseFloat(val) < parseFloat(mode));
```

Na primeira iteração `mode` é `null` → `parseFloat(null)` é `NaN` → a comparação
é sempre `false`. Funcionava por acidente porque o V8 itera chaves numéricas em
ordem crescente; com uma carta não numérica (`?`, `XG`, `M`) o desempate ficava
imprevisível. Reescrito com desempate explícito. Teste 10.

### 1.12 Clicar numa carta limpava a seleção da outra tela

`document.querySelectorAll('.fib-card')` no handler do Dev pegava também as
cartas do Tech Lead (os dois grids existem no DOM ao mesmo tempo). Seletor
escopado por container.

### 1.13 Imagem para o Jira saía ilegível no tema escuro

O `html2canvas` força fundo branco. Com o tema escuro agora suportado, o texto
sairia claro sobre branco. Uma classe `.capturing` força os tokens claros só
durante a captura.

**Também corrigido de quebra:** `clearSession()` não limpava `myRoomId`,
deixando a sala anterior apontada depois do logout.

---

## 2. Novas regras de estimativa

O app apurava a moda e pronto — sem sinalizar quando a estimativa **não deveria
ser fechada**. Foram adicionados três avisos abaixo do resumo:

| Situação | Aviso |
|---|---|
| Todos os devs votaram igual | ✅ **Consenso total** |
| Empate na moda (ex.: dois votos 3 e dois votos 8) | ⚠️ **Empate** — não há predominante; o rodapé também marca |
| Menor e maior voto a ≥ 3 posições no baralho | ⚠️ **Divergência alta** com a distância |

A distância é medida em **posições do baralho ativo**, não em valor absoluto:
5→8 são vizinhos, 1→21 estão a 6 posições. Funciona com baralho customizado.

Os três recomendam discutir e rodar uma nova rodada antes de fechar.

### Sugestão que deixei para você decidir

No empate, o código escolhe o **menor** valor (comportamento original,
preservado). A convenção de planning poker é ficar com o **maior** — o menor
subestima sistematicamente. Não mudei porque altera o número gravado no
histórico; se quiser, é uma linha em `calcMode()`.

---

## 3. Isolamento por squad

> Regra pedida: *cada squad não pode visualizar os dados do outro; estando no
> histórico com o perfil de SM, ver só o squad em que estou.*

Antes, o squad só afetava **qual baralho de cartas** cada pessoa via. Todo o
resto — participantes, painel de votos, resultado e histórico — era da sala
inteira. Um Dev do Squad Alpha via os nomes e os votos do Squad Beta, e o
histórico misturava os dois times.

Agora vale a regra: **quem está dentro de um squad só enxerga o próprio squad.**

| Onde | Comportamento |
|---|---|
| Histórico (SM e Tech Lead) | Só as rodadas do meu squad |
| Rodada com mais de um squad | Aparece, mas com **apenas os votantes do meu squad** — nome e voto do outro time não vazam |
| Participantes / painel de votos / resultado | Só o meu squad (o Scrum Master sempre aparece, porque é quem conduz) |
| Progresso e "Revelar Votos" | Contam só o meu squad — um SM não fica mais esperando o squad vizinho votar |
| Gravação da rodada | Grava a apuração do meu squad, não a soma dos dois |
| Iniciar / Nova Rodada | Limpa só os votos do meu squad |
| Exportação para Excel | Exporta exatamente o que está na tela, já filtrado |

Quem **não tem squad** — o Scrum Master dono da sala — mantém a visão completa.
É a diferença entre "facilitador da sala" e "facilitador de um time".

### Onde você troca de squad

Configurações → **Squads** → *Você está atuando no squad*. Antes o SM só definia
squad no login e não conseguia mais trocar sem sair e entrar de novo. O squad
ativo aparece no cabeçalho, ao lado do seu nome.

### Nada some em silêncio

Dentro de um squad, o histórico mostra uma faixa no topo:

> 🔒 Escopo: **Squad Alpha** — rodadas de outros squads não são exibidas (1 oculta(s) neste período)

Assim ninguém acha que perdeu dados quando a lista encolhe.

### O limite honesto disso

O isolamento é **de visualização**, e é forte o suficiente para o uso do dia a
dia. Duas ressalvas que você precisa saber:

1. **A rodada ainda é uma só por sala.** `round` (ativa / história / revelada) é
   compartilhado, então se dois squads estiverem na mesma sala ao mesmo tempo,
   um SM iniciar ou revelar uma rodada afeta o andamento do outro — cada um vê a
   própria apuração, mas o "sinal" é comum. Enquanto isso não virar
   `rounds/$squad`, **o mais seguro é uma sala por squad** (o link de SM já
   carrega o `?r=` da sala, então basta uma sala para cada time).
2. **Isolamento no cliente, não no servidor.** Vale a mesma ressalva do item 4.2:
   os dados chegam ao navegador e são filtrados lá. Quem abrir o DevTools vê o
   que foi filtrado. Para isolamento de verdade, o filtro precisa estar nas
   regras do Firebase — o que exige autenticação (item 5.1).

---

## 4. Layout e UX

- **Tema escuro** seguindo o tema do sistema (`prefers-color-scheme`). Só os
  tokens de cor mudam — nenhuma regra de layout precisou saber o tema.
- **Celular**: cartas em grade (o `flex-wrap` deixava a última linha
  desalinhada); botões do SM em largura total; modal de Configurações vira folha
  de baixo em vez de ficar espremido; abas com rolagem horizontal; filtros de
  data, links de acesso e lista de participantes empilhados.
- **Barra de progresso da votação** na tela do SM (`3/5` + barra), que fica
  verde no 100%.
- **Banner de conexão perdida**. Antes, perder o Firebase era silencioso: a tela
  congelava e a pessoa continuava clicando achando que estava votando. Agora
  avisa via `.info/connected`.
- **Toasts** no lugar de `alert()` — `alert()` trava a aba inteira, o que é ruim
  numa sessão ao vivo. As confirmações destrutivas seguem em `confirm()`, de
  propósito.
- **Acessibilidade**: foco visível de teclado (não existia — navegar por Tab não
  deixava rastro em botão nenhum), `aria-pressed` nas cartas e nos papéis,
  `aria-label` com pontos e horas, `aria-live` nas mensagens de voto e erro,
  `<label for>` ligado a cada input, `prefers-reduced-motion`.
- **Textos longos** não estouram mais o layout: nome de história com reticências
  no header, tabelas com rolagem própria, quebra de nomes compridos.
- `<meta name="description">`, `theme-color` e `color-scheme`.

---

## 5. Riscos que dependem de você — **leia esta parte**

Estes **não dá para corrigir só no código do site**, porque o navegador é o
único guardião hoje. Vão em ordem de gravidade.

### 5.1 Qualquer participante pode virar Scrum Master

O token é uma constante no código, igual para todas as salas:

```js
const SM_TOKEN = 'SalaAgilidade-SM';
```

Qualquer pessoa com o link de participante (`?r=sala`) pode acrescentar
`&sm=SalaAgilidade-SM` e entrar como **Scrum Master da sua sala**: revelar votos
na hora que quiser, remover pessoas, trocar o baralho e apagar o histórico
inteiro. Não precisa de conhecimento técnico — o token aparece na URL que você
mesma compartilha, inclusive na que você me mandou.

Vale ainda mais porque a tela de "Convidar outro Scrum Master" distribui esse
mesmo token.

**Correção real:** Firebase Authentication (Google/Microsoft da empresa) e um nó
`rooms/$id/owner` com o UID do dono; as regras passam a exigir
`auth.uid === owner` para escrever em `round`, `settings`, `kicked` e `history`.

**Paliativo imediato**, se dá para viver com isso por enquanto: gere um token
aleatório **por sala** em vez da constante única. Não é seguro de verdade (ainda
é um segredo que trafega na URL), mas acaba com o "adivinhei o token da sala de
todo mundo".

### 5.2 Os votos são visíveis antes da revelação

O app esconde o voto alheio até o reveal, mas isso é **só na renderização**. O
listener baixa a sala inteira, votos incluídos:

```js
vote: round.revealed ? p.vote : null,   // filtro no cliente, não no servidor
```

Qualquer pessoa com o DevTools aberto (aba Network, ou `_latestParticipants` no
console) vê o voto de todo mundo antes de votar. Num planning poker isso
invalida a dinâmica — é exatamente o viés de ancoragem que o jogo existe para
evitar.

**Correção:** mover os votos para `rooms/$id/votes/$clientId` e usar regras que
só liberam leitura quando `round/revealed === true`. Exige separar as leituras
no app (`round`, `settings`, `participants` e `votes` em listeners distintos),
porque no Realtime Database a permissão de leitura é decidida no **nó lido** —
regras mais profundas não restringem quem lê o nó pai.

### 5.3 O banco provavelmente está sem regras

Não há `database.rules.json` no repositório, o que sugere as regras abertas
(`".read": true, ".write": true`). Nesse estado, qualquer pessoa na internet com
a URL do banco — que está no `app.js`, visível para todos — pode ler e apagar
**todas as salas**.

Deixei um **`database.rules.json` pronto** na raiz do repositório. Ele é
compatível com o app atual: não exige login, não quebra nenhuma tela, e já:

- bloqueia leitura e escrita fora de `rooms/`, impedindo varrer ou apagar o
  banco na raiz;
- valida tipo e tamanho de todos os campos (nome ≤ 30, história ≤ 200, papel
  precisa ser um dos cinco válidos etc.);
- cria o índice `_ts` no histórico — hoje o `orderByChild('_ts')` ordena no
  cliente e gera aviso no console.

Publicar com:

```bash
firebase deploy --only database
```

Isso é o **piso**, não a solução: com ele o 5.1 e o 5.2 continuam de pé, porque
os dois dependem de autenticação.

> A `apiKey` do Firebase estar no `app.js` é normal e não é um vazamento — no
> Firebase ela identifica o projeto, não autoriza nada. Quem autoriza são as
> regras. É justamente por isso que o 5.3 importa.

---

## 6. Outras sugestões (não implementadas)

- **Rodadas por squad no servidor.** A apuração e a visualização já são por
  squad (seção 3), mas `round` continua único por sala. Migrar para
  `rounds/$squad` deixaria dois squads rodarem sessões independentes na mesma
  sala. Até lá, uma sala por squad resolve.
- **Reestimativa como primeira classe.** A dedup por `date|story` existe porque
  rodar a mesma história duas vezes é comum. Um campo `rodada: 1, 2, 3` deixaria
  isso explícito e dispensaria a heurística.
- **Limite de horas do QA.** Aceita qualquer número positivo; um `999` digitado
  errado contamina a média sem aviso.
- **`legacy-socketio/`** ainda está no repositório e tem seu próprio
  `server.js`. Se não é mais usado, apagar evita confusão sobre qual é o app.

---

## 7. Como testar

```bash
npm install
npx playwright install --with-deps chromium
npm run test:xss
```

14 casos, rodando o `docs/app.js` real (sem cópia) num Chromium headless com o
SDK do Firebase mockado — nenhuma chamada de rede, nenhum toque no projeto real.
O mesmo comando roda no CI a cada PR.

Os testes 6, 7, 8 e 11 foram verificados contra o código antigo: falham com o
bug presente e passam com a correção, então não são testes vazios.
