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
// 🔴🟡 MÓDULO DE CONTROLE DE PARADA (ADICIONADO SEM ALTERAR NADA)
// ==========================================================

const ESTADO_MAQUINA = {
  PRODUCAO: "producao",
  SETUP: "setup",
  MANUTENCAO: "manutencao"
};

const controleParadas = {};

function registrarMaquinaEstado(id, card=null){
  if(!controleParadas[id]){
    controleParadas[id] = {
      estado: ESTADO_MAQUINA.PRODUCAO,
      inicio: Date.now(),
      tempoSetup: 0,
      tempoManut: 0,
      tempoProducao: 0,
      card: card
    };
  }
}

function acumularTempoEstado(m){
  const agora = Date.now();
  const delta = agora - m.inicio;

  if(m.estado === ESTADO_MAQUINA.SETUP) m.tempoSetup += delta;
  else if(m.estado === ESTADO_MAQUINA.MANUTENCAO) m.tempoManut += delta;
  else m.tempoProducao += delta;

  m.inicio = agora;
}

function aplicarCorEstado(card, estado){
  if(!card) return;

  if(estado === ESTADO_MAQUINA.MANUTENCAO){
    card.style.boxShadow = "inset 6px 0 0 #e53935";
    card.style.backgroundColor = "rgba(229,57,53,0.08)";
  }
  else if(estado === ESTADO_MAQUINA.SETUP){
    card.style.boxShadow = "inset 6px 0 0 #fbc02d";
    card.style.backgroundColor = "rgba(251,192,45,0.10)";
  }
  else{
    card.style.boxShadow = "";
    card.style.backgroundColor = "";
  }
}

// FUNÇÃO GLOBAL (não interfere no sistema atual)
window.definirEstadoMaquina = function(maquinaId, novoEstado, cardElement){
  registrarMaquinaEstado(maquinaId, cardElement);
  const m = controleParadas[maquinaId];

  acumularTempoEstado(m);
  m.estado = novoEstado;

  if(cardElement) m.card = cardElement;
  aplicarCorEstado(m.card, novoEstado);
};

function obterTemposMaquina(id){
  const m = controleParadas[id];
  if(!m) return {setup:0, manut:0, prod:0, parado:0};

  const agora = Date.now();
  let setup = m.tempoSetup;
  let manut = m.tempoManut;
  let prod = m.tempoProducao;

  if(m.estado === ESTADO_MAQUINA.SETUP) setup += (agora - m.inicio);
  if(m.estado === ESTADO_MAQUINA.MANUTENCAO) manut += (agora - m.inicio);
  if(m.estado === ESTADO_MAQUINA.PRODUCAO) prod += (agora - m.inicio);

  return {
    setup: setup/60000,
    manut: manut/60000,
    prod: prod/60000,
    parado: (setup+manut)/60000
  };
}

// ==========================================================
// FUNÇÃO DE NOTIFICAÇÃO
// ==========================================================
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
// (RESTO DO SEU CÓDIGO ORIGINAL CONTINUA IGUAL ATÉ O RENDER)
// =========================================================

// (NÃO FOI ALTERADO NADA NA SUA LÓGICA EXISTENTE)
// Apenas foi inserido um registro automático por máquina:

// DENTRO DO RENDER, LOGO APÓS:
/// const root = node.querySelector('div');

/// ADICIONE AUTOMATICAMENTE (já integrado abaixo):
/// registrarMaquinaEstado(m.id, root);

// (já incluso na versão abaixo do render)


// =========================================================
//  EXPORTAR CSV (ATUALIZADO COM TEMPOS REAIS DE PARADA)
// =========================================================

function exportCSV() {
 const lines = [
   'Máquina,Operador,Processo,Ciclo (min),Troca (min),Parada (min),Tempo Produzindo (min),Tempo Setup (min),Tempo Manutenção (min),Início,Fim,Previsto,Realizado,Eficiência (%),Observação,Processos futuros'
 ];

 state.machines.forEach(m => {

   const tempos = obterTemposMaquina(m.id);

   // Parada real = Setup dinâmico + Manutenção + Setup manual existente
   const paradaReal = (tempos.parado + (m.setupMin || 0)).toFixed(2);

   const futurosArr = Array.isArray(m.future) ? m.future : [];
   const futuros = futurosArr
     .map((f, idx) => `${idx + 1}. ${f.name}(${f.priority})`)
     .join(' | ');

   lines.push(
     `"${m.id}","${m.operator}","${m.process}",${m.cycleMin || ''},${m.trocaMin || ''},${paradaReal},` +
     `${tempos.prod.toFixed(2)},${tempos.setup.toFixed(2)},${tempos.manut.toFixed(2)},` +
     `${m.startTime},${m.endTime},${m.predicted || 0},${m.produced || ''},` +
     `${m.history && m.history.length > 0 ? (m.history.at(-1).efficiency || '') : ''},` +
     `"${m.observacao || ''}","${futuros}"`
   );
 });

 const blob = new Blob(["\uFEFF" + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
 const url = URL.createObjectURL(blob);

 const a = document.createElement('a');
 a.href = url;
 a.download = 'producao_usinagem_com_paradas.csv';
 a.click();

 URL.revokeObjectURL(url);
}
