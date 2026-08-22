const socket = io();

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let myRole = null;
let myName = null;
let myVote = null;
let mySquad = null;
let myRoomId = null;
let currentSettings = { cards: [], hourMap: {}, squads: [] };
let tempSettings = null;
let currentSmToken = null;
let _latestParticipants = [];
let _lastRevealedState = false;

const SESSION_KEY = 'pp_session';
const SM_ROOM_KEY  = 'pp_sm_room';

// URL params
const urlParams   = new URLSearchParams(window.location.search);
const urlSmToken  = urlParams.get('sm');
const urlRoomId   = urlParams.get('room');

// Show SM role button only when URL contains SM token
if (urlSmToken) {
  document.querySelector('.role-btn[data-role="master"]')?.classList.remove('hidden');
}

// ─── SM room ID (generated once, persisted forever in localStorage) ───────────
function getOrCreateSmRoom() {
  let id = localStorage.getItem(SM_ROOM_KEY);
  if (!id) {
    id = 'r' + Math.random().toString(36).substr(2, 10);
    localStorage.setItem(SM_ROOM_KEY, id);
  }
  return id;
}

// ─── History (stored per room in localStorage, private to each SM browser) ────
function historyKey(roomId) { return `pp_hist_${roomId}`; }
function loadHistory(roomId) {
  try { return JSON.parse(localStorage.getItem(historyKey(roomId))) || []; } catch { return []; }
}
function appendHistory(roomId, entry) {
  const h = loadHistory(roomId);
  h.unshift(entry);
  if (h.length > 100) h.pop();
  localStorage.setItem(historyKey(roomId), JSON.stringify(h));
}
function clearHistory(roomId) {
  localStorage.removeItem(historyKey(roomId));
}

// ─── Session persistence ──────────────────────────────────────────────────────
function saveSession() {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ name: myName, role: myRole, squad: mySquad, smToken: urlSmToken, roomId: myRoomId }));
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  myName = null; myRole = null; myVote = null; mySquad = null;
}

// Auto-join on reconnect (page refresh)
socket.on('connect', () => {
  const saved = loadSession();
  if (saved && saved.name && saved.role) {
    myName   = saved.name;
    myRole   = saved.role;
    mySquad  = saved.squad || null;
    myRoomId = saved.roomId || (saved.role === 'master' ? getOrCreateSmRoom() : urlRoomId);
    socket.emit('join', { name: saved.name, role: saved.role, squad: mySquad, smToken: saved.smToken || urlSmToken, roomId: myRoomId });
    showScreen(saved.role);
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
let selectedRole = 'developer';

document.querySelectorAll('.role-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.role-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    selectedRole = btn.dataset.role;
  });
});

document.getElementById('btn-join').addEventListener('click', doJoin);
document.getElementById('input-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

function doJoin() {
  const name   = document.getElementById('input-name').value.trim();
  const errEl  = document.getElementById('login-error');

  if (!name) { errEl.textContent = 'Por favor, informe seu nome.'; errEl.classList.remove('hidden'); return; }

  // Non-master participants need a room link (?room=...)
  if (selectedRole !== 'master' && !urlRoomId) {
    errEl.textContent = 'Use o link da sessão enviado pelo Scrum Master.';
    errEl.classList.remove('hidden');
    return;
  }

  const squadEl = document.getElementById('squad-select');
  mySquad  = (squadEl && squadEl.offsetParent !== null && squadEl.value) ? squadEl.value : null;
  myName   = name;
  myRole   = selectedRole;
  myRoomId = selectedRole === 'master' ? getOrCreateSmRoom() : urlRoomId;

  errEl.classList.add('hidden');
  saveSession();
  socket.emit('join', { name, role: selectedRole, squad: mySquad, smToken: urlSmToken, roomId: myRoomId });
  showScreen(selectedRole);
}

// ─── Logout ───────────────────────────────────────────────────────────────────
['dev-logout', 'qa-logout', 'observer-logout', 'master-logout'].forEach((id) => {
  document.getElementById(id)?.addEventListener('click', doLogout);
});

function doLogout() {
  clearSession();
  myVote = null;
  _lastRevealedState = false;
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById('screen-login').classList.add('active');
  document.getElementById('input-name').value = '';
  document.getElementById('login-error').classList.add('hidden');
}

// ─── Socket: errors / forced logout ──────────────────────────────────────────
socket.on('join_error', (msg) => {
  clearSession();
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById('screen-login').classList.add('active');
  const errEl = document.getElementById('login-error');
  errEl.textContent = msg;
  errEl.classList.remove('hidden');
});

socket.on('force_logout', () => {
  clearSession();
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById('screen-login').classList.add('active');
  document.getElementById('input-name').value = '';
  const errEl = document.getElementById('login-error');
  errEl.textContent = 'Você foi removido da sessão pelo Scrum Master.';
  errEl.classList.remove('hidden');
});

socket.on('sm_ready', ({ token, roomId }) => {
  currentSmToken = token;
  myRoomId = roomId;
  localStorage.setItem(SM_ROOM_KEY, roomId);
  saveSession();
});

// ─── Developer voting ─────────────────────────────────────────────────────────
document.getElementById('fibonacci-cards').addEventListener('click', (e) => {
  const card = e.target.closest('.fib-card');
  if (!card || card.disabled) return;
  myVote = card.dataset.value;
  document.querySelectorAll('.fib-card').forEach((c) => c.classList.remove('selected'));
  card.classList.add('selected');
  socket.emit('vote', { value: myVote });
  document.getElementById('dev-voted-msg').classList.remove('hidden');
});

// ─── QA voting ────────────────────────────────────────────────────────────────
document.getElementById('btn-qa-vote').addEventListener('click', submitQaVote);
document.getElementById('qa-hours-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitQaVote(); });

function submitQaVote() {
  const val = document.getElementById('qa-hours-input').value;
  const parsed = parseFloat(val);
  if (!val || isNaN(parsed) || parsed <= 0) return;
  myVote = `${parsed}h`;
  socket.emit('vote', { value: myVote });
  document.getElementById('qa-voted-msg').classList.remove('hidden');
  document.getElementById('btn-qa-vote').disabled = true;
  document.getElementById('qa-hours-input').disabled = true;
}

// ─── Master controls ──────────────────────────────────────────────────────────
document.getElementById('btn-copy-result').addEventListener('click', copyResultsAsImage);
document.getElementById('btn-start').addEventListener('click', () => {
  socket.emit('start_round', { story: document.getElementById('master-story-input').value.trim() });
});
document.getElementById('btn-reveal').addEventListener('click', () => socket.emit('reveal'));
document.getElementById('btn-reset').addEventListener('click', () => {
  myVote = null;
  document.getElementById('master-story-input').value = '';
  socket.emit('reset');
});

// ─── História panel ───────────────────────────────────────────────────────────
document.getElementById('btn-toggle-history').addEventListener('click', () => {
  const panel = document.getElementById('master-history-panel');
  const isHidden = panel.classList.contains('hidden');
  panel.classList.toggle('hidden');
  document.getElementById('btn-toggle-history').textContent = isHidden ? '✕ Fechar' : '📋 História';
  if (isHidden) renderHistory();
});

document.getElementById('btn-clear-history').addEventListener('click', () => {
  if (!myRoomId) return;
  clearHistory(myRoomId);
  renderHistory();
});

function saveRoundToHistory(participants, round) {
  if (!myRoomId) return;
  const devVoters = participants.filter((p) => p.role === 'developer' && p.vote && p.vote !== '?');
  const qaVoters  = participants.filter((p) => p.role === 'qa' && p.vote);
  const now = new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  let devMode = null, devHours = null;
  if (devVoters.length) {
    const { mode } = calcMode(devVoters.map((p) => p.vote));
    devMode = mode;
    devHours = currentSettings.hourMap[mode] || null;
  }
  let qaAvg = null;
  if (qaVoters.length) {
    const qaH = qaVoters.map((p) => parseFloat(p.vote)).filter((v) => !isNaN(v));
    const avg = qaH.reduce((a, b) => a + b, 0) / qaH.length;
    qaAvg = avg % 1 === 0 ? `${avg}h` : `${avg.toFixed(1)}h`;
  }
  const squads = [...new Set(participants.filter((p) => p.squad).map((p) => p.squad))];
  const names  = participants.filter((p) => p.role !== 'master').map((p) => p.name);

  appendHistory(myRoomId, {
    date: now,
    story: round.story || '(sem título)',
    devMode, devHours, qaAvg,
    squads, names,
    voters: participants.filter((p) => p.role !== 'master' && p.role !== 'observer').map((p) => ({
      name: p.name, role: p.role, squad: p.squad, vote: p.vote,
    })),
  });
}

function renderHistory() {
  const container = document.getElementById('history-entries');
  if (!container || !myRoomId) return;
  const history = loadHistory(myRoomId);
  if (!history.length) {
    container.innerHTML = '<p class="history-empty">Nenhuma rodada registrada ainda.</p>';
    return;
  }
  container.innerHTML = history.map((entry) => {
    const stats = [];
    if (entry.devMode) stats.push(`<span class="history-stat-chip hsc-dev">Dev: ${escHtml(entry.devMode)}${entry.devHours ? ' = ' + escHtml(entry.devHours) : ''}</span>`);
    if (entry.qaAvg)  stats.push(`<span class="history-stat-chip hsc-qa">QA média: ${escHtml(entry.qaAvg)}</span>`);
    if (entry.devHours && entry.qaAvg) {
      const total = (parseFloat(entry.devHours) || 0) + (parseFloat(entry.qaAvg) || 0);
      if (total > 0) stats.push(`<span class="history-stat-chip hsc-total">Total: ${total % 1 === 0 ? total : total.toFixed(1)}h</span>`);
    }
    const squadStr = entry.squads?.length ? entry.squads.map(escHtml).join(', ') : '';
    const namesStr = entry.voters?.map((v) => `${escHtml(v.name)} (${escHtml(v.vote || '—')})`).join(', ') || '';
    return `
      <div class="history-entry">
        <div class="history-entry-header">
          <span class="history-date">${entry.date}</span>
          <span class="history-story">${escHtml(entry.story)}</span>
          ${squadStr ? `<span class="squad-tag">${squadStr}</span>` : ''}
        </div>
        ${stats.length ? `<div class="history-stats">${stats.join('')}</div>` : ''}
        ${namesStr ? `<div class="history-participants">${namesStr}</div>` : ''}
      </div>`;
  }).join('');
}

// ─── Settings modal ───────────────────────────────────────────────────────────
document.getElementById('btn-open-settings').addEventListener('click', openSettings);
document.getElementById('btn-close-settings').addEventListener('click', closeSettings);
document.getElementById('btn-cancel-settings').addEventListener('click', closeSettings);
document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
document.getElementById('btn-add-card').addEventListener('click', addCardRow);
document.getElementById('btn-add-squad').addEventListener('click', addSquad);
document.getElementById('settings-modal').addEventListener('click', (e) => { if (e.target.id === 'settings-modal') closeSettings(); });

// Tab switching
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tabId = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active-tab'));
    document.getElementById(tabId)?.classList.add('active-tab');
    const footer = document.getElementById('settings-footer');
    if (tabId === 'tab-access' || tabId === 'tab-users') { footer?.classList.add('hidden'); }
    else { footer?.classList.remove('hidden'); }
    if (tabId === 'tab-access') renderSmAccessTab();
    if (tabId === 'tab-users') renderParticipantsManage();
  });
});

function openSettings() {
  tempSettings = { cards: [...currentSettings.cards], hourMap: { ...currentSettings.hourMap }, squads: [...(currentSettings.squads || [])] };
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
  document.querySelector('.tab-btn[data-tab="tab-cards"]')?.classList.add('active');
  document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active-tab'));
  document.getElementById('tab-cards')?.classList.add('active-tab');
  document.getElementById('settings-footer')?.classList.remove('hidden');
  renderSettingsRows();
  renderSquadsTab();
  document.getElementById('settings-modal').classList.remove('hidden');
}
function closeSettings() { document.getElementById('settings-modal').classList.add('hidden'); tempSettings = null; }

// ── Cards tab ─────────────────────────────────────────────────────────────────
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
    tr.innerHTML = `
      <td><strong>${val}</strong></td>
      <td><input class="s-input h-edit" type="text" value="${hours}" placeholder="ex: 8h" /></td>
      <td><label class="toggle"><input type="checkbox" class="a-toggle" ${isActive ? 'checked' : ''} /><span class="t-slider"></span></label></td>
      <td><button class="btn-del" title="Remover">🗑</button></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.btn-del').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.closest('tr').dataset.cardVal;
      tempSettings.cards = tempSettings.cards.filter((c) => c !== v);
      delete tempSettings.hourMap[v];
      renderSettingsRows();
    });
  });
}
function addCardRow() {
  const valIn = document.getElementById('new-card-value');
  const hIn   = document.getElementById('new-card-hours');
  const val   = valIn.value.trim();
  if (!val) return;
  if (!tempSettings.cards.includes(val)) tempSettings.cards.push(val);
  if (hIn.value.trim()) tempSettings.hourMap[val] = hIn.value.trim();
  valIn.value = ''; hIn.value = '';
  renderSettingsRows();
}

// ── Squads tab ────────────────────────────────────────────────────────────────
function renderSquadsTab() {
  const list = document.getElementById('squads-list');
  if (!list) return;
  list.innerHTML = '';
  const squads = tempSettings.squads || [];
  if (!squads.length) { list.innerHTML = '<p style="color:var(--muted);font-size:.82rem;padding:.5rem 0">Nenhum squad cadastrado.</p>'; return; }
  squads.forEach((sq, i) => {
    const item = document.createElement('div');
    item.className = 'squad-item';
    item.innerHTML = `<span>${sq}</span><button class="btn-del" title="Remover">🗑</button>`;
    item.querySelector('.btn-del').addEventListener('click', () => { tempSettings.squads.splice(i, 1); renderSquadsTab(); });
    list.appendChild(item);
  });
}
function addSquad() {
  const input = document.getElementById('new-squad-name');
  const name  = input.value.trim();
  if (!name) return;
  if (!tempSettings.squads) tempSettings.squads = [];
  if (!tempSettings.squads.includes(name)) { tempSettings.squads.push(name); renderSquadsTab(); }
  input.value = '';
}

// ── Participants manage tab ───────────────────────────────────────────────────
function renderParticipantsManage() {
  const el = document.getElementById('participants-manage');
  if (!el) return;
  el.innerHTML = '';
  const others = _latestParticipants.filter((p) => p.role !== 'master');
  if (!others.length) { el.innerHTML = '<p style="color:var(--muted);font-size:.82rem;padding:.5rem 0">Nenhum participante na sessão.</p>'; return; }
  const list = document.createElement('div');
  list.className = 'manage-list';
  others.forEach((p) => {
    const item = document.createElement('div');
    item.className = 'manage-item';
    item.innerHTML = `
      <div class="manage-item-info">
        <span class="p-dot ${p.role}"></span><strong>${p.name}</strong>
        <span class="badge badge-${p.role}">${roleLabel(p.role)}</span>
        ${p.squad ? `<span class="squad-tag">${p.squad}</span>` : ''}
      </div>
      <button class="btn-kick" data-id="${p.id}">Remover</button>`;
    item.querySelector('.btn-kick').addEventListener('click', () => socket.emit('kick', { targetId: p.id }));
    list.appendChild(item);
  });
  el.appendChild(list);
}

// ── SM Access tab ─────────────────────────────────────────────────────────────
function renderSmAccessTab() {
  const base = window.location.origin + window.location.pathname;
  const participantLink = myRoomId ? `${base}?room=${myRoomId}` : '(carregando...)';
  const smLink = currentSmToken ? `${base}?sm=${currentSmToken}` : '(carregando...)';
  const pubInput = document.getElementById('public-link-input');
  const smInput  = document.getElementById('sm-link-input');
  if (pubInput) pubInput.value = participantLink;
  if (smInput)  smInput.value  = smLink;
}

document.getElementById('btn-copy-public-link')?.addEventListener('click', () => copyText(document.getElementById('public-link-input')?.value, 'btn-copy-public-link'));
document.getElementById('btn-copy-sm-link')?.addEventListener('click', () => copyText(document.getElementById('sm-link-input')?.value, 'btn-copy-sm-link'));

function copyText(text, btnId) {
  if (!text) return;
  const btn  = document.getElementById(btnId);
  const orig = btn?.textContent;
  const done = () => { if (btn) { btn.textContent = '✅ Copiado!'; setTimeout(() => { btn.textContent = orig; }, 2000); } };
  navigator.clipboard.writeText(text).then(done).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done();
  });
}

// ── Save settings ─────────────────────────────────────────────────────────────
function saveSettings() {
  document.getElementById('settings-rows').querySelectorAll('tr').forEach((tr) => {
    const val    = tr.dataset.cardVal;
    const h      = tr.querySelector('.h-edit');
    const active = tr.querySelector('.a-toggle');
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
  currentSettings = { ...tempSettings, squads: [...(tempSettings.squads || [])] };
  socket.emit('update_settings', { cards: currentSettings.cards, hourMap: currentSettings.hourMap, squads: currentSettings.squads });
  closeSettings();
}

// ─── Socket: state update ─────────────────────────────────────────────────────
socket.on('state_update', ({ participants, round, settings, allVoted }) => {
  if (settings) { currentSettings = settings; updateSquadSelector(); }
  _latestParticipants = participants;

  // Save history when round is revealed (SM only, once per reveal)
  if (myRole === 'master' && round.revealed && !_lastRevealedState) {
    saveRoundToHistory(participants, round);
    // Refresh history panel if open
    if (!document.getElementById('master-history-panel')?.classList.contains('hidden')) renderHistory();
  }
  _lastRevealedState = round.revealed;

  if (myRole === 'developer')    { updateDevView(participants, round);       updateParticipants(participants, 'dev-participants'); }
  else if (myRole === 'qa')      { updateQaView(participants, round);        updateParticipants(participants, 'qa-participants'); }
  else if (myRole === 'observer'){ updateObserverView(participants, round);  updateParticipants(participants, 'observer-participants'); }
  else if (myRole === 'master')  { updateMasterView(participants, round, allVoted); updateParticipants(participants, 'master-participants'); }

  const usersTab = document.getElementById('tab-users');
  if (usersTab?.classList.contains('active-tab')) renderParticipantsManage();
});

// ── Squad selector ────────────────────────────────────────────────────────────
function updateSquadSelector() {
  const group  = document.getElementById('squad-group');
  const sel    = document.getElementById('squad-select');
  if (!group || !sel) return;
  const squads = currentSettings.squads || [];
  if (squads.length > 0) {
    sel.innerHTML = '<option value="">— Selecione seu squad —</option>';
    squads.forEach((sq) => { const o = document.createElement('option'); o.value = sq; o.textContent = sq; sel.appendChild(o); });
    group.style.display = '';
  } else {
    group.style.display = 'none';
  }
}

// ─── Developer view ───────────────────────────────────────────────────────────
function updateDevView(participants, round) {
  setStoryLabel('dev-story', round.story);
  const waiting = document.getElementById('dev-waiting');
  const voting  = document.getElementById('dev-voting');
  const reveal  = document.getElementById('dev-reveal');
  if (!round.active) { show(waiting); hide(voting); hide(reveal); resetDevCards(); return; }
  hide(waiting);
  if (round.revealed) { hide(voting); show(reveal); renderSimpleTable('dev-results-table', participants); }
  else { hide(reveal); show(voting); renderFibCards(); }
}
function renderFibCards() {
  const container = document.getElementById('fibonacci-cards');
  container.innerHTML = '';
  currentSettings.cards.forEach((val) => {
    const hours = currentSettings.hourMap[val] || '';
    const btn = document.createElement('button');
    btn.className = 'fib-card' + (myVote === val ? ' selected' : '');
    btn.dataset.value = val;
    btn.innerHTML = `<span class="fib-value">${val}</span>${hours ? `<span class="fib-hours">${hours}</span>` : ''}`;
    container.appendChild(btn);
  });
}
function resetDevCards() {
  myVote = null; renderFibCards();
  document.getElementById('dev-voted-msg').classList.add('hidden');
}

// ─── QA view ─────────────────────────────────────────────────────────────────
function updateQaView(participants, round) {
  setStoryLabel('qa-story', round.story);
  const waiting = document.getElementById('qa-waiting');
  const voting  = document.getElementById('qa-voting');
  const reveal  = document.getElementById('qa-reveal');
  if (!round.active) { show(waiting); hide(voting); hide(reveal); resetQaInput(); return; }
  hide(waiting);
  if (round.revealed) { hide(voting); show(reveal); renderSimpleTable('qa-results-table', participants); }
  else { hide(reveal); show(voting); if (!myVote) resetQaInput(); }
}
function resetQaInput() {
  myVote = null;
  document.getElementById('qa-hours-input').value = '';
  document.getElementById('qa-hours-input').disabled = false;
  document.getElementById('btn-qa-vote').disabled = false;
  document.getElementById('qa-voted-msg').classList.add('hidden');
}

// ─── Observer view ────────────────────────────────────────────────────────────
function updateObserverView(participants, round) {
  setStoryLabel('observer-story', round.story);
  const waiting = document.getElementById('observer-waiting');
  const voting  = document.getElementById('observer-voting');
  const reveal  = document.getElementById('observer-reveal');
  if (!round.active) { show(waiting); hide(voting); hide(reveal); return; }
  hide(waiting);
  if (round.revealed) { hide(voting); show(reveal); renderSimpleTable('observer-results-table', participants); }
  else { hide(reveal); show(voting); renderObserverVoteStatus(participants); }
}
function renderObserverVoteStatus(participants) {
  const grid = document.getElementById('observer-vote-status');
  if (!grid) return;
  grid.innerHTML = '';
  participants.filter((p) => p.role !== 'master' && p.role !== 'observer').forEach((p) => {
    const card = document.createElement('div');
    card.className = 'vote-status-card';
    const pill = p.hasVoted ? `<span class="vs-pill voted">Votou ✓</span>` : `<span class="vs-pill pending">Aguardando…</span>`;
    card.innerHTML = `<div class="vs-name">${escHtml(p.name)}</div><div class="vs-role">${roleLabel(p.role)}</div>${pill}`;
    grid.appendChild(card);
  });
}

// ─── Master view ──────────────────────────────────────────────────────────────
function updateMasterView(participants, round, allVoted) {
  setStoryLabel('master-story-display', round.story);
  const setup   = document.getElementById('master-setup');
  const active  = document.getElementById('master-active');
  const results = document.getElementById('master-results');
  if (!round.active) { show(setup); hide(active); return; }
  hide(setup); show(active);
  document.getElementById('btn-reveal').disabled = !allVoted;
  renderVoteGrid(participants, round.revealed);
  if (round.revealed) { show(results); renderSplitResults(participants); renderSummary(participants); }
  else hide(results);
}

// ─── Vote status grid ─────────────────────────────────────────────────────────
function renderVoteGrid(participants, revealed) {
  const grid = document.getElementById('master-vote-status');
  grid.innerHTML = '';
  participants.filter((p) => p.role !== 'master').forEach((p) => {
    const card = document.createElement('div');
    card.className = 'vote-status-card';
    let pill;
    if (p.role === 'observer') {
      pill = `<span class="vs-pill pending">Observando</span>`;
    } else if (revealed && p.vote !== null) {
      pill = `<span class="vs-pill ${p.role === 'qa' ? 'val-qa' : 'val-dev'}">${escHtml(p.vote)}</span>`;
    } else if (p.hasVoted) {
      pill = `<span class="vs-pill voted">Votou ✓</span>`;
    } else {
      pill = `<span class="vs-pill pending">Aguardando…</span>`;
    }
    card.innerHTML = `<div class="vs-name">${escHtml(p.name)}</div><div class="vs-role">${roleLabel(p.role)}</div>${pill}`;
    grid.appendChild(card);
  });
}

// ─── Split results ────────────────────────────────────────────────────────────
function calcMode(votes) {
  const freq = {};
  votes.forEach((v) => { freq[v] = (freq[v] || 0) + 1; });
  let maxFreq = 0; let mode = null;
  for (const [val, count] of Object.entries(freq)) {
    const wins = count > maxFreq || (count === maxFreq && parseFloat(val) < parseFloat(mode));
    if (wins) { maxFreq = count; mode = val; }
  }
  return { mode, count: maxFreq, total: votes.length };
}
function renderSplitResults(participants) {
  const devs = participants.filter((p) => p.role === 'developer');
  const qas  = participants.filter((p) => p.role === 'qa');
  const devVotes = devs.filter((p) => p.vote && p.vote !== '?').map((p) => p.vote);
  const { mode: modeVote, count: modeCount } = devVotes.length ? calcMode(devVotes) : {};
  const devRows = devs.map((p) => {
    const hours = p.vote ? (currentSettings.hourMap[p.vote] || '') : '';
    const isMod = p.vote && p.vote === modeVote;
    const chip = p.vote
      ? `<span class="vote-chip developer ${isMod ? 'vote-winner' : ''}"><span class="chip-points">${escHtml(p.vote)}</span>${hours ? `<span class="chip-hours">${escHtml(hours)}</span>` : ''}</span>`
      : `<span style="color:var(--muted)">—</span>`;
    return `<tr><td>${escHtml(p.name)}${isMod ? '<span class="winner-tag">✓</span>' : ''}</td><td>${chip}</td></tr>`;
  }).join('') || `<tr><td colspan="2" style="color:var(--muted);font-size:.85rem">Nenhum desenvolvedor</td></tr>`;
  const qaHours = qas.filter((p) => p.vote).map((p) => parseFloat(p.vote)).filter((v) => !isNaN(v));
  const avgQaH  = qaHours.length ? qaHours.reduce((a, b) => a + b, 0) / qaHours.length : null;
  const qaRows  = qas.map((p) => {
    const chip = p.vote ? `<span class="vote-chip qa"><span class="chip-points">${escHtml(p.vote)}</span></span>` : `<span style="color:var(--muted)">—</span>`;
    return `<tr><td>${escHtml(p.name)}</td><td>${chip}</td></tr>`;
  }).join('') || `<tr><td colspan="2" style="color:var(--muted);font-size:.85rem">Nenhum QA</td></tr>`;
  const devFooter = modeVote ? `<tfoot><tr><td colspan="2" class="table-footer">Predominante: <strong>${escHtml(modeVote)}</strong> (${modeCount}/${devVotes.length}) = <strong>${escHtml(currentSettings.hourMap[modeVote] || '?')}</strong></td></tr></tfoot>` : '';
  const qaFooter  = avgQaH !== null ? `<tfoot><tr><td colspan="2" class="table-footer">Média QA: <strong>${avgQaH % 1 === 0 ? avgQaH : avgQaH.toFixed(1)}h</strong></td></tr></tfoot>` : '';
  document.getElementById('master-dev-results').innerHTML = `<table class="results-table"><thead><tr><th>Nome</th><th>Pontos / Horas</th></tr></thead><tbody>${devRows}</tbody>${devFooter}</table>`;
  document.getElementById('master-qa-results').innerHTML  = `<table class="results-table"><thead><tr><th>Nome</th><th>Estimativa</th></tr></thead><tbody>${qaRows}</tbody>${qaFooter}</table>`;
}

// ─── Simple table ─────────────────────────────────────────────────────────────
function renderSimpleTable(containerId, participants) {
  const rows = participants.filter((p) => p.role !== 'master').map((p) => {
    const hours = (p.role === 'developer' && p.vote) ? (currentSettings.hourMap[p.vote] || '') : '';
    const chip  = p.vote ? `<span class="vote-chip ${p.role}"><span class="chip-points">${escHtml(p.vote)}</span>${hours ? `<span class="chip-hours">${escHtml(hours)}</span>` : ''}</span>` : `<span style="color:var(--muted)">—</span>`;
    return `<tr><td>${escHtml(p.name)}</td><td><span class="badge badge-${p.role}">${roleLabel(p.role)}</span></td><td>${chip}</td></tr>`;
  }).join('');
  document.getElementById(containerId).innerHTML = `<table class="results-table"><thead><tr><th>Nome</th><th>Papel</th><th>Estimativa</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ─── Summary ──────────────────────────────────────────────────────────────────
function renderSummary(participants) {
  const box       = document.getElementById('master-summary');
  const devVoters = participants.filter((p) => p.role === 'developer' && p.vote && p.vote !== '?');
  const qaVoters  = participants.filter((p) => p.role === 'qa' && p.vote);
  const stats = []; let devHoursNum = 0;
  if (devVoters.length) {
    const { mode: modeVote, count: modeCount } = calcMode(devVoters.map((p) => p.vote));
    const modeHoursStr = currentSettings.hourMap[modeVote] || '';
    devHoursNum = parseFloat(modeHoursStr) || 0;
    stats.push(`<div class="summary-stat"><div class="stat-value">${modeVote}</div><div class="stat-label">Voto Predominante Dev</div></div>`);
    if (modeHoursStr) stats.push(`<div class="summary-stat"><div class="stat-value">${modeHoursStr}</div><div class="stat-label">Horas Dev (${modeCount}/${devVoters.length} devs)</div></div>`);
    stats.push('<div class="summary-divider"></div>');
  }
  if (qaVoters.length) {
    const qaH = qaVoters.map((p) => parseFloat(p.vote)).filter((v) => !isNaN(v));
    const avg = qaH.reduce((a, b) => a + b, 0) / qaH.length;
    const avgDisplay = avg % 1 === 0 ? `${avg}h` : `${avg.toFixed(1)}h`;
    stats.push(`<div class="summary-stat stat-qa"><div class="stat-value">${avgDisplay}</div><div class="stat-label">Média Horas QA (${qaVoters.length} QAs)</div></div>`);
    if (devVoters.length && (devHoursNum + avg) > 0) {
      const grand = devHoursNum + avg;
      stats.push('<div class="summary-divider"></div>');
      stats.push(`<div class="summary-stat stat-total"><div class="stat-value">${grand % 1 === 0 ? grand : grand.toFixed(1)}h</div><div class="stat-label">Total Geral Dev+QA</div></div>`);
    }
  }
  box.innerHTML = stats.length ? `<div class="summary-box">${stats.join('')}</div>` : '';
}

// ─── Participants ─────────────────────────────────────────────────────────────
function updateParticipants(participants, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'participant-list';
  participants.forEach((p) => {
    const chip = document.createElement('div');
    chip.className = 'participant-chip';
    chip.innerHTML = `<span class="p-dot ${p.role}"></span><span>${escHtml(p.name)}</span>${p.squad ? `<span class="squad-tag">${escHtml(p.squad)}</span>` : ''}<span style="font-size:.68rem;color:var(--muted)">${roleLabel(p.role)}</span>`;
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
  if (squadTagEl) {
    if (mySquad) { squadTagEl.textContent = mySquad; squadTagEl.classList.remove('hidden'); }
    else squadTagEl.classList.add('hidden');
  }
}
function setStoryLabel(id, story) {
  const el = document.getElementById(id);
  if (!el) return;
  if (story) { el.textContent = story; el.classList.remove('hidden'); } else el.classList.add('hidden');
}
function show(el) { el?.classList.remove('hidden'); }
function hide(el) { el?.classList.add('hidden'); }
function roleLabel(role) { return { developer: 'Dev', qa: 'QA', master: 'SM', observer: 'Obs' }[role] || role; }

// ─── Copy results as image for Jira ──────────────────────────────────────────
async function copyResultsAsImage() {
  const btn = document.getElementById('btn-copy-result');
  btn.textContent = '⏳ Gerando...'; btn.disabled = true;
  try {
    const area  = document.getElementById('capture-area');
    const story = document.getElementById('master-story-display').textContent.trim();
    const now   = new Date().toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    const canvas = await html2canvas(area, { backgroundColor: '#ffffff', scale: 2, useCORS: true });
    const finalW = canvas.width; const headerH = 72;
    const final  = document.createElement('canvas');
    final.width  = finalW; final.height = canvas.height + headerH;
    const ctx  = final.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, finalW, 0);
    grad.addColorStop(0, '#1a1035'); grad.addColorStop(1, '#cc092f');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, finalW, headerH);
    ctx.fillStyle = '#ffffff'; ctx.font = `bold ${headerH * 0.36}px Segoe UI, sans-serif`;
    ctx.fillText('🃏 Planning Poker', 28, headerH * 0.48);
    ctx.font = `${headerH * 0.26}px Segoe UI, sans-serif`; ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(story ? `${story}  ·  ${now}` : now, 28, headerH * 0.82);
    ctx.drawImage(canvas, 0, headerH);
    final.toBlob(async (blob) => {
      let copied = false;
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); copied = true; } catch (_) {}
      if (copied) {
        btn.textContent = '✅ Copiado! Cole no Jira (Ctrl+V)';
        setTimeout(() => { btn.textContent = '📸 Copiar para Jira'; btn.disabled = false; }, 3000);
      } else {
        const url = URL.createObjectURL(blob); const a = document.createElement('a');
        a.href = url; a.download = `planning-poker-${Date.now()}.png`; a.click(); URL.revokeObjectURL(url);
        btn.textContent = '📥 Baixado!';
        setTimeout(() => { btn.textContent = '📸 Copiar para Jira'; btn.disabled = false; }, 2500);
      }
    }, 'image/png');
  } catch (err) { console.error(err); btn.textContent = '❌ Erro — tente novamente'; btn.disabled = false; }
}
