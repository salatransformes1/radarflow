// ─── Firebase init ────────────────────────────────────────────────────────────
// v2026-05-27c — botão editar/deletar histórico, fix duplicação
const firebaseConfig = {
  apiKey: "AIzaSyDvJifQVEbLdza9H6jKJXnCJPKdnUkdk80",
  authDomain: "estimativa-agil.firebaseapp.com",
  databaseURL: "https://estimativa-agil-default-rtdb.firebaseio.com",
  projectId: "estimativa-agil",
  storageBucket: "estimativa-agil.firebasestorage.app",
  messagingSenderId: "497922511445",
  appId: "1:497922511445:web:9af960654a76428ffe3adc",
};
firebase.initializeApp(firebaseConfig);

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const db = firebase.database();

// ─── Constants ────────────────────────────────────────────────────────────────
const SM_TOKEN       = 'SalaAgilidade-SM';
const CLIENT_ID_KEY  = 'pp_client_id';
const SM_ROOM_KEY    = 'pp_sm_room';
const SESSION_KEY    = 'pp_session';
const AVATAR_KEY     = 'pp_avatar';
const AVATARS = ['🦊','🐱','🐶','🦁','🐯','🐸','🤖','👾','🦄','🐼','🚀','⭐','🔥','💎','🧙','🦋'];

const DEFAULT_CARDS    = ['1', '2', '3', '5', '8', '13', '21', '?'];
const DEFAULT_HOUR_MAP = { '1':'2h','2':'4h','3':'8h','5':'16h','8':'24h','13':'60h','21':'80h','?':'?' };

// Unique client ID (replaces socket.id)
function getOrCreateClientId() {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) { id = 'c' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6); localStorage.setItem(CLIENT_ID_KEY, id); }
  return id;
}
const clientId = getOrCreateClientId();

// ─── State ────────────────────────────────────────────────────────────────────
let myRole = null, myName = null, myVote = null, mySquad = null, myRoomId = null;
let myAvatar = localStorage.getItem(AVATAR_KEY) || AVATARS[0];
let currentSettings = { cards: [...DEFAULT_CARDS], hourMap: { ...DEFAULT_HOUR_MAP }, squads: [] };
let tempSettings = null;
let _latestParticipants = [];
let _latestPendingSm = {};
let _lastRevealedState = false;
let _savingHistory = false; // guard anti-duplicata no mesmo client
let _roomListenerRef = null;
let _kickListenerRef = null;
let _timerInterval = null;
let _currentTimerId = null;
let _pendingVoters = 0;
let squadOverrideDirty = false; // true quando o SM já editou cartas do squad nesta abertura do modal, antes de salvar

// ─── Configuração por squad ───────────────────────────────────────────────────
// Chaves do Firebase não aceitam . # $ / [ ] — encodeURIComponent cobre tudo menos o '.'
const squadKey = (sq) => encodeURIComponent(sq).replace(/\./g, '%2E');
// Resolve cartas/horas efetivas: override do squad quando existe, senão config global da sala
function effectiveFor(squad) {
  const ov = squad && currentSettings.squadOverrides && currentSettings.squadOverrides[squadKey(squad)];
  return ov ? { cards: ov.cards || [], hourMap: ov.hourMap || {} }
            : { cards: currentSettings.cards || [], hourMap: currentSettings.hourMap || {} };
}
const effectiveSettings = () => effectiveFor(mySquad);

// ─── Isolamento por squad ─────────────────────────────────────────────────────
// Regra: quem está dentro de um squad só enxerga o próprio squad — participantes,
// painel de votos, resultado e histórico. Quem não tem squad (o SM dono da sala)
// continua com a visão completa. O Scrum Master aparece para todos porque é ele
// quem conduz a rodada.
function scopeToSquad(participants) {
  if (!mySquad) return participants;
  return participants.filter((p) => p.squad === mySquad || p.role === 'master');
}

// Quantas rodadas ficaram de fora do histórico por serem de outro squad
let _scopeHiddenCount = 0;

// Filtra o histórico pelo squad ativo. Numa rodada em que mais de um squad votou,
// também remove os votantes dos outros squads de dentro da entrada — senão o
// nome e o voto do outro time vazariam na linha "Participantes".
function scopeHistoryToSquad(entries) {
  if (!mySquad) { _scopeHiddenCount = 0; return entries; }
  const kept = entries
    .filter((e) => Array.isArray(e.squads) && e.squads.includes(mySquad))
    .map((e) => ({
      ...e,
      squads: [mySquad],
      voters: Array.isArray(e.voters) ? e.voters.filter((v) => v.squad === mySquad) : [],
    }));
  _scopeHiddenCount = entries.length - kept.length;
  return kept;
}

function scopeNoteHtml() {
  if (!mySquad) return '';
  return `<div class="history-scope-note">🔒 Escopo: <strong>${escHtml(mySquad)}</strong> — rodadas de outros squads não são exibidas`
    + (_scopeHiddenCount > 0 ? ` (${_scopeHiddenCount} oculta(s) neste período)` : '')
    + `.</div>`;
}

const urlParams  = new URLSearchParams(window.location.search);
const urlSmToken = urlParams.get('sm');
const urlRoomId  = urlParams.get('r') || urlParams.get('room');   // 'room' mantido para compatibilidade
const urlSquad   = urlParams.get('s') || urlParams.get('squad');  // 'squad' mantido para compatibilidade

if (urlSmToken) document.querySelector('.role-btn[data-role="master"]')?.classList.remove('hidden');

// Pre-load room settings — uses localStorage cache for instant display, then refreshes from Firebase
(function preloadSettings() {
  const roomToLoad = urlRoomId || (urlSmToken ? localStorage.getItem(SM_ROOM_KEY) : null);
  if (!roomToLoad) return;

  // Synchronous: restore from cache so dropdown appears immediately (no flash on F5)
  try {
    const cached = JSON.parse(localStorage.getItem(`pp_sqc_${roomToLoad}`));
    if (Array.isArray(cached) && cached.length) {
      currentSettings = { ...currentSettings, squads: cached };
      updateSquadSelector();
    }
  } catch {}

  // Async: fetch fresh data from Firebase and update cache
  db.ref(`rooms/${roomToLoad}/settings`).once('value').then((snap) => {
    if (snap.exists() && snap.val()) {
      currentSettings = { ...currentSettings, ...snap.val() };
      updateSquadSelector();
      try { localStorage.setItem(`pp_sqc_${roomToLoad}`, JSON.stringify(currentSettings.squads || [])); } catch {}
    }
  });
})();

// ─── SM room ID ───────────────────────────────────────────────────────────────
function getOrCreateSmRoom() {
  let id = localStorage.getItem(SM_ROOM_KEY);
  if (!id) { id = 'r' + Math.random().toString(36).substr(2, 10); localStorage.setItem(SM_ROOM_KEY, id); }
  return id;
}

// ─── History ──────────────────────────────────────────────────────────────────
const historyKey = (r) => `pp_hist_${r}`;
function loadHistory(r) { try { return JSON.parse(localStorage.getItem(historyKey(r))) || []; } catch { return []; } }
function appendHistory(r, entry) {
  const h = loadHistory(r);
  // Evita duplicatas: não adiciona se já existe entrada com mesma data+história
  const sig = `${entry.date}|${entry.story}`;
  if (h.some(e => `${e.date}|${e.story}` === sig)) return;
  h.unshift(entry);
  if (h.length > 100) h.pop();
  localStorage.setItem(historyKey(r), JSON.stringify(h));
}
async function clearHistory(r) {
  localStorage.removeItem(historyKey(r));
  if (r) try { await db.ref(`rooms/${r}/history`).remove(); } catch {}
}

// _migrationDone é persistido no localStorage para sobreviver ao F5
// (chave por sala para isolar migrações de salas diferentes)
const migrationKey = (r) => `pp_migrated_${r}`;
function isMigrationDone(r) { return localStorage.getItem(migrationKey(r)) === '1'; }
function setMigrationDone(r) { try { localStorage.setItem(migrationKey(r), '1'); } catch {} }

async function loadMergedHistory(roomId) {
  if (!roomId) return [];

  let fbEntries = [];
  let fbLoaded = false;
  let fbSnap = null;
  try {
    const fbPromise = db.ref(`rooms/${roomId}/history`).orderByChild('_ts').once('value');
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000));
    fbSnap = await Promise.race([fbPromise, timeoutPromise]);
    fbLoaded = true;
    if (fbSnap.exists()) {
      fbSnap.forEach((child) => {
        const val = child.val();
        if (val._deleted) return;
        fbEntries.unshift({ ...val, _firebaseKey: child.key });
      });
    }
  } catch {}

  if (fbLoaded) {
    // Firebase respondeu — migração legada (roda só uma vez, flag durável)
    if (!isMigrationDone(roomId)) {
      const localEntries = loadHistory(roomId);
      // Inclui story names do Firebase (inclusive _deleted) para não re-importar deletadas
      const fbAllStories = new Set();
      if (fbSnap && fbSnap.exists()) {
        fbSnap.forEach((child) => { const v = child.val(); if (v.story) fbAllStories.add(v.story); });
      }
      const fbSigs = new Set(fbEntries.map(e => `${e.date}|${e.story}`));
      const localOnly = localEntries.filter(e => !fbSigs.has(`${e.date}|${e.story}`) && !fbAllStories.has(e.story));

      // Recovery scan de outras chaves pp_hist_*
      try {
        Object.keys(localStorage)
          .filter(k => k.startsWith('pp_hist_') && k !== historyKey(roomId))
          .forEach(key => {
            try {
              const other = JSON.parse(localStorage.getItem(key)) || [];
              other.forEach(e => {
                if (!fbAllStories.has(e.story) && !fbSigs.has(`${e.date}|${e.story}`)) localOnly.push(e);
              });
            } catch {}
          });
      } catch {}

      if (localOnly.length) {
        localOnly.forEach((entry) => {
          const ts = parseHistoryDate(entry.date)?.getTime() || Date.now();
          db.ref(`rooms/${roomId}/history`).push({ ...entry, _ts: ts }).catch(() => {});
        });
        await new Promise(r => setTimeout(r, 500));
        // Recarrega após migração
        try {
          const snap2 = await db.ref(`rooms/${roomId}/history`).orderByChild('_ts').once('value');
          if (snap2.exists()) {
            fbEntries = [];
            snap2.forEach((child) => {
              const val = child.val();
              if (val._deleted) return;
              fbEntries.unshift({ ...val, _firebaseKey: child.key });
            });
          }
        } catch {}
      }
      setMigrationDone(roomId);
    }

    // Firebase é fonte de verdade — apaga localStorage de histórico para evitar ressurreição
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith('pp_hist_'))
        .forEach(k => { try { localStorage.removeItem(k); } catch {} });
    } catch {}
  }

  fbEntries.sort((a, b) => {
    const ta = a._ts || parseHistoryDate(a.date)?.getTime() || 0;
    const tb = b._ts || parseHistoryDate(b.date)?.getTime() || 0;
    return tb - ta;
  });
  return fbEntries;
}

async function loadFirebaseHistory(roomId, fromVal, toVal) {
  const all = await loadMergedHistory(roomId);
  // O escopo por squad vem ANTES do filtro de data para que a contagem de
  // "rodadas ocultas" reflita o período que está sendo exibido.
  let scoped = scopeHistoryToSquad(all);
  if (!fromVal && !toVal) return scoped;
  const fromDate = fromVal ? new Date(fromVal) : null;
  const toDate   = toVal   ? new Date(toVal + 'T23:59:59') : null;
  return scoped.filter((entry) => {
    const d = parseHistoryDate(entry.date);
    if (!d) return true;
    if (fromDate && d < fromDate) return false;
    if (toDate   && d > toDate)   return false;
    return true;
  });
}

let _currentHistoryEntries = [];

function renderHistoryEntriesToContainer(container, entries, { canEdit = false, showScope = false } = {}) {
  const scopeNote = showScope ? scopeNoteHtml() : '';
  if (!entries.length) {
    container.innerHTML = scopeNote + '<p class="history-empty">Nenhuma rodada registrada ainda para este escopo.</p>';
    _currentHistoryEntries = [];
    return;
  }
  _currentHistoryEntries = entries;
  container.innerHTML = scopeNote + entries.map((entry, idx) => {
    const stats = [];
    if (entry.devMode)  stats.push(`<span class="history-stat-chip hsc-dev">Dev: ${escHtml(entry.devMode)}${entry.devHours ? ' = ' + escHtml(entry.devHours) : ''}</span>`);
    if (entry.qaAvg)   stats.push(`<span class="history-stat-chip hsc-qa">QA média: ${escHtml(entry.qaAvg)}</span>`);
    if (entry.devHours && entry.qaAvg) {
      const total = (parseFloat(entry.devHours) || 0) + (parseFloat(entry.qaAvg) || 0);
      if (total > 0) stats.push(`<span class="history-stat-chip hsc-total">Total: ${total % 1 === 0 ? total : total.toFixed(1)}h</span>`);
    }
    const squadStr = entry.squads?.length ? entry.squads.map(escHtml).join(', ') : '';
    const namesStr = entry.voters?.map((v) => `${escHtml(v.name)} (${escHtml(v.vote || '—')})`).join(', ') || '';
    const noteHtml = entry.note ? `<div class="history-note"><span class="history-note-icon">💬</span> ${escHtml(entry.note)}</div>` : '';
    const actionBtns = canEdit
      ? `<div class="history-entry-actions">
           <button class="btn-edit-entry"   data-idx="${idx}" title="Editar história e recado">✏️</button>
           <button class="btn-delete-entry" data-idx="${idx}" title="Excluir esta entrada">🗑️</button>
         </div>`
      : '';
    return `<div class="history-entry">
      <div class="history-entry-header">
        <span class="history-date">${escHtml(entry.date)}</span>
        <span class="history-story">${escHtml(entry.story)}</span>
        ${squadStr ? `<span class="squad-tag">${squadStr}</span>` : ''}
        ${actionBtns}
      </div>
      ${stats.length ? `<div class="history-stats">${stats.join('')}</div>` : ''}
      ${namesStr ? `<div class="history-participants">${namesStr}</div>` : ''}
      ${noteHtml}
    </div>`;
  }).join('');

  if (canEdit) {
    container.querySelectorAll('.btn-edit-entry').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        openEditStoryModal(_currentHistoryEntries[idx]);
      });
    });
    container.querySelectorAll('.btn-delete-entry').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx   = parseInt(btn.dataset.idx, 10);
        const entry = _currentHistoryEntries[idx];
        if (!confirm(`Excluir "${entry.story}" (${entry.date})?`)) return;

        // Remove visualmente só a entrada clicada (chave do Firebase quando existe)
        _currentHistoryEntries = entry._firebaseKey
          ? _currentHistoryEntries.filter(e => e._firebaseKey !== entry._firebaseKey)
          : _currentHistoryEntries.filter(e => `${e.date}|${e.story}` !== `${entry.date}|${entry.story}`);
        const cont = btn.closest('.history-entries') || document.getElementById('history-entries');
        if (cont) renderHistoryEntriesToContainer(cont, _currentHistoryEntries, { canEdit: true });

        // Deleta no Firebase e localStorage (aguarda e avisa se falhar)
        try {
          await deleteHistoryEntry(entry);
        } catch {
          toast('Não foi possível excluir do servidor. Tente novamente.', 'error');
        }
      });
    });
  }
}

async function exportHistoryDataToExcel(entries) {
  if (!entries.length) { toast('Nenhum dado para exportar no período selecionado.', 'warn'); return; }
  const rows = entries.map((entry) => {
    const devCol = entry.devMode ? `${entry.devMode}${entry.devHours ? ' = ' + entry.devHours : ''}` : '—';
    const qaCol  = entry.qaAvg || '—';
    const devH   = parseFloat(entry.devHours) || 0;
    const qaH    = parseFloat(entry.qaAvg)    || 0;
    const total  = devH + qaH;
    const totalCol = total > 0 ? `${total % 1 === 0 ? total : total.toFixed(1)}h` : '—';
    return { 'Data': entry.date, 'Histórias': entry.story, 'Pontuação/Horas Dev': devCol, 'Horas QA': qaCol, 'Total': totalCol };
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch: 20 }, { wch: 40 }, { wch: 22 }, { wch: 12 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Histórico');
  XLSX.writeFile(wb, 'historico-estimativas.xlsx');
}

// ─── Session persistence ──────────────────────────────────────────────────────
function saveSession() { localStorage.setItem(SESSION_KEY, JSON.stringify({ name: myName, role: myRole, squad: mySquad, smToken: urlSmToken, roomId: myRoomId })); }
function loadSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } }
function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  myName = null; myRole = null; myVote = null; mySquad = null; myRoomId = null;
  _latestParticipants = []; _currentHistoryEntries = []; _savingHistory = false; _pendingVoters = 0;
}

// Auto-join on page load
window.addEventListener('load', async () => {
  const saved = loadSession();
  if (saved && saved.name && saved.role) {
    myName = saved.name; myRole = saved.role; mySquad = saved.squad || null;
    myRoomId = saved.roomId || (saved.role === 'master' ? getOrCreateSmRoom() : urlRoomId);
    showScreen(saved.role);
    await joinRoom(saved.name, saved.role, mySquad, myRoomId, saved.smToken || urlSmToken);
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
let selectedRole = 'developer';
let selectedLoginSquad = '';
document.querySelectorAll('.role-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.role-btn').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
    btn.classList.add('active'); btn.setAttribute('aria-pressed', 'true'); selectedRole = btn.dataset.role;
  });
});
document.getElementById('squad-picker')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.squad-btn'); if (!btn) return;
  selectedLoginSquad = btn.dataset.squad;
  document.querySelectorAll('#squad-picker .squad-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.squad === selectedLoginSquad)));
});
document.getElementById('btn-join').addEventListener('click', doJoin);
document.getElementById('input-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

function initAvatarPicker() {
  const picker = document.getElementById('avatar-picker');
  if (!picker) return;
  AVATARS.forEach((emoji) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'avatar-opt' + (myAvatar === emoji ? ' av-selected' : '');
    btn.textContent = emoji;
    btn.addEventListener('click', () => {
      myAvatar = emoji;
      localStorage.setItem(AVATAR_KEY, emoji);
      picker.querySelectorAll('.avatar-opt').forEach((b) => b.classList.remove('av-selected'));
      btn.classList.add('av-selected');
    });
    picker.appendChild(btn);
  });
}
document.addEventListener('DOMContentLoaded', initAvatarPicker);

async function doJoin() {
  const name  = document.getElementById('input-name').value.trim();
  const errEl = document.getElementById('login-error');
  if (!name) { errEl.textContent = 'Por favor, informe seu nome.'; errEl.classList.remove('hidden'); return; }
  if (selectedRole !== 'master' && !urlRoomId) { errEl.textContent = 'Use o link da sessão enviado pelo Scrum Master.'; errEl.classList.remove('hidden'); return; }
  if (selectedRole === 'master' && urlSmToken !== SM_TOKEN) { errEl.textContent = 'Token de Scrum Master inválido. Use o link correto.'; errEl.classList.remove('hidden'); return; }

  if (selectedRole !== 'master') {
    const snap = await db.ref(`rooms/${urlRoomId}`).once('value');
    if (!snap.exists()) { errEl.textContent = 'Sala não encontrada. Peça o link correto ao Scrum Master.'; errEl.classList.remove('hidden'); return; }

    // Squad tem que existir na sala: nem a URL nem o picker podem inventar um
    const roomSquads = (snap.val() && snap.val().settings && snap.val().settings.squads) || [];
    const picked = (urlSquad && roomSquads.includes(urlSquad))
      ? urlSquad
      : ((selectedLoginSquad && roomSquads.includes(selectedLoginSquad)) ? selectedLoginSquad : null);
    if (roomSquads.length && !picked) {
      errEl.textContent = urlSquad
        ? `O squad "${urlSquad}" não existe nesta sala. Selecione um squad válido.`
        : 'Selecione o seu squad para entrar.';
      errEl.classList.remove('hidden');
      document.getElementById('squad-group').style.display = '';
      return;
    }
    mySquad = picked;
    myName = name; myRole = selectedRole; myRoomId = urlRoomId;
    errEl.classList.add('hidden');
    saveSession();
    showScreen(selectedRole);
    await joinRoom(name, selectedRole, mySquad, myRoomId, urlSmToken);
    return;
  }

  // Scrum Master: quem já é dono da sala (ou já foi aprovado) entra direto;
  // qualquer outro navegador pede acesso e espera aprovação do dono — fecha a
  // brecha do token fixo (MELHORIAS.md item 5.1: link = qualquer um vira SM).
  const squadGroupEl = document.getElementById('squad-group');
  const squad = (squadGroupEl && squadGroupEl.offsetParent !== null && selectedLoginSquad) ? selectedLoginSquad : null;
  const roomId = urlRoomId || getOrCreateSmRoom();
  if (urlRoomId) localStorage.setItem(SM_ROOM_KEY, urlRoomId);
  errEl.classList.add('hidden');
  await attemptMasterJoin(name, squad, roomId);
}

async function attemptMasterJoin(name, squad, roomId) {
  const ownerSnap = await db.ref(`rooms/${roomId}/owner`).once('value');
  const owner = ownerSnap.val();
  if (!owner) {
    // Ninguém reivindicou esta sala como Scrum Master ainda — este navegador vira o dono.
    await db.ref(`rooms/${roomId}/owner`).set(clientId);
    await db.ref(`rooms/${roomId}/approvedSmClients/${clientId}`).set(true);
  } else if (owner !== clientId) {
    const approvedSnap = await db.ref(`rooms/${roomId}/approvedSmClients/${clientId}`).once('value');
    if (approvedSnap.val() !== true) {
      await db.ref(`rooms/${roomId}/pendingSm/${clientId}`).set({ name, requestedAt: Date.now() });
      showSmPendingScreen(roomId, name, squad);
      return;
    }
  }
  completeMasterLogin(name, squad, roomId);
}

function completeMasterLogin(name, squad, roomId) {
  myName = name; myRole = 'master'; mySquad = squad; myRoomId = roomId;
  saveSession();
  showScreen('master');
  joinRoom(name, 'master', squad, roomId, urlSmToken);
}

// ─── Pedido de acesso a SM pendente de aprovação ───────────────────────────────
let _smApprovedListenerRef = null;
let _smDenyListenerRef = null;
let _pendingSmRoomId = null;

function showSmPendingScreen(roomId, name, squad) {
  _pendingSmRoomId = roomId;
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById('screen-sm-pending').classList.add('active');

  if (_smApprovedListenerRef) _smApprovedListenerRef.off();
  _smApprovedListenerRef = db.ref(`rooms/${roomId}/approvedSmClients/${clientId}`);
  _smApprovedListenerRef.on('value', (snap) => {
    if (snap.val() === true) {
      stopSmPendingListeners();
      db.ref(`rooms/${roomId}/pendingSm/${clientId}`).remove();
      completeMasterLogin(name, squad, roomId);
    }
  });

  // Se o pedido pendente sumir sem aprovação, o SM da sala recusou.
  if (_smDenyListenerRef) _smDenyListenerRef.off();
  _smDenyListenerRef = db.ref(`rooms/${roomId}/pendingSm/${clientId}`);
  let sawPending = false;
  _smDenyListenerRef.on('value', (snap) => {
    if (snap.exists()) { sawPending = true; return; }
    if (!sawPending) return;
    db.ref(`rooms/${roomId}/approvedSmClients/${clientId}`).once('value').then((approvedSnap) => {
      if (approvedSnap.val() === true) return; // aprovado — o outro listener cuida do login
      stopSmPendingListeners();
      document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
      document.getElementById('screen-login').classList.add('active');
      const errEl = document.getElementById('login-error');
      errEl.textContent = 'Seu pedido de acesso como Scrum Master foi recusado.';
      errEl.classList.remove('hidden');
    });
  });
}

function stopSmPendingListeners() {
  if (_smApprovedListenerRef) { _smApprovedListenerRef.off(); _smApprovedListenerRef = null; }
  if (_smDenyListenerRef) { _smDenyListenerRef.off(); _smDenyListenerRef = null; }
  _pendingSmRoomId = null;
}

document.getElementById('btn-cancel-sm-pending')?.addEventListener('click', async () => {
  const roomId = _pendingSmRoomId;
  stopSmPendingListeners();
  if (roomId) await db.ref(`rooms/${roomId}/pendingSm/${clientId}`).remove();
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById('screen-login').classList.add('active');
});

// ─── Logout ───────────────────────────────────────────────────────────────────
['dev-logout', 'qa-logout', 'observer-logout', 'tl-logout', 'master-logout'].forEach((id) => {
  document.getElementById(id)?.addEventListener('click', doLogout);
});

function doLogout() {
  if (myRoomId) {
    db.ref(`rooms/${myRoomId}/participants/${clientId}`).remove();
    if (_roomListenerRef) { _roomListenerRef.off(); _roomListenerRef = null; }
    if (_kickListenerRef) { _kickListenerRef.off(); _kickListenerRef = null; }
  }
  clearSession(); myVote = null; _lastRevealedState = false;
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById('screen-login').classList.add('active');
  document.getElementById('input-name').value = '';
  document.getElementById('login-error').classList.add('hidden');
}

// ─── Firebase: join room ──────────────────────────────────────────────────────
async function joinRoom(name, role, squad, roomId, smToken) {
  if (!roomId) return;
  const participantRef = db.ref(`rooms/${roomId}/participants/${clientId}`);
  await participantRef.set({ name, role, squad: squad || null, vote: null, avatar: myAvatar });
  participantRef.onDisconnect().remove();

  if (role === 'master') {
    const settSnap = await db.ref(`rooms/${roomId}/settings`).once('value');
    if (!settSnap.exists()) await db.ref(`rooms/${roomId}/settings`).set({ cards: [...DEFAULT_CARDS], hourMap: { ...DEFAULT_HOUR_MAP }, squads: [] });
    const roundSnap = await db.ref(`rooms/${roomId}/round`).once('value');
    if (!roundSnap.exists()) await db.ref(`rooms/${roomId}/round`).set({ active: false, story: '', revealed: false });
  }

  listenToRoom(roomId);
  listenForKick(roomId);

  // For SM: update the browser URL to include room= so the address bar becomes a bookmarkable link
  if (role === 'master' && roomId) {
    const url = new URL(window.location.href);
    if (url.searchParams.get('r') !== roomId) {
      url.searchParams.delete('room'); // remove param legado se existir
      url.searchParams.set('r', roomId);
      history.replaceState(null, '', url.toString());
    }
  }
}

function listenToRoom(roomId) {
  if (_roomListenerRef) _roomListenerRef.off();
  _roomListenerRef = db.ref(`rooms/${roomId}`);
  _roomListenerRef.on('value', async (snap) => {
    const data = snap.val();
    if (!data) return;
    const round    = data.round    || { active: false, story: '', revealed: false };
    const settings = data.settings || currentSettings;
    const rawParts = data.participants || {};

    if (settings) { currentSettings = settings; updateSquadSelector(); }

    // Build participant array — hide votes until revealed
    const participants = Object.entries(rawParts).map(([id, p]) => ({
      id, name: p.name, role: p.role, squad: p.squad || null,
      avatar: p.avatar || '',
      hasVoted: p.vote !== null && p.vote !== undefined,
      vote: round.revealed ? p.vote : null,
    }));
    // Isolamento por squad: dentro de um squad, as telas mostram só o próprio time
    const visible = scopeToSquad(participants);
    _latestParticipants = visible;
    _latestPendingSm = data.pendingSm || {};
    if (myRole === 'master' && document.getElementById('tab-access')?.classList.contains('active-tab')) renderPendingSmRequests();

    // Rehidrata o voto local a partir do Firebase (F5 no meio da rodada)
    const myStoredVote = rawParts[clientId] ? (rawParts[clientId].vote ?? null) : null;
    if (round.active && myVote === null && myStoredVote !== null) myVote = myStoredVote;

    // Votantes e progresso também são do squad — o SM de um squad não fica
    // esperando o squad vizinho votar para conseguir revelar a própria rodada
    const voters   = visible.filter((p) => p.role !== 'master' && p.role !== 'observer');
    const allVoted = voters.length > 0 && voters.every((p) => p.hasVoted);
    const votedCount = voters.filter((p) => p.hasVoted).length;

    // Save history on reveal (SM only, once per reveal)
    // _historySaved: flag no Firebase impede re-salvar ao recarregar
    // _savingHistory: guard local impede duplo disparo no mesmo client
    if (myRole === 'master' && round.revealed && !_lastRevealedState && !round._historySaved && !_savingHistory) {
      _savingHistory = true;
      // Mesmo escopo da tela: um SM dentro de um squad grava a rodada do squad
      // dele, não a apuração misturada com o squad vizinho
      const partsWithVotes = scopeToSquad(Object.entries(rawParts).map(([id, p]) => ({
        id, name: p.name, role: p.role, squad: p.squad || null,
        hasVoted: p.vote !== null, vote: p.vote,
      })));
      // Grava histórico E _historySaved atomicamente num único update para fechar
      // a race condition: se o SM der F5 entre o reveal e o set do flag,
      // _historySaved chega antes e o listener não re-dispara no reload
      await saveRoundToHistory(partsWithVotes, round);
      if (!document.getElementById('master-history-panel')?.classList.contains('hidden')) renderHistory();
    }
    _lastRevealedState = round.revealed;
    if (!round.revealed) _savingHistory = false;

    if (myRole === 'developer')      { updateDevView(visible, round);              updateParticipants(visible, 'dev-participants'); }
    else if (myRole === 'qa')        { updateQaView(visible, round);               updateParticipants(visible, 'qa-participants'); }
    else if (myRole === 'observer')  { updateObserverView(visible, round);         updateParticipants(visible, 'observer-participants'); }
    else if (myRole === 'tech-lead') { updateTechLeadView(visible, round);         updateParticipants(visible, 'tl-participants'); }
    else if (myRole === 'master')    { updateMasterView(visible, round, allVoted, votedCount, voters.length); updateParticipants(visible, 'master-participants'); }

    const usersTab = document.getElementById('tab-users');
    if (usersTab?.classList.contains('active-tab')) renderParticipantsManage();
  });
}

function listenForKick(roomId) {
  if (_kickListenerRef) _kickListenerRef.off();
  _kickListenerRef = db.ref(`rooms/${roomId}/kicked/${clientId}`);
  _kickListenerRef.on('value', (snap) => {
    if (snap.val() === true) {
      snap.ref.remove();
      doLogout();
      const errEl = document.getElementById('login-error');
      errEl.textContent = 'Você foi removido da sessão pelo Scrum Master.';
      errEl.classList.remove('hidden');
    }
  });
}

// ─── Indicador de conexão ─────────────────────────────────────────────────────
(function watchConnection() {
  let firstValue = true;
  try {
    db.ref('.info/connected').on('value', (snap) => {
      const online = snap.val() === true;
      // O primeiro callback quase sempre chega como false antes do handshake
      if (firstValue && !online) { firstValue = false; return; }
      firstValue = false;
      const el = document.getElementById('conn-banner');
      if (!el) return;
      el.classList.toggle('hidden', online);
    });
  } catch {}
})();

// ─── Firebase actions ─────────────────────────────────────────────────────────
// squad opcional: quando informado, limpa só os votos dos participantes daquele squad
async function clearVotes(squad) {
  const snap = await db.ref(`rooms/${myRoomId}/participants`).once('value');
  if (!snap.exists()) return;
  const updates = {};
  snap.forEach((c) => {
    if (squad && (c.val()?.squad || null) !== squad) return;
    updates[`${c.key}/vote`] = null;
  });
  if (!Object.keys(updates).length) return;
  await db.ref(`rooms/${myRoomId}/participants`).update(updates);
}

// ─── Developer voting ─────────────────────────────────────────────────────────
document.getElementById('fibonacci-cards').addEventListener('click', (e) => {
  const card = e.target.closest('.fib-card');
  if (!card || card.disabled) return;
  myVote = card.dataset.value;
  document.querySelectorAll('#fibonacci-cards .fib-card').forEach((c) => { c.classList.remove('selected'); c.setAttribute('aria-pressed', 'false'); });
  card.classList.add('selected'); card.setAttribute('aria-pressed', 'true');
  db.ref(`rooms/${myRoomId}/participants/${clientId}/vote`).set(myVote);
  document.getElementById('dev-voted-msg').classList.remove('hidden');
});

// ─── Tech Lead voting ─────────────────────────────────────────────────────────
document.getElementById('tl-fibonacci-cards').addEventListener('click', (e) => {
  const card = e.target.closest('.fib-card');
  if (!card || card.disabled) return;
  myVote = card.dataset.value;
  document.querySelectorAll('#tl-fibonacci-cards .fib-card').forEach((c) => { c.classList.remove('selected'); c.setAttribute('aria-pressed', 'false'); });
  card.classList.add('selected'); card.setAttribute('aria-pressed', 'true');
  db.ref(`rooms/${myRoomId}/participants/${clientId}/vote`).set(myVote);
  document.getElementById('tl-voted-msg').classList.remove('hidden');
});

// ─── QA voting ────────────────────────────────────────────────────────────────
document.getElementById('btn-qa-vote').addEventListener('click', submitQaVote);
document.getElementById('qa-hours-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitQaVote(); });
function submitQaVote() {
  const val = document.getElementById('qa-hours-input').value;
  const parsed = parseFloat(val);
  if (!val || isNaN(parsed) || parsed <= 0) return;
  myVote = `${parsed}h`;
  db.ref(`rooms/${myRoomId}/participants/${clientId}/vote`).set(myVote);
  document.getElementById('qa-voted-msg').classList.remove('hidden');
  document.getElementById('btn-qa-vote').textContent = 'Atualizar';
}

// ─── Master controls ──────────────────────────────────────────────────────────
document.getElementById('btn-copy-result').addEventListener('click', copyResultsAsImage);
document.getElementById('btn-tl-copy-result').addEventListener('click', copyTlResultsAsImage);
document.getElementById('btn-start').addEventListener('click', async () => {
  const story = document.getElementById('master-story-input').value.trim();
  await db.ref(`rooms/${myRoomId}/round`).set({ active: true, story: story || '', revealed: false, startedAt: Date.now() });
  await clearVotes(mySquad || undefined);
});
document.getElementById('btn-reveal').addEventListener('click', () => {
  if (_pendingVoters > 0 && !confirm(`Ainda faltam ${_pendingVoters} voto(s). Revelar mesmo assim?`)) return;
  db.ref(`rooms/${myRoomId}/round/revealed`).set(true);
});

// Barra de progresso da votacao — o SM enxerga de relance quanto falta
function renderVoteProgress(voted, total, revealed) {
  const el = document.getElementById('master-vote-progress');
  if (!el) return;
  if (!total) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  const pct = Math.round((voted / total) * 100);
  el.innerHTML = `
    <div class="vp-label"><span>${revealed ? 'Rodada revelada' : 'Votos recebidos'}</span><strong>${voted}/${total}</strong></div>
    <div class="vp-track"><div class="vp-fill${voted === total ? ' vp-full' : ''}" style="width:${pct}%"></div></div>`;
}
document.getElementById('btn-reset').addEventListener('click', async () => {
  myVote = null;
  document.getElementById('master-story-input').value = '';
  await db.ref(`rooms/${myRoomId}/round`).set({ active: false, story: '', revealed: false });
  await clearVotes(mySquad || undefined);
});

// ─── Histórico ────────────────────────────────────────────────────────────────
document.getElementById('btn-toggle-history').addEventListener('click', () => {
  const panel = document.getElementById('master-history-panel');
  const open  = panel.classList.contains('hidden');
  panel.classList.toggle('hidden');
  document.getElementById('btn-toggle-history').textContent = open ? '✕ Fechar' : '📋 Histórico';
  if (open) renderHistory();
});
document.getElementById('btn-clear-history').addEventListener('click', async () => {
  // Acao destrutiva e irreversivel numa sala compartilhada: exige confirmacao
  const total = _currentHistoryEntries.length;
  if (!confirm(`Apagar TODO o histórico desta sala${total ? ` (${total} rodada(s))` : ''}?\n\nIsso afeta todos os participantes e não pode ser desfeito.\nExporte para Excel antes se quiser guardar.`)) return;
  await clearHistory(myRoomId);
  _currentHistoryEntries = [];
  renderHistory();
  toast('Histórico apagado.');
});
document.getElementById('btn-filter-history').addEventListener('click', renderHistory);
document.getElementById('btn-filter-clear').addEventListener('click', () => {
  const fromEl = document.getElementById('filter-from');
  const toEl   = document.getElementById('filter-to');
  if (fromEl) fromEl.value = '';
  if (toEl)   toEl.value   = '';
  renderHistory();
});
document.getElementById('btn-export-history').addEventListener('click', exportHistoryToExcel);
document.getElementById('btn-import-history').addEventListener('click', importHistoryFromExcel);

// ─── Tech Lead history ─────────────────────────────────────────────────────────
document.getElementById('btn-tl-toggle-history').addEventListener('click', () => {
  const panel = document.getElementById('tl-history-panel');
  const open  = panel.classList.contains('hidden');
  panel.classList.toggle('hidden');
  document.getElementById('btn-tl-toggle-history').textContent = open ? '✕ Fechar' : '📋 Histórico';
  if (open) renderTlHistory();
});
document.getElementById('btn-tl-filter-history').addEventListener('click', renderTlHistory);
document.getElementById('btn-tl-filter-clear').addEventListener('click', () => {
  const fromEl = document.getElementById('tl-filter-from');
  const toEl   = document.getElementById('tl-filter-to');
  if (fromEl) fromEl.value = '';
  if (toEl)   toEl.value   = '';
  renderTlHistory();
});
document.getElementById('btn-tl-export-history').addEventListener('click', exportTlHistoryToExcel);

async function saveRoundToHistory(participants, round) {
  if (!myRoomId) return;
  const devVoters = participants.filter((p) => (p.role === 'developer' || p.role === 'tech-lead') && p.vote && p.vote !== '?');
  const qaVoters  = participants.filter((p) => p.role === 'qa' && p.vote);
  const now = new Date().toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
  let devMode = null, devHours = null;
  if (devVoters.length) { const { mode } = calcMode(devVoters.map((p) => p.vote)); devMode = mode; devHours = hoursForVote(mode, devVoters) || null; }
  let qaAvg = null;
  if (qaVoters.length) {
    const qaH = qaVoters.map((p) => parseFloat(p.vote)).filter((v) => !isNaN(v));
    const avg = qaH.reduce((a, b) => a + b, 0) / qaH.length;
    qaAvg = avg % 1 === 0 ? `${avg}h` : `${avg.toFixed(1)}h`;
  }
  const squads = [...new Set(participants.filter((p) => p.squad).map((p) => p.squad))];
  const entry = {
    date: now, story: round.story || '(sem título)', devMode, devHours, qaAvg, squads,
    voters: participants.filter((p) => p.role !== 'master' && p.role !== 'observer').map((p) => ({ name: p.name, role: p.role, squad: p.squad, vote: p.vote })),
  };
  // Escrita atômica: histórico + _historySaved num único update
  // Garante que _historySaved chega ao Firebase junto com a entrada,
  // fechando a race condition que causava re-salvamento no reload
  try {
    const histKey = db.ref(`rooms/${myRoomId}/history`).push().key;
    const updates = {};
    updates[`rooms/${myRoomId}/history/${histKey}`] = { ...entry, _ts: Date.now() };
    updates[`rooms/${myRoomId}/round/_historySaved`] = true;
    await db.ref().update(updates);
  } catch {}
}

function importHistoryFromExcel() {
  if (!myRoomId) { toast('Entre na sessão como Scrum Master antes de importar.', 'warn'); return; }
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.xlsx,.xls';
  input.onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      const entries = rows.map(row => {
        const dateStr = String(row['Data'] || '').trim();
        if (!dateStr) return null;
        const story = String(row['Histórias'] || '(sem título)').trim();
        const devCol = String(row['Pontuação/Horas Dev'] || '').trim();
        const qaCol  = String(row['Horas QA'] || '').trim();
        let devMode = null, devHours = null;
        const devMatch = devCol.match(/^([^\s=]+)\s*=\s*(\S+)/);
        if (devMatch) { devMode = devMatch[1]; devHours = devMatch[2]; }
        else if (devCol && devCol !== '—') devMode = devCol;
        const qaAvg = (qaCol && qaCol !== '—') ? qaCol : null;
        return { date: dateStr, story, devMode, devHours, qaAvg, squads: [], voters: [], _imported: true };
      }).filter(Boolean);
      if (!entries.length) { toast('Nenhuma linha válida encontrada. Verifique se o arquivo é o exportado por esta aplicação.', 'warn'); return; }
      // Load existing sigs to avoid duplicates
      const existing = await loadMergedHistory(myRoomId);
      const existSigs = new Set(existing.map(e => `${e.date}|${e.story}`));
      const toImport = entries.filter(e => !existSigs.has(`${e.date}|${e.story}`));
      if (!toImport.length) { toast('Todas as entradas do arquivo já existem no histórico.', 'warn'); return; }
      for (const entry of toImport) {
        const ts = parseHistoryDate(entry.date)?.getTime() || Date.now();
        try { await db.ref(`rooms/${myRoomId}/history`).push({ ...entry, _ts: ts }); } catch {}
      }
      // Reseta flag de migração para que novas entradas importadas sejam incluídas
      try { localStorage.removeItem(migrationKey(myRoomId)); } catch {}
      renderHistory();
      toast(`✅ ${toImport.length} entrada(s) restaurada(s) com sucesso!`, 'ok');
    } catch { toast('Erro ao ler o arquivo. Verifique se é um .xlsx exportado por esta aplicação.', 'error'); }
  };
  input.click();
}

function parseHistoryDate(dateStr) {
  const m = String(dateStr).match(/^(\d{2})\/(\d{2})\/(\d{4})(?:,\s*(\d{2}):(\d{2}))?/);
  if (!m) return null;
  const time = (m[4] && m[5]) ? `T${m[4]}:${m[5]}:00` : 'T00:00:00';
  return new Date(`${m[3]}-${m[2]}-${m[1]}${time}`);
}

async function renderHistory() {
  const container = document.getElementById('history-entries');
  if (!container || !myRoomId) return;
  const from = document.getElementById('filter-from')?.value;
  const to   = document.getElementById('filter-to')?.value;
  container.innerHTML = '<p class="history-empty">Carregando...</p>';
  try {
    const entries = await loadFirebaseHistory(myRoomId, from, to);
    renderHistoryEntriesToContainer(container, entries, { canEdit: true, showScope: true });
  } catch {
    container.innerHTML = '<p class="history-empty">⚠️ Não foi possível carregar o histórico. Tente novamente.</p>';
  }
}

async function exportHistoryToExcel() {
  // Usa o que está exibido na tela para o Excel refletir deleções feitas na sessão
  if (_currentHistoryEntries.length > 0) {
    exportHistoryDataToExcel(_currentHistoryEntries);
    return;
  }
  const from = document.getElementById('filter-from')?.value;
  const to   = document.getElementById('filter-to')?.value;
  const entries = await loadFirebaseHistory(myRoomId, from, to);
  exportHistoryDataToExcel(entries);
}

async function renderTlHistory() {
  const container = document.getElementById('tl-history-entries');
  if (!container || !myRoomId) return;
  container.innerHTML = '<p class="history-empty">Carregando...</p>';
  const from = document.getElementById('tl-filter-from')?.value;
  const to   = document.getElementById('tl-filter-to')?.value;
  try {
    const entries = await loadFirebaseHistory(myRoomId, from, to);
    renderHistoryEntriesToContainer(container, entries, { showScope: true });
  } catch {
    container.innerHTML = '<p class="history-empty">⚠️ Não foi possível carregar o histórico. Tente novamente.</p>';
  }
}

async function exportTlHistoryToExcel() {
  const from = document.getElementById('tl-filter-from')?.value;
  const to   = document.getElementById('tl-filter-to')?.value;
  const entries = await loadFirebaseHistory(myRoomId, from, to);
  exportHistoryDataToExcel(entries);
}

// ─── Delete history entry ─────────────────────────────────────────────────────
async function deleteHistoryEntry(entry) {
  if (!myRoomId) return;
  // Soft-delete: marca _deleted=true. Isso é obrigatório: com localStorage bloqueado
  // (Edge Tracking Prevention) a migration não consegue salvar a flag "já migrado" e
  // roda a cada F5 — o soft-delete garante que a entrada continua visível em
  // fbAllStories e nunca é re-importada do localStorage.
  // Quando a entrada veio do Firebase apagamos exatamente ela pela chave; a varredura
  // por date|story só existe como fallback para entradas legadas sem _firebaseKey.
  if (entry._firebaseKey) {
    await db.ref(`rooms/${myRoomId}/history/${entry._firebaseKey}`).update({ _deleted: true });
    return;
  }
  const sig = `${entry.date}|${entry.story}`;
  const snap = await db.ref(`rooms/${myRoomId}/history`).once('value');
  if (snap.exists()) {
    const toMark = [];
    snap.forEach((child) => {
      const v = child.val();
      if (`${v.date}|${v.story}` === sig && !v._deleted) toMark.push(child.key);
    });
    for (const k of toMark) {
      await db.ref(`rooms/${myRoomId}/history/${k}`).update({ _deleted: true });
    }
  }
}

// ─── Edit story modal ─────────────────────────────────────────────────────────
let _editingEntry = null;

function openEditStoryModal(entry) {
  _editingEntry = entry;
  document.getElementById('edit-story-name').value = entry.story || '';
  document.getElementById('edit-story-note').value = entry.note || '';
  document.getElementById('edit-story-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('edit-story-name').focus(), 50);
}

function closeEditStoryModal() {
  _editingEntry = null;
  document.getElementById('edit-story-modal').classList.add('hidden');
}

async function saveEditStory() {
  if (!_editingEntry || !myRoomId) return;
  const newName = document.getElementById('edit-story-name').value.trim();
  const newNote = document.getElementById('edit-story-note').value.trim();
  if (!newName) { toast('O nome da história não pode estar vazio.', 'warn'); return; }

  const updates = { story: newName };
  if (newNote) updates.note = newNote; else updates.note = null;
  const oldSig = `${_editingEntry.date}|${_editingEntry.story}`;

  // Atualiza no Firebase
  if (_editingEntry._firebaseKey) {
    try { await db.ref(`rooms/${myRoomId}/history/${_editingEntry._firebaseKey}`).update(updates); }
    catch (e) { console.warn('Firebase update failed:', e); }
  }

  // Atualiza no localStorage
  try {
    const localHist = loadHistory(myRoomId);
    const i = localHist.findIndex((e) => `${e.date}|${e.story}` === oldSig);
    if (i >= 0) {
      localHist[i] = { ...localHist[i], ...updates };
      localStorage.setItem(historyKey(myRoomId), JSON.stringify(localHist));
    }
  } catch {}

  closeEditStoryModal();
  renderHistory();
}

document.getElementById('btn-close-edit-story').addEventListener('click', closeEditStoryModal);
document.getElementById('btn-cancel-edit-story').addEventListener('click', closeEditStoryModal);
document.getElementById('btn-save-edit-story').addEventListener('click', saveEditStory);
document.getElementById('edit-story-modal').addEventListener('click', (e) => { if (e.target.id === 'edit-story-modal') closeEditStoryModal(); });

// ─── Settings modal ───────────────────────────────────────────────────────────
document.getElementById('btn-open-settings').addEventListener('click', openSettings);
document.getElementById('btn-close-settings').addEventListener('click', closeSettings);
document.getElementById('btn-cancel-settings').addEventListener('click', closeSettings);
document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
document.getElementById('btn-add-card').addEventListener('click', addCardRow);
document.getElementById('btn-add-squad').addEventListener('click', addSquad);
document.getElementById('settings-modal').addEventListener('click', (e) => { if (e.target.id === 'settings-modal') closeSettings(); });

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tabId = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active-tab'));
    document.getElementById(tabId)?.classList.add('active-tab');
    const footer = document.getElementById('settings-footer');
    if (tabId === 'tab-access' || tabId === 'tab-users') footer?.classList.add('hidden');
    else footer?.classList.remove('hidden');
    if (tabId === 'tab-access') { renderSmAccessTab(); renderPendingSmRequests(); }
    if (tabId === 'tab-users') renderParticipantsManage();
  });
});

function openSettings() {
  // Semeia com as cartas/horas efetivas do squad do SM (a lista de squads segue global)
  const eff = effectiveFor(mySquad);
  tempSettings = { cards: [...eff.cards], hourMap: { ...eff.hourMap }, squads: [...(currentSettings.squads || [])] };
  squadOverrideDirty = false;
  applySquadScopeLabels();
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
  document.querySelector('.tab-btn[data-tab="tab-cards"]')?.classList.add('active');
  document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active-tab'));
  document.getElementById('tab-cards')?.classList.add('active-tab');
  document.getElementById('settings-footer')?.classList.remove('hidden');
  renderSettingsRows(); renderSquadsTab();
  document.getElementById('settings-modal').classList.remove('hidden');
}
function closeSettings() { document.getElementById('settings-modal').classList.add('hidden'); tempSettings = null; }

function getAllCardKeys() {
  const all = new Set([...tempSettings.cards, ...Object.keys(tempSettings.hourMap)]);
  const nums = [...all].filter((v) => v !== '?' && !isNaN(parseFloat(v)));
  nums.sort((a, b) => parseFloat(a) - parseFloat(b));
  if (all.has('?')) nums.push('?');
  return nums;
}
function renderSettingsRows() {
  const tbody = document.getElementById('settings-rows');
  tbody.innerHTML = '';
  getAllCardKeys().forEach((val) => {
    const isActive = tempSettings.cards.includes(val);
    const hours = tempSettings.hourMap[val] || '';
    const tr = document.createElement('tr');
    tr.dataset.cardVal = val;
    tr.innerHTML = `<td><strong>${escHtml(val)}</strong></td><td><input class="s-input h-edit" type="text" value="${escHtml(hours)}" placeholder="ex: 8h" /></td><td><label class="toggle"><input type="checkbox" class="a-toggle" ${isActive ? 'checked' : ''} /><span class="t-slider"></span></label></td><td><button class="btn-del" title="Remover">🗑</button></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.btn-del').forEach((btn) => {
    btn.addEventListener('click', () => { const v = btn.closest('tr').dataset.cardVal; tempSettings.cards = tempSettings.cards.filter((c) => c !== v); delete tempSettings.hourMap[v]; markSquadOverrideDirty(); renderSettingsRows(); });
  });
  tbody.querySelectorAll('.a-toggle, .h-edit').forEach((input) => {
    input.addEventListener(input.classList.contains('h-edit') ? 'input' : 'change', markSquadOverrideDirty);
  });
}
function addCardRow() {
  const valIn = document.getElementById('new-card-value'); const hIn = document.getElementById('new-card-hours');
  const val = valIn.value.trim(); if (!val) return;
  if (!tempSettings.cards.includes(val)) tempSettings.cards.push(val);
  if (hIn.value.trim()) tempSettings.hourMap[val] = hIn.value.trim();
  valIn.value = ''; hIn.value = ''; markSquadOverrideDirty(); renderSettingsRows();
}
// Marca que o SM já editou o baralho do squad ativo — a etiqueta de escopo
// reage na hora, antes de "Salvar" gravar de fato o override.
function markSquadOverrideDirty() {
  if (!mySquad) return;
  squadOverrideDirty = true;
  applySquadScopeLabels();
}

// Seletor de escopo do SM: com o isolamento por squad, o SM precisa poder
// dizer em qual squad está atuando sem ter que sair e entrar de novo.
function renderSquadScope() {
  const box = document.getElementById('squad-scope-box');
  const picker = document.getElementById('squad-scope-picker');
  if (!box || !picker) return;
  const squads = (tempSettings && tempSettings.squads) || currentSettings.squads || [];
  if (myRole !== 'master' || !squads.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  picker.innerHTML = '<button type="button" class="squad-btn" data-scope="" aria-pressed="' + (!mySquad) + '">Toda a sala</button>'
    + squads.map((sq) => `<button type="button" class="squad-btn" data-scope="${escHtml(sq)}" aria-pressed="${sq === mySquad}">${escHtml(sq)}</button>`).join('');
}

document.getElementById('squad-scope-picker')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.squad-btn'); if (!btn) return;
  const squads = (tempSettings && tempSettings.squads) || currentSettings.squads || [];
  const next = squads.includes(btn.dataset.scope) ? btn.dataset.scope : null;
  mySquad = next;
  saveSession();
  renderSquadScope();
  // Reabastece a aba Cartas com o baralho do novo escopo
  const eff = effectiveFor(mySquad);
  if (tempSettings) { tempSettings.cards = [...eff.cards]; tempSettings.hourMap = { ...eff.hourMap }; }
  squadOverrideDirty = false;
  applySquadScopeLabels();
  renderSettingsRows();
  // Reflete o novo escopo no que já estiver aberto
  if (!document.getElementById('master-history-panel')?.classList.contains('hidden')) renderHistory();
  const squadTagEl = document.getElementById('master-squad-tag');
  if (squadTagEl) { if (mySquad) { squadTagEl.textContent = `Squad ${mySquad}`; squadTagEl.classList.remove('hidden'); } else squadTagEl.classList.add('hidden'); }
  toast(mySquad ? `Atuando no squad ${mySquad}.` : 'Visão da sala inteira.');
});

// Badge do modal + texto e etiqueta de escopo da aba Cartas
function applySquadScopeLabels() {
  const squadBadge = document.getElementById('modal-squad-badge');
  if (squadBadge) {
    if (mySquad) { squadBadge.textContent = `Squad ${mySquad}`; squadBadge.classList.remove('hidden'); }
    else squadBadge.classList.add('hidden');
  }
  const scopeHint = document.getElementById('cards-scope-hint');
  if (scopeHint) {
    scopeHint.textContent = (mySquad
      ? `Estas cartas valem apenas para o squad ${mySquad}. `
      : 'Estas cartas valem para todos os squads sem configuração própria. ')
      + 'Ative/desative cartas e ajuste as horas correspondentes.';
  }
  const deckBadge = document.getElementById('cards-scope-badge');
  const revertBtn = document.getElementById('btn-revert-squad-cards');
  const hasOwnOverride = !!(mySquad && currentSettings.squadOverrides && currentSettings.squadOverrides[squadKey(mySquad)]);
  if (deckBadge) {
    if (!mySquad) {
      deckBadge.textContent = '🌐 Padrão da sala';
      deckBadge.className = 'deck-badge';
    } else if (hasOwnOverride || squadOverrideDirty) {
      deckBadge.textContent = `🔀 Baralho próprio do Squad ${mySquad}`;
      deckBadge.className = 'deck-badge badge-own';
    } else {
      deckBadge.textContent = `👁 Squad ${mySquad} está herdando o padrão da sala (ainda sem baralho próprio)`;
      deckBadge.className = 'deck-badge';
    }
  }
  if (revertBtn) revertBtn.classList.toggle('hidden', !hasOwnOverride);
}

// Remove o override do squad ativo e volta a herdar o padrão da sala.
async function revertSquadCardsToDefault() {
  if (!mySquad || !myRoomId) return;
  if (!confirm(`Remover o baralho próprio do Squad ${mySquad} e voltar a usar o padrão da sala?`)) return;
  await db.ref(`rooms/${myRoomId}/settings/squadOverrides/${squadKey(mySquad)}`).remove();
  const overrides = { ...(currentSettings.squadOverrides || {}) };
  delete overrides[squadKey(mySquad)];
  currentSettings = { ...currentSettings, squadOverrides: overrides };
  const eff = effectiveFor(mySquad);
  tempSettings.cards = [...eff.cards];
  tempSettings.hourMap = { ...eff.hourMap };
  squadOverrideDirty = false;
  applySquadScopeLabels();
  renderSettingsRows();
  toast(`Squad ${mySquad} voltou a herdar o padrão da sala.`);
}
document.getElementById('btn-revert-squad-cards')?.addEventListener('click', revertSquadCardsToDefault);

function renderSquadsTab() {
  renderSquadScope();
  const list = document.getElementById('squads-list'); if (!list) return;
  list.innerHTML = '';
  const squads = tempSettings.squads || [];
  if (!squads.length) { list.innerHTML = '<p style="color:var(--muted);font-size:.82rem;padding:.5rem 0">Nenhum squad cadastrado.</p>'; return; }
  squads.forEach((sq, i) => {
    const item = document.createElement('div'); item.className = 'squad-item';
    item.innerHTML = `<span>${escHtml(sq)}</span><button class="btn-del" title="Remover">🗑</button>`;
    item.querySelector('.btn-del').addEventListener('click', () => {
      const removed = tempSettings.squads[i];
      tempSettings.squads.splice(i, 1);
      // Sem o squad em que estava atuando, o SM volta para a visão da sala
      if (removed === mySquad) { mySquad = null; saveSession(); applySquadScopeLabels(); renderSettingsRows(); }
      renderSquadsTab();
    });
    list.appendChild(item);
  });
}
function addSquad() {
  const input = document.getElementById('new-squad-name'); const name = input.value.trim(); if (!name) return;
  if (!tempSettings.squads) tempSettings.squads = [];
  if (!tempSettings.squads.includes(name)) { tempSettings.squads.push(name); renderSquadsTab(); }
  input.value = '';
}

function renderParticipantsManage() {
  const el = document.getElementById('participants-manage'); if (!el) return;
  el.innerHTML = '';
  const others = _latestParticipants.filter((p) => p.role !== 'master');
  if (!others.length) { el.innerHTML = '<p style="color:var(--muted);font-size:.82rem;padding:.5rem 0">Nenhum participante na sessão.</p>'; return; }
  const list = document.createElement('div'); list.className = 'manage-list';
  others.forEach((p) => {
    const item = document.createElement('div'); item.className = 'manage-item';
    item.innerHTML = `<div class="manage-item-info"><span class="p-dot ${p.role}"></span><strong>${escHtml(p.name)}</strong><span class="badge badge-${p.role}">${roleLabel(p.role)}</span>${p.squad ? `<span class="squad-tag">Squad ${escHtml(p.squad)}</span>` : ''}</div><button class="btn-kick" data-id="${p.id}">Remover</button>`;
    item.querySelector('.btn-kick').addEventListener('click', async () => {
      const targetId = p.id;
      await db.ref(`rooms/${myRoomId}/kicked/${targetId}`).set(true);
      await db.ref(`rooms/${myRoomId}/participants/${targetId}`).remove();
    });
    list.appendChild(item);
  });
  el.appendChild(list);
}

function renderPendingSmRequests() {
  const list = document.getElementById('pending-sm-list');
  const empty = document.getElementById('pending-sm-empty');
  if (!list || !empty) return;
  const entries = Object.entries(_latestPendingSm || {});
  if (!entries.length) { list.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  list.innerHTML = entries.map(([reqClientId, r]) => `
    <div class="pending-item">
      <span class="who">👤 ${escHtml(r.name)}</span>
      <div class="pending-actions">
        <button type="button" class="btn-approve" data-approve="${escHtml(reqClientId)}">✅ Liberar</button>
        <button type="button" class="btn-deny" data-deny="${escHtml(reqClientId)}">✖ Recusar</button>
      </div>
    </div>`).join('');
}
document.getElementById('pending-sm-list')?.addEventListener('click', async (e) => {
  const approveBtn = e.target.closest('[data-approve]');
  const denyBtn = e.target.closest('[data-deny]');
  if (approveBtn) {
    const reqId = approveBtn.dataset.approve;
    await db.ref().update({
      [`rooms/${myRoomId}/approvedSmClients/${reqId}`]: true,
      [`rooms/${myRoomId}/pendingSm/${reqId}`]: null,
    });
    toast('Acesso de Scrum Master liberado.');
  } else if (denyBtn) {
    await db.ref(`rooms/${myRoomId}/pendingSm/${denyBtn.dataset.deny}`).remove();
    toast('Pedido recusado.');
  }
});

function renderSmAccessTab() {
  const base = window.location.origin + window.location.pathname;
  const participantLink = myRoomId ? `${base}?r=${myRoomId}` : '(carregando...)';
  const smLink = myRoomId ? `${base}?sm=${SM_TOKEN}&r=${myRoomId}` : `${base}?sm=${SM_TOKEN}`;
  const pubInput = document.getElementById('public-link-input');
  const smInput  = document.getElementById('sm-link-input');
  if (pubInput) pubInput.value = participantLink;
  if (smInput)  smInput.value  = smLink;

  const inviteSmInput = document.getElementById('sm-invite-input');
  if (inviteSmInput) inviteSmInput.value = `${base}?sm=${SM_TOKEN}`;

  const squadSection = document.getElementById('squad-links-section');
  if (!squadSection) return;
  const squads = (tempSettings || currentSettings).squads || [];
  if (!squads.length || !myRoomId) { squadSection.innerHTML = ''; return; }
  squadSection.innerHTML = `
    <div class="access-card" style="margin-top:.25rem">
      <div class="access-card-header">
        <span class="access-icon">🏷️</span>
        <div>
          <strong>Links por Squad</strong>
          <p>O squad já vem pré-selecionado — envie o link do squad certo para cada time.</p>
        </div>
      </div>
      ${squads.map((sq, i) => `
        <div class="sm-link-box" style="margin-bottom:.5rem">
          <span class="squad-tag" style="min-width:fit-content;flex-shrink:0">${escHtml(sq)}</span>
          <input id="squad-link-${i}" type="text" readonly value="${base}?r=${myRoomId}&s=${encodeURIComponent(sq)}" />
          <button id="btn-copy-squad-${i}" class="btn-copy-sm">📋 Copiar</button>
        </div>`).join('')}
    </div>`;
}

// Event delegation for squad copy buttons (handles dynamic innerHTML injection)
document.getElementById('squad-links-section')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[id^="btn-copy-squad-"]');
  if (!btn) return;
  const i = btn.id.replace('btn-copy-squad-', '');
  copyText(document.getElementById(`squad-link-${i}`)?.value, btn.id);
});

document.getElementById('btn-copy-public-link')?.addEventListener('click', () => copyText(document.getElementById('public-link-input')?.value, 'btn-copy-public-link'));
document.getElementById('btn-copy-sm-link')?.addEventListener('click', () => copyText(document.getElementById('sm-link-input')?.value, 'btn-copy-sm-link'));
document.getElementById('btn-copy-sm-invite')?.addEventListener('click', () => {
  const base = window.location.origin + window.location.pathname;
  const url = `${base}?sm=${SM_TOKEN}`;
  const inp = document.getElementById('sm-invite-input');
  if (inp) inp.value = url;
  copyText(url, 'btn-copy-sm-invite');
});

function copyText(text, btnId) {
  if (!text) return;
  const btn = document.getElementById(btnId); const orig = btn?.textContent;
  const done = () => { if (btn) { btn.textContent = '✅ Copiado!'; setTimeout(() => { btn.textContent = orig; }, 2000); } };
  navigator.clipboard.writeText(text).then(done).catch(() => {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done();
  });
}

async function saveSettings() {
  document.getElementById('settings-rows').querySelectorAll('tr').forEach((tr) => {
    const val = tr.dataset.cardVal; const h = tr.querySelector('.h-edit'); const active = tr.querySelector('.a-toggle');
    if (h) tempSettings.hourMap[val] = h.value.trim();
    if (active) {
      if (active.checked) { if (!tempSettings.cards.includes(val)) tempSettings.cards.push(val); }
      else tempSettings.cards = tempSettings.cards.filter((c) => c !== val);
    }
  });
  const nums = tempSettings.cards.filter((v) => v !== '?' && !isNaN(parseFloat(v)));
  nums.sort((a, b) => parseFloat(a) - parseFloat(b));
  const hasQ = tempSettings.cards.includes('?');
  tempSettings.cards = hasQ ? [...nums, '?'] : nums;

  const cards      = [...tempSettings.cards];
  const hourMap    = { ...tempSettings.hourMap };
  const newSquads  = [...(tempSettings.squads || [])];
  const prevSquads = currentSettings.squads || [];

  // Escrita multi-path atômica: com squad grava só o override do squad do SM,
  // sem squad grava a config global — nunca sobrescreve overrides de outros squads
  const updates = {};
  updates[`rooms/${myRoomId}/settings/squads`] = newSquads;
  if (mySquad) {
    updates[`rooms/${myRoomId}/settings/squadOverrides/${squadKey(mySquad)}`] = { cards, hourMap };
  } else {
    updates[`rooms/${myRoomId}/settings/cards`] = cards;
    updates[`rooms/${myRoomId}/settings/hourMap`] = hourMap;
  }
  // Squads removidos da lista perdem o override na mesma escrita atômica
  prevSquads.filter((sq) => !newSquads.includes(sq)).forEach((sq) => {
    updates[`rooms/${myRoomId}/settings/squadOverrides/${squadKey(sq)}`] = null;
  });
  await db.ref().update(updates);

  // Espelho local consistente (o listener da sala também atualiza a partir do Firebase)
  const overrides = { ...(currentSettings.squadOverrides || {}) };
  prevSquads.filter((sq) => !newSquads.includes(sq)).forEach((sq) => { delete overrides[squadKey(sq)]; });
  if (mySquad) {
    overrides[squadKey(mySquad)] = { cards, hourMap };
    currentSettings = { ...currentSettings, squads: newSquads, squadOverrides: overrides };
  } else {
    currentSettings = { ...currentSettings, cards, hourMap, squads: newSquads, squadOverrides: overrides };
  }
  // Limpa só os votos do squad do SM — não derruba a rodada de outro squad
  await clearVotes(mySquad || undefined);
  closeSettings();
}

// ─── Squad selector ───────────────────────────────────────────────────────────
function updateSquadSelector() {
  const group = document.getElementById('squad-group'); const picker = document.getElementById('squad-picker');
  if (!group || !picker) return;
  const squads = currentSettings.squads || [];
  if (squads.length > 0) {
    // Keep cache up-to-date so the next F5 shows squads instantly
    if (myRoomId) try { localStorage.setItem(`pp_sqc_${myRoomId}`, JSON.stringify(squads)); } catch {}
    if (urlSquad && squads.includes(urlSquad)) {
      selectedLoginSquad = urlSquad;
      group.style.display = 'none';
    } else {
      if (!squads.includes(selectedLoginSquad)) selectedLoginSquad = '';
      group.style.display = '';
    }
    picker.innerHTML = squads.map((sq) => `<button type="button" class="squad-btn" data-squad="${escHtml(sq)}" aria-pressed="${sq === selectedLoginSquad}">${escHtml(sq)}</button>`).join('');
  } else { group.style.display = 'none'; selectedLoginSquad = ''; }
  renderLoginIsolationChips(squads);
}

// Legenda decorativa da capa de login — mostra os squads da sala (se houver)
// para reforçar visualmente que cada um vê só os próprios dados.
function renderLoginIsolationChips(squads) {
  const el = document.getElementById('login-isolation');
  if (!el) return;
  const dotColors = ['#c4b5fd', '#7dd3fc', '#5eead4', '#fca5a5', '#fde68a'];
  const chips = (squads || []).slice(0, 4).map((sq, i) =>
    `<span class="iso-chip"><span class="sw" style="background:${dotColors[i % dotColors.length]}"></span>${escHtml(sq)}</span>`
  ).join('');
  el.innerHTML = chips + '<span class="foot">cada squad vê só os próprios dados</span>';
}

// ─── Round timer ──────────────────────────────────────────────────────────────
function startRoundTimer(startedAt, timerId) {
  if (_timerInterval && _currentTimerId === timerId) return;
  stopRoundTimer();
  _currentTimerId = timerId;
  const el = document.getElementById(timerId);
  if (!el) return;
  el.classList.remove('hidden');
  function tick() {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    el.textContent = `⏱ ${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
  }
  tick();
  _timerInterval = setInterval(tick, 1000);
}
function stopRoundTimer() {
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  if (_currentTimerId) { document.getElementById(_currentTimerId)?.classList.add('hidden'); _currentTimerId = null; }
}

// ─── Views ────────────────────────────────────────────────────────────────────
function updateDevView(participants, round) {
  setStoryLabel('developer-story', round.story);
  const waiting = document.getElementById('dev-waiting'); const voting = document.getElementById('dev-voting'); const reveal = document.getElementById('dev-reveal');
  if (!round.active) { show(waiting); hide(voting); hide(reveal); resetDevCards(); stopRoundTimer(); return; }
  hide(waiting);
  if (round.revealed) { hide(voting); show(reveal); renderSimpleTable('dev-results-table', participants); stopRoundTimer(); }
  else {
    hide(reveal); show(voting); renderFibCards();
    document.getElementById('dev-voted-msg').classList.toggle('hidden', !myVote);
    if (round.startedAt) startRoundTimer(round.startedAt, 'dev-timer');
  }
}
function renderFibCards() {
  const container = document.getElementById('fibonacci-cards'); container.innerHTML = '';
  const eff = effectiveSettings(); // cartas do squad do participante
  eff.cards.forEach((val) => {
    const hours = eff.hourMap[val] || '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fib-card' + (myVote === val ? ' selected' : ''); btn.dataset.value = val;
    btn.setAttribute('aria-pressed', String(myVote === val));
    btn.setAttribute('aria-label', hours ? `${val} pontos, ${hours}` : `${val} pontos`);
    btn.innerHTML = `<span class="fib-value">${escHtml(val)}</span>${hours ? `<span class="fib-hours">${escHtml(hours)}</span>` : ''}`;
    container.appendChild(btn);
  });
}
function resetDevCards() { myVote = null; renderFibCards(); document.getElementById('dev-voted-msg').classList.add('hidden'); }

function updateQaView(participants, round) {
  setStoryLabel('qa-story', round.story);
  const waiting = document.getElementById('qa-waiting'); const voting = document.getElementById('qa-voting'); const reveal = document.getElementById('qa-reveal');
  if (!round.active) { show(waiting); hide(voting); hide(reveal); resetQaInput(); stopRoundTimer(); return; }
  hide(waiting);
  if (round.revealed) { hide(voting); show(reveal); renderSimpleTable('qa-results-table', participants); stopRoundTimer(); }
  else { hide(reveal); show(voting); if (!myVote) resetQaInput(); else restoreQaInput(); if (round.startedAt) startRoundTimer(round.startedAt, 'qa-timer'); }
}
function resetQaInput() {
  myVote = null;
  const input = document.getElementById('qa-hours-input');
  input.value = ''; input.disabled = false;
  const btn = document.getElementById('btn-qa-vote');
  btn.disabled = false; btn.textContent = 'Confirmar';
  document.getElementById('qa-voted-msg').classList.add('hidden');
}

// Reexibe o proprio voto do QA apos F5 no meio da rodada
function restoreQaInput() {
  const input = document.getElementById('qa-hours-input');
  const btn   = document.getElementById('btn-qa-vote');
  input.disabled = false; btn.disabled = false;
  if (myVote) {
    if (!input.value) input.value = parseFloat(myVote) || '';
    btn.textContent = 'Atualizar';
    document.getElementById('qa-voted-msg').classList.remove('hidden');
  }
}

function updateObserverView(participants, round) {
  setStoryLabel('observer-story', round.story);
  const waiting = document.getElementById('observer-waiting'); const voting = document.getElementById('observer-voting'); const reveal = document.getElementById('observer-reveal');
  if (!round.active) { show(waiting); hide(voting); hide(reveal); stopRoundTimer(); return; }
  hide(waiting);
  if (round.revealed) { hide(voting); show(reveal); renderSimpleTable('observer-results-table', participants); stopRoundTimer(); }
  else {
    hide(reveal); show(voting); if (round.startedAt) startRoundTimer(round.startedAt, 'observer-timer');
    const grid = document.getElementById('observer-vote-status'); if (!grid) return; grid.innerHTML = '';
    participants.filter((p) => p.role !== 'master' && p.role !== 'observer').forEach((p) => {
      const card = document.createElement('div'); card.className = 'vote-status-card';
      const pill = p.hasVoted ? `<span class="vs-pill voted">Votou ✓</span>` : `<span class="vs-pill pending">Aguardando…</span>`;
      card.innerHTML = `<div class="vs-name">${p.avatar ? p.avatar + ' ' : ''}${escHtml(p.name)}</div><div class="vs-role">${roleLabel(p.role)}</div>${pill}`;
      grid.appendChild(card);
    });
  }
}

function renderTlFibCards() {
  const container = document.getElementById('tl-fibonacci-cards'); if (!container) return;
  container.innerHTML = '';
  const eff = effectiveSettings(); // cartas do squad do participante
  eff.cards.forEach((val) => {
    const hours = eff.hourMap[val] || '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fib-card' + (myVote === val ? ' selected' : ''); btn.dataset.value = val;
    btn.setAttribute('aria-pressed', String(myVote === val));
    btn.setAttribute('aria-label', hours ? `${val} pontos, ${hours}` : `${val} pontos`);
    btn.innerHTML = `<span class="fib-value">${escHtml(val)}</span>${hours ? `<span class="fib-hours">${escHtml(hours)}</span>` : ''}`;
    container.appendChild(btn);
  });
}
function resetTlCards() { myVote = null; renderTlFibCards(); document.getElementById('tl-voted-msg')?.classList.add('hidden'); }

function updateTechLeadView(participants, round) {
  setStoryLabel('tl-story', round.story);
  const waiting = document.getElementById('tl-waiting'); const voting = document.getElementById('tl-voting'); const reveal = document.getElementById('tl-reveal');
  if (!round.active) { show(waiting); hide(voting); hide(reveal); resetTlCards(); stopRoundTimer(); return; }
  hide(waiting);
  if (round.revealed) {
    hide(voting); show(reveal);
    renderSplitResults(participants, 'tl-dev-results', 'tl-qa-results');
    renderSummary(participants, 'tl-summary');
    stopRoundTimer();
  } else {
    hide(reveal); show(voting);
    renderTlFibCards();
    document.getElementById('tl-voted-msg')?.classList.toggle('hidden', !myVote);
    if (round.startedAt) startRoundTimer(round.startedAt, 'tl-timer');
    const grid = document.getElementById('tl-vote-status'); if (!grid) return;
    grid.innerHTML = '';
    participants.filter((p) => p.role !== 'master' && p.role !== 'observer').forEach((p) => {
      const card = document.createElement('div'); card.className = 'vote-status-card';
      const pill = p.hasVoted ? `<span class="vs-pill voted">Votou ✓</span>` : `<span class="vs-pill pending">Aguardando…</span>`;
      card.innerHTML = `<div class="vs-name">${p.avatar ? p.avatar + ' ' : ''}${escHtml(p.name)}</div><div class="vs-role">${roleLabel(p.role)}</div>${pill}`;
      grid.appendChild(card);
    });
  }
}

async function copyTlResultsAsImage() {
  const btn = document.getElementById('btn-tl-copy-result');
  btn.textContent = '⏳ Gerando...'; btn.disabled = true;
  try {
    const area = document.getElementById('capture-area-tl');
    const story = document.getElementById('tl-story').textContent.trim();
    const now = new Date().toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    area.classList.add('capturing');
    let canvas;
    try { canvas = await html2canvas(area, { backgroundColor: '#ffffff', scale: 2, useCORS: true }); }
    finally { area.classList.remove('capturing'); }
    const finalW = canvas.width; const headerH = 72;
    const final = document.createElement('canvas'); final.width = finalW; final.height = canvas.height + headerH;
    const ctx = final.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, finalW, 0); grad.addColorStop(0, '#1a1035'); grad.addColorStop(1, '#cc092f');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, finalW, headerH);
    ctx.fillStyle = '#ffffff'; ctx.font = `bold ${headerH * 0.36}px Segoe UI, sans-serif`;
    ctx.fillText('🃏 Estimativa Ágil', 28, headerH * 0.48);
    ctx.font = `${headerH * 0.26}px Segoe UI, sans-serif`; ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(story ? `${story}  ·  ${now}` : now, 28, headerH * 0.82);
    ctx.drawImage(canvas, 0, headerH);
    final.toBlob(async (blob) => {
      let copied = false;
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); copied = true; } catch (_) {}
      if (copied) { btn.textContent = '✅ Copiado! Cole no Jira (Ctrl+V)'; setTimeout(() => { btn.textContent = '📸 Copiar para Jira'; btn.disabled = false; }, 3000); }
      else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'resultado.png'; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        btn.textContent = '📸 Copiar para Jira'; btn.disabled = false;
      }
    }, 'image/png');
  } catch {
    btn.textContent = '📸 Copiar para Jira'; btn.disabled = false;
  }
}

function updateMasterView(participants, round, allVoted, votedCount = 0, voterTotal = 0) {
  setStoryLabel('master-story-display', round.story);
  const setup = document.getElementById('master-setup'); const active = document.getElementById('master-active'); const results = document.getElementById('master-results');
  if (!round.active) {
    show(setup); hide(active); stopRoundTimer(); renderVoteProgress(0, 0, false);
    // Reseta o botão para não reaparecer com o rótulo da rodada anterior
    const b = document.getElementById('btn-reveal');
    b.textContent = '👁 Revelar Votos'; b.disabled = true; b.classList.remove('btn-reveal-partial');
    _pendingVoters = 0;
    return;
  }
  hide(setup); show(active);
  if (round.startedAt) startRoundTimer(round.startedAt, 'master-timer');
  const revealBtn = document.getElementById('btn-reveal');
  _pendingVoters = voterTotal - votedCount;
  revealBtn.disabled = round.revealed || votedCount === 0;
  revealBtn.textContent = round.revealed
    ? '👁 Votos revelados'
    : (allVoted ? '👁 Revelar Votos' : `👁 Revelar Votos (${votedCount}/${voterTotal})`);
  revealBtn.classList.toggle('btn-reveal-partial', !allVoted && votedCount > 0 && !round.revealed);
  renderVoteProgress(votedCount, voterTotal, round.revealed);
  const grid = document.getElementById('master-vote-status'); grid.innerHTML = '';
  participants.filter((p) => p.role !== 'master').forEach((p) => {
    const card = document.createElement('div'); card.className = 'vote-status-card';
    let pill;
    if (p.role === 'observer') pill = `<span class="vs-pill pending">Observando</span>`;
    else if (round.revealed && p.vote !== null) pill = `<span class="vs-pill ${p.role === 'qa' ? 'val-qa' : 'val-dev'}">${escHtml(p.vote)}</span>`;
    else if (p.hasVoted) pill = `<span class="vs-pill voted">Votou ✓</span>`;
    else pill = `<span class="vs-pill pending">Aguardando…</span>`;
    card.innerHTML = `<div class="vs-name">${p.avatar ? p.avatar + ' ' : ''}${escHtml(p.name)}</div><div class="vs-role">${roleLabel(p.role)}</div>${pill}`;
    grid.appendChild(card);
  });
  if (round.revealed) { show(results); renderSplitResults(participants); renderSummary(participants); stopRoundTimer(); }
  else hide(results);
}

// Moda dos votos. Em caso de empate na frequencia vence o MENOR valor
// (comportamento historico, mantido), mas o empate e devolvido em `tied`
// para que a UI possa avisar que a historia precisa ser rediscutida.
// A ordem de iteracao de Object.entries nao e confiavel para chaves nao
// numericas, entao o desempate e explicito e nunca depende de parseFloat(null).
function calcMode(votes) {
  const freq = {};
  votes.forEach((v) => { freq[v] = (freq[v] || 0) + 1; });
  let mode = null, maxFreq = 0;
  for (const [val, count] of Object.entries(freq)) {
    if (mode === null || count > maxFreq) { mode = val; maxFreq = count; continue; }
    if (count !== maxFreq) continue;
    const a = parseFloat(val), b = parseFloat(mode);
    const aNum = !isNaN(a), bNum = !isNaN(b);
    // numerico vence nao-numerico ('?'); entre numericos vence o menor
    if ((aNum && !bNum) || (aNum && bNum && a < b)) mode = val;
  }
  const tied = Object.entries(freq).filter(([, c]) => c === maxFreq).map(([v]) => v);
  return { mode, count: maxFreq, tied, freq };
}

// Distancia entre o menor e o maior voto em POSICOES do baralho ativo.
// Serve para detectar divergência alta: 5 e 8 são vizinhos (distância 1),
// 1 e 21 estão a 5 posições de distância mesmo com baralho customizado.
function voteSpread(votes, cards) {
  const deck = (cards || []).filter((c) => c !== '?');
  const idx = votes.filter((v) => v !== '?').map((v) => deck.indexOf(v)).filter((i) => i >= 0);
  if (idx.length < 2) return 0;
  return Math.max(...idx) - Math.min(...idx);
}

// Horas correspondentes a um voto usando o baralho do SQUAD DE QUEM VOTOU.
// Usar effectiveSettings() aqui era um bug: o mapa de horas de quem esta
// OLHANDO a tela (SM, TL, outro squad) nao e o mapa de quem votou, entao o
// rodape, o resumo e o historico mostravam horas de outro squad.
function hoursForVote(vote, voters) {
  if (!vote) return '';
  const voter = (voters || []).find((p) => p.vote === vote);
  return effectiveFor(voter ? voter.squad : mySquad).hourMap[vote] || '';
}

function renderSplitResults(participants, devContainerId = 'master-dev-results', qaContainerId = 'master-qa-results') {
  const devs = participants.filter((p) => p.role === 'developer' || p.role === 'tech-lead'); const qas = participants.filter((p) => p.role === 'qa');
  const devVotes = devs.filter((p) => p.vote && p.vote !== '?').map((p) => p.vote);
  const { mode: modeVote, count: modeCount, tied: modeTied } = devVotes.length ? calcMode(devVotes) : {};
  const devRows = devs.map((p) => {
    const hours = p.vote ? (effectiveFor(p.squad).hourMap[p.vote] || '') : ''; const isMod = p.vote && p.vote === modeVote;
    const chip = p.vote ? `<span class="vote-chip ${p.role} ${isMod ? 'vote-winner' : ''}"><span class="chip-points">${escHtml(p.vote)}</span>${hours ? `<span class="chip-hours">${escHtml(hours)}</span>` : ''}</span>` : `<span style="color:var(--muted)">—</span>`;
    return `<tr><td>${escHtml(p.name)}${isMod ? '<span class="winner-tag">✓</span>' : ''}</td><td>${chip}</td></tr>`;
  }).join('') || `<tr><td colspan="2" style="color:var(--muted);font-size:.85rem">Nenhum desenvolvedor</td></tr>`;
  const qaHours = qas.filter((p) => p.vote).map((p) => parseFloat(p.vote)).filter((v) => !isNaN(v));
  const avgQaH  = qaHours.length ? qaHours.reduce((a, b) => a + b, 0) / qaHours.length : null;
  const qaRows  = qas.map((p) => {
    const chip = p.vote ? `<span class="vote-chip qa"><span class="chip-points">${escHtml(p.vote)}</span></span>` : `<span style="color:var(--muted)">—</span>`;
    return `<tr><td>${escHtml(p.name)}</td><td>${chip}</td></tr>`;
  }).join('') || `<tr><td colspan="2" style="color:var(--muted);font-size:.85rem">Nenhum QA</td></tr>`;
  const devFooter = modeVote ? `<tfoot><tr><td colspan="2" class="table-footer">Predominante: <strong>${escHtml(modeVote)}</strong> (${modeCount}/${devVotes.length}) = <strong>${escHtml(hoursForVote(modeVote, devs) || '?')}</strong>${(modeTied || []).length > 1 ? ` <span class="footer-warn">⚠️ empate com ${modeTied.filter((v) => v !== modeVote).map(escHtml).join(', ')}</span>` : ''}</td></tr></tfoot>` : '';
  const qaFooter  = avgQaH !== null ? `<tfoot><tr><td colspan="2" class="table-footer">Média QA: <strong>${avgQaH % 1 === 0 ? avgQaH : avgQaH.toFixed(1)}h</strong></td></tr></tfoot>` : '';
  document.getElementById(devContainerId).innerHTML = `<table class="results-table"><thead><tr><th>Nome</th><th>Pontos / Horas</th></tr></thead><tbody>${devRows}</tbody>${devFooter}</table>`;
  document.getElementById(qaContainerId).innerHTML  = `<table class="results-table"><thead><tr><th>Nome</th><th>Estimativa</th></tr></thead><tbody>${qaRows}</tbody>${qaFooter}</table>`;
}

function renderSimpleTable(containerId, participants) {
  const rows = participants.filter((p) => p.role !== 'master').map((p) => {
    const hours = ((p.role === 'developer' || p.role === 'tech-lead') && p.vote) ? (effectiveFor(p.squad).hourMap[p.vote] || '') : '';
    const chip = p.vote ? `<span class="vote-chip ${p.role}"><span class="chip-points">${escHtml(p.vote)}</span>${hours ? `<span class="chip-hours">${escHtml(hours)}</span>` : ''}</span>` : `<span style="color:var(--muted)">—</span>`;
    return `<tr><td>${escHtml(p.name)}</td><td><span class="badge badge-${p.role}">${roleLabel(p.role)}</span></td><td>${chip}</td></tr>`;
  }).join('');
  document.getElementById(containerId).innerHTML = `<table class="results-table"><thead><tr><th>Nome</th><th>Papel</th><th>Estimativa</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderSummary(participants, containerId = 'master-summary') {
  const box = document.getElementById(containerId);
  const devVoters = participants.filter((p) => (p.role === 'developer' || p.role === 'tech-lead') && p.vote && p.vote !== '?');
  const qaVoters  = participants.filter((p) => p.role === 'qa' && p.vote);
  const stats = []; let devHoursNum = 0; let consensusHtml = '';
  if (devVoters.length) {
    const devVotes = devVoters.map((p) => p.vote);
    const { mode: modeVote, count: modeCount, tied } = calcMode(devVotes);
    // Horas vem do baralho do squad de quem votou, nao do squad de quem le a tela
    const modeHoursStr = hoursForVote(modeVote, devVoters); devHoursNum = parseFloat(modeHoursStr) || 0;
    stats.push(`<div class="summary-stat"><div class="stat-value">${escHtml(modeVote)}</div><div class="stat-label">Voto Predominante Dev</div></div>`);
    if (modeHoursStr) stats.push(`<div class="summary-stat"><div class="stat-value">${escHtml(modeHoursStr)}</div><div class="stat-label">Horas Dev (${modeCount}/${devVoters.length})</div></div>`);
    stats.push('<div class="summary-divider"></div>');
    consensusHtml = consensusBanner(devVotes, tied, devVoters);
  }
  if (qaVoters.length) {
    const qaH = qaVoters.map((p) => parseFloat(p.vote)).filter((v) => !isNaN(v));
    const avg = qaH.reduce((a, b) => a + b, 0) / qaH.length;
    const avgDisplay = avg % 1 === 0 ? `${avg}h` : `${avg.toFixed(1)}h`;
    stats.push(`<div class="summary-stat stat-qa"><div class="stat-value">${avgDisplay}</div><div class="stat-label">Média Horas QA (${qaVoters.length})</div></div>`);
    if (devVoters.length && (devHoursNum + avg) > 0) {
      const grand = devHoursNum + avg;
      stats.push('<div class="summary-divider"></div>');
      stats.push(`<div class="summary-stat stat-total"><div class="stat-value">${grand % 1 === 0 ? grand : grand.toFixed(1)}h</div><div class="stat-label">Total Geral Dev+QA</div></div>`);
    }
  }
  box.innerHTML = (stats.length ? `<div class="summary-box">${stats.join('')}</div>` : '') + consensusHtml;
}

// ── Regra de consenso ─────────────────────────────────────────────────────────
// Planning poker so vale se o time convergir. Tres situacoes merecem aviso:
//  · consenso total  → segue para a proxima historia
//  · empate na moda  → nao existe "predominante", precisa de uma nova rodada
//  · divergência alta (>= 3 posições do baralho entre menor e maior voto)
//    → sinal classico de que a historia nao foi entendida da mesma forma
function consensusBanner(devVotes, tied, devVoters) {
  const unique = [...new Set(devVotes)];
  if (unique.length <= 1) {
    return `<div class="consensus-note consensus-ok" role="status">✅ <strong>Consenso total</strong> — todos os desenvolvedores votaram ${escHtml(unique[0] ?? '')}.</div>`;
  }
  const deck = effectiveFor(devVoters[0] ? devVoters[0].squad : mySquad).cards;
  const spread = voteSpread(devVotes, deck);
  const msgs = [];
  if (tied && tied.length > 1) {
    msgs.push(`<strong>Empate</strong> entre ${tied.map(escHtml).join(' e ')} — não há voto predominante claro.`);
  }
  if (spread >= 3) {
    const nums = devVotes.filter((v) => v !== '?');
    msgs.push(`<strong>Divergência alta</strong> (${escHtml(nums.slice().sort((a, b) => parseFloat(a) - parseFloat(b))[0])} a ${escHtml(nums.slice().sort((a, b) => parseFloat(b) - parseFloat(a))[0])}) — ${spread} posições de distância no baralho.`);
  }
  if (!msgs.length) return '';
  return `<div class="consensus-note consensus-warn" role="alert">⚠️ ${msgs.join(' ')} Recomendado discutir e rodar <em>Nova Rodada</em> antes de fechar a estimativa.</div>`;
}

function updateParticipants(participants, containerId) {
  const el = document.getElementById(containerId); if (!el) return;
  el.innerHTML = '';
  const list = document.createElement('div'); list.className = 'participant-list';
  participants.forEach((p) => {
    const chip = document.createElement('div'); chip.className = 'participant-chip';
    chip.innerHTML = `<span class="p-dot ${p.role}"></span>${p.avatar ? `<span style="font-size:.9rem">${p.avatar}</span>` : ''}<span>${escHtml(p.name)}</span><span style="font-size:.68rem;color:var(--muted)">${roleLabel(p.role)}</span>`;
    list.appendChild(chip);
  });
  el.appendChild(list);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function showScreen(role) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById(`screen-${role}`)?.classList.add('active');
  const nameEl = document.getElementById(`${role}-name`);
  if (nameEl) nameEl.textContent = myName;
  const squadTagEl = document.getElementById(`${role}-squad-tag`);
  if (squadTagEl) { if (mySquad) { squadTagEl.textContent = `Squad ${mySquad}`; squadTagEl.classList.remove('hidden'); } else squadTagEl.classList.add('hidden'); }
}
function setStoryLabel(id, story) {
  const el = document.getElementById(id); if (!el) return;
  if (story) { el.textContent = story; el.classList.remove('hidden'); } else el.classList.add('hidden');
}
// Aviso nao bloqueante. alert() trava a aba inteira — numa sessao ao vivo com
// varias pessoas isso e pior do que o proprio aviso.
let _toastTimer = null;
function toast(msg, kind = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast'; el.className = 'toast hidden';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `toast toast-${kind}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

function show(el) { el?.classList.remove('hidden'); }
function hide(el) { el?.classList.add('hidden'); }
function roleLabel(role) { return { developer: 'Dev', qa: 'QA', master: 'SM', observer: 'Obs', 'tech-lead': 'TL' }[role] || role; }

// ─── Copy results as image for Jira ──────────────────────────────────────────
async function copyResultsAsImage() {
  const btn = document.getElementById('btn-copy-result');
  btn.textContent = '⏳ Gerando...'; btn.disabled = true;
  try {
    const area = document.getElementById('capture-area');
    const story = document.getElementById('master-story-display').textContent.trim();
    const now = new Date().toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    area.classList.add('capturing');
    let canvas;
    try { canvas = await html2canvas(area, { backgroundColor: '#ffffff', scale: 2, useCORS: true }); }
    finally { area.classList.remove('capturing'); }
    const finalW = canvas.width; const headerH = 72;
    const final = document.createElement('canvas'); final.width = finalW; final.height = canvas.height + headerH;
    const ctx = final.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, finalW, 0); grad.addColorStop(0, '#1a1035'); grad.addColorStop(1, '#cc092f');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, finalW, headerH);
    ctx.fillStyle = '#ffffff'; ctx.font = `bold ${headerH * 0.36}px Segoe UI, sans-serif`;
    ctx.fillText('🃏 Estimativa Ágil', 28, headerH * 0.48);
    ctx.font = `${headerH * 0.26}px Segoe UI, sans-serif`; ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(story ? `${story}  ·  ${now}` : now, 28, headerH * 0.82);
    ctx.drawImage(canvas, 0, headerH);
    final.toBlob(async (blob) => {
      let copied = false;
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); copied = true; } catch (_) {}
      if (copied) { btn.textContent = '✅ Copiado! Cole no Jira (Ctrl+V)'; setTimeout(() => { btn.textContent = '📸 Copiar para Jira'; btn.disabled = false; }, 3000); }
      else {
        const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `estimativa-${Date.now()}.png`; a.click(); URL.revokeObjectURL(url);
        btn.textContent = '📥 Baixado!'; setTimeout(() => { btn.textContent = '📸 Copiar para Jira'; btn.disabled = false; }, 2500);
      }
    }, 'image/png');
  } catch (err) { console.error(err); btn.textContent = '❌ Erro — tente novamente'; btn.disabled = false; }
}
