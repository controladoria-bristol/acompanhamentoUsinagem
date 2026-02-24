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

const db = firebase.database();
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

/** Formata segundos inteiros como H:MM:SS ou MM:SS */
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

 function toMinutes(timeStr) {
   const parts = timeStr.split(':').map(Number);
   if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / 60;
   if (parts.length === 2) return parts[0] * 60 + parts[1];
   if (parts.length === 1) return parts[0] * 60;
   return 0;
 }

 const start = toMinutes(startStr);
 const end = toMinutes(endStr);
 let diff = end - start;

 if (diff < 0) return 0;

 const lunchStart = toMinutes('12:00');
 const lunchEnd = toMinutes('13:00');

 if (end > lunchStart && start < lunchEnd) {
   const overlap = Math.min(end, lunchEnd) - Math.max(start, lunchStart);
   if (overlap > 0) diff -= overlap;
 }

 return Math.max(diff, 0);
}

/**
 * Calcula previsto usando:
 *   Tempo disponível = (fim - início) - intervalo almoço (12h-13h)
 *                    - tempo acumulado de Setup (cronômetro automático)
 *                    - tempo acumulado de Manutenção (cronômetro automático)
 *
 * O campo manual "Tempo de parada" (setupMin) foi substituído pelo cronômetro
 * automático de status. statusAccSec deve conter { setup: segundos, manutencao: segundos }.
 */
function calcularPrevisto(cycleMin, trocaMin, _setupMinLegado, startStr, endStr, statusAccSec) {
  // Converte segundos acumulados pelo cronômetro → minutos
  const paradaMin = ((statusAccSec?.setup || 0) + (statusAccSec?.manutencao || 0)) / 60;

  const totalDisponivel = Math.max(
    minutosDisponiveis(startStr, endStr) - paradaMin,
    0
  );

  if (!cycleMin || cycleMin <= 0 || totalDisponivel <= 0) return 0;

  const cicloTotal = cycleMin + (trocaMin || 0);
  if (cicloTotal <= 0) return 0;

  return Math.floor(totalDisponivel / cicloTotal);
}

// =========================================================
//  STATE
// =========================================================
let state = { machines: [] };

// Mapa de intervalos de cronômetro ativos: { machineId: intervalId }
const activeTimers = {};

function initDefaultMachines() {
 return MACHINE_NAMES.map(name => ({
   id: name,
   operator: '',
   process: '',
   cycleMin: null,
   setupMin: 0,
   trocaMin: null,
   observacao: '',
   startTime: '07:00',
   endTime: '16:45',
   produced: null,
   predicted: 0,
   history: [],
   future: [],
   // --- NOVOS CAMPOS DE STATUS ---
   status: 'producao',           // 'producao' | 'setup' | 'manutencao'
   statusChangedAt: null,        // timestamp ms em que o status atual começou
   statusAccSec: {               // segundos acumulados em cada status (persistido)
     producao: 0,
     setup: 0,
     manutencao: 0
   },
   statusPaused: false            // cronômetro pausado?
 }));
}

function ensureFutureArray(machine) {
 if (!machine) return;
 if (!Array.isArray(machine.future)) machine.future = [];
}

function ensureStatusFields(machine) {
  if (!machine.status) machine.status = 'producao';
  if (!machine.statusAccSec || typeof machine.statusAccSec !== 'object') {
    machine.statusAccSec = { producao: 0, setup: 0, manutencao: 0 };
  }
  if (!machine.statusAccSec.producao)   machine.statusAccSec.producao   = 0;
  if (!machine.statusAccSec.setup)      machine.statusAccSec.setup      = 0;
  if (!machine.statusAccSec.manutencao) machine.statusAccSec.manutencao = 0;
  if (machine.statusPaused === undefined) machine.statusPaused = false;
}

// =========================================================
//  CRONÔMETRO DE STATUS
// =========================================================

/**
 * Retorna os segundos acumulados "ao vivo" para um status,
 * somando o que já estava salvo + o tempo desde statusChangedAt (se for o status atual).
 */
function getLiveSeconds(m, statusKey) {
  const acc = m.statusAccSec[statusKey] || 0;
  // Se pausado, retorna só o acumulado (não soma tempo corrente)
  if (m.statusPaused) return acc;
  if (m.status === statusKey && m.statusChangedAt) {
    const extra = Math.floor((Date.now() - m.statusChangedAt) / 1000);
    return acc + extra;
  }
  return acc;
}

/**
 * Para o cronômetro de um card (limpa o interval).
 */
function stopTimer(machineId) {
  if (activeTimers[machineId]) {
    clearInterval(activeTimers[machineId]);
    delete activeTimers[machineId];
  }
}

/**
 * Inicia o cronômetro para um card, atualizando os chips de tempo a cada segundo.
 */
function startTimer(m, root, predictedEl, chart, atualizarGraficoFn) {
  stopTimer(m.id);

  const timeProducaoEl    = root.querySelector('[data-role="timeProducao"]');
  const timeSetupEl       = root.querySelector('[data-role="timeSetup"]');
  const timeManutencaoEl  = root.querySelector('[data-role="timeManutencao"]');
  const paradaAutoDisplay = root.querySelector('[data-role="paradaAutoDisplay"]');

  activeTimers[m.id] = setInterval(() => {
    const secSetup  = getLiveSeconds(m, 'setup');
    const secManut  = getLiveSeconds(m, 'manutencao');

    timeProducaoEl.textContent   = formatSeconds(getLiveSeconds(m, 'producao'));
    timeSetupEl.textContent      = formatSeconds(secSetup);
    timeManutencaoEl.textContent = formatSeconds(secManut);

    // Exibe o total de parada automática (Setup + Manutenção) no display do card
    if (paradaAutoDisplay) {
      paradaAutoDisplay.textContent = formatSeconds(secSetup + secManut);
    }

    // Recalcular previsto — parada automática substitui o campo manual
    const liveAccSec = { setup: secSetup, manutencao: secManut };
    const newPredicted = calcularPrevisto(m.cycleMin, m.trocaMin, null, m.startTime, m.endTime, liveAccSec);
    if (newPredicted !== m.predicted) {
      m.predicted = newPredicted;
      predictedEl.textContent = newPredicted;
      if (typeof atualizarGraficoFn === 'function') atualizarGraficoFn();
    }
  }, 1000);
}

// =========================================================
//  CONFIGURAÇÃO VISUAL DE STATUS
// =========================================================
const STATUS_CONFIG = {
  producao:   { label: '🟢 Produção',   badgeClass: 'status-badge-producao',   cardClass: 'card-status-producao'   },
  setup:      { label: '🟡 Setup',      badgeClass: 'status-badge-setup',      cardClass: 'card-status-setup'      },
  manutencao: { label: '🔴 Manutenção', badgeClass: 'status-badge-manutencao', cardClass: 'card-status-manutencao' }
};

function applyStatusVisual(root, status) {
  const cfg = STATUS_CONFIG[status];

  // Borda lateral do card
  root.classList.remove('card-status-producao', 'card-status-setup', 'card-status-manutencao');
  root.classList.add(cfg.cardClass);

  // Badge
  const badge = root.querySelector('[data-role="statusBadge"]');
  badge.className = `status-badge ${cfg.badgeClass}`;
  badge.textContent = cfg.label;

  // Chips — destaca o ativo
  root.querySelector('[data-role="btnProducao"]').classList.toggle('active-chip',   status === 'producao');
  root.querySelector('[data-role="btnSetup"]').classList.toggle('active-chip',      status === 'setup');
  root.querySelector('[data-role="btnManutencao"]').classList.toggle('active-chip', status === 'manutencao');
}

// =========================================================
//  RENDER
// =========================================================
function render() {
 // Parar todos os timers antes de re-renderizar
 Object.keys(activeTimers).forEach(id => stopTimer(id));

 const container = document.getElementById('machinesContainer');
 container.innerHTML = '';

 state.machines.forEach(m => {
   ensureFutureArray(m);
   ensureStatusFields(m);

   const tpl = document.getElementById('machine-template');
   const node = tpl.content.cloneNode(true);
   const root = node.querySelector('div');

   // Adiciona ao DOM imediatamente para que querySelector funcione corretamente
   container.appendChild(root);

   // ---- Referências DOM ----
   const title          = root.querySelector('[data-role="title"]');
   const subtitle       = root.querySelector('[data-role="subtitle"]');
   const operatorInput  = root.querySelector('[data-role="operator"]');
   const processInput   = root.querySelector('[data-role="process"]');
   const cycleInput     = root.querySelector('[data-role="cycle"]');
   const trocaInput     = root.querySelector('[data-role="troca"]');
   const paradaAutoDisplay = root.querySelector('[data-role="paradaAutoDisplay"]');
   const observacaoInput= root.querySelector('[data-role="observacao"]');
   const startInput     = root.querySelector('[data-role="startTime"]');
   const endInput       = root.querySelector('[data-role="endTime"]');
   const producedInput  = root.querySelector('[data-role="produced"]');
   const saveBtn        = root.querySelector('[data-role="save"]');
   const addHistBtn     = root.querySelector('[data-role="addHistory"]');
   const clearHistBtn   = root.querySelector('[data-role="clearHistory"]');
   const predictedEl    = root.querySelector('[data-role="predicted"]');
   const historyEl      = root.querySelector('[data-role="history"]');
   const performanceEl  = root.querySelector('[data-role="performance"]');
   const futureInput    = root.querySelector('[data-role="futureInput"]');
   const addFutureBtn   = root.querySelector('[data-role="addFuture"]');
   const futureList     = root.querySelector('[data-role="futureList"]');
   const prioritySelect = root.querySelector('[data-role="prioritySelect"]');
   const sortFutureBtn  = root.querySelector('[data-role="sortFuture"]');

   // Botões de status
   const btnProducao   = root.querySelector('[data-role="btnProducao"]');
   const btnSetup      = root.querySelector('[data-role="btnSetup"]');
   const btnManutencao = root.querySelector('[data-role="btnManutencao"]');
   const btnPausar     = root.querySelector('[data-role="btnPausar"]');
   const btnZerar      = root.querySelector('[data-role="btnZerar"]');

   // Chips de tempo (spans dentro dos botões de status)
   const timeProducaoEl   = root.querySelector('[data-role="timeProducao"]');
   const timeSetupEl      = root.querySelector('[data-role="timeSetup"]');
   const timeManutencaoEl = root.querySelector('[data-role="timeManutencao"]');

   // ---- Preencher dados ----
   title.textContent = m.id;
   subtitle.textContent = `Operador: ${m.operator||'-'} · Ciclo: ${m.cycleMin!=null?formatMinutesToMMSS(m.cycleMin):'-'} · Peça: ${m.process||'-'}`;

   operatorInput.value  = m.operator;
   processInput.value   = m.process;
   cycleInput.value     = m.cycleMin != null ? formatMinutesToMMSS(m.cycleMin) : '';
   trocaInput.value     = m.trocaMin != null ? formatMinutesToMMSS(m.trocaMin) : '';
   observacaoInput.value= m.observacao || '';
   startInput.value     = m.startTime;
   endInput.value       = m.endTime;
   producedInput.value  = m.produced != null ? m.produced : '';
   predictedEl.textContent = m.predicted ?? 0;

   // Chips iniciais
   timeProducaoEl.textContent   = formatSeconds(getLiveSeconds(m, 'producao'));
   timeSetupEl.textContent      = formatSeconds(getLiveSeconds(m, 'setup'));
   timeManutencaoEl.textContent = formatSeconds(getLiveSeconds(m, 'manutencao'));

   // Visual de status
   applyStatusVisual(root, m.status);

   // ---- Gráfico ----
   const ctx = root.querySelector('[data-role="chart"]').getContext('2d');
   const chart = new Chart(ctx, {
     type: 'bar',
     data: {
       labels: ['Previsto', 'Realizado'],
       datasets: [{
         label: m.id,
         data: [m.predicted || 0, m.produced || 0],
         backgroundColor: ['rgba(0,200,0,0.4)', 'rgba(255,255,255,0.2)']
       }]
     },
     options: {
       scales: { y: { beginAtZero: true } },
       plugins: { legend: { display: false } }
     }
   });

   function atualizarGrafico() {
     const predicted = m.predicted || 0;
     const produced  = (m.produced != null && m.produced !== '') ? Number(m.produced) : 0;
     const ratio     = predicted > 0 ? (produced / predicted) * 100 : 0;

     let color = 'rgba(255,255,255,0.3)', txtColor = 'text-gray-400';
     if      (ratio < 50) { color = 'rgba(255,0,0,0.6)';   txtColor = 'text-red-500';    }
     else if (ratio < 80) { color = 'rgba(255,255,0,0.6)'; txtColor = 'text-yellow-400'; }
     else                 { color = 'rgba(0,255,0,0.6)';   txtColor = 'text-green-400';  }

     chart.data.datasets[0].data            = [predicted, produced];
     chart.data.datasets[0].backgroundColor = ['rgba(0,200,0,0.4)', color];
     chart.update();

     performanceEl.className   = `text-center text-sm font-semibold mt-1 ${txtColor}`;
     performanceEl.textContent = `Desempenho: ${ratio.toFixed(1)}%`;
   }

   // ---- Iniciar cronômetro ----
   startTimer(m, root, predictedEl, chart, atualizarGrafico);

   // ---- Mudança de status ----
   function mudarStatus(novoStatus) {
     if (m.status === novoStatus) return;

     const agora = Date.now();

     // Acumula o tempo do status atual antes de trocar
     if (m.statusChangedAt) {
       const segundosExtras = Math.floor((agora - m.statusChangedAt) / 1000);
       m.statusAccSec[m.status] = (m.statusAccSec[m.status] || 0) + segundosExtras;
     }

     m.status          = novoStatus;
     m.statusChangedAt = agora;

     applyStatusVisual(root, novoStatus);
     salvarFirebase();
     notificar('Status Alterado', `${m.id} agora está em: ${STATUS_CONFIG[novoStatus].label}`);
   }

   btnProducao.addEventListener('click',   () => mudarStatus('producao'));
   btnSetup.addEventListener('click',      () => mudarStatus('setup'));
   btnManutencao.addEventListener('click', () => mudarStatus('manutencao'));

   // ---- Pausar ----
   function atualizarBtnPausar() {
     if (m.statusPaused) {
       btnPausar.textContent = '▶ Retomar';
       btnPausar.classList.replace('bg-gray-600', 'bg-yellow-600');
     } else {
       btnPausar.textContent = '⏸ Pausar';
       btnPausar.classList.replace('bg-yellow-600', 'bg-gray-600');
     }
   }

   btnPausar.addEventListener('click', () => {
     const agora = Date.now();
     if (!m.statusPaused) {
       // Pausar: congela acumulando o tempo corrente no statusAccSec antes de parar
       if (m.statusChangedAt) {
         const extra = Math.floor((agora - m.statusChangedAt) / 1000);
         m.statusAccSec[m.status] = (m.statusAccSec[m.status] || 0) + extra;
       }
       m.statusChangedAt = null;
       m.statusPaused = true;
     } else {
       // Retomar: reinicia a contagem a partir de agora
       m.statusChangedAt = agora;
       m.statusPaused = false;
     }
     atualizarBtnPausar();
     salvarFirebase();
   });

   // ---- Zerar (troca de peça) ----
   btnZerar.addEventListener('click', () => {
     if (!confirm(`Zerar todos os tempos de ${m.id}? (Use ao trocar de peça)`)) return;
     // Reseta tempos acumulados e estado do cronômetro
     m.statusAccSec  = { producao: 0, setup: 0, manutencao: 0 };
     m.statusChangedAt = m.statusPaused ? null : Date.now();
     m.statusPaused  = false;
     atualizarBtnPausar();
     salvarFirebase();
   });

   atualizarBtnPausar();

   // ---- Histórico ----
   function renderHistory() {
     historyEl.innerHTML = '';
     if (!m.history || m.history.length === 0) {
       historyEl.innerHTML = '<div class="text-gray-400">Histórico vazio</div>';
       return;
     }
     m.history.slice().reverse().forEach(h => {
       const div = document.createElement('div');
       div.className = 'mb-1 border-b border-gray-800 pb-1';
       const ts = new Date(h.ts).toLocaleString();

       // Formata tempos de status do histórico
       const accProd  = formatSeconds(h.statusAccSec?.producao   || 0);
       const accSetup = formatSeconds(h.statusAccSec?.setup      || 0);
       const accManut = formatSeconds(h.statusAccSec?.manutencao || 0);

       div.innerHTML = `
         <div class="text-xs text-gray-300">${ts}</div>
         <div class="text-sm">Operador: <strong>${h.operator}</strong> · Peça: <strong>${h.process}</strong></div>
         <div class="text-xs text-gray-400">Previsto: ${h.predicted} · Realizado: ${h.produced ?? '-'} · Eficiência: ${h.efficiency ?? '-'}%</div>
         <div class="text-xs mt-0.5 flex gap-2">
           <span class="status-time-chip chip-producao">🟢 ${accProd}</span>
           <span class="status-time-chip chip-setup">🟡 ${accSetup}</span>
           <span class="status-time-chip chip-manutencao">🔴 ${accManut}</span>
         </div>
         ${h.observacao ? `<div class='text-xs text-sky-300'>Obs.: ${h.observacao}</div>` : ''}
       `;
       historyEl.appendChild(div);
     });
   }

   // ---- Firebase ----
   function salvarFirebase() {
     REF.child(m.id).set(m);
   }

   function salvarFutureAndSync(machine) {
     ensureFutureArray(machine);
     REF.child(machine.id).set(machine);
   }

   // ---- Futuros ----
   function renderFuture() {
     futureList.innerHTML = '';
     ensureFutureArray(m);

     if (m.future.length === 0) {
       futureList.innerHTML = '<div class="text-gray-400">Nenhum processo futuro</div>';
       return;
     }

     m.future.forEach((f, i) => {
       const div = document.createElement('div');
       div.className = `rounded px-2 py-1 flex justify-between items-center cursor-move prioridade-${f.priority}`;

       const badge = document.createElement('div');
       badge.className = 'wait-badge';
       badge.textContent = String(i + 1);

       const left = document.createElement('div');
       left.className = 'flex items-center gap-2 flex-1';

       const input = document.createElement('input');
       input.value = f.name;
       input.className = 'bg-transparent flex-1 mr-2 outline-none text-black font-bold';
       input.addEventListener('input', () => { f.name = input.value; });
       input.addEventListener('blur',  () => { salvarFutureAndSync(m); });

       const select = document.createElement('select');
       select.className = 'bg-gray-200 text-black text-sm rounded px-1 font-bold';
       [['vermelho','🔴 Urgente'],['amarelo','🟡 Alta'],['verde','🟢 Normal']].forEach(([p,label]) => {
         const opt = document.createElement('option');
         opt.value = p; opt.textContent = label;
         if (p === f.priority) opt.selected = true;
         select.appendChild(opt);
       });
       select.addEventListener('change', () => { f.priority = select.value; salvarFutureAndSync(m); renderFuture(); });

       const delBtn = document.createElement('button');
       delBtn.className = 'ml-2 text-black font-bold';
       delBtn.textContent = '✖';
       delBtn.addEventListener('click', () => { m.future.splice(i, 1); salvarFutureAndSync(m); renderFuture(); });

       left.appendChild(badge);
       left.appendChild(input);
       div.appendChild(left);
       div.appendChild(select);
       div.appendChild(delBtn);
       futureList.appendChild(div);
     });

     Sortable.create(futureList, {
       animation: 150,
       onEnd(evt) {
         const item = m.future.splice(evt.oldIndex, 1)[0];
         m.future.splice(evt.newIndex, 0, item);
         salvarFutureAndSync(m);
         renderFuture();
       }
     });
   }

   // ---- Salvar ----
   saveBtn.addEventListener('click', () => {
     const cycleVal    = parseTempoMinutos(cycleInput.value.trim());
     const trocaVal    = parseTempoMinutos(trocaInput.value.trim());
     const startVal    = startInput.value || '07:00';
     const endVal      = endInput.value   || '16:45';
     const producedVal = producedInput.value.trim() === '' ? null : Number(producedInput.value.trim());

     // Calcula previsto — parada automática vem do cronômetro de status
     const liveAccSec = {
       setup:      getLiveSeconds(m, 'setup'),
       manutencao: getLiveSeconds(m, 'manutencao')
     };
     const pred = calcularPrevisto(cycleVal, trocaVal, null, startVal, endVal, liveAccSec);

     m.operator  = operatorInput.value.trim();
     m.process   = processInput.value.trim();
     m.cycleMin  = cycleInput.value.trim() === '' ? null : cycleVal;
     m.trocaMin  = trocaInput.value.trim() === '' ? null : trocaVal;
     m.observacao= observacaoInput.value;
     m.startTime = startVal;
     m.endTime   = endVal;
     m.produced  = producedVal;
     m.predicted = pred;

     predictedEl.textContent = pred;
     subtitle.textContent = `Operador: ${m.operator||'-'} · Ciclo: ${m.cycleMin!=null?formatMinutesToMMSS(m.cycleMin):'-'} · Peça: ${m.process||'-'}`;

     salvarFirebase();
     atualizarGrafico();
     notificar('Dashboard Atualizado!', 'Maquina ' + m.id + ' teve novos dados salvos.');
   });

   // ---- Adicionar ao histórico ----
   addHistBtn.addEventListener('click', () => {
     const cycleVal    = parseTempoMinutos(cycleInput.value.trim());
     const trocaVal    = parseTempoMinutos(trocaInput.value.trim());
     const startVal    = startInput.value || '07:00';
     const endVal      = endInput.value   || '16:45';
     const producedVal = producedInput.value.trim() === '' ? null : Number(producedInput.value.trim());

     const liveAccSec = {
       setup:      getLiveSeconds(m, 'setup'),
       manutencao: getLiveSeconds(m, 'manutencao')
     };
     const predicted = calcularPrevisto(cycleVal, trocaVal, null, startVal, endVal, liveAccSec);
     const efficiency = (predicted > 0 && producedVal != null)
       ? ((producedVal / predicted) * 100).toFixed(1) : '-';

     // Snapshot dos tempos acumulados ao vivo no momento do registro
     const snapshotAccSec = {
       producao:   getLiveSeconds(m, 'producao'),
       setup:      getLiveSeconds(m, 'setup'),
       manutencao: getLiveSeconds(m, 'manutencao')
     };

     const entry = {
       ts: Date.now(),
       operator:    operatorInput.value.trim() || '-',
       process:     processInput.value.trim()  || '-',
       cycleMin:    cycleVal,
       setupMin:    0, // parada gerenciada pelo cronômetro de status
       trocaMin:    trocaInput.value.trim() === '' ? null : trocaVal,
       startTime:   startVal,
       endTime:     endVal,
       produced:    producedVal,
       predicted,
       efficiency,
       observacao:  observacaoInput.value,
       status:      m.status,
       statusAccSec: snapshotAccSec
     };

     m.history.push(entry);
     renderHistory();
     salvarFirebase();
     notificar('Histórico Atualizado!', 'Novo registro adicionado na maquina ' + m.id + '.');
   });

   // ---- Limpar histórico ----
   clearHistBtn.addEventListener('click', () => {
     if (!confirm(`Limpar histórico de ${m.id}?`)) return;
     m.history = [];
     renderHistory();
     salvarFirebase();
   });

   // ---- Futuros ----
   addFutureBtn.addEventListener('click', () => {
     const nome      = futureInput.value.trim();
     const prioridade = prioritySelect.value;
     if (!nome) return alert('Digite o nome do processo futuro.');
     m.future.push({ name: nome, priority: prioridade });
     futureInput.value = '';
     salvarFutureAndSync(m);
     renderFuture();
   });

   sortFutureBtn.addEventListener('click', () => {
     const ordem = { vermelho: 1, amarelo: 2, verde: 3 };
     m.future.sort((a, b) => ordem[a.priority] - ordem[b.priority]);
     salvarFutureAndSync(m);
     renderFuture();
   });

   renderHistory();
   renderFuture();
   atualizarGrafico();
 });

  // Reaplica o filtro de pesquisa após re-renderizar
  const searchInput = document.getElementById('searchInput');
  if (searchInput && searchInput.value) filtrarCards(searchInput.value);
}

// =========================================================
// FIREBASE LISTENER
// =========================================================
REF.on('value', snapshot => {
 const data = snapshot.val();

 if (!data) {
   state.machines = initDefaultMachines();
   state.machines.forEach(m => REF.child(m.id).set(m));
 } else {
   state.machines = MACHINE_NAMES.map(name => {
     const raw = data[name] || {};
     return {
       id:        name,
       operator:  raw.operator  || '',
       process:   raw.process   || '',
       cycleMin:  raw.cycleMin  ?? null,
       setupMin:  raw.setupMin  ?? 0,
       trocaMin:  raw.trocaMin  ?? null,
       observacao:raw.observacao?? '',
       startTime: raw.startTime || '07:00',
       endTime:   raw.endTime   || '16:45',
       produced:  raw.produced  ?? null,
       predicted: raw.predicted ?? 0,
       history:   Array.isArray(raw.history) ? raw.history : [],
       future:    Array.isArray(raw.future)  ? raw.future  : [],
       // Status
       status:          raw.status          || 'producao',
       statusChangedAt: raw.statusChangedAt || null,
       statusPaused: raw.statusPaused || false,
       statusAccSec: {
         producao:   raw.statusAccSec?.producao   || 0,
         setup:      raw.statusAccSec?.setup      || 0,
         manutencao: raw.statusAccSec?.manutencao || 0
       }
     };
   });
 }

 render();
});

// =========================================================
// EXPORTAÇÃO CSV (RESUMO + HISTÓRICO)
// =========================================================
function exportCSV() {
 const hoje         = new Date();
 const dataFormatada= hoje.toLocaleDateString('pt-BR');
 const horaFormatada= hoje.toLocaleTimeString('pt-BR');
 const dataArquivo  = dataFormatada.replace(/\//g, '-');

 // CSV 1 - RESUMO
 const resumoLines = [
   'Data;Hora;Máquina;Operador;Processo;Ciclo (min);Troca (min);Parada (min);Início;Fim;Previsto;Realizado;Eficiência (%);Status;T.Produção;T.Setup;T.Manutenção;Observação;Processos Futuros'
 ];

 state.machines.forEach(m => {
   let eficiencia = '';
   if (m.predicted && m.produced != null)
     eficiencia = ((m.produced / m.predicted) * 100).toFixed(1).replace('.', ',');

   const futuros = (Array.isArray(m.future) ? m.future : [])
     .map((f, idx) => `${idx+1}. ${f.name} [${f.priority}]`).join(' | ').replace(/;/g, ',');

   resumoLines.push([
     dataFormatada, horaFormatada,
     (m.id        || '').replace(/;/g, ','),
     (m.operator  || '').replace(/;/g, ','),
     (m.process   || '').replace(/;/g, ','),
     m.cycleMin ?? '', m.trocaMin ?? '', m.setupMin ?? '',
     m.startTime || '', m.endTime || '',
     m.predicted ?? 0, m.produced ?? '', eficiencia,
     m.status || '',
     formatSeconds(getLiveSeconds(m, 'producao')),
     formatSeconds(getLiveSeconds(m, 'setup')),
     formatSeconds(getLiveSeconds(m, 'manutencao')),
     (m.observacao|| '').replace(/;/g, ','),
     futuros
   ].join(';'));
 });

 baixarCSV('\uFEFF' + resumoLines.join('\n'), `producao_resumo_${dataArquivo}.csv`);

 // CSV 2 - HISTÓRICO
 const historicoLines = [
   'Data Registro;Hora Registro;Máquina;Operador;Processo;Ciclo (min);Troca (min);Parada (min);Início;Fim;Previsto;Realizado;Eficiência (%);Status;T.Produção;T.Setup;T.Manutenção;Observação'
 ];

 state.machines.forEach(m => {
   (m.history || []).forEach(h => {
     const d = new Date(h.ts);
     historicoLines.push([
       d.toLocaleDateString('pt-BR'), d.toLocaleTimeString('pt-BR'),
       (m.id        || '').replace(/;/g, ','),
       (h.operator  || '').replace(/;/g, ','),
       (h.process   || '').replace(/;/g, ','),
       h.cycleMin ?? '', h.trocaMin ?? '', h.setupMin ?? '',
       h.startTime || '', h.endTime || '',
       h.predicted ?? '', h.produced ?? '',
       (h.efficiency ?? '').toString().replace('.', ','),
       h.status || '',
       formatSeconds(h.statusAccSec?.producao   || 0),
       formatSeconds(h.statusAccSec?.setup      || 0),
       formatSeconds(h.statusAccSec?.manutencao || 0),
       (h.observacao|| '').replace(/;/g, ',')
     ].join(';'));
   });
 });

 baixarCSV('\uFEFF' + historicoLines.join('\n'), `producao_historico_${dataArquivo}.csv`);
}

function baixarCSV(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// =========================================================
// RESET
// =========================================================
function resetAll() {
 if (!confirm('Resetar tudo e apagar dados?')) return;
 state.machines.forEach(m => {
   REF.child(m.id).set({
     id: m.id, operator: '', process: '', cycleMin: null, setupMin: 0,
     trocaMin: null, observacao: '', startTime: '07:00', endTime: '16:45',
     produced: null, predicted: 0, history: [], future: [],
     status: 'producao', statusChangedAt: null,
     statusAccSec: { producao: 0, setup: 0, manutencao: 0 }
   });
 });
}

document.getElementById('exportAll').addEventListener('click', exportCSV);
document.getElementById('resetAll').addEventListener('click', resetAll);

// =========================================================
// PESQUISA EM TEMPO REAL
// =========================================================
function filtrarCards(termo) {
  const q = termo.trim().toLowerCase();
  const cards = document.querySelectorAll('#machinesContainer > div');
  let visiveis = 0;

  cards.forEach((card, i) => {
    const m = state.machines[i];
    if (!m) return;

    const campos = [
      m.id,
      m.operator,
      m.process,
      // futuros também entram na busca
      ...(Array.isArray(m.future) ? m.future.map(f => f.name) : [])
    ].join(' ').toLowerCase();

    const visivel = !q || campos.includes(q);
    card.style.display = visivel ? '' : 'none';
    if (visivel) visiveis++;
  });

  // Contador de resultados
  const countEl = document.getElementById('searchCount');
  if (q) {
    countEl.textContent = `${visiveis} resultado${visiveis !== 1 ? 's' : ''}`;
    countEl.classList.remove('hidden');
  } else {
    countEl.classList.add('hidden');
  }
}

document.getElementById('searchInput').addEventListener('input', e => {
  filtrarCards(e.target.value);
});
