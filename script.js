// =============================
//  CONFIGURAÇÕES INICIAIS E FIREBASE
// =============================

const MACHINE_NAMES = [
  'Fresa CNC 1','Fresa CNC 2','Fresa CNC 3','Robodrill 2','D 800-1','Fagor',
  'Robodrill 1','VTC','D 800-2','D 800-3','Centur','Nardine','GL 280',
  '15S','E 280','G 240','Galaxy 10A','Galaxy 10B','GL 170G','GL 250','GL 350','GL 450','Torno Convencional'
];

firebase.initializeApp({
  apiKey: "AIzaSyBtJ5bhKoYsG4Ht57yxJ-69fvvbVCVPGjI",
  authDomain: "dashboardusinagem.firebaseapp.com",
  projectId: "dashboardusinagem",
  storageBucket: "dashboardusinagem.appspot.com",
  messagingSenderId: "677023128312",
  appId: "1:677023128312:web:75376363a62105f360f90d"
});

const db  = firebase.database();
const REF = db.ref('usinagem_dashboard_v18_6');

// =========================================================
//  SERVER TIME OFFSET
//  Corrige a diferença entre o relógio local e o servidor.
//  serverNow() retorna o tempo do servidor Firebase,
//  idêntico em todos os dispositivos.
// =========================================================
let serverTimeOffset = 0;
db.ref('.info/serverTimeOffset').on('value', snap => {
  serverTimeOffset = snap.val() || 0;
});
function serverNow() {
  return Date.now() + serverTimeOffset;
}

// =========================================================
//  NOTIFICAÇÃO
// =========================================================
function notificar(titulo, mensagem) {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    new Notification(titulo, {
      body: mensagem,
      icon: "https://cdn-icons-png.flaticon.com/512/1827/1827272.png"
    });
  }
}

// =========================================================
//  FUNÇÕES DE TEMPO
// =========================================================
function parseTempoMinutos(str) {
  if (!str) return 0;
  const s = String(str).trim();
  if (s.includes(':')) {
    const parts = s.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / 60;
    if (parts.length === 2) return parts[0] + parts[1] / 60;
  }
  const v = Number(s.replace(',', '.'));
  return isNaN(v) ? 0 : v;
}

function formatMinutesToMMSS(minFloat) {
  if (!minFloat || isNaN(minFloat)) return '-';
  const totalSeconds = Math.round(minFloat * 60);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatSeconds(totalSec) {
  if (!totalSec || totalSec < 0) return '0:00';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function minutosDisponiveis(startStr, endStr) {
  if (!startStr || !endStr) return 0;
  function toMin(t) {
    const p = t.split(':').map(Number);
    return p.length >= 2 ? p[0] * 60 + p[1] : 0;
  }
  return Math.max(toMin(endStr) - toMin(startStr), 0);
}

function calcularPrevisto(cycleMin, trocaMin, startStr, endStr, statusAccSec, pausaAccSec) {
  if (!cycleMin || cycleMin <= 0) return 0;
  const cicloTotal = cycleMin + (trocaMin || 0);
  if (cicloTotal <= 0) return 0;
  const turnoTotal = minutosDisponiveis(startStr, endStr);
  if (turnoTotal <= 0) return 0;
  const parado = ((statusAccSec?.setup || 0) + (statusAccSec?.manutencao || 0) + (pausaAccSec || 0)) / 60;
  return Math.floor(Math.max(turnoTotal - parado, 0) / cicloTotal);
}

// =========================================================
//  LEITURA AO VIVO DOS CRONÔMETROS
//  Usa serverNow() — mesmo resultado em todos os dispositivos
// =========================================================
function getLiveStatusSec(m, key) {
  const acc = m.statusAccSec[key] || 0;
  if (m.statusPaused) return acc;
  if (m.status === key && m.statusChangedAt)
    return acc + Math.floor((serverNow() - m.statusChangedAt) / 1000);
  return acc;
}

function getLivePausaSec(m) {
  const acc = m.pausaAccSec || 0;
  if (m.pausaChangedAt)
    return acc + Math.floor((serverNow() - m.pausaChangedAt) / 1000);
  return acc;
}

// =========================================================
//  STATE CENTRAL
//  machines: dados de cada máquina
//  cards:    referências DOM de cada card (criado só 1 vez)
// =========================================================
const machines = {};  // { [id]: dadosDaMaquina }
const cards    = {};  // { [id]: { dom refs, chart, timer } }

function machineDefault(name) {
  return {
    id: name,
    operator: '', process: '',
    cycleMin: null, setupMin: 0, trocaMin: null,
    observacao: '',
    startTime: '07:00', endTime: '16:45',
    produced: null, predicted: 0,
    history: [], future: [],
    status: 'producao',
    statusChangedAt: null,
    statusPaused: false,
    statusAccSec: { producao: 0, setup: 0, manutencao: 0 },
    pausaAccSec: 0,
    pausaChangedAt: null
  };
}

function rawToMachine(name, raw) {
  return {
    id:        name,
    operator:  raw.operator   || '',
    process:   raw.process    || '',
    cycleMin:  raw.cycleMin   ?? null,
    setupMin:  raw.setupMin   ?? 0,
    trocaMin:  raw.trocaMin   ?? null,
    observacao:raw.observacao ?? '',
    startTime: raw.startTime  || '07:00',
    endTime:   raw.endTime    || '16:45',
    produced:  raw.produced   ?? null,
    predicted: raw.predicted  ?? 0,
    history:   Array.isArray(raw.history) ? raw.history : [],
    future:    Array.isArray(raw.future)  ? raw.future  : [],
    status:          raw.status          || 'producao',
    statusChangedAt: raw.statusChangedAt || null,
    statusPaused:    raw.statusPaused    || false,
    statusAccSec: {
      producao:   raw.statusAccSec?.producao   || 0,
      setup:      raw.statusAccSec?.setup      || 0,
      manutencao: raw.statusAccSec?.manutencao || 0
    },
    pausaAccSec:    raw.pausaAccSec    || 0,
    pausaChangedAt: raw.pausaChangedAt || null
  };
}

// =========================================================
//  VISUAL DE STATUS
// =========================================================
const STATUS_CONFIG = {
  producao:   { label: '🟢 Produção',   badgeClass: 'status-badge-producao',   cardClass: 'card-status-producao'   },
  setup:      { label: '🟡 Setup',      badgeClass: 'status-badge-setup',      cardClass: 'card-status-setup'      },
  manutencao: { label: '🔴 Manutenção', badgeClass: 'status-badge-manutencao', cardClass: 'card-status-manutencao' }
};

function applyStatusVisual(c, m) {
  const cfg = STATUS_CONFIG[m.status];
  c.root.classList.remove('card-status-producao','card-status-setup','card-status-manutencao');
  c.root.classList.add(cfg.cardClass);
  c.statusBadge.className   = `status-badge ${cfg.badgeClass}`;
  c.statusBadge.textContent = m.statusPaused ? '⏸ Pausado' : cfg.label;
  ['btnProducao','btnSetup','btnManutencao'].forEach(r => c[r].classList.remove('active-chip'));
  const map = { producao:'btnProducao', setup:'btnSetup', manutencao:'btnManutencao' };
  c[map[m.status]].classList.add('active-chip');
}

function applyBtnPausar(c, m) {
  const pausado = m.statusPaused || m.pausaChangedAt !== null;
  c.btnPausar.textContent = pausado ? '▶ Retomar' : '⏸ Pausar';
  c.btnPausar.classList.toggle('bg-yellow-600', pausado);
  c.btnPausar.classList.toggle('bg-gray-600',  !pausado);
}

// =========================================================
//  ATUALIZAR GRÁFICO
// =========================================================
function atualizarGrafico(c, m) {
  const predicted = m.predicted || 0;
  const produced  = (m.produced != null && m.produced !== '') ? Number(m.produced) : 0;
  const ratio     = predicted > 0 ? (produced / predicted) * 100 : 0;
  let color = 'rgba(255,255,255,0.3)', txt = 'text-gray-400';
  if      (ratio < 50) { color='rgba(255,0,0,0.6)';   txt='text-red-500';    }
  else if (ratio < 80) { color='rgba(255,255,0,0.6)'; txt='text-yellow-400'; }
  else                 { color='rgba(0,255,0,0.6)';   txt='text-green-400';  }
  c.chart.data.datasets[0].data            = [predicted, produced];
  c.chart.data.datasets[0].backgroundColor = ['rgba(0,200,0,0.4)', color];
  c.chart.update();
  c.performanceEl.className   = `text-center text-sm font-semibold mt-1 ${txt}`;
  c.performanceEl.textContent = `Desempenho: ${ratio.toFixed(1)}%`;
}

// =========================================================
//  RENDERIZAR HISTÓRICO
// =========================================================
function renderHistory(c, m) {
  c.historyEl.innerHTML = '';
  if (!m.history || m.history.length === 0) {
    c.historyEl.innerHTML = '<div class="text-gray-400">Histórico vazio</div>'; return;
  }
  m.history.slice().reverse().forEach(h => {
    const div = document.createElement('div');
    div.className = 'mb-1 border-b border-gray-800 pb-1';
    div.innerHTML = `
      <div class="text-xs text-gray-300">${new Date(h.ts).toLocaleString()}</div>
      <div class="text-sm">Operador: <strong>${h.operator}</strong> · Peça: <strong>${h.process}</strong></div>
      <div class="text-xs text-gray-400">Previsto: ${h.predicted} · Realizado: ${h.produced??'-'} · Eficiência: ${h.efficiency??'-'}%</div>
      <div class="text-xs mt-0.5 flex gap-2 flex-wrap">
        <span class="status-time-chip chip-producao" style="pointer-events:none">🟢 ${formatSeconds(h.statusAccSec?.producao||0)}</span>
        <span class="status-time-chip chip-setup"    style="pointer-events:none">🟡 ${formatSeconds(h.statusAccSec?.setup||0)}</span>
        <span class="status-time-chip chip-manutencao" style="pointer-events:none">🔴 ${formatSeconds(h.statusAccSec?.manutencao||0)}</span>
        ${h.pausaAccSec ? `<span class="status-time-chip chip-setup" style="pointer-events:none">⏸ ${formatSeconds(h.pausaAccSec)}</span>` : ''}
      </div>
      ${h.observacao ? `<div class='text-xs text-sky-300'>Obs.: ${h.observacao}</div>` : ''}`;
    c.historyEl.appendChild(div);
  });
}

// =========================================================
//  RENDERIZAR FUTUROS
// =========================================================
function renderFuture(c, m) {
  c.futureList.innerHTML = '';
  if (!Array.isArray(m.future)) m.future = [];
  if (m.future.length === 0) {
    c.futureList.innerHTML = '<div class="text-gray-400">Nenhum processo futuro</div>'; return;
  }
  m.future.forEach((f, i) => {
    const div = document.createElement('div');
    div.className = `rounded px-2 py-1 flex justify-between items-center cursor-move prioridade-${f.priority}`;
    const badge = document.createElement('div');
    badge.className = 'wait-badge'; badge.textContent = String(i+1);
    const left = document.createElement('div');
    left.className = 'flex items-center gap-2 flex-1';
    const inp = document.createElement('input');
    inp.value = f.name;
    inp.className = 'bg-transparent flex-1 mr-2 outline-none text-black font-bold';
    inp.addEventListener('input', () => { f.name = inp.value; });
    inp.addEventListener('blur',  () => { if (!Array.isArray(m.future)) m.future=[]; REF.child(m.id).set(m); });
    const sel = document.createElement('select');
    sel.className = 'bg-gray-200 text-black text-sm rounded px-1 font-bold';
    [['vermelho','🔴 Urgente'],['amarelo','🟡 Alta'],['verde','🟢 Normal']].forEach(([p,l]) => {
      const o = document.createElement('option');
      o.value=p; o.textContent=l; if(p===f.priority) o.selected=true; sel.appendChild(o);
    });
    sel.addEventListener('change', () => { f.priority=sel.value; REF.child(m.id).set(m); renderFuture(c,m); });
    const del = document.createElement('button');
    del.className='ml-2 text-black font-bold'; del.textContent='✖';
    del.addEventListener('click', () => { m.future.splice(i,1); REF.child(m.id).set(m); renderFuture(c,m); });
    left.appendChild(badge); left.appendChild(inp);
    div.appendChild(left); div.appendChild(sel); div.appendChild(del);
    c.futureList.appendChild(div);
  });
  Sortable.create(c.futureList, { animation:150, onEnd(e) {
    const it = m.future.splice(e.oldIndex,1)[0];
    m.future.splice(e.newIndex,0,it);
    REF.child(m.id).set(m); renderFuture(c,m);
  }});
}

// =========================================================
//  CRIAR CARD — chamado apenas UMA VEZ por máquina
//  Depois disso só atualizamos os dados, nunca recriamos.
// =========================================================
function criarCard(m) {
  const tpl  = document.getElementById('machine-template');
  const node = tpl.content.cloneNode(true);
  const root = node.querySelector('div');
  document.getElementById('machinesContainer').appendChild(root);

  // Guarda todas as referências DOM no objeto c
  const c = {
    root,
    title:          root.querySelector('[data-role="title"]'),
    subtitle:       root.querySelector('[data-role="subtitle"]'),
    operatorInput:  root.querySelector('[data-role="operator"]'),
    processInput:   root.querySelector('[data-role="process"]'),
    cycleInput:     root.querySelector('[data-role="cycle"]'),
    trocaInput:     root.querySelector('[data-role="troca"]'),
    paradaDisplay:  root.querySelector('[data-role="paradaAutoDisplay"]'),
    startInput:     root.querySelector('[data-role="startTime"]'),
    endInput:       root.querySelector('[data-role="endTime"]'),
    producedInput:  root.querySelector('[data-role="produced"]'),
    observacaoInput:root.querySelector('[data-role="observacao"]'),
    saveBtn:        root.querySelector('[data-role="save"]'),
    addHistBtn:     root.querySelector('[data-role="addHistory"]'),
    clearHistBtn:   root.querySelector('[data-role="clearHistory"]'),
    predictedEl:    root.querySelector('[data-role="predicted"]'),
    historyEl:      root.querySelector('[data-role="history"]'),
    performanceEl:  root.querySelector('[data-role="performance"]'),
    futureInput:    root.querySelector('[data-role="futureInput"]'),
    addFutureBtn:   root.querySelector('[data-role="addFuture"]'),
    futureList:     root.querySelector('[data-role="futureList"]'),
    prioritySelect: root.querySelector('[data-role="prioritySelect"]'),
    sortFutureBtn:  root.querySelector('[data-role="sortFuture"]'),
    btnProducao:    root.querySelector('[data-role="btnProducao"]'),
    btnSetup:       root.querySelector('[data-role="btnSetup"]'),
    btnManutencao:  root.querySelector('[data-role="btnManutencao"]'),
    btnPausar:      root.querySelector('[data-role="btnPausar"]'),
    btnZerar:       root.querySelector('[data-role="btnZerar"]'),
    elProd:         root.querySelector('[data-role="timeProducao"]'),
    elSetup:        root.querySelector('[data-role="timeSetup"]'),
    elManut:        root.querySelector('[data-role="timeManutencao"]'),
    statusBadge:    root.querySelector('[data-role="statusBadge"]'),
    chart:          null,
    timer:          null
  };

  // Preenche campos estáticos
  c.title.textContent     = m.id;
  c.subtitle.textContent  = `Operador: ${m.operator||'-'} · Ciclo: ${m.cycleMin!=null?formatMinutesToMMSS(m.cycleMin):'-'} · Peça: ${m.process||'-'}`;
  c.operatorInput.value   = m.operator;
  c.processInput.value    = m.process;
  c.cycleInput.value      = m.cycleMin != null ? formatMinutesToMMSS(m.cycleMin) : '';
  c.trocaInput.value      = m.trocaMin != null ? formatMinutesToMMSS(m.trocaMin) : '';
  c.startInput.value      = m.startTime;
  c.endInput.value        = m.endTime;
  c.producedInput.value   = m.produced != null ? m.produced : '';
  c.observacaoInput.value = m.observacao || '';
  c.predictedEl.textContent = m.predicted ?? 0;

  applyStatusVisual(c, m);
  applyBtnPausar(c, m);

  // Gráfico
  c.chart = new Chart(root.querySelector('[data-role="chart"]').getContext('2d'), {
    type: 'bar',
    data: {
      labels: ['Previsto','Realizado'],
      datasets: [{ label: m.id, data: [m.predicted||0, m.produced||0],
        backgroundColor: ['rgba(0,200,0,0.4)','rgba(255,255,255,0.2)'] }]
    },
    options: { scales:{ y:{ beginAtZero:true } }, plugins:{ legend:{ display:false } } }
  });

  atualizarGrafico(c, m);
  renderHistory(c, m);
  renderFuture(c, m);

  // =========================================================
  //  CRONÔMETRO LOCAL — roda a cada 1s e lê do state em memória
  //  Como usa serverNow(), o valor é idêntico em todos os
  //  dispositivos que têm o mesmo statusChangedAt.
  // =========================================================
  c.timer = setInterval(() => {
    const secProd  = getLiveStatusSec(m, 'producao');
    const secSetup = getLiveStatusSec(m, 'setup');
    const secManut = getLiveStatusSec(m, 'manutencao');
    const secPausa = getLivePausaSec(m);

    c.elProd.textContent  = formatSeconds(secProd);
    c.elSetup.textContent = formatSeconds(secSetup);
    c.elManut.textContent = formatSeconds(secManut);
    c.paradaDisplay.textContent = formatSeconds(secSetup + secManut + secPausa);

    const novo = calcularPrevisto(
      m.cycleMin, m.trocaMin, m.startTime, m.endTime,
      { setup: secSetup, manutencao: secManut }, secPausa
    );
    if (novo !== m.predicted) {
      m.predicted = novo;
      c.predictedEl.textContent = novo;
      atualizarGrafico(c, m);
    }
  }, 1000);

  // =========================================================
  //  EVENTOS DOS BOTÕES
  // =========================================================

  function mudarStatus(novo) {
    if (m.status === novo && !m.statusPaused) return;
    const agora = serverNow();
    if (m.statusChangedAt && !m.statusPaused) {
      const extra = Math.floor((agora - m.statusChangedAt) / 1000);
      m.statusAccSec[m.status] = (m.statusAccSec[m.status] || 0) + extra;
    }
    if (m.pausaChangedAt) {
      const extra = Math.floor((agora - m.pausaChangedAt) / 1000);
      m.pausaAccSec    = (m.pausaAccSec || 0) + extra;
      m.pausaChangedAt = null;
    }
    m.status       = novo;
    m.statusPaused = false;
    applyStatusVisual(c, m);
    applyBtnPausar(c, m);
    REF.child(m.id).update({
      status:          novo,
      statusPaused:    false,
      statusChangedAt: firebase.database.ServerValue.TIMESTAMP,
      pausaChangedAt:  null,
      statusAccSec:    m.statusAccSec,
      pausaAccSec:     m.pausaAccSec
    });
  }

  c.btnProducao.addEventListener('click',   () => mudarStatus('producao'));
  c.btnSetup.addEventListener('click',      () => mudarStatus('setup'));
  c.btnManutencao.addEventListener('click', () => mudarStatus('manutencao'));

  c.btnPausar.addEventListener('click', () => {
    const agora     = serverNow();
    const jaPausado = m.statusPaused || m.pausaChangedAt !== null;
    if (!jaPausado) {
      if (m.statusChangedAt) {
        const extra = Math.floor((agora - m.statusChangedAt) / 1000);
        m.statusAccSec[m.status] = (m.statusAccSec[m.status] || 0) + extra;
      }
      m.statusPaused    = true;
      m.statusChangedAt = null;
      applyStatusVisual(c, m);
      applyBtnPausar(c, m);
      REF.child(m.id).update({
        statusPaused:    true,
        statusChangedAt: null,
        pausaChangedAt:  firebase.database.ServerValue.TIMESTAMP,
        statusAccSec:    m.statusAccSec
      });
    } else {
      if (m.pausaChangedAt) {
        const extra = Math.floor((agora - m.pausaChangedAt) / 1000);
        m.pausaAccSec = (m.pausaAccSec || 0) + extra;
      }
      m.statusPaused   = false;
      m.pausaChangedAt = null;
      applyStatusVisual(c, m);
      applyBtnPausar(c, m);
      REF.child(m.id).update({
        statusPaused:    false,
        pausaChangedAt:  null,
        statusChangedAt: firebase.database.ServerValue.TIMESTAMP,
        pausaAccSec:     m.pausaAccSec
      });
    }
  });

  c.btnZerar.addEventListener('click', () => {
    if (!confirm(`Zerar todos os tempos de ${m.id}? (Use ao trocar de peça)`)) return;
    m.statusAccSec   = { producao: 0, setup: 0, manutencao: 0 };
    m.pausaAccSec    = 0;
    m.pausaChangedAt = null;
    m.statusPaused   = false;
    applyBtnPausar(c, m);
    REF.child(m.id).update({
      statusAccSec:    { producao: 0, setup: 0, manutencao: 0 },
      pausaAccSec:     0,
      pausaChangedAt:  null,
      statusPaused:    false,
      statusChangedAt: firebase.database.ServerValue.TIMESTAMP
    });
  });

  c.saveBtn.addEventListener('click', () => {
    m.operator   = c.operatorInput.value.trim();
    m.process    = c.processInput.value.trim();
    m.cycleMin   = c.cycleInput.value.trim() === '' ? null : parseTempoMinutos(c.cycleInput.value.trim());
    m.trocaMin   = c.trocaInput.value.trim() === '' ? null : parseTempoMinutos(c.trocaInput.value.trim());
    m.observacao = c.observacaoInput.value;
    m.startTime  = c.startInput.value  || '07:00';
    m.endTime    = c.endInput.value    || '16:45';
    m.produced   = c.producedInput.value.trim() === '' ? null : Number(c.producedInput.value.trim());
    c.subtitle.textContent = `Operador: ${m.operator||'-'} · Ciclo: ${m.cycleMin!=null?formatMinutesToMMSS(m.cycleMin):'-'} · Peça: ${m.process||'-'}`;
    REF.child(m.id).set(m);
  });

  c.addHistBtn.addEventListener('click', () => {
    const cycleVal    = parseTempoMinutos(c.cycleInput.value.trim());
    const trocaVal    = parseTempoMinutos(c.trocaInput.value.trim());
    const startVal    = c.startInput.value  || '07:00';
    const endVal      = c.endInput.value    || '16:45';
    const producedVal = c.producedInput.value.trim() === '' ? null : Number(c.producedInput.value.trim());
    const secSetup    = getLiveStatusSec(m, 'setup');
    const secManut    = getLiveStatusSec(m, 'manutencao');
    const secPausa    = getLivePausaSec(m);
    const predicted   = calcularPrevisto(cycleVal, trocaVal, startVal, endVal,
      { setup: secSetup, manutencao: secManut }, secPausa);
    const efficiency  = (predicted > 0 && producedVal != null)
      ? ((producedVal / predicted) * 100).toFixed(1) : '-';
    if (!Array.isArray(m.history)) m.history = [];
    m.history.push({
      ts: Date.now(),
      operator: c.operatorInput.value.trim() || '-',
      process:  c.processInput.value.trim()  || '-',
      cycleMin: cycleVal, trocaMin: trocaVal,
      startTime: startVal, endTime: endVal,
      produced: producedVal, predicted, efficiency,
      observacao: c.observacaoInput.value,
      status: m.status,
      statusAccSec: { producao: getLiveStatusSec(m,'producao'), setup: secSetup, manutencao: secManut },
      pausaAccSec: secPausa
    });
    renderHistory(c, m);
    REF.child(m.id).set(m);
  });

  c.clearHistBtn.addEventListener('click', () => {
    if (!confirm(`Limpar histórico de ${m.id}?`)) return;
    m.history = [];
    renderHistory(c, m);
    REF.child(m.id).set(m);
  });

  c.addFutureBtn.addEventListener('click', () => {
    const nome = c.futureInput.value.trim();
    if (!nome) return alert('Digite o nome do processo futuro.');
    if (!Array.isArray(m.future)) m.future = [];
    m.future.push({ name: nome, priority: c.prioritySelect.value });
    c.futureInput.value = '';
    REF.child(m.id).set(m);
    renderFuture(c, m);
  });

  c.sortFutureBtn.addEventListener('click', () => {
    const ordem = { vermelho:1, amarelo:2, verde:3 };
    if (!Array.isArray(m.future)) m.future = [];
    m.future.sort((a,b) => ordem[a.priority]-ordem[b.priority]);
    REF.child(m.id).set(m);
    renderFuture(c, m);
  });

  return c;
}

// =========================================================
//  ATUALIZAR CARD EXISTENTE SEM RECRIAR
//  Chamado quando o Firebase notifica uma mudança.
//  Atualiza só o objeto m em memória — o setInterval
//  já está rodando e exibe o valor correto no próximo tick.
// =========================================================
function atualizarCard(c, m, raw) {
  const statusMudou   = m.status !== (raw.status || 'producao') ||
                        m.statusPaused !== (raw.statusPaused || false);
  const estruturaMudou = m.operator  !== (raw.operator  || '') ||
                         m.process   !== (raw.process   || '') ||
                         m.cycleMin  !== (raw.cycleMin  ?? null) ||
                         m.trocaMin  !== (raw.trocaMin  ?? null) ||
                         m.startTime !== (raw.startTime || '07:00') ||
                         m.endTime   !== (raw.endTime   || '16:45') ||
                         m.produced  !== (raw.produced  ?? null) ||
                         m.observacao!== (raw.observacao?? '') ||
                         JSON.stringify(m.history) !== JSON.stringify(raw.history || []) ||
                         JSON.stringify(m.future)  !== JSON.stringify(raw.future  || []);

  // Sempre atualiza os campos de cronômetro no objeto em memória
  m.status          = raw.status          || 'producao';
  m.statusChangedAt = raw.statusChangedAt || null;
  m.statusPaused    = raw.statusPaused    || false;
  m.statusAccSec    = {
    producao:   raw.statusAccSec?.producao   || 0,
    setup:      raw.statusAccSec?.setup      || 0,
    manutencao: raw.statusAccSec?.manutencao || 0
  };
  m.pausaAccSec    = raw.pausaAccSec    || 0;
  m.pausaChangedAt = raw.pausaChangedAt || null;

  // Atualiza visual de status e pausar sempre que mudar
  if (statusMudou) {
    applyStatusVisual(c, m);
    applyBtnPausar(c, m);
  }

  // Atualiza campos estruturais se necessário
  if (estruturaMudou) {
    m.operator   = raw.operator   || '';
    m.process    = raw.process    || '';
    m.cycleMin   = raw.cycleMin   ?? null;
    m.trocaMin   = raw.trocaMin   ?? null;
    m.startTime  = raw.startTime  || '07:00';
    m.endTime    = raw.endTime    || '16:45';
    m.produced   = raw.produced   ?? null;
    m.observacao = raw.observacao ?? '';
    m.history    = Array.isArray(raw.history) ? raw.history : [];
    m.future     = Array.isArray(raw.future)  ? raw.future  : [];

    c.subtitle.textContent  = `Operador: ${m.operator||'-'} · Ciclo: ${m.cycleMin!=null?formatMinutesToMMSS(m.cycleMin):'-'} · Peça: ${m.process||'-'}`;
    c.operatorInput.value   = m.operator;
    c.processInput.value    = m.process;
    c.cycleInput.value      = m.cycleMin != null ? formatMinutesToMMSS(m.cycleMin) : '';
    c.trocaInput.value      = m.trocaMin != null ? formatMinutesToMMSS(m.trocaMin) : '';
    c.startInput.value      = m.startTime;
    c.endInput.value        = m.endTime;
    c.producedInput.value   = m.produced != null ? m.produced : '';
    c.observacaoInput.value = m.observacao;
    atualizarGrafico(c, m);
    renderHistory(c, m);
    renderFuture(c, m);
  }
}

// =========================================================
//  FIREBASE LISTENER
//  - 1ª carga: cria todos os cards
//  - Atualizações seguintes: só atualiza o state em memória
//    e os visuais afetados — sem recriar nada
// =========================================================
let primeiraCarrega = true;
let prevSnapshot    = {};

REF.on('value', snapshot => {
  const data = snapshot.val();

  if (!data) {
    MACHINE_NAMES.forEach(name => {
      const m = machineDefault(name);
      machines[name] = m;
      REF.child(name).set(m);
      cards[name] = criarCard(m);
    });
    primeiraCarrega = false;
    return;
  }

  // Notificações
  if (!primeiraCarrega) {
    MACHINE_NAMES.forEach(name => {
      const raw  = data[name] || {};
      const prev = prevSnapshot[name] || {};
      if ((raw.operator !== prev.operator || raw.process !== prev.process) && (raw.operator || raw.process))
        notificar(`⚙️ ${name} atualizada`, `Operador: ${raw.operator||'-'} · Peça: ${raw.process||'-'}`);
      const prevHL = Array.isArray(prev.history) ? prev.history.length : 0;
      const currHL = Array.isArray(raw.history)  ? raw.history.length  : 0;
      if (currHL > prevHL) {
        const u = raw.history[raw.history.length-1];
        notificar(`📋 Histórico — ${name}`, `Realizado: ${u.produced??'-'} · Eficiência: ${u.efficiency??'-'}%`);
      }
      if (raw.status && raw.status !== prev.status) {
        const labels = { producao:'🟢 Produção', setup:'🟡 Setup', manutencao:'🔴 Manutenção' };
        notificar(name, `Status: ${labels[raw.status]||raw.status}`);
      }
    });
  }

  prevSnapshot = JSON.parse(JSON.stringify(data));

  if (primeiraCarrega) {
    // Cria todos os cards uma única vez
    MACHINE_NAMES.forEach(name => {
      const raw = data[name] || {};
      const m   = rawToMachine(name, raw);
      machines[name] = m;
      cards[name]    = criarCard(m);
    });
    primeiraCarrega = false;
  } else {
    // Atualiza só o state e os visuais afetados — sem recriar cards
    MACHINE_NAMES.forEach(name => {
      const raw = data[name];
      if (!raw) return;
      const m = machines[name];
      const c = cards[name];
      if (!m || !c) return;
      atualizarCard(c, m, raw);
    });
  }

  // Reaplica filtro de pesquisa se houver
  const si = document.getElementById('searchInput');
  if (si && si.value) filtrarCards(si.value);
});

// =========================================================
//  EXPORTAÇÃO CSV
// =========================================================
function exportCSV() {
  const hoje    = new Date();
  const dataFmt = hoje.toLocaleDateString('pt-BR');
  const horaFmt = hoje.toLocaleTimeString('pt-BR');
  const dataArq = dataFmt.replace(/\//g,'-');

  const resumo = ['Data;Hora;Máquina;Operador;Processo;Ciclo (min);Troca (min);Início;Fim;Previsto;Realizado;Eficiência (%);Status;T.Produção;T.Setup;T.Manutenção;T.Pausa;Observação;Processos Futuros'];
  MACHINE_NAMES.forEach(name => {
    const m = machines[name]; if (!m) return;
    const ef  = m.predicted && m.produced!=null ? ((m.produced/m.predicted)*100).toFixed(1).replace('.',',') : '';
    const fut = (Array.isArray(m.future)?m.future:[]).map((f,i)=>`${i+1}. ${f.name} [${f.priority}]`).join(' | ').replace(/;/g,',');
    resumo.push([
      dataFmt, horaFmt,
      (m.id||'').replace(/;/g,','), (m.operator||'').replace(/;/g,','), (m.process||'').replace(/;/g,','),
      m.cycleMin??'', m.trocaMin??'', m.startTime||'', m.endTime||'',
      m.predicted??0, m.produced??'', ef, m.status||'',
      formatSeconds(getLiveStatusSec(m,'producao')),
      formatSeconds(getLiveStatusSec(m,'setup')),
      formatSeconds(getLiveStatusSec(m,'manutencao')),
      formatSeconds(getLivePausaSec(m)),
      (m.observacao||'').replace(/;/g,','), fut
    ].join(';'));
  });
  baixarCSV('\uFEFF'+resumo.join('\n'), `producao_resumo_${dataArq}.csv`);

  const hist = ['Data Registro;Hora Registro;Máquina;Operador;Processo;Ciclo;Troca;Início;Fim;Previsto;Realizado;Eficiência (%);Status;T.Produção;T.Setup;T.Manutenção;T.Pausa;Observação'];
  MACHINE_NAMES.forEach(name => {
    const m = machines[name]; if (!m) return;
    (m.history||[]).forEach(h => {
      const d = new Date(h.ts);
      hist.push([
        d.toLocaleDateString('pt-BR'), d.toLocaleTimeString('pt-BR'),
        (m.id||'').replace(/;/g,','), (h.operator||'').replace(/;/g,','), (h.process||'').replace(/;/g,','),
        h.cycleMin??'', h.trocaMin??'', h.startTime||'', h.endTime||'',
        h.predicted??'', h.produced??'',
        (h.efficiency??'').toString().replace('.',','), h.status||'',
        formatSeconds(h.statusAccSec?.producao||0),
        formatSeconds(h.statusAccSec?.setup||0),
        formatSeconds(h.statusAccSec?.manutencao||0),
        formatSeconds(h.pausaAccSec||0),
        (h.observacao||'').replace(/;/g,',')
      ].join(';'));
    });
  });
  baixarCSV('\uFEFF'+hist.join('\n'), `producao_historico_${dataArq}.csv`);
}

function baixarCSV(content, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type:'text/csv;charset=utf-8;' }));
  a.download = filename; a.click();
}

// =========================================================
//  RESET
// =========================================================
function resetAll() {
  if (!confirm('Resetar tudo e apagar dados?')) return;
  MACHINE_NAMES.forEach(name => {
    REF.child(name).set(machineDefault(name));
  });
}

// =========================================================
//  PESQUISA
// =========================================================
function filtrarCards(termo) {
  const q = termo.trim().toLowerCase();
  let visiveis = 0;
  MACHINE_NAMES.forEach((name, i) => {
    const c = cards[name];
    const m = machines[name];
    if (!c || !m) return;
    const campos = [m.id, m.operator, m.process,
      ...(Array.isArray(m.future) ? m.future.map(f=>f.name) : [])
    ].join(' ').toLowerCase();
    const vis = !q || campos.includes(q);
    c.root.style.display = vis ? '' : 'none';
    if (vis) visiveis++;
  });
  const countEl = document.getElementById('searchCount');
  if (q) { countEl.textContent=`${visiveis} resultado${visiveis!==1?'s':''}`; countEl.classList.remove('hidden'); }
  else   { countEl.classList.add('hidden'); }
}

document.getElementById('exportAll').addEventListener('click', exportCSV);
document.getElementById('resetAll').addEventListener('click', resetAll);
document.getElementById('searchInput').addEventListener('input', e => filtrarCards(e.target.value));
