// =============================
//  CONFIGURAÇÕES INICIAIS E FIREBASE
// =============================

const MACHINE_NAMES = [
  'Fresa CNC 1','Fresa CNC 2','Fresa CNC 3','Robodrill 2','D 800-1','Fagor',
  'Robodrill 1','VTC','D 800-2','D 800-3','Centur','Nardine','GL 280',
  '15S','E 280','G 240','Galaxy 10A','Galaxy 10B','GL 170G','GL 250','GL 350','GL 450','Torno Convencional'
];

// =============================
// FIREBASE
// =============================
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
// NOTIFICAÇÃO
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
  const start = toMin(startStr);
  const end   = toMin(endStr);
  const diff  = end - start;
  return Math.max(diff, 0);
}

// =========================================================
//  CÁLCULO DO PREVISTO
//
//  Lógica:
//    Tempo produtivo = Tempo total do turno (início→fim)
//                    - Setup acumulado
//                    - Manutenção acumulada
//                    - Pausas acumuladas (inclui intervalo manual)
//    Previsto = Tempo produtivo ÷ (Ciclo + Troca)
//
//  O almoço e demais intervalos são controlados manualmente
//  pelo operador via botão Pausar.
// =========================================================
function calcularPrevisto(cycleMin, trocaMin, startStr, endStr, statusAccSec, pausaAccSec) {
  if (!cycleMin || cycleMin <= 0) return 0;
  const cicloTotal = cycleMin + (trocaMin || 0);
  if (cicloTotal <= 0) return 0;

  const turnoTotal = minutosDisponiveis(startStr, endStr);
  if (turnoTotal <= 0) return 0;

  const minSetup    = (statusAccSec?.setup      || 0) / 60;
  const minManut    = (statusAccSec?.manutencao || 0) / 60;
  const minPausa    = (pausaAccSec             || 0) / 60;
  const totalParada = minSetup + minManut + minPausa;

  const produtivo = Math.max(turnoTotal - totalParada, 0);
  return Math.floor(produtivo / cicloTotal);
}

// =========================================================
//  STATE
// =========================================================
let state = { machines: [] };

const activeTimers = {};

function initDefaultMachines() {
  return MACHINE_NAMES.map(name => ({
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
  }));
}

function ensureFutureArray(m) {
  if (!Array.isArray(m.future)) m.future = [];
}

function ensureFields(m) {
  if (!m.status) m.status = 'producao';
  if (!m.statusAccSec || typeof m.statusAccSec !== 'object')
    m.statusAccSec = { producao: 0, setup: 0, manutencao: 0 };
  ['producao','setup','manutencao'].forEach(k => {
    if (!m.statusAccSec[k]) m.statusAccSec[k] = 0;
  });
  if (m.statusPaused === undefined) m.statusPaused = false;
  if (!m.pausaAccSec)    m.pausaAccSec    = 0;
  if (!m.pausaChangedAt) m.pausaChangedAt = null;
}

// =========================================================
//  CRONÔMETRO — tempo ao vivo por chave
//  Usa o timestamp salvo no Firebase (servidor) como
//  referência, garantindo sincronismo entre dispositivos.
// =========================================================
function getLiveStatusSec(m, key) {
  const acc = m.statusAccSec[key] || 0;
  if (m.statusPaused) return acc;
  if (m.status === key && m.statusChangedAt)
    return acc + Math.floor((Date.now() - m.statusChangedAt) / 1000);
  return acc;
}

function getLivePausaSec(m) {
  const acc = m.pausaAccSec || 0;
  if (m.pausaChangedAt)
    return acc + Math.floor((Date.now() - m.pausaChangedAt) / 1000);
  return acc;
}

function stopTimer(id) {
  if (activeTimers[id]) { clearInterval(activeTimers[id]); delete activeTimers[id]; }
}

function startTimer(m, root, predictedEl, atualizarGraficoFn) {
  stopTimer(m.id);

  const elProd  = root.querySelector('[data-role="timeProducao"]');
  const elSetup = root.querySelector('[data-role="timeSetup"]');
  const elManut = root.querySelector('[data-role="timeManutencao"]');
  const elPara  = root.querySelector('[data-role="paradaAutoDisplay"]');

  activeTimers[m.id] = setInterval(() => {
    const secProd  = getLiveStatusSec(m, 'producao');
    const secSetup = getLiveStatusSec(m, 'setup');
    const secManut = getLiveStatusSec(m, 'manutencao');
    const secPausa = getLivePausaSec(m);

    if (elProd)  elProd.textContent  = formatSeconds(secProd);
    if (elSetup) elSetup.textContent = formatSeconds(secSetup);
    if (elManut) elManut.textContent = formatSeconds(secManut);
    if (elPara)  elPara.textContent  = formatSeconds(secSetup + secManut + secPausa);

    const novo = calcularPrevisto(
      m.cycleMin, m.trocaMin, m.startTime, m.endTime,
      { setup: secSetup, manutencao: secManut }, secPausa
    );
    if (novo !== m.predicted) {
      m.predicted = novo;
      predictedEl.textContent = novo;
      if (typeof atualizarGraficoFn === 'function') atualizarGraficoFn();
    }
  }, 1000);
}

// =========================================================
//  VISUAL DE STATUS
// =========================================================
const STATUS_CONFIG = {
  producao:   { label: '🟢 Produção',   badgeClass: 'status-badge-producao',   cardClass: 'card-status-producao'   },
  setup:      { label: '🟡 Setup',      badgeClass: 'status-badge-setup',      cardClass: 'card-status-setup'      },
  manutencao: { label: '🔴 Manutenção', badgeClass: 'status-badge-manutencao', cardClass: 'card-status-manutencao' }
};

function applyStatusVisual(root, status, paused) {
  const cfg = STATUS_CONFIG[status];
  root.classList.remove('card-status-producao','card-status-setup','card-status-manutencao');
  root.classList.add(cfg.cardClass);

  const badge = root.querySelector('[data-role="statusBadge"]');
  badge.className   = `status-badge ${cfg.badgeClass}`;
  badge.textContent = paused ? '⏸ Pausado' : cfg.label;

  ['btnProducao','btnSetup','btnManutencao'].forEach(r => {
    const btn = root.querySelector(`[data-role="${r}"]`);
    if (btn) btn.classList.remove('active-chip');
  });
  const activeRole = { producao:'btnProducao', setup:'btnSetup', manutencao:'btnManutencao' }[status];
  const activeBtn  = root.querySelector(`[data-role="${activeRole}"]`);
  if (activeBtn) activeBtn.classList.add('active-chip');
}

// =========================================================
//  RENDER
// =========================================================
function render() {
  Object.keys(activeTimers).forEach(id => stopTimer(id));

  const container = document.getElementById('machinesContainer');
  container.innerHTML = '';

  state.machines.forEach(m => {
    ensureFutureArray(m);
    ensureFields(m);

    const tpl  = document.getElementById('machine-template');
    const node = tpl.content.cloneNode(true);
    const root = node.querySelector('div');
    container.appendChild(root);

    // ---- DOM refs ----
    const title           = root.querySelector('[data-role="title"]');
    const subtitle        = root.querySelector('[data-role="subtitle"]');
    const operatorInput   = root.querySelector('[data-role="operator"]');
    const processInput    = root.querySelector('[data-role="process"]');
    const cycleInput      = root.querySelector('[data-role="cycle"]');
    const trocaInput      = root.querySelector('[data-role="troca"]');
    const paradaDisplay   = root.querySelector('[data-role="paradaAutoDisplay"]');
    const startInput      = root.querySelector('[data-role="startTime"]');
    const endInput        = root.querySelector('[data-role="endTime"]');
    const producedInput   = root.querySelector('[data-role="produced"]');
    const observacaoInput = root.querySelector('[data-role="observacao"]');
    const saveBtn         = root.querySelector('[data-role="save"]');
    const addHistBtn      = root.querySelector('[data-role="addHistory"]');
    const clearHistBtn    = root.querySelector('[data-role="clearHistory"]');
    const predictedEl     = root.querySelector('[data-role="predicted"]');
    const historyEl       = root.querySelector('[data-role="history"]');
    const performanceEl   = root.querySelector('[data-role="performance"]');
    const futureInput     = root.querySelector('[data-role="futureInput"]');
    const addFutureBtn    = root.querySelector('[data-role="addFuture"]');
    const futureList      = root.querySelector('[data-role="futureList"]');
    const prioritySelect  = root.querySelector('[data-role="prioritySelect"]');
    const sortFutureBtn   = root.querySelector('[data-role="sortFuture"]');
    const btnProducao     = root.querySelector('[data-role="btnProducao"]');
    const btnSetup        = root.querySelector('[data-role="btnSetup"]');
    const btnManutencao   = root.querySelector('[data-role="btnManutencao"]');
    const btnPausar       = root.querySelector('[data-role="btnPausar"]');
    const btnZerar        = root.querySelector('[data-role="btnZerar"]');
    const elProd          = root.querySelector('[data-role="timeProducao"]');
    const elSetup         = root.querySelector('[data-role="timeSetup"]');
    const elManut         = root.querySelector('[data-role="timeManutencao"]');

    // ---- Preencher ----
    title.textContent    = m.id;
    subtitle.textContent = `Operador: ${m.operator||'-'} · Ciclo: ${m.cycleMin!=null?formatMinutesToMMSS(m.cycleMin):'-'} · Peça: ${m.process||'-'}`;
    operatorInput.value  = m.operator;
    processInput.value   = m.process;
    cycleInput.value     = m.cycleMin != null ? formatMinutesToMMSS(m.cycleMin) : '';
    trocaInput.value     = m.trocaMin != null ? formatMinutesToMMSS(m.trocaMin) : '';
    startInput.value     = m.startTime;
    endInput.value       = m.endTime;
    producedInput.value  = m.produced != null ? m.produced : '';
    observacaoInput.value= m.observacao || '';
    predictedEl.textContent = m.predicted ?? 0;

    if (elProd)  elProd.textContent  = formatSeconds(getLiveStatusSec(m, 'producao'));
    if (elSetup) elSetup.textContent = formatSeconds(getLiveStatusSec(m, 'setup'));
    if (elManut) elManut.textContent = formatSeconds(getLiveStatusSec(m, 'manutencao'));
    if (paradaDisplay) paradaDisplay.textContent = formatSeconds(
      getLiveStatusSec(m,'setup') + getLiveStatusSec(m,'manutencao') + getLivePausaSec(m)
    );

    applyStatusVisual(root, m.status, m.statusPaused);

    // ---- Gráfico ----
    const ctx   = root.querySelector('[data-role="chart"]').getContext('2d');
    const chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['Previsto','Realizado'],
        datasets: [{ label: m.id, data: [m.predicted||0, m.produced||0],
          backgroundColor: ['rgba(0,200,0,0.4)','rgba(255,255,255,0.2)'] }]
      },
      options: { scales:{ y:{ beginAtZero:true } }, plugins:{ legend:{ display:false } } }
    });

    function atualizarGrafico() {
      const predicted = m.predicted || 0;
      const produced  = (m.produced != null && m.produced !== '') ? Number(m.produced) : 0;
      const ratio     = predicted > 0 ? (produced / predicted) * 100 : 0;
      let color = 'rgba(255,255,255,0.3)', txt = 'text-gray-400';
      if      (ratio < 50) { color='rgba(255,0,0,0.6)';   txt='text-red-500';    }
      else if (ratio < 80) { color='rgba(255,255,0,0.6)'; txt='text-yellow-400'; }
      else                 { color='rgba(0,255,0,0.6)';   txt='text-green-400';  }
      chart.data.datasets[0].data            = [predicted, produced];
      chart.data.datasets[0].backgroundColor = ['rgba(0,200,0,0.4)', color];
      chart.update();
      performanceEl.className   = `text-center text-sm font-semibold mt-1 ${txt}`;
      performanceEl.textContent = `Desempenho: ${ratio.toFixed(1)}%`;
    }

    startTimer(m, root, predictedEl, atualizarGrafico);
    atualizarGrafico();

    // ---- Helper: recalcula e persiste o previsto ----
    function recalcularEPersistir() {
      const secSetup = getLiveStatusSec(m, 'setup');
      const secManut = getLiveStatusSec(m, 'manutencao');
      const secPausa = getLivePausaSec(m);
      m.predicted = calcularPrevisto(
        m.cycleMin, m.trocaMin, m.startTime, m.endTime,
        { setup: secSetup, manutencao: secManut }, secPausa
      );
      predictedEl.textContent = m.predicted;
      atualizarGrafico();
    }

    // ---- Firebase ----
    function salvarFirebase() { REF.child(m.id).set(m); }
    function salvarFutureAndSync(mac) { ensureFutureArray(mac); REF.child(mac.id).set(mac); }

    // =========================================================
    //  MUDANÇA DE STATUS
    //  Usa ServerValue.TIMESTAMP para garantir sincronismo
    //  entre todos os dispositivos (celular, computador, etc.)
    // =========================================================
    function mudarStatus(novo) {
      if (m.status === novo && !m.statusPaused) return;
      const agora = Date.now();

      // Acumula tempo do status atual antes de trocar
      if (m.statusChangedAt && !m.statusPaused) {
        const extra = Math.floor((agora - m.statusChangedAt) / 1000);
        m.statusAccSec[m.status] = (m.statusAccSec[m.status] || 0) + extra;
      }
      // Encerra pausa se houver
      if (m.pausaChangedAt) {
        const extra = Math.floor((agora - m.pausaChangedAt) / 1000);
        m.pausaAccSec = (m.pausaAccSec || 0) + extra;
        m.pausaChangedAt = null;
      }

      m.status       = novo;
      m.statusPaused = false;

      // Salva usando timestamp do SERVIDOR Firebase (referência única para todos os dispositivos)
      REF.child(m.id).update({
        status:          novo,
        statusPaused:    false,
        statusChangedAt: firebase.database.ServerValue.TIMESTAMP,
        pausaChangedAt:  null,
        statusAccSec:    m.statusAccSec,
        pausaAccSec:     m.pausaAccSec,
        predicted:       m.predicted
      });

      recalcularEPersistir();
      applyStatusVisual(root, novo, false);
      atualizarBtnPausar();
    }

    btnProducao.addEventListener('click',   () => mudarStatus('producao'));
    btnSetup.addEventListener('click',      () => mudarStatus('setup'));
    btnManutencao.addEventListener('click', () => mudarStatus('manutencao'));

    // =========================================================
    //  PAUSAR / RETOMAR
    // =========================================================
    function atualizarBtnPausar() {
      if (m.statusPaused || m.pausaChangedAt !== null) {
        btnPausar.textContent = '▶ Retomar';
        btnPausar.classList.remove('bg-gray-600');
        btnPausar.classList.add('bg-yellow-600');
      } else {
        btnPausar.textContent = '⏸ Pausar';
        btnPausar.classList.remove('bg-yellow-600');
        btnPausar.classList.add('bg-gray-600');
      }
    }

    btnPausar.addEventListener('click', () => {
      const agora     = Date.now();
      const jaPausado = m.statusPaused || m.pausaChangedAt !== null;

      if (!jaPausado) {
        // Pausar: congela o status atual e inicia contagem de pausa
        if (m.statusChangedAt) {
          const extra = Math.floor((agora - m.statusChangedAt) / 1000);
          m.statusAccSec[m.status] = (m.statusAccSec[m.status] || 0) + extra;
        }
        m.statusPaused    = true;
        m.statusChangedAt = null;

        REF.child(m.id).update({
          statusPaused:    true,
          statusChangedAt: null,
          pausaChangedAt:  firebase.database.ServerValue.TIMESTAMP,
          statusAccSec:    m.statusAccSec
        });
      } else {
        // Retomar: fecha a pausa e reinicia o status
        if (m.pausaChangedAt) {
          const extra = Math.floor((agora - m.pausaChangedAt) / 1000);
          m.pausaAccSec = (m.pausaAccSec || 0) + extra;
        }
        m.statusPaused   = false;
        m.pausaChangedAt = null;

        REF.child(m.id).update({
          statusPaused:    false,
          pausaChangedAt:  null,
          statusChangedAt: firebase.database.ServerValue.TIMESTAMP,
          pausaAccSec:     m.pausaAccSec
        });
      }

      recalcularEPersistir();
      applyStatusVisual(root, m.status, m.statusPaused);
      atualizarBtnPausar();
    });

    // =========================================================
    //  ZERAR (troca de peça)
    // =========================================================
    btnZerar.addEventListener('click', () => {
      if (!confirm(`Zerar todos os tempos de ${m.id}? (Use ao trocar de peça)`)) return;
      m.statusAccSec   = { producao: 0, setup: 0, manutencao: 0 };
      m.pausaAccSec    = 0;
      m.pausaChangedAt = null;
      m.statusPaused   = false;

      REF.child(m.id).update({
        statusAccSec:    { producao: 0, setup: 0, manutencao: 0 },
        pausaAccSec:     0,
        pausaChangedAt:  null,
        statusPaused:    false,
        statusChangedAt: firebase.database.ServerValue.TIMESTAMP
      });

      recalcularEPersistir();
      atualizarBtnPausar();
    });

    atualizarBtnPausar();

    // ---- Histórico ----
    function renderHistory() {
      historyEl.innerHTML = '';
      if (!m.history || m.history.length === 0) {
        historyEl.innerHTML = '<div class="text-gray-400">Histórico vazio</div>'; return;
      }
      m.history.slice().reverse().forEach(h => {
        const div = document.createElement('div');
        div.className = 'mb-1 border-b border-gray-800 pb-1';
        const accProd  = formatSeconds(h.statusAccSec?.producao   || 0);
        const accSetup = formatSeconds(h.statusAccSec?.setup      || 0);
        const accManut = formatSeconds(h.statusAccSec?.manutencao || 0);
        const accPausa = formatSeconds(h.pausaAccSec              || 0);
        div.innerHTML = `
          <div class="text-xs text-gray-300">${new Date(h.ts).toLocaleString()}</div>
          <div class="text-sm">Operador: <strong>${h.operator}</strong> · Peça: <strong>${h.process}</strong></div>
          <div class="text-xs text-gray-400">Previsto: ${h.predicted} · Realizado: ${h.produced??'-'} · Eficiência: ${h.efficiency??'-'}%</div>
          <div class="text-xs mt-0.5 flex gap-2 flex-wrap">
            <span class="status-time-chip chip-producao" style="pointer-events:none">🟢 ${accProd}</span>
            <span class="status-time-chip chip-setup"    style="pointer-events:none">🟡 ${accSetup}</span>
            <span class="status-time-chip chip-manutencao" style="pointer-events:none">🔴 ${accManut}</span>
            ${h.pausaAccSec ? `<span class="status-time-chip chip-setup" style="pointer-events:none">⏸ ${accPausa}</span>` : ''}
          </div>
          ${h.observacao ? `<div class='text-xs text-sky-300'>Obs.: ${h.observacao}</div>` : ''}`;
        historyEl.appendChild(div);
      });
    }

    // ---- Futuros ----
    function renderFuture() {
      futureList.innerHTML = '';
      ensureFutureArray(m);
      if (m.future.length === 0) {
        futureList.innerHTML = '<div class="text-gray-400">Nenhum processo futuro</div>'; return;
      }
      m.future.forEach((f, i) => {
        const div = document.createElement('div');
        div.className = `rounded px-2 py-1 flex justify-between items-center cursor-move prioridade-${f.priority}`;
        const badge = document.createElement('div');
        badge.className = 'wait-badge'; badge.textContent = String(i+1);
        const left = document.createElement('div');
        left.className = 'flex items-center gap-2 flex-1';
        const inp = document.createElement('input');
        inp.value = f.name; inp.className = 'bg-transparent flex-1 mr-2 outline-none text-black font-bold';
        inp.addEventListener('input', () => { f.name = inp.value; });
        inp.addEventListener('blur',  () => salvarFutureAndSync(m));
        const sel = document.createElement('select');
        sel.className = 'bg-gray-200 text-black text-sm rounded px-1 font-bold';
        [['vermelho','🔴 Urgente'],['amarelo','🟡 Alta'],['verde','🟢 Normal']].forEach(([p,l]) => {
          const o = document.createElement('option');
          o.value=p; o.textContent=l; if(p===f.priority) o.selected=true; sel.appendChild(o);
        });
        sel.addEventListener('change', () => { f.priority=sel.value; salvarFutureAndSync(m); renderFuture(); });
        const del = document.createElement('button');
        del.className='ml-2 text-black font-bold'; del.textContent='✖';
        del.addEventListener('click', () => { m.future.splice(i,1); salvarFutureAndSync(m); renderFuture(); });
        left.appendChild(badge); left.appendChild(inp);
        div.appendChild(left); div.appendChild(sel); div.appendChild(del);
        futureList.appendChild(div);
      });
      Sortable.create(futureList, { animation:150, onEnd(e) {
        const it = m.future.splice(e.oldIndex,1)[0];
        m.future.splice(e.newIndex,0,it);
        salvarFutureAndSync(m); renderFuture();
      }});
    }

    // ---- Salvar ----
    saveBtn.addEventListener('click', () => {
      const cycleVal    = parseTempoMinutos(cycleInput.value.trim());
      const trocaVal    = parseTempoMinutos(trocaInput.value.trim());
      const startVal    = startInput.value   || '07:00';
      const endVal      = endInput.value     || '16:45';
      const producedVal = producedInput.value.trim() === '' ? null : Number(producedInput.value.trim());

      m.operator   = operatorInput.value.trim();
      m.process    = processInput.value.trim();
      m.cycleMin   = cycleInput.value.trim() === '' ? null : cycleVal;
      m.trocaMin   = trocaInput.value.trim() === '' ? null : trocaVal;
      m.observacao = observacaoInput.value;
      m.startTime  = startVal;
      m.endTime    = endVal;
      m.produced   = producedVal;

      recalcularEPersistir();
      subtitle.textContent = `Operador: ${m.operator||'-'} · Ciclo: ${m.cycleMin!=null?formatMinutesToMMSS(m.cycleMin):'-'} · Peça: ${m.process||'-'}`;
      salvarFirebase();
    });

    // ---- Adicionar ao histórico ----
    addHistBtn.addEventListener('click', () => {
      const cycleVal    = parseTempoMinutos(cycleInput.value.trim());
      const trocaVal    = parseTempoMinutos(trocaInput.value.trim());
      const startVal    = startInput.value   || '07:00';
      const endVal      = endInput.value     || '16:45';
      const producedVal = producedInput.value.trim() === '' ? null : Number(producedInput.value.trim());

      const secSetup = getLiveStatusSec(m, 'setup');
      const secManut = getLiveStatusSec(m, 'manutencao');
      const secPausa = getLivePausaSec(m);
      const predicted = calcularPrevisto(cycleVal, trocaVal, startVal, endVal,
        { setup: secSetup, manutencao: secManut }, secPausa);
      const efficiency = (predicted > 0 && producedVal != null)
        ? ((producedVal / predicted) * 100).toFixed(1) : '-';

      m.history.push({
        ts: Date.now(),
        operator: operatorInput.value.trim() || '-',
        process:  processInput.value.trim()  || '-',
        cycleMin: cycleVal, trocaMin: trocaVal,
        startTime: startVal, endTime: endVal,
        produced: producedVal, predicted, efficiency,
        observacao: observacaoInput.value,
        status: m.status,
        statusAccSec: {
          producao:   getLiveStatusSec(m,'producao'),
          setup:      secSetup,
          manutencao: secManut
        },
        pausaAccSec: secPausa
      });

      renderHistory();
      salvarFirebase();
    });

    // ---- Limpar histórico ----
    clearHistBtn.addEventListener('click', () => {
      if (!confirm(`Limpar histórico de ${m.id}?`)) return;
      m.history = []; renderHistory(); salvarFirebase();
    });

    // ---- Futuros ----
    addFutureBtn.addEventListener('click', () => {
      const nome = futureInput.value.trim();
      if (!nome) return alert('Digite o nome do processo futuro.');
      m.future.push({ name: nome, priority: prioritySelect.value });
      futureInput.value = '';
      salvarFutureAndSync(m); renderFuture();
    });

    sortFutureBtn.addEventListener('click', () => {
      const ordem = { vermelho:1, amarelo:2, verde:3 };
      m.future.sort((a,b) => ordem[a.priority]-ordem[b.priority]);
      salvarFutureAndSync(m); renderFuture();
    });

    renderHistory();
    renderFuture();
  });

  const si = document.getElementById('searchInput');
  if (si && si.value) filtrarCards(si.value);
}

// =========================================================
// FIREBASE LISTENER
// =========================================================
let primeiraCarrega = true;
let prevSnapshot    = {};

REF.on('value', snapshot => {
  const data = snapshot.val();

  if (!data) {
    state.machines = initDefaultMachines();
    state.machines.forEach(m => REF.child(m.id).set(m));
    primeiraCarrega = false;
    render();
    return;
  }

  // Notificações para outros dispositivos
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

  prevSnapshot    = JSON.parse(JSON.stringify(data));
  primeiraCarrega = false;

  state.machines = MACHINE_NAMES.map(name => {
    const raw = data[name] || {};

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
  });

  render();
});

// =========================================================
// EXPORTAÇÃO CSV
// =========================================================
function exportCSV() {
  const hoje = new Date();
  const dataFmt = hoje.toLocaleDateString('pt-BR');
  const horaFmt = hoje.toLocaleTimeString('pt-BR');
  const dataArq = dataFmt.replace(/\//g,'-');

  const resumo = [
    'Data;Hora;Máquina;Operador;Processo;Ciclo (min);Troca (min);Início;Fim;Previsto;Realizado;Eficiência (%);Status;T.Produção;T.Setup;T.Manutenção;T.Pausa;Observação;Processos Futuros'
  ];
  state.machines.forEach(m => {
    const ef = m.predicted && m.produced!=null
      ? ((m.produced/m.predicted)*100).toFixed(1).replace('.',',') : '';
    const fut = (Array.isArray(m.future)?m.future:[])
      .map((f,i)=>`${i+1}. ${f.name} [${f.priority}]`).join(' | ').replace(/;/g,',');
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

  const hist = [
    'Data Registro;Hora Registro;Máquina;Operador;Processo;Ciclo;Troca;Início;Fim;Previsto;Realizado;Eficiência (%);Status;T.Produção;T.Setup;T.Manutenção;T.Pausa;Observação'
  ];
  state.machines.forEach(m => {
    (m.history||[]).forEach(h => {
      const d = new Date(h.ts);
      hist.push([
        d.toLocaleDateString('pt-BR'), d.toLocaleTimeString('pt-BR'),
        (m.id||'').replace(/;/g,','), (h.operator||'').replace(/;/g,','), (h.process||'').replace(/;/g,','),
        h.cycleMin??'', h.trocaMin??'', h.startTime||'', h.endTime||'',
        h.predicted??'', h.produced??'',
        (h.efficiency??'').toString().replace('.',','),
        h.status||'',
        formatSeconds(h.statusAccSec?.producao   || 0),
        formatSeconds(h.statusAccSec?.setup      || 0),
        formatSeconds(h.statusAccSec?.manutencao || 0),
        formatSeconds(h.pausaAccSec              || 0),
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
// RESET
// =========================================================
function resetAll() {
  if (!confirm('Resetar tudo e apagar dados?')) return;
  state.machines.forEach(m => {
    REF.child(m.id).set({
      id:m.id, operator:'', process:'', cycleMin:null, setupMin:0, trocaMin:null,
      observacao:'', startTime:'07:00', endTime:'16:45', produced:null, predicted:0,
      history:[], future:[], status:'producao', statusChangedAt:null,
      statusPaused:false, statusAccSec:{producao:0,setup:0,manutencao:0},
      pausaAccSec:0, pausaChangedAt:null
    });
  });
}

// =========================================================
// PESQUISA
// =========================================================
function filtrarCards(termo) {
  const q = termo.trim().toLowerCase();
  const cards = document.querySelectorAll('#machinesContainer > div');
  let visiveis = 0;
  cards.forEach((card, i) => {
    const m = state.machines[i];
    if (!m) return;
    const campos = [m.id, m.operator, m.process,
      ...(Array.isArray(m.future) ? m.future.map(f=>f.name) : [])
    ].join(' ').toLowerCase();
    const vis = !q || campos.includes(q);
    card.style.display = vis ? '' : 'none';
    if (vis) visiveis++;
  });
  const countEl = document.getElementById('searchCount');
  if (q) { countEl.textContent=`${visiveis} resultado${visiveis!==1?'s':''}`; countEl.classList.remove('hidden'); }
  else   { countEl.classList.add('hidden'); }
}

document.getElementById('exportAll').addEventListener('click', exportCSV);
document.getElementById('resetAll').addEventListener('click', resetAll);
document.getElementById('searchInput').addEventListener('input', e => filtrarCards(e.target.value));
