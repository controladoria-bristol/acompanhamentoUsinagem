/**
 * Sincroniza o histórico do Dashboard de Usinagem com esta planilha.
 *
 * Cada registro feito no botão "Histórico" do painel é gravado no Firebase
 * em usinagem_historico_log. Este script roda a cada 1 minuto, lê os
 * registros dos últimos dias e acrescenta os que ainda não foram enviados
 * (uma linha por registro, mesmas colunas do CSV) na aba do turno: noite se
 * o Turno Início for das 18:00 às 06:59, dia se for das 07:00 às 17:59.
 * Registro excluído no painel (lixeira 🗑️) tem a linha apagada daqui.
 *
 * Também faz o fechamento de turno às 07:30 e às 18:00, mesmo com todos os
 * PCs desligados: registra as máquinas com peças ainda não enviadas e limpa
 * o histórico dos cards e "Peças realizadas" no painel.
 *
 * INSTALAÇÃO (uma vez só):
 *   1. Na planilha: Extensões → Apps Script.
 *   2. Apague o conteúdo de Código.gs e cole este arquivo inteiro.
 *   3. Ajuste ABA_DIA e ABA_NOITE abaixo com os nomes exatos das abas.
 *   4. Selecione a função "instalar" no topo e clique em Executar.
 *      Autorize o acesso quando o Google pedir.
 *   5. Pronto. Recarregue a planilha: aparece o menu "Dashboard" com
 *      "Sincronizar agora", caso queira forçar uma sincronização.
 *
 * Os IDs já enviados ficam na aba oculta "_sync_dashboard" — não apague,
 * senão os registros dos últimos dias serão enviados de novo.
 */

const ABA_DIA   = 'Dia';                // nome da aba do turno do dia
const ABA_NOITE = 'Noite';              // nome da aba do turno da noite
const NOITE_A_PARTIR_DE = 18;           // Turno Início >= 18h ou < 7h → noite
const NOITE_ATE = 7;
const ABA_CONTROLE = '_sync_dashboard'; // aba oculta com os IDs já enviados
const DIAS_RETROATIVOS = 7;             // janela de busca (cobre PCs que ficaram offline)
const TZ = 'America/Sao_Paulo';

const FIREBASE_URL = 'https://dashboardusinagem-default-rtdb.firebaseio.com';
const LOG_PATH = 'usinagem_historico_log';
const DB_ROOT = 'usinagem_dashboard_v18_6';     // dados das máquinas do painel
const TURNO_PATH = 'usinagem_turno_virada';     // última virada de turno já fechada
const VIRADAS_TURNO = [[7, 30], [18, 0]];       // horários do fechamento de turno

const COL_EFICIENCIA = 12;              // coluna L, "Eficiência (%)"

const STATUS_LABEL ={ producao: 'Produção', setup: 'Setup', manutencao: 'Manutenção' };


function instalar() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'sincronizarHistorico')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sincronizarHistorico').timeBased().everyMinutes(1).create();
  sincronizarHistorico();
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Dashboard')
    .addItem('Sincronizar agora', 'sincronizarHistorico')
    .addToUi();
}

function sincronizarHistorico() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const abas = { dia: ss.getSheetByName(ABA_DIA), noite: ss.getSheetByName(ABA_NOITE) };
    if (!abas.dia)   throw new Error('Aba "' + ABA_DIA   + '" não encontrada. Ajuste ABA_DIA no script.');
    if (!abas.noite) throw new Error('Aba "' + ABA_NOITE + '" não encontrada. Ajuste ABA_NOITE no script.');

    // Fecha o turno antes de sincronizar, para os registros automáticos
    // já entrarem na planilha nesta mesma rodada.
    try {
      fecharTurnoSeNecessario();
    } catch (e) {
      console.error('Falha no fechamento de turno: ' + e.message);
    }

    // Aba de controle: coluna A = ID enviado, coluna B = "excluído" quando a
    // linha já foi apagada da planilha.
    const controle   = obterAbaControle(ss);
    const jaEnviados = new Map();
    controle.getRange(1, 1, Math.max(controle.getLastRow(), 1), 2).getValues()
      .forEach((l, i) => { if (l[0]) jaEnviados.set(l[0], { linha: i + 1, excluido: l[1] === 'excluído' }); });

    const inicio = prefixoPushId(Date.now() - DIAS_RETROATIVOS * 86400000);
    const url = FIREBASE_URL + '/' + LOG_PATH + '.json'
      + '?orderBy=' + encodeURIComponent('"$key"')
      + '&startAt=' + encodeURIComponent('"' + inicio + '"');
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200)
      throw new Error('Firebase respondeu ' + resp.getResponseCode() + ': ' + resp.getContentText());

    const dados = JSON.parse(resp.getContentText()) || {};
    const ids   = Object.keys(dados).sort();

    // Excluídos no painel depois de enviados: apaga a linha da aba do turno.
    ids.forEach(id => {
      const enviado = jaEnviados.get(id);
      if (!enviado || enviado.excluido || !dados[id].excluido) return;
      removerLinha(abas[turnoDoRegistro(dados[id])], dados[id]);
      controle.getRange(enviado.linha, 2).setValue('excluído');
    });

    // Novos: envia os que não foram excluídos; os excluídos antes de enviar
    // só entram na aba de controle, para não serem enviados depois.
    const novos = ids.filter(id => !jaEnviados.has(id));
    if (novos.length === 0) return;

    const linhasPorTurno = { dia: [], noite: [] };
    novos.filter(id => !dados[id].excluido)
      .forEach(id => linhasPorTurno[turnoDoRegistro(dados[id])].push(montarLinha(dados[id])));
    Object.keys(linhasPorTurno).forEach(turno => {
      const linhas = linhasPorTurno[turno];
      if (linhas.length === 0) return;
      const aba   = abas[turno];
      const faixa = aba.getRange(aba.getLastRow() + 1, 1, linhas.length, linhas[0].length);
      faixa.setValues(linhas);
      formatarLinhas(aba, faixa);
    });
    controle.getRange(controle.getLastRow() + 1, 1, novos.length, 2)
      .setValues(novos.map(id => [id, dados[id].excluido ? 'excluído' : '']));
  } finally {
    lock.releaseLock();
  }
}

// ── Fechamento de turno ─────────────────────────────────────────────────
// Às 07:30 e às 18:00 (horário de Brasília), mesmo com todos os PCs
// desligados: envia ao log as máquinas com "Peças realizadas" ainda não
// registradas no turno e depois limpa o histórico do card e "Peças
// realizadas" no Firebase. O painel tem a mesma lógica como reserva; a
// marca em usinagem_turno_virada (gravada com ETag) garante que só um faz.

function fecharTurnoSeNecessario() {
  const virada = ultimaVirada(Date.now());
  const url    = FIREBASE_URL + '/' + TURNO_PATH + '.json';
  const resp   = UrlFetchApp.fetch(url, { headers: { 'X-Firebase-ETag': 'true' }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200)
    throw new Error('Firebase respondeu ' + resp.getResponseCode() + ': ' + resp.getContentText());
  const atual = JSON.parse(resp.getContentText());
  if (atual != null && atual >= virada) return; // já fechado

  const etag = cabecalho(resp, 'etag');
  const marca = UrlFetchApp.fetch(url, {
    method: 'put', contentType: 'application/json', payload: JSON.stringify(virada),
    headers: { 'if-match': etag }, muteHttpExceptions: true
  });
  if (marca.getResponseCode() === 412) return; // um painel fechou no mesmo instante
  if (marca.getResponseCode() !== 200)
    throw new Error('Firebase respondeu ' + marca.getResponseCode() + ': ' + marca.getContentText());
  if (atual == null) return; // primeira vez: só marca a virada atual, sem limpar

  fecharTurno(ultimaVirada(virada - 1));
}

function fecharTurno(inicioTurno) {
  const dados   = buscarJson(DB_ROOT) || {};
  const agora   = Date.now();
  const updates = {};

  Object.keys(dados).forEach(nome => {
    const m = dados[nome] || {};
    const temSensor = !!(m.auto && (m.auto.p1 || m.auto.p2));
    const produced  = (temSensor && !m.producedManual) ? contagemSensor(m) : (m.produced ?? null);
    const historico = Array.isArray(m.history) ? m.history : Object.values(m.history || {});
    const jaEnviado = historico.some(h => h && h.ts >= inicioTurno && h.produced === produced);

    if (produced > 0 && !jaEnviado) {
      const resp = UrlFetchApp.fetch(FIREBASE_URL + '/' + LOG_PATH + '.json', {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify(registroAutomatico(nome, m, produced, agora)), muteHttpExceptions: true
      });
      if (resp.getResponseCode() !== 200)
        throw new Error('Falha ao registrar ' + nome + ': ' + resp.getContentText());
    }

    const base = DB_ROOT + '/' + nome + '/';
    updates[base + 'history']        = null;
    updates[base + 'produced']       = null;
    updates[base + 'producedManual'] = null;
    if (temSensor) {
      const marco = {};
      ['p1', 'p2'].forEach(l => { if (m.auto[l]) marco[l] = m.auto[l].totalPulses || 0; });
      updates[base + 'autoBaseline'] = marco;
    }
  });

  const resp = UrlFetchApp.fetch(FIREBASE_URL + '/.json', {
    method: 'patch', contentType: 'application/json', payload: JSON.stringify(updates), muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200)
    throw new Error('Falha ao limpar as máquinas: ' + resp.getContentText());
}

// Mesmo registro que o painel monta no clique em "Histórico".
function registroAutomatico(nome, m, produced, agora) {
  const secSetup  = segundosNoStatus(m, 'setup', agora);
  const secManut  = segundosNoStatus(m, 'manutencao', agora);
  const secPausa  = segundosEmPausa(m, agora);
  const startTime = m.startTime || '07:00';
  const endTime   = m.endTime   || '16:45';
  const predicted = calcularPrevisto(m.cycleMin, m.trocaMin, startTime, endTime, secSetup + secManut + secPausa);
  return {
    ts:           agora,
    operator:     m.operator || '-',
    process:      m.process  || '-',
    cycleMin:     m.cycleMin ?? null,
    trocaMin:     m.trocaMin ?? null,
    startTime,
    endTime,
    produced,
    predicted,
    efficiency:   predicted > 0 ? ((produced / predicted) * 100).toFixed(1) : '-',
    observacao:   (m.observacao ? m.observacao + ' · ' : '') + 'registro automático (fim de turno)',
    status:       m.status || 'producao',
    statusAccSec: { setup: secSetup, manutencao: secManut },
    pausaAccSec:  secPausa,
    machineId:    nome,
    createdAt:    { '.sv': 'timestamp' }
  };
}

function contagemSensor(m) {
  const marco = m.autoBaseline || {};
  let total = 0;
  ['p1', 'p2'].forEach(l => {
    if (!m.auto[l]) return;
    const atual = m.auto[l].totalPulses || 0;
    total += Math.max(0, atual - (marco[l] ?? atual));
  });
  return total;
}

function segundosNoStatus(m, chave, agora) {
  const acc = (m.statusAccSec && m.statusAccSec[chave]) || 0;
  if (m.statusPaused) return acc;
  if (m.status === chave && m.statusChangedAt) return acc + Math.floor((agora - m.statusChangedAt) / 1000);
  return acc;
}

function segundosEmPausa(m, agora) {
  const acc = m.pausaAccSec || 0;
  return m.pausaChangedAt ? acc + Math.floor((agora - m.pausaChangedAt) / 1000) : acc;
}

// Igual ao calcularPrevisto/minutosDisponiveis do painel (script.js).
function calcularPrevisto(cycleMin, trocaMin, startStr, endStr, paradoSec) {
  if (!cycleMin || cycleMin <= 0) return 0;
  const cicloTotal = cycleMin + (trocaMin || 0);
  if (cicloTotal <= 0) return 0;
  const turnoTotal = minutosDisponiveis(startStr, endStr);
  if (turnoTotal <= 0) return 0;
  return Math.floor(Math.max(turnoTotal - paradoSec / 60, 0) / cicloTotal);
}

function minutosDisponiveis(startStr, endStr) {
  if (!startStr || !endStr) return 0;
  const toMin = t => { const p = t.split(':').map(Number); return p[0] * 60 + (p[1] || 0); };
  const startMin  = toMin(startStr);
  const endMin    = toMin(endStr);
  const overnight = endMin < startMin;
  let diff = overnight ? (endMin + 1440) - startMin : endMin - startMin;
  if (diff <= 0) return 0;
  if (diff >= 240) diff -= 15;
  if (!overnight) {
    const iS = 720, iE = 780;
    if (endMin > iS && startMin < iE) diff -= Math.min(endMin, iE) - Math.max(startMin, iS);
  } else {
    const iS = 120, iE = 180;
    if (endMin > iS) diff -= Math.min(endMin, iE) - Math.max(0, iS);
  }
  return Math.max(diff, 0);
}

// Última virada de turno (07:30 ou 18:00 de Brasília) até `ms`.
function ultimaVirada(ms) {
  let ultima = null;
  [0, -1].forEach(dia => {
    const ymd = Utilities.formatDate(new Date(ms + dia * 86400000), TZ, 'yyyy-MM-dd');
    VIRADAS_TURNO.forEach(([h, min]) => {
      const v = Utilities.parseDate(ymd + ' ' + h + ':' + min, TZ, 'yyyy-MM-dd H:m').getTime();
      if (v <= ms && (ultima == null || v > ultima)) ultima = v;
    });
  });
  return ultima;
}

function buscarJson(caminho) {
  const resp = UrlFetchApp.fetch(FIREBASE_URL + '/' + caminho + '.json', { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200)
    throw new Error('Firebase respondeu ' + resp.getResponseCode() + ': ' + resp.getContentText());
  return JSON.parse(resp.getContentText());
}

function cabecalho(resp, nome) {
  const h = resp.getAllHeaders();
  const chave = Object.keys(h).find(k => k.toLowerCase() === nome);
  return chave ? h[chave] : '';
}

// Pelo Turno Início do registro; sem ele, pela hora em que foi registrado.
function turnoDoRegistro(h) {
  const hora = h.startTime
    ? Number(String(h.startTime).split(':')[0])
    : Number(Utilities.formatDate(new Date(h.ts || h.createdAt), TZ, 'H'));
  return (hora >= NOITE_A_PARTIR_DE || hora < NOITE_ATE) ? 'noite' : 'dia';
}

// Procura a linha pela Data + Hora do Registro + Máquina (de baixo pra cima)
// e apaga. Compara o texto exibido, ignorando zeros à esquerda (07:05 = 7:05).
function removerLinha(aba, h) {
  const ultima = aba.getLastRow();
  if (ultima < 1) return false;
  const d     = new Date(h.ts || h.createdAt);
  const norm  = s => String(s).trim().split(/[\/:]/).map(p => String(Number(p))).join('|');
  const data  = norm(Utilities.formatDate(d, TZ, 'dd/MM/yyyy'));
  const hora  = norm(Utilities.formatDate(d, TZ, 'HH:mm:ss'));
  const valores = aba.getRange(1, 1, ultima, 3).getDisplayValues();
  for (let i = valores.length - 1; i >= 0; i--) {
    if (norm(valores[i][0]) === data && norm(valores[i][1]) === hora && valores[i][2] === h.machineId) {
      aba.deleteRow(i + 1);
      return true;
    }
  }
  return false; // já tinha sido apagada à mão
}

// Bordas em todas as células, texto centralizado e Eficiência em %.
function formatarLinhas(aba, faixa) {
  faixa.setBorder(true, true, true, true, true, true)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  aba.getRange(faixa.getRow(), COL_EFICIENCIA, faixa.getNumRows(), 1).setNumberFormat('0.0%');
}

// Mesmas colunas do "Exportar CSV" do painel. Eficiência vai como fração
// (85% = 0,85) para o formato de porcentagem da célula exibir "85,0%".
function montarLinha(h) {
  const d  = new Date(h.ts || h.createdAt);
  const ef = (h.efficiency != null && h.efficiency !== '-' && !isNaN(Number(h.efficiency)))
    ? Number(h.efficiency) / 100 : '';
  return [
    Utilities.formatDate(d, TZ, 'dd/MM/yyyy'),
    Utilities.formatDate(d, TZ, 'HH:mm:ss'),
    h.machineId || '',
    h.operator  || '-',
    h.process   || '-',
    h.startTime || '',
    h.endTime   || '',
    h.cycleMin  != null ? formatMinutesToMMSS(h.cycleMin) : '',
    h.trocaMin  != null ? formatMinutesToMMSS(h.trocaMin) : '',
    h.predicted ?? '',
    h.produced  ?? '',
    ef,
    formatSeconds((h.statusAccSec && h.statusAccSec.setup)      || 0),
    formatSeconds((h.statusAccSec && h.statusAccSec.manutencao) || 0),
    formatSeconds(h.pausaAccSec || 0),
    STATUS_LABEL[h.status] || h.status || '',
    h.observacao || ''
  ];
}

function obterAbaControle(ss) {
  let aba = ss.getSheetByName(ABA_CONTROLE);
  if (!aba) {
    aba = ss.insertSheet(ABA_CONTROLE);
    aba.hideSheet();
  }
  return aba;
}

// Os 8 primeiros caracteres de um push ID do Firebase codificam o horário
// de criação; usar isso no startAt busca só os registros da janela.
function prefixoPushId(ms) {
  const ALFABETO = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 8; i++) {
    s = ALFABETO.charAt(ms % 64) + s;
    ms = Math.floor(ms / 64);
  }
  return s;
}

function formatMinutesToMMSS(minFloat) {
  if (!minFloat || isNaN(minFloat)) return '-';
  const totalSeconds = Math.round(minFloat * 60);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function formatSeconds(totalSec) {
  if (!totalSec || totalSec < 0) return '0:00';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  return m + ':' + String(s).padStart(2, '0');
}
