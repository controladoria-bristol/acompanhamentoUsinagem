// =============================
//  CONFIGURAÇÕES INICIAIS E FIREBASE
// =============================

const MACHINE_NAMES = [
 'Fresa CNC 1','Fresa CNC 2','Fresa CNC 3','Robodrill 2','D 800-1','Fagor',
 'Robodrill 1','VTC','D 800-2','D 800-3','Centur','Nardine','GL 280',
 '15S','E 280','G 240','Galaxy 10A','Galaxy 10B','GL 170G','GL 250','GL 350','GL 450','Torno Convencional'
];

// =============================
// FIREBASE NOVO
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

// ==========================================================
// FUNÇÃO DE NOTIFICAÇÃO — SEM CRASE E SEM ERRO
// ==========================================================
function notificar(titulo, mensagem) {
  if (!("Notification" in window)) {
    console.log("Navegador não suporta notificações.");
    return;
  }

  if (Notification.permission === "granted") {
    new Notification(titulo, {
      body: mensagem,
      icon: "https://cdn-icons-png.flaticon.com/512/1827/1827272.png"
    });
  }
}
// =========================================================
//  FUNÇÕES DE TEMPO E CÁLCULO DE PRODUÇÃO
// =========================================================

function parseTempoMinutos(str) {
 if (!str) return 0;
 const s = String(str).trim();
 if (s.includes(':')) {
   const parts = s.split(':').map(Number);
   if (parts.length === 3) {
     return parts[0] * 60 + parts[1] + parts[2] / 60;
   }
   if (parts.length === 2) {
     return parts[0] + parts[1] / 60;
   }
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

// 🔧 TROCA POR CICLO
function calcularPrevisto(cycleMin, trocaMin, setupMin, startStr, endStr) {
 const totalDisponivel = Math.max(
   minutosDisponiveis(startStr, endStr) - (setupMin || 0),
   0
 );

 if (!cycleMin || cycleMin <= 0 || totalDisponivel <= 0) return 0;

 const cicloTotal = cycleMin + (trocaMin || 0);
 if (cicloTotal <= 0) return 0;

 return Math.floor(totalDisponivel / cicloTotal);
}

// Estado global
let state = { machines: [] };

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
   future: []
 }));
}

function ensureFutureArray(machine) {
 if (!machine) return;
 if (!Array.isArray(machine.future)) machine.future = [];
}
// =========================================================
//  FUNÇÃO PRINCIPAL DE RENDERIZAÇÃO DO DASHBOARD
// =========================================================

function render() {
 const container = document.getElementById('machinesContainer');
 container.innerHTML = '';

 state.machines.forEach(m => {
   ensureFutureArray(m);

   const tpl = document.getElementById('machine-template');
   const node = tpl.content.cloneNode(true);
   const root = node.querySelector('div');

   const title = node.querySelector('[data-role="title"]');
   const subtitle = node.querySelector('[data-role="subtitle"]');

   const operatorInput = node.querySelector('[data-role="operator"]');
   const processInput = node.querySelector('[data-role="process"]');
   const cycleInput = node.querySelector('[data-role="cycle"]');
   const trocaInput = node.querySelector('[data-role="troca"]');
   const setupInput = node.querySelector('[data-role="setup"]');
   const observacaoInput = node.querySelector('[data-role="observacao"]');
   const startInput = node.querySelector('[data-role="startTime"]');
   const endInput = node.querySelector('[data-role="endTime"]');
   const producedInput = node.querySelector('[data-role="produced"]');

   const saveBtn = node.querySelector('[data-role="save"]');
   const addHistBtn = node.querySelector('[data-role="addHistory"]');
   const clearHistBtn = node.querySelector('[data-role="clearHistory"]');

   const predictedEl = node.querySelector('[data-role="predicted"]');
   const historyEl = node.querySelector('[data-role="history"]');
   const performanceEl = node.querySelector('[data-role="performance"]');

   const futureInput = node.querySelector('[data-role="futureInput"]');
   const addFutureBtn = node.querySelector('[data-role="addFuture"]');
   const futureList = node.querySelector('[data-role="futureList"]');
   const prioritySelect = node.querySelector('[data-role="prioritySelect"]');
   const sortFutureBtn = node.querySelector('[data-role="sortFuture"]');

   // -------------------------------
   // Preenche dados
   // -------------------------------

   title.textContent = m.id;
   subtitle.textContent = `Operador: ${m.operator||'-'} · Ciclo: ${m.cycleMin!=null?formatMinutesToMMSS(m.cycleMin):'-'} · Peça: ${m.process||'-'}`;

   operatorInput.value = m.operator;
   processInput.value = m.process;

   cycleInput.value = m.cycleMin!=null?formatMinutesToMMSS(m.cycleMin):'';
   trocaInput.value = m.trocaMin!=null?formatMinutesToMMSS(m.trocaMin):'';
   setupInput.value = m.setupMin!=null?formatMinutesToMMSS(m.setupMin):'';

   observacaoInput.value = m.observacao || '';

   startInput.value = m.startTime;
   endInput.value = m.endTime;

   producedInput.value = m.produced!=null?m.produced:'';
   predictedEl.textContent = m.predicted ?? 0;

   container.appendChild(root);

   // --------------------------------
   // GRÁFICO
   // --------------------------------

   const ctx = root.querySelector('[data-role="chart"]').getContext('2d');
   const chart = new Chart(ctx, {
     type:'bar',
     data:{
       labels:['Previsto','Realizado'],
       datasets:[{
         label:m.id,
         data:[m.predicted||0, m.produced||0],
         backgroundColor:['rgba(0,200,0,0.4)','rgba(255,255,255,0.2)']
       }]
     },
     options:{
       scales:{ y:{ beginAtZero:true } },
       plugins:{ legend:{ display:false } }
     }
   });

   function atualizarGrafico() {
     const predicted = m.predicted || 0;
     const produced = (m.produced!=null && m.produced!=='') ? Number(m.produced) : 0;
     const ratio = (predicted > 0) ? (produced / predicted) * 100 : 0;

     let color = 'rgba(255,255,255,0.3)', txtColor='text-gray-400';

     if (ratio < 50) { color='rgba(255,0,0,0.6)'; txtColor='text-red-500'; }
     else if (ratio < 80) { color='rgba(255,255,0,0.6)'; txtColor='text-yellow-400'; }
     else { color='rgba(0,255,0,0.6)'; txtColor='text-green-400'; }

     chart.data.datasets[0].data = [predicted, produced];
     chart.data.datasets[0].backgroundColor = ['rgba(0,200,0,0.4)', color];
     chart.update();

     performanceEl.className = `text-center text-sm font-semibold mt-1 ${txtColor}`;
     performanceEl.textContent = `Desempenho: ${ratio.toFixed(1)}%`;
   }

   // -------------------------------
   // Histórico
   // -------------------------------

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

       div.innerHTML = `
         <div class="text-xs text-gray-300">${ts}</div>
         <div class="text-sm">Operador: <strong>${h.operator}</strong> · Peça: <strong>${h.process}</strong></div>
         <div class="text-xs text-gray-400">Previsto: ${h.predicted} · Realizado: ${h.produced ?? '-'} · Eficiência: ${h.efficiency ?? '-'}%</div>
         ${h.observacao ? `<div class='text-xs text-sky-300'>Obs.: ${h.observacao}</div>` : ''}
       `;

       historyEl.appendChild(div);
     });
   }
   // ------------------------------------
   // Lista de Espera / Processos Futuros
   // ------------------------------------

   function salvarFirebase() {
     REF.child(m.id).set(m);
   }

   function salvarFutureAndSync(machine) {
     ensureFutureArray(machine);
     REF.child(machine.id).set(machine);
   }

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

       // Bolinha com numeração
       const badge = document.createElement('div');
       badge.className = 'wait-badge';

       if (f.priority === 'vermelho') {
         badge.style.backgroundColor = '#dc2626';
         badge.style.color = '#000';
       } else if (f.priority === 'amarelo') {
         badge.style.backgroundColor = '#eab308';
         badge.style.color = '#000';
       } else {
         badge.style.backgroundColor = '#16a34a';
         badge.style.color = '#000';
       }

       badge.textContent = String(i + 1);

       // Área esquerda
       const left = document.createElement('div');
       left.className = 'flex items-center gap-2 flex-1';

       const input = document.createElement('input');
       input.value = f.name;
       input.className = 'bg-transparent flex-1 mr-2 outline-none text-black font-bold';

       input.addEventListener('input', () => {
         f.name = input.value;
       });

       input.addEventListener('blur', () => {
         salvarFutureAndSync(m);
       });

       const select = document.createElement('select');
       select.className = 'bg-gray-200 text-black text-sm rounded px-1 font-bold';

       [['vermelho','🔴 Urgente'], ['amarelo','🟡 Alta'], ['verde','🟢 Normal']].forEach(([p,label]) => {
         const opt = document.createElement('option');
         opt.value = p;
         opt.textContent = label;
         if (p === f.priority) opt.selected = true;
         select.appendChild(opt);
       });

       select.addEventListener('change', () => {
         f.priority = select.value;
         salvarFutureAndSync(m);
         renderFuture();
       });

       const delBtn = document.createElement('button');
       delBtn.className = 'ml-2 text-black font-bold';
       delBtn.textContent = '✖';

       delBtn.addEventListener('click', () => {
         m.future.splice(i, 1);
         salvarFutureAndSync(m);
         renderFuture();
       });

       left.appendChild(badge);
       left.appendChild(input);
       div.appendChild(left);
       div.appendChild(select);
       div.appendChild(delBtn);

       futureList.appendChild(div);
     });

     // Sortable arrasta-e-solta
     Sortable.create(futureList, {
       animation: 150,
       onEnd: function(evt) {
         const item = m.future.splice(evt.oldIndex, 1)[0];
         m.future.splice(evt.newIndex, 0, item);
         salvarFutureAndSync(m);
         renderFuture();
       }
     });
   }

   // =========================================
   // BOTÕES: Salvar, Histórico, Reset etc.
   // =========================================

   saveBtn.addEventListener('click', () => {
     const cycleVal = parseTempoMinutos(cycleInput.value.trim());
     const setupVal = parseTempoMinutos(setupInput.value.trim());
     const trocaVal = parseTempoMinutos(trocaInput.value.trim());

     const startVal = startInput.value || '07:00';
     const endVal = endInput.value || '16:45';

     const producedVal =
       producedInput.value.trim() === '' ? null : Number(producedInput.value.trim());

     const pred = calcularPrevisto(cycleVal, trocaVal, setupVal, startVal, endVal);

     m.operator = operatorInput.value.trim();
     m.process = processInput.value.trim();
     m.cycleMin = (cycleInput.value.trim() === '') ? null : cycleVal;
     m.setupMin = setupVal || 0;
     m.trocaMin = (trocaInput.value.trim() === '') ? null : trocaVal;

     m.observacao = observacaoInput.value;
     m.startTime = startVal;
     m.endTime = endVal;
     m.produced = producedVal;
     m.predicted = pred;

     predictedEl.textContent = pred;

     subtitle.textContent =
       `Operador: ${m.operator || '-'} · Ciclo: ${m.cycleMin != null ? formatMinutesToMMSS(m.cycleMin) : '-'} · Peça: ${m.process || '-'}`;

     salvarFirebase();
     atualizarGrafico();
     notificar("Dashboard Atualizado!", "Maquina " + m.id + " teve novos dados salvos.");

   });

   addHistBtn.addEventListener('click', () => {
     const cycleVal = parseTempoMinutos(cycleInput.value.trim());
     const setupVal = parseTempoMinutos(setupInput.value.trim());
     const trocaVal = parseTempoMinutos(trocaInput.value.trim());

     const startVal = startInput.value || '07:00';
     const endVal = endInput.value || '16:45';

     const producedVal =
       producedInput.value.trim() === '' ? null : Number(producedInput.value.trim());

     const predicted = calcularPrevisto(cycleVal, trocaVal, setupVal, startVal, endVal);
     const efficiency = (predicted > 0 && producedVal != null)
       ? ((producedVal / predicted) * 100).toFixed(1)
       : '-';

     const entry = {
       ts: Date.now(),
       operator: operatorInput.value.trim() || '-',
       process: processInput.value.trim() || '-',
       cycleMin: cycleVal,
       setupMin: setupVal,
       trocaMin: (trocaInput.value.trim() === '' ? null : trocaVal),
       startTime: startVal,
       endTime: endVal,
       produced: producedVal,
       predicted,
       efficiency,
       observacao: observacaoInput.value
     };

     m.history.push(entry);
     renderHistory();
     salvarFirebase();
     notificar("Histórico Atualizado!", "Novo registro adicionado na maquina " + m.id + ".");

   });

   clearHistBtn.addEventListener('click', () => {
     if (!confirm(`Limpar histórico de ${m.id}?`)) return;
     m.history = [];
     renderHistory();
     salvarFirebase();
   });

   addFutureBtn.addEventListener('click', () => {
     const nome = futureInput.value.trim();
     const prioridade = prioritySelect.value;

     if (!nome) return alert('Digite o nome do processo futuro.');

     ensureFutureArray(m);

     m.future.push({
       name: nome,
       priority: prioridade
     });

     futureInput.value = '';
     salvarFutureAndSync(m);
     renderFuture();
   });

   sortFutureBtn.addEventListener('click', () => {
     ensureFutureArray(m);

     const ordem = { vermelho: 1, amarelo: 2, verde: 3 };

     m.future.sort((a, b) => ordem[a.priority] - ordem[b.priority]);

     salvarFutureAndSync(m);
     renderFuture();
   });

   // Renderizações iniciais
   renderHistory();
   renderFuture();
   atualizarGrafico();
 });
}
// =========================================================
//  LISTENER DO FIREBASE — CARREGA TUDO EM TEMPO REAL
// =========================================================

REF.on('value', snapshot => {
 const data = snapshot.val();

 if (!data) {
   // Se não existir nada no banco, cria tudo zerado
   state.machines = initDefaultMachines();
   state.machines.forEach(m => REF.child(m.id).set(m));
 } else {
   // Reconstrói o estado com base no Firebase
   state.machines = MACHINE_NAMES.map(name => {
     const raw = data[name] || {};

     if (!Array.isArray(raw.future)) raw.future = [];
     if (!Array.isArray(raw.history)) raw.history = [];

     return {
       id: name,
       operator: raw.operator || '',
       process: raw.process || '',
       cycleMin: (raw.cycleMin !== undefined && raw.cycleMin !== null) ? raw.cycleMin : null,
       setupMin: (raw.setupMin !== undefined && raw.setupMin !== null) ? raw.setupMin : 0,
       trocaMin: (raw.trocaMin !== undefined && raw.trocaMin !== null) ? raw.trocaMin : null,
       observacao: (raw.observacao !== undefined && raw.observacao !== null) ? raw.observacao : '',
       startTime: (raw.startTime) || '07:00',
       endTime: (raw.endTime) || '16:45',
       produced: (raw.produced !== undefined && raw.produced !== null) ? raw.produced : null,
       predicted: (raw.predicted !== undefined && raw.predicted !== null) ? raw.predicted : 0,
       history: Array.isArray(raw.history) ? raw.history : [],
       future: Array.isArray(raw.future) ? raw.future : []
     };
   });
 }

 render();
});

// =========================================================
//  EXPORTAR CSV
// =========================================================

function exportCSV() {
 const lines = [
   'Máquina,Operador,Processo,Ciclo (min),Troca (min),Parada (min),Início,Fim,Previsto,Realizado,Eficiência (%),Observação,Processos futuros'
 ];

 state.machines.forEach(m => {
   const futurosArr = Array.isArray(m.future) ? m.future : [];
   const futuros = futurosArr
     .map((f, idx) => `${idx + 1}. ${f.name}(${f.priority})`)
     .join(' | ');

   lines.push(
     `"${m.id}","${m.operator}","${m.process}",${m.cycleMin || ''},${m.trocaMin || ''},${m.setupMin || ''},${m.startTime},${m.endTime},${m.predicted || 0},${m.produced || ''},` +
     `${m.history && m.history.length > 0 ? (m.history.at(-1).efficiency || '') : ''},"${m.observacao || ''}","${futuros}"`
   );
 });

 const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
 const url = URL.createObjectURL(blob);

 const a = document.createElement('a');
 a.href = url;
 a.download = 'producao_usinagem_v18_6.csv';
 a.click();

 URL.revokeObjectURL(url);
}

// =========================================================
//  RESETAR TUDO
// =========================================================
function resetAll() {
 if (!confirm('Resetar tudo e apagar dados?')) return;

 state.machines.forEach(m => {
   REF.child(m.id).set({
     id: m.id,
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
     future: []
   });
 });
}

// Gatilhos
document.getElementById('exportAll').addEventListener('click', exportCSV);

document.getElementById('resetAll').addEventListener('click', resetAll);
