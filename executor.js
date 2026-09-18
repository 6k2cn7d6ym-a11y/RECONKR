/* ============================================================
 * RECONKR SWING 실행기 — executor.js (Node)
 *
 * 역할: bot-live.js가 낸 orders/YYYYMMDD.json을 읽어 D+1 집행.
 *
 * 체결 규약 (백테스트 동일):
 *   매수 — D+1 시장가. paper: 일봉 시가.
 *          시가 > entry×1.03 이면 갭업 스킵.
 *          시가 ≤ stop 이면 계획 무효 취소.
 *   매도 — urgency 'now' → 시가 / 'close' → 종가.
 *   비용 — backtest-swing-kr.js CFG.costs 상수 공유.
 *
 * 페이퍼 중단: 자본 최고점 대비 -10% → halt + 텔레그램.
 *   재개: ops/status.json { status:'active' } 수동 변경.
 *
 * 킬스위치: ops/killswitch 파일 존재 시 주문 skip.
 *   생성/삭제는 디스패처 ("매매 중지"/"매매 재개").
 *
 * 텔레그램: ~/.config/minon/alert.json { url } 로
 *   POST { ticker:'RECONKR', type, msg } — request-restart.js 방식 동일.
 *
 * live 모드: 함수 시그니처만. throw '미구현'.
 *
 * 사용:
 *   node executor.js --mode paper --date 20260919
 *   node executor.js --mode paper   (날짜 생략 시 오늘)
 * ============================================================ */
'use strict';

var fs    = require('fs');
var path  = require('path');
var os    = require('os');
var https = require('https');
var http  = require('http');

var BCFG = require('./backtest-swing-kr.js').CFG;
var kisData = require('./kisData.js');
var loadCandles = kisData.loadCandles;
var u = require('./engineUtil.js');

global.G = { marketPhase: 'PRIME', spyAboveMA200: null, spyIntraday: null, _isNxtHours: false };
global.document = { getElementById: function(){ return null; } };
global.localStorage = { getItem: function(){ return null; }, setItem: function(){}, removeItem: function(){} };
global.saveJournal = function(){};
global.getTimeAwareness = u.getTimeAwareness;
global.tradeHoldDays    = u.tradeHoldDays;
global.parseTradeDate   = u.parseTradeDate;

// ── 설정 ──────────────────────────────────────────────────
var CFG = {
  costs:           BCFG.costs,
  gapSkipPct:      BCFG.gapSkipPct,
  haltDrawdownPct: 10,
  killswitchPath:  path.join(__dirname, 'ops', 'killswitch'),
  statusFile:      path.join(__dirname, 'ops', 'status.json'),
  ordersDir:       path.join(__dirname, 'orders'),
  positionsFile:   path.join(__dirname, 'positions.json'),
  ledgerFile:      path.join(__dirname, 'ledger.csv'),
  fillsFile:       path.join(__dirname, 'fills.csv'),
  alertConfigFile: path.join(os.homedir(), '.config', 'minon', 'alert.json'),
  staleOrderDays:  3,   // 직전 영업일 근사 (금→월 주말 3일 커버, 그 이상 스킵)
};

// ── 유틸 ──────────────────────────────────────────────────
function readJson(p, dflt){ try{ return JSON.parse(fs.readFileSync(p, 'utf-8')); }catch(_){ return dflt; } }
function writeJson(p, obj){ fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }
function round2(v){ return Math.round(v * 100) / 100; }

function parseArgs(argv){
  var o = { mode: 'paper', date: null };
  for(var i = 0; i < argv.length; i++){
    if(argv[i] === '--mode') o.mode = argv[++i];
    if(argv[i] === '--date') o.date = argv[++i];
  }
  return o;
}

function todayKst(){
  var d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  return d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
}

function asOfCandles(candles, date){
  if(!date) return candles;
  return candles.filter(function(c){ return c.stck_bsop_date <= date; });
}

// ── 날짜·orders 탐색 ──────────────────────────────────────
function dateDiff(d1, d2){
  var dt1 = new Date(d1.slice(0,4) + '-' + d1.slice(4,6) + '-' + d1.slice(6,8));
  var dt2 = new Date(d2.slice(0,4) + '-' + d2.slice(4,6) + '-' + d2.slice(6,8));
  return Math.round((dt2 - dt1) / 86400000);
}

function findPendingOrdersFile(execDate){
  if(!fs.existsSync(CFG.ordersDir)) return null;
  var files = fs.readdirSync(CFG.ordersDir)
    .filter(function(f){ return /^\d{8}\.json$/.test(f); })
    .sort().reverse();
  for(var i = 0; i < files.length; i++){
    var signalDate = files[i].slice(0, 8);
    if(signalDate >= execDate) continue;
    var diff = dateDiff(signalDate, execDate);
    if(diff > CFG.staleOrderDays){
      console.log('[SKIP] 오래된 신호 ' + signalDate + ' (' + diff + '일 전) — 스킵');
      sendAlert('warn', '오래된 신호 스킵: ' + signalDate + ' · 집행일 ' + execDate);
      return null;
    }
    // 집행 여부 무관 — 최신 파일 반환, caller가 _executedAt 판단
    return path.join(CFG.ordersDir, files[i]);
  }
  return null;
}

// ── 텔레그램 알림 ─────────────────────────────────────────
function sendAlert(type, msg){
  console.log('[ALERT]', type, msg);
  var cfg = readJson(CFG.alertConfigFile, null);
  if(!cfg || !cfg.url){ console.warn('[ALERT] alert.json 없음 — 콘솔만'); return; }
  var body = JSON.stringify({ ticker: 'RECONKR', type: type, msg: msg });
  var parsed;
  try{ parsed = new URL(cfg.url); }catch(e){ console.warn('[ALERT] URL 파싱 실패:', cfg.url); return; }
  var lib  = parsed.protocol === 'https:' ? https : http;
  var opts = {
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path:     parsed.pathname + (parsed.search || ''),
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };
  var req = lib.request(opts, function(res){ res.resume(); });
  req.on('error', function(e){ console.warn('[ALERT] 전송 실패:', e.message); });
  req.write(body);
  req.end();
}

// ── killswitch ────────────────────────────────────────────
function isKillswitchActive(){
  var active = fs.existsSync(CFG.killswitchPath);
  if(active) console.log('[KILLSWITCH] ops/killswitch 감지 — 주문 skip');
  return active;
}

// ── halt ──────────────────────────────────────────────────
function isHalted(){
  return readJson(CFG.statusFile, { status: 'active' }).status === 'halted';
}

function checkAndUpdateHalt(equity){
  var s        = readJson(CFG.statusFile, { status: 'active', peakEquity: 0 });
  var peak     = Math.max(s.peakEquity || 0, equity);
  var drawdown = peak > 0 ? (equity - peak) / peak * 100 : 0;
  var nowHalt  = drawdown <= -CFG.haltDrawdownPct;
  writeJson(CFG.statusFile, Object.assign({}, s, {
    peakEquity:  round2(peak),
    lastEquity:  round2(equity),
    drawdownPct: round2(drawdown),
    status: nowHalt ? 'halted' : (s.status === 'halted' ? 'halted' : 'active'),
  }));
  return { halted: nowHalt, peak: peak, drawdown: drawdown };
}

// ── ledger ────────────────────────────────────────────────
function readLatestLedger(initialEquity){
  if(!fs.existsSync(CFG.ledgerFile)) return { equity: initialEquity, cash: initialEquity };
  var lines = fs.readFileSync(CFG.ledgerFile, 'utf-8').trim().split('\n');
  var last  = lines[lines.length - 1];
  if(!last || last.startsWith('일자')) return { equity: initialEquity, cash: initialEquity };
  var cols = last.split(',');
  return { equity: parseFloat(cols[1]) || initialEquity, cash: parseFloat(cols[2]) || initialEquity };
}

function appendLedger(row){
  if(!fs.existsSync(CFG.ledgerFile))
    fs.writeFileSync(CFG.ledgerFile, '일자,자본,현금,보유평가,실현손익\n');
  fs.appendFileSync(CFG.ledgerFile,
    [row.date, row.equity, row.cash, row.holdValue, row.realizedPnl].join(',') + '\n');
}

function appendFill(fill){
  if(!fs.existsSync(CFG.fillsFile))
    fs.writeFileSync(CFG.fillsFile, '일자,종목,매수매도,수량,체결가,체결금액,비용,requestId\n');
  fs.appendFileSync(CFG.fillsFile,
    [fill.date, fill.code, fill.action, fill.qty, fill.price,
     round2(fill.notional), round2(fill.cost), fill.requestId || ''].join(',') + '\n');
}

// ── 비용 ──────────────────────────────────────────────────
function calcCost(action, notional){
  var c = CFG.costs;
  if(action === 'BUY')  return notional * (c.commissionPct + c.slipPct) / 100;
  if(action === 'SELL') return notional * (c.commissionPct + c.taxSellPct + c.slipPct) / 100;
  return 0;
}

// ── paper 체결가 ──────────────────────────────────────────
function paperFillPrice(order, dayCandle){
  if(!dayCandle) return { skip: true, reason: '봉 데이터 없음' };
  var open  = parseFloat(dayCandle.stck_oprc);
  var close = parseFloat(dayCandle.stck_clpr);
  if(order.action === 'BUY'){
    if(open > order.price * (1 + CFG.gapSkipPct / 100))
      return { skip: true, reason: '갭업 스킵: 시가 ' + open + ' > entry×1.0' + CFG.gapSkipPct + ' (' + order.price + ')' };
    if(order.plan && open <= order.plan.stop)
      return { skip: true, reason: '시가(' + open + ') ≤ stop(' + order.plan.stop + ') — 계획 무효' };
    return { price: open };
  }
  if(order.action === 'SELL'){
    return { price: open }; // urgency 무관 D+1 시가 · 'close' 2차 실행은 백로그
  }
  return { skip: true, reason: '알 수 없는 action: ' + order.action };
}

// ── live 체결 stub ────────────────────────────────────────
function liveFill(order, requestId){
  void order; void requestId;
  throw new Error('live 모드 미구현 — Worker /order 프록시 연동 후 활성화');
}

// ── positions 갱신 ────────────────────────────────────────
function applyFillToPositions(positions, fill, order){
  if(fill.action === 'BUY'){
    positions.push({
      code: order.code, name: order.name || order.code,
      mode: 'swing', entry: fill.price, shares: fill.qty, remaining: fill.qty,
      stop: order.plan ? order.plan.stop : null,
      t1:   order.plan ? order.plan.t1   : null,
      t2:   order.plan ? order.plan.t2   : null,
      date: fill.date, status: 'open', exitState: null,
    });
  } else {
    var idx = -1;
    for(var i = 0; i < positions.length; i++){
      if(positions[i].code === fill.code && (positions[i].status === 'open' || positions[i].status === 'partial')){
        idx = i; break;
      }
    }
    if(idx >= 0){
      var pos = positions[idx];
      pos.remaining = Math.max(0, (pos.remaining != null ? pos.remaining : pos.shares) - fill.qty);
      pos.status    = pos.remaining === 0 ? 'closed' : 'partial';
    }
  }
}

// ── 메인 ─────────────────────────────────────────────────
async function main(){
  var args = parseArgs(process.argv.slice(2));
  if(args.mode !== 'paper' && args.mode !== 'live'){ console.error('--mode paper | live'); process.exit(1); }
  if(args.mode === 'live') throw new Error('live 모드 미구현 — 페이퍼 검증 완료 후 활성화');

  var date = args.date || todayKst();
  console.log('[executor] mode=' + args.mode + ' date=' + date);

  // 1. killswitch
  if(isKillswitchActive()) return;

  // 2. halt
  if(isHalted()){ console.log('[HALT] status=halted — 재개 전까지 skip'); return; }

  // 3. orders 파일 — 집행일 이전 최신 미집행 파일
  var ordersFile = findPendingOrdersFile(date);
  if(!ordersFile){ console.log('[SKIP] 집행 가능한 orders 없음 (date=' + date + ')'); return; }
  var orders = readJson(ordersFile, null);
  if(!orders){ console.error('orders 파싱 실패'); process.exit(1); }
  if(orders._executedAt){
    console.log('[SKIP] 이미 집행됨 (' + path.basename(ordersFile) + ' executedAt=' + orders._executedAt + ')'); return;
  }

  // 4. 자본·현금 (ledger 최신, 초기 100만)
  var ledger = readLatestLedger(1000000);
  var equity = ledger.equity;
  var cash   = ledger.cash;

  // 5. positions
  var positions = readJson(CFG.positionsFile, []);
  var openPos   = positions.filter(function(p){ return p && (p.status === 'open' || p.status === 'partial'); });

  var fills       = [];
  var realizedPnl = 0;

  // 6. 매도 집행
  var exits = orders.exits || [];
  for(var ei = 0; ei < exits.length; ei++){
    var exOrder  = exits[ei];
    var exCandle = null;
    try{
      var exRaw = await loadCandles(exOrder.code, 5);
      var exF   = asOfCandles(exRaw, date);
      exCandle  = exF.length ? exF[0] : null;
    }catch(e){ console.warn('[SKIP SELL] ' + exOrder.code + ' 봉 로드 실패: ' + e.message); continue; }
    var exResult = paperFillPrice(exOrder, exCandle);
    if(exResult.skip){ console.log('[SKIP SELL] ' + exOrder.code + ' — ' + exResult.reason); continue; }
    var exNotional = exResult.price * exOrder.qty;
    var exCost     = calcCost('SELL', exNotional);
    var exPos = null;
    for(var pi = 0; pi < openPos.length; pi++){ if(openPos[pi].code === exOrder.code){ exPos = openPos[pi]; break; } }
    if(!exPos){ console.log('[SKIP SELL] ' + exOrder.code + ' — open 포지션 없음 (유령 매도 방지)'); continue; }
    var exRemaining = exPos.remaining != null ? exPos.remaining : exPos.shares;
    if(exOrder.qty > exRemaining){ console.log('[SKIP SELL] ' + exOrder.code + ' — qty(' + exOrder.qty + ') > remaining(' + exRemaining + ')'); continue; }
    var entryNotional = exPos.entry * exOrder.qty;
    var pnl = exNotional - entryNotional - exCost;
    realizedPnl += pnl;
    cash += (exNotional - exCost);
    var exFill = { date: date, code: exOrder.code, action: 'SELL', qty: exOrder.qty,
                   price: exResult.price, notional: exNotional, cost: exCost, requestId: exOrder.requestId || '' };
    fills.push(exFill);
    appendFill(exFill);
    applyFillToPositions(positions, exFill, exOrder);
    console.log('  SELL ' + exOrder.code + ' ' + exOrder.qty + '주 @' + exResult.price +
                ' urgency=' + (exOrder.urgency||'now') + ' pnl=' + Math.round(pnl));
  }

  // 7. 매수 집행
  var entries = orders.entries || [];
  for(var bi = 0; bi < entries.length; bi++){
    var buyOrder  = entries[bi];
    var buyCandle = null;
    try{
      var buyRaw = await loadCandles(buyOrder.code, 5);
      var buyF   = asOfCandles(buyRaw, date);
      buyCandle  = buyF.length ? buyF[0] : null;
    }catch(e){ console.warn('[SKIP BUY] ' + buyOrder.code + ' 봉 로드 실패: ' + e.message); continue; }
    var buyResult = paperFillPrice(buyOrder, buyCandle);
    if(buyResult.skip){ console.log('[SKIP BUY] ' + buyOrder.code + ' — ' + buyResult.reason); continue; }
    var buyNotional = buyResult.price * buyOrder.qty;
    var buyCost     = calcCost('BUY', buyNotional);
    if(cash < buyNotional + buyCost){ console.log('[SKIP BUY] ' + buyOrder.code + ' — 현금 부족 (필요 ' + Math.round(buyNotional + buyCost) + ' > 보유 ' + Math.round(cash) + ')'); continue; }
    cash -= (buyNotional + buyCost);
    var buyFill = { date: date, code: buyOrder.code, action: 'BUY', qty: buyOrder.qty,
                    price: buyResult.price, notional: buyNotional, cost: buyCost, requestId: buyOrder.requestId || '' };
    fills.push(buyFill);
    appendFill(buyFill);
    applyFillToPositions(positions, buyFill, buyOrder);
    console.log('  BUY  ' + buyOrder.code + ' ' + buyOrder.qty + '주 @' + buyResult.price);
  }

  // 8. 보유평가 — 체결 후 보유 포지션 전일 종가 합산
  var holdValue = 0;
  var newOpen   = positions.filter(function(p){ return p.status === 'open' || p.status === 'partial'; });
  for(var hi = 0; hi < newOpen.length; hi++){
    var hp = newOpen[hi];
    try{
      var hRaw  = await loadCandles(hp.code, 3);
      var hPrev = asOfCandles(hRaw, date).filter(function(c){ return c.stck_bsop_date < date; });
      var hPx   = hPrev.length ? parseFloat(hPrev[0].stck_clpr) : hp.entry;
      holdValue += hPx * (hp.remaining != null ? hp.remaining : hp.shares);
    }catch(_){ holdValue += hp.entry * (hp.remaining != null ? hp.remaining : hp.shares); }
  }

  equity = round2(cash + holdValue);
  cash   = round2(cash);

  // 9. positions 저장
  writeJson(CFG.positionsFile, positions);

  // 10. ledger 기록
  appendLedger({ date: date, equity: equity, cash: cash,
                 holdValue: round2(holdValue), realizedPnl: round2(realizedPnl) });

  // 11. executedAt 마킹 (멱등성)
  orders._executedAt = date;
  fs.writeFileSync(ordersFile, JSON.stringify(orders, null, 2));

  // 12. halt 재평가
  var hr = checkAndUpdateHalt(equity);
  if(hr.halted){
    var hMsg = 'PAPER HALT — 낙폭 ' + round2(Math.abs(hr.drawdown)) + '% 자본 ' + equity.toLocaleString() + '원';
    sendAlert('halt', hMsg);
    console.log('[HALT]', hMsg);
  }

  console.log('[executor] 완료 · date=' + date + ' fills=' + fills.length +
              ' cash=' + cash + ' holdValue=' + round2(holdValue) + ' equity=' + equity);
}

module.exports = { CFG: CFG, isKillswitchActive: isKillswitchActive,
                   checkAndUpdateHalt: checkAndUpdateHalt, paperFillPrice: paperFillPrice,
                   calcCost: calcCost, sendAlert: sendAlert };
if(require.main === module) main().catch(function(e){ console.error(e); process.exit(1); });
