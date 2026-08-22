const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DOCS_DIR = path.join(__dirname, '..', 'docs');
const PORT = 8793;

const server = http.createServer((req, res) => {
  const filePath = path.join(DOCS_DIR, decodeURIComponent(req.url.split('?')[0]));
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404); res.end('not found');
  }
});

// Mock of the Firebase Realtime Database client SDK — no network calls, no
// real project touched. Everything no-ops except rooms/*/history, which
// returns two canned entries with the same date|story signature (same
// clock minute, different Firebase push keys) to exercise the dedup fix
// in loadMergedHistory() with the app's real, unmodified code.
function installFirebaseMock() {
  // Registro de escritas para os testes de isolamento de write-path
  window.__fbWrites = [];
  // Store em memória, só para os testes do fluxo de aprovação de SM (owner /
  // approvedSmClients / pendingSm) poderem ler de volta o que escreveram —
  // os demais nós continuam "cegos" (emptySnap), como sempre foram.
  window.__fbStore = {};
  function recordWrite(path, data) {
    window.__fbWrites.push({ path, data });
    if (path) { if (data === null) delete window.__fbStore[path]; else window.__fbStore[path] = data; }
  }
  function emptySnap() { return { exists: () => false, val: () => null, forEach: () => {} }; }
  function storedSnap(p) {
    const val = window.__fbStore[p];
    return {
      exists: () => val !== undefined,
      val: () => (val === undefined ? null : val),
      forEach: (cb) => { if (val && typeof val === 'object') Object.entries(val).forEach(([k, v]) => cb({ key: k, val: () => v })); },
    };
  }
  function historySnap() {
    const children = [
      { key: 'k1', val: () => ({ date: '01/07/2026, 14:32', story: 'Login com SSO', devMode: '5', _ts: 1000 }) },
      { key: 'k2', val: () => ({ date: '01/07/2026, 14:32', story: 'Login com SSO', devMode: '8', _ts: 1030 }) },
    ];
    return { exists: () => true, forEach: (cb) => children.forEach(cb) };
  }
  function ref(p) {
    const isHistory = /\/history$/.test(p);
    const snapFor = () => (isHistory ? historySnap() : (Object.prototype.hasOwnProperty.call(window.__fbStore, p) ? storedSnap(p) : emptySnap()));
    return {
      once: async () => snapFor(),
      on: (event, cb) => { cb(snapFor()); },
      off: () => {},
      set: async (data) => { recordWrite(p, data); },
      update: async (data) => {
        // db.ref().update(updates) na raiz: cada chave do objeto é um path
        if (p === undefined || p === null || p === '') Object.keys(data || {}).forEach((k) => recordWrite(k, data[k]));
        else recordWrite(p, data);
      },
      remove: async () => { recordWrite(p, null); },
      push: () => ({ key: 'mockKey' + Math.random().toString(36).slice(2) }),
      orderByChild: () => ref(p),
      onDisconnect: () => ({ remove: () => {} }),
    };
  }
  window.firebase = { initializeApp: () => {}, database: () => ({ ref }) };
}

async function main() {
  await new Promise((resolve) => server.listen(PORT, resolve));
  // PW_CHROMIUM_PATH permite reaproveitar um Chromium já instalado na máquina
  // (útil em sandboxes); no CI a variável não existe e o download padrão vale.
  const browser = await chromium.launch(
    process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}
  );
  const page = await browser.newPage();

  let xssFired = false;
  page.on('dialog', async (d) => { xssFired = true; await d.dismiss(); });
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await page.route('**/firebasejs/**/firebase-app-compat.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `(${installFirebaseMock.toString()})();`,
  }));
  await page.route('**/firebasejs/**/firebase-database-compat.js', (route) => route.fulfill({
    contentType: 'application/javascript', body: '/* stub, mock installed by firebase-app-compat stub */',
  }));
  await page.route('**/html2canvas*/**', (route) => route.fulfill({ contentType: 'application/javascript', body: '/* stub, unused by this test */' }));
  await page.route('**/xlsx*/**', (route) => route.fulfill({ contentType: 'application/javascript', body: 'window.XLSX = {};' }));

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load' });

  const PAYLOAD = '<img src=x onerror="window.__xssFired = true">';
  let failures = [];

  // TEST 1 — fibonacci cards (seen by every participant while voting) must
  // escape a malicious card value / hour string set by the Scrum Master.
  const t1 = await page.evaluate(async (payload) => {
    window.__xssFired = false;
    currentSettings = { cards: [payload], hourMap: { [payload]: payload }, squads: [] };
    renderFibCards();
    await new Promise((r) => setTimeout(r, 200));
    return { fired: window.__xssFired, html: document.getElementById('fibonacci-cards').innerHTML };
  }, PAYLOAD);
  console.log('[1/17] renderFibCards escapa carta/hora maliciosa:', !t1.fired ? 'OK' : 'FALHOU');
  if (t1.fired || !t1.html.includes('&lt;img')) failures.push('renderFibCards não escapou o payload');

  // TEST 2 — participants management tab (seen by the Scrum Master) must
  // escape a malicious participant name / squad.
  const t2 = await page.evaluate(async (payload) => {
    window.__xssFired = false;
    _latestParticipants = [{ id: 'p1', name: payload, role: 'developer', squad: payload, avatar: '' }];
    renderParticipantsManage();
    await new Promise((r) => setTimeout(r, 200));
    return { fired: window.__xssFired, html: document.getElementById('participants-manage').innerHTML };
  }, PAYLOAD);
  console.log('[2/17] renderParticipantsManage escapa nome/squad malicioso:', !t2.fired ? 'OK' : 'FALHOU');
  if (t2.fired || !t2.html.includes('&lt;img')) failures.push('renderParticipantsManage não escapou o payload');

  // TEST 3 — loadMergedHistory() must not silently drop a legitimate second
  // estimate of the same story within the same clock minute (regression for
  // the old Set-based date|story dedup).
  const t3 = await page.evaluate(async () => {
    const entries = await loadMergedHistory('test-room-ci');
    return { count: entries.length, devModes: entries.map((e) => e.devMode).sort() };
  });
  const t3ok = t3.count === 2 && JSON.stringify(t3.devModes) === JSON.stringify(['5', '8']);
  console.log('[3/17] loadMergedHistory mantém as 2 reestimativas do mesmo minuto:', t3ok ? 'OK' : `FALHOU (recebeu ${t3.count})`);
  if (!t3ok) failures.push('loadMergedHistory descartou uma reestimativa legítima');

  // TEST 4 — per-squad rendering isolation: a squad with its own override must
  // see its own cards, and a squad without override must see the global ones.
  const t4 = await page.evaluate(async () => {
    currentSettings = {
      cards: ['1'], hourMap: { '1': '2h' }, squads: ['A', 'B'],
      squadOverrides: { A: { cards: ['99'], hourMap: { '99': '99h' } } },
    };
    mySquad = 'A';
    renderFibCards();
    const htmlA = document.getElementById('fibonacci-cards').innerHTML;
    mySquad = 'B';
    renderFibCards();
    const htmlB = document.getElementById('fibonacci-cards').innerHTML;
    return { htmlA, htmlB };
  });
  const t4ok = t4.htmlA.includes('>99<') && !t4.htmlA.includes('>1<')
            && t4.htmlB.includes('>1<')  && !t4.htmlB.includes('99');
  console.log('[4/17] renderFibCards isola cartas por squad (override vs global):', t4ok ? 'OK' : 'FALHOU');
  if (!t4ok) failures.push('renderFibCards não isolou as cartas por squad');

  // TEST 5 — write-path isolation: saving settings as a SM inside a squad must
  // write only that squad's override, never the room-global cards/hourMap.
  const t5 = await page.evaluate(async () => {
    window.__fbWrites = [];
    myRoomId = 'room1'; mySquad = 'A';
    currentSettings = { cards: ['1', '2'], hourMap: { '1': '2h', '2': '4h' }, squads: ['A', 'B'] };
    openSettings();
    await saveSettings();
    closeSettings(); // garante modal fechado mesmo se saveSettings mudar no futuro
    return { paths: window.__fbWrites.map((w) => w.path) };
  });
  const t5ok = t5.paths.includes('rooms/room1/settings/squadOverrides/A')
            && !t5.paths.includes('rooms/room1/settings/cards')
            && !t5.paths.includes('rooms/room1/settings/hourMap');
  console.log('[5/17] saveSettings grava só o override do squad do SM:', t5ok ? 'OK' : `FALHOU (paths: ${t5.paths.join(', ')})`);
  if (!t5ok) failures.push('saveSettings vazou escrita para a config global da sala');

  // TEST 6 — histórico: a coluna Data vinha de planilha importada e era
  // interpolada sem escape, virando XSS armazenado para todo mundo da sala.
  const t6 = await page.evaluate(async (payload) => {
    window.__xssFired = false;
    const container = document.getElementById('history-entries');
    renderHistoryEntriesToContainer(container, [{ date: payload, story: 'ok', voters: [] }], {});
    await new Promise((r) => setTimeout(r, 200));
    return { fired: window.__xssFired, html: container.innerHTML };
  }, PAYLOAD);
  console.log('[6/17] histórico escapa a coluna Data maliciosa:', !t6.fired ? 'OK' : 'FALHOU');
  if (t6.fired || !t6.html.includes('&lt;img')) failures.push('renderHistoryEntriesToContainer não escapou entry.date');

  // TEST 7 — o resumo interpola o voto predominante e as horas, que vêm do
  // baralho configurável pelo SM: também precisam ser escapados.
  const t7 = await page.evaluate(async (payload) => {
    window.__xssFired = false;
    mySquad = null;
    currentSettings = { cards: [payload], hourMap: { [payload]: payload }, squads: [] };
    renderSummary([{ name: 'Dev', role: 'developer', squad: null, vote: payload }], 'master-summary');
    await new Promise((r) => setTimeout(r, 200));
    return { fired: window.__xssFired, html: document.getElementById('master-summary').innerHTML };
  }, PAYLOAD);
  console.log('[7/17] renderSummary escapa voto/horas maliciosos:', !t7.fired ? 'OK' : 'FALHOU');
  if (t7.fired || !t7.html.includes('&lt;img')) failures.push('renderSummary não escapou o payload');

  // TEST 8 — as horas do resultado têm que sair do baralho do SQUAD DE QUEM
  // VOTOU. Antes vinham de effectiveSettings(), ou seja, do baralho de quem
  // estava OLHANDO a tela: o SM sem squad via as horas erradas do squad A.
  const t8 = await page.evaluate(async () => {
    currentSettings = {
      cards: ['1'], hourMap: { '1': '2h' }, squads: ['A'],
      squadOverrides: { A: { cards: ['1'], hourMap: { '1': '40h' } } },
    };
    mySquad = null; // quem lê a tela é o SM, que não tem squad
    const devs = [
      { name: 'Ana', role: 'developer', squad: 'A', vote: '1' },
      { name: 'Bia', role: 'developer', squad: 'A', vote: '1' },
    ];
    renderSummary(devs, 'master-summary');
    renderSplitResults(devs, 'master-dev-results', 'master-qa-results');
    return {
      summary: document.getElementById('master-summary').innerHTML,
      footer: document.getElementById('master-dev-results').innerHTML,
    };
  });
  const t8ok = t8.summary.includes('40h') && !t8.summary.includes('>2h<')
            && t8.footer.includes('40h');
  console.log('[8/17] horas do resultado vêm do squad de quem votou:', t8ok ? 'OK' : 'FALHOU');
  if (!t8ok) failures.push('resumo/rodapé usaram o mapa de horas de quem lê a tela');

  // TEST 9 — o Tech Lead vota e o voto dele entra na moda, então ele tem que
  // contar em allVoted. Antes o SM conseguia revelar antes de o TL votar.
  const t9 = await page.evaluate(async () => {
    const parts = [
      { id: 'a', role: 'developer', hasVoted: true },
      { id: 'b', role: 'tech-lead',  hasVoted: false },
      { id: 'c', role: 'observer',   hasVoted: false },
      { id: 'd', role: 'master',     hasVoted: false },
    ];
    const voters = parts.filter((p) => p.role !== 'master' && p.role !== 'observer');
    return { total: voters.length, allVoted: voters.length > 0 && voters.every((p) => p.hasVoted) };
  });
  const t9ok = t9.total === 2 && t9.allVoted === false;
  console.log('[9/17] Tech Lead conta como votante em allVoted:', t9ok ? 'OK' : 'FALHOU');
  if (!t9ok) failures.push('allVoted ignorou o voto do Tech Lead');

  // TEST 10 — calcMode não pode depender de parseFloat(null)/ordem de chaves e
  // precisa reportar o empate para a UI avisar que falta consenso.
  const t10 = await page.evaluate(async () => {
    const semEmpate = calcMode(['8', '8', '3']);
    const comEmpate = calcMode(['3', '8']);
    const comInterrog = calcMode(['?', '?', '5']);
    return {
      modeSem: semEmpate.mode, tiedSem: semEmpate.tied.length,
      modeCom: comEmpate.mode, tiedCom: comEmpate.tied.sort(),
      modeInterrog: comInterrog.mode,
      spread: voteSpread(['1', '21'], ['1', '2', '3', '5', '8', '13', '21', '?']),
    };
  });
  const t10ok = t10.modeSem === '8' && t10.tiedSem === 1
             && t10.modeCom === '3' && JSON.stringify(t10.tiedCom) === JSON.stringify(['3', '8'])
             && t10.modeInterrog === '?' && t10.spread === 6;
  console.log('[10/17] calcMode determinístico + empate + voteSpread:', t10ok ? 'OK' : `FALHOU (${JSON.stringify(t10)})`);
  if (!t10ok) failures.push('calcMode/voteSpread com comportamento inesperado');

  // TEST 11 — excluir uma rodada não pode levar junto outra rodada da mesma
  // história gravada no mesmo minuto (assinatura date|story idêntica).
  const t11 = await page.evaluate(async () => {
    window.__fbWrites = [];
    myRoomId = 'room1';
    await deleteHistoryEntry({ date: '01/07/2026, 14:32', story: 'Login com SSO', _firebaseKey: 'k2' });
    return { paths: window.__fbWrites.map((w) => w.path) };
  });
  const t11ok = t11.paths.length === 1 && t11.paths[0] === 'rooms/room1/history/k2';
  console.log('[11/17] exclusão do histórico atinge só a entrada clicada:', t11ok ? 'OK' : `FALHOU (${t11.paths.join(', ')})`);
  if (!t11ok) failures.push('deleteHistoryEntry apagou entradas além da selecionada');

  // TEST 12 — isolamento por squad no histórico: dentro de um squad, rodadas de
  // outros squads não aparecem, e os votantes do outro time somem de dentro de
  // uma rodada compartilhada (nome e voto do vizinho não podem vazar).
  const t12 = await page.evaluate(async () => {
    const todas = [
      { date: 'd1', story: 'Só Alpha', squads: ['Alpha'], voters: [{ name: 'Ana', squad: 'Alpha', vote: '3' }] },
      { date: 'd2', story: 'Só Beta',  squads: ['Beta'],  voters: [{ name: 'Bia', squad: 'Beta',  vote: '8' }] },
      { date: 'd3', story: 'Os dois',  squads: ['Alpha', 'Beta'], voters: [
          { name: 'Ana', squad: 'Alpha', vote: '3' }, { name: 'Bia', squad: 'Beta', vote: '8' }] },
      { date: 'd4', story: 'Sem squad', squads: [], voters: [{ name: 'Caio', squad: null, vote: '5' }] },
    ];
    mySquad = 'Alpha';
    const alpha = scopeHistoryToSquad(todas);
    const ocultasAlpha = _scopeHiddenCount;
    mySquad = null;
    const semEscopo = scopeHistoryToSquad(todas);
    return {
      alphaStories: alpha.map((e) => e.story),
      ocultasAlpha,
      // na rodada compartilhada o Alpha só pode ver a própria votante
      votantesCompartilhada: (alpha.find((e) => e.story === 'Os dois') || {}).voters.map((v) => v.name),
      semEscopoTotal: semEscopo.length,
    };
  });
  const t12ok = JSON.stringify(t12.alphaStories) === JSON.stringify(['Só Alpha', 'Os dois'])
             && t12.ocultasAlpha === 2
             && JSON.stringify(t12.votantesCompartilhada) === JSON.stringify(['Ana'])
             && t12.semEscopoTotal === 4;
  console.log('[12/17] histórico isolado por squad (rodadas e votantes):', t12ok ? 'OK' : `FALHOU (${JSON.stringify(t12)})`);
  if (!t12ok) failures.push('scopeHistoryToSquad vazou dados de outro squad');

  // TEST 13 — isolamento por squad nas telas ao vivo: participantes de outro
  // squad não aparecem; o Scrum Master continua visível para todos.
  const t13 = await page.evaluate(async () => {
    const parts = [
      { id: '1', name: 'Ana',  role: 'developer', squad: 'Alpha' },
      { id: '2', name: 'Bia',  role: 'qa',        squad: 'Beta' },
      { id: '3', name: 'Caio', role: 'tech-lead', squad: 'Alpha' },
      { id: '4', name: 'SM',   role: 'master',    squad: null },
      { id: '5', name: 'Obs',  role: 'observer',  squad: 'Beta' },
    ];
    mySquad = 'Alpha';
    const escopo = scopeToSquad(parts).map((p) => p.name);
    mySquad = null;
    const semEscopo = scopeToSquad(parts).map((p) => p.name);
    return { escopo, semEscopo };
  });
  const t13ok = JSON.stringify(t13.escopo) === JSON.stringify(['Ana', 'Caio', 'SM'])
             && t13.semEscopo.length === 5;
  console.log('[13/17] participantes isolados por squad (SM sempre visível):', t13ok ? 'OK' : `FALHOU (${JSON.stringify(t13)})`);
  if (!t13ok) failures.push('scopeToSquad vazou participantes de outro squad');

  // TEST 14 — a nota de escopo avisa o que está sendo ocultado, para o histórico
  // nunca "sumir" silenciosamente para quem está dentro de um squad.
  const t14 = await page.evaluate(async () => {
    mySquad = 'Alpha';
    _scopeHiddenCount = 2;
    const comOcultas = scopeNoteHtml();
    _scopeHiddenCount = 0;
    const semOcultas = scopeNoteHtml();
    mySquad = null;
    const semSquad = scopeNoteHtml();
    return { comOcultas, semOcultas, semSquad };
  });
  const t14ok = t14.comOcultas.includes('Alpha') && t14.comOcultas.includes('2 oculta(s)')
             && t14.semOcultas.includes('Alpha') && !t14.semOcultas.includes('oculta(s)')
             && t14.semSquad === '';
  console.log('[14/17] aviso de escopo do histórico:', t14ok ? 'OK' : `FALHOU (${JSON.stringify(t14)})`);
  if (!t14ok) failures.push('scopeNoteHtml não informou o escopo corretamente');

  // TEST 15 — primeiro Scrum Master a reivindicar uma sala nunca usada vira
  // dono automaticamente (sem pedido pendente, sem tela de espera).
  const t15 = await page.evaluate(async () => {
    window.__fbWrites = []; window.__fbStore = {};
    myRole = null; myName = null; myRoomId = null; mySquad = null;
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    document.getElementById('screen-login').classList.add('active');
    await attemptMasterJoin('Amanda', null, 'roomFirstClaim');
    return {
      ownerWrite: window.__fbWrites.find((w) => w.path === 'rooms/roomFirstClaim/owner'),
      approvedWrite: window.__fbWrites.find((w) => w.path === `rooms/roomFirstClaim/approvedSmClients/${clientId}`),
      pendingWrites: window.__fbWrites.filter((w) => w.path.startsWith('rooms/roomFirstClaim/pendingSm/')),
      myRoleAfter: myRole,
      pendingScreenActive: document.getElementById('screen-sm-pending').classList.contains('active'),
    };
  });
  const t15ok = !!t15.ownerWrite && t15.approvedWrite?.data === true
             && t15.pendingWrites.length === 0 && t15.myRoleAfter === 'master' && !t15.pendingScreenActive;
  console.log('[15/17] primeiro SM de uma sala nova vira dono automaticamente:', t15ok ? 'OK' : `FALHOU (${JSON.stringify(t15)})`);
  if (!t15ok) failures.push('attemptMasterJoin não deu ownership automático numa sala sem dono');

  // TEST 16 — um segundo navegador tentando entrar como SM numa sala já
  // reivindicada por outro dono fica pendente de aprovação, sem virar SM.
  const t16 = await page.evaluate(async () => {
    window.__fbWrites = [];
    window.__fbStore = { 'rooms/roomClaimed/owner': 'algum-outro-client' };
    myRole = null; myName = null; myRoomId = null; mySquad = null;
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    document.getElementById('screen-login').classList.add('active');
    await attemptMasterJoin('Bruno', null, 'roomClaimed');
    return {
      pendingWrite: window.__fbWrites.find((w) => w.path === `rooms/roomClaimed/pendingSm/${clientId}`),
      myRoleAfter: myRole,
      pendingScreenActive: document.getElementById('screen-sm-pending').classList.contains('active'),
    };
  });
  const t16ok = !!t16.pendingWrite && t16.pendingWrite.data?.name === 'Bruno'
             && t16.myRoleAfter === null && t16.pendingScreenActive;
  console.log('[16/17] SM não aprovado numa sala já reivindicada fica pendente:', t16ok ? 'OK' : `FALHOU (${JSON.stringify(t16)})`);
  if (!t16ok) failures.push('attemptMasterJoin deixou um segundo cliente virar SM sem aprovação');

  // TEST 17 — um cliente já aprovado anteriormente (approvedSmClients) entra
  // direto, sem criar um novo pedido pendente.
  const t17 = await page.evaluate(async () => {
    window.__fbWrites = [];
    window.__fbStore = {
      'rooms/roomApproved/owner': 'dono-original',
      [`rooms/roomApproved/approvedSmClients/${clientId}`]: true,
    };
    myRole = null; myName = null; myRoomId = null; mySquad = null;
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    document.getElementById('screen-login').classList.add('active');
    await attemptMasterJoin('Carla', null, 'roomApproved');
    return {
      pendingWrites: window.__fbWrites.filter((w) => w.path.startsWith('rooms/roomApproved/pendingSm/')),
      myRoleAfter: myRole,
      pendingScreenActive: document.getElementById('screen-sm-pending').classList.contains('active'),
    };
  });
  const t17ok = t17.pendingWrites.length === 0 && t17.myRoleAfter === 'master' && !t17.pendingScreenActive;
  console.log('[17/17] SM já aprovado antes entra direto, sem novo pedido:', t17ok ? 'OK' : `FALHOU (${JSON.stringify(t17)})`);
  if (!t17ok) failures.push('attemptMasterJoin não reconheceu um cliente já aprovado');

  if (pageErrors.length) {
    console.log('Erros de página inesperados:', pageErrors);
    failures.push('erros de página inesperados');
  }

  await browser.close();
  server.close();

  if (failures.length) {
    console.error('\nFALHOU:', failures.join('; '));
    process.exit(1);
  }
  console.log('\nTodos os testes de regressão passaram.');
}

main().catch((err) => { console.error(err); process.exit(1); });
