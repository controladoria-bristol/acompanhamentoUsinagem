/**
 * Sincroniza o histórico do Dashboard de Usinagem com esta planilha.
 *
 * Cada registro feito no botão "Histórico" do painel é gravado no Firebase
 * em usinagem_historico_log. Este script roda a cada 1 minuto, lê os
 * registros dos últimos dias e acrescenta os que ainda não foram enviados
 * (uma linha por registro, mesmas colunas do CSV) na aba do turno: noite se
 * o Turno Início for das 18:00 às 06:59, dia se for das 07:00 às 17:59.
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

const STATUS_LABEL = { producao: 'Produção', setup: 'Setup', manutencao: 'Manutenção' };


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

    const controle   = obterAbaControle(ss);
    const jaEnviados = new Set(
      controle.getRange(1, 1, Math.max(controle.getLastRow(), 1), 1).getValues()
        .map(l => l[0]).filter(String)
    );

    const inicio = prefixoPushId(Date.now() - DIAS_RETROATIVOS * 86400000);
    const url = FIREBASE_URL + '/' + LOG_PATH + '.json'
      + '?orderBy=' + encodeURIComponent('"$key"')
      + '&startAt=' + encodeURIComponent('"' + inicio + '"');
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200)
      throw new Error('Firebase respondeu ' + resp.getResponseCode() + ': ' + resp.getContentText());

    const dados = JSON.parse(resp.getContentText()) || {};
    const novos = Object.keys(dados).sort().filter(id => !jaEnviados.has(id));
    if (novos.length === 0) return;

    const linhasPorTurno = { dia: [], noite: [] };
    novos.forEach(id => linhasPorTurno[turnoDoRegistro(dados[id])].push(montarLinha(dados[id])));
    Object.keys(linhasPorTurno).forEach(turno => {
      const linhas = linhasPorTurno[turno];
      if (linhas.length === 0) return;
      const aba = abas[turno];
      aba.getRange(aba.getLastRow() + 1, 1, linhas.length, linhas[0].length).setValues(linhas);
    });
    controle.getRange(controle.getLastRow() + 1, 1, novos.length, 1).setValues(novos.map(id => [id]));
  } finally {
    lock.releaseLock();
  }
}

// Pelo Turno Início do registro; sem ele, pela hora em que foi registrado.
function turnoDoRegistro(h) {
  const hora = h.startTime
    ? Number(String(h.startTime).split(':')[0])
    : Number(Utilities.formatDate(new Date(h.ts || h.createdAt), TZ, 'H'));
  return (hora >= NOITE_A_PARTIR_DE || hora < NOITE_ATE) ? 'noite' : 'dia';
}

// Mesmas colunas e formatos do "Exportar CSV" do painel.
function montarLinha(h) {
  const d  = new Date(h.ts || h.createdAt);
  const ef = (h.efficiency != null && h.efficiency !== '-')
    ? String(h.efficiency).replace('.', ',') : '';
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
