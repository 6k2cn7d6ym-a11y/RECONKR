/* ============================================================
 * RECONKR SWING 실행기 — executor.js (Node)
 *
 * 역할: bot-live.js가 낸 orders/YYYYMMDD.json을 읽어 D+1 집행.
 *
 * 체결 규약 (백테스트 동일):
 *   매수 — D+1 09:00 시장가. paper: 일봉 시가.
 *          08:55 예상체결가 > entry×1.03 이면 취소(갭업 스킵). paper: 갭업 체크 스킵.
 *          시가 ≤ stop 이면 취소 (계획 무효).
 *   매도 — urgency 'now'  → D+1 시가.  paper: 일봉 시가.
 *          urgency 'close' → D+1 종가.  paper: 일봉 종가.
 *   비용 — backtest-swing-kr.js CFG.costs 상수 공유.
 *
 * 페이퍼 중단: ledger 자본 최고점 대비 -10% 이하 → orders 무시 + 텔레그램.
 *   재개: ops/status.json { status: 'active' } 으로 수동 변경.
 *
 * 킬스위치: ops/killswitch 파일 존재 시 모든 주문 skip.
 *
 * live 모드: 함수 시그니처만. 본체는 throw '미구현'.
 *
 * 사용:
 *   node executor.js --mode paper --date 20260919
 *   node executor.js --mode paper   (날짜 생략 시 오늘 orders 읽음)
 * ============================================================ */
'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');
const { CFG: BCFG } = require('./backtest-swing-kr.js');
const { loadCandles } = require('./kisData.js');
const u = require('./engineUtil.js');
global.G = { marketPhase: 'PRIME', spyAboveMA200: null, spyIntraday: null, _isNxtHours: false };
global.document = { getElementById: () => null };
global.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
global.saveJournal = () => {};
global.getTimeAwareness = u.getTimeAwareness;
global.tradeHoldDays    = u.tradeHoldDays;
global.parseTradeDate   = u.parseTradeDate;

// ── 설정 ──────────────────────────────────────────────────
const CFG = {
  costs:           BCFG.costs,             // { commissionPct:0.015, taxSellPct:0.20, slipPct:0.10 }
  gapSkipPct:      BCFG.gapSkipPct,        // 3 — 갭업 스킵 임계
  haltDrawdownPct: 10,                     // 최고점 대비 -10% 낙폭 → halt
  killswitchPath:  path.join(__dirname, 'ops', 'killswitch'),
  statusFile:      path.join(__dirname, 'ops', 'status.json'),
  ordersDir:       path.join(__dirname, 'orders'),
  positionsFile:   path.join(__dirname, 'positions.json'),
  ledgerFile:      path.join(__dirname, 'ledger.csv'),
  fillsFile:       path.join(__dirname, 'fills.csv'),
  workerUrl:       'https://recon.miinonnnn.workers.dev', // 텔레그램 프록시 [★ 결정 지점: 인증 방식 확인 후 활성화]
};

// ── 유틸 ──────────────────────────────────────────────────
const readJson  = (p, dflt) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch(_){ return dflt; } };
const writeJson = (p, obj)  => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); };
const ymdOf = d => d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
const round2 = v => Math.round(v * 100) / 100;

function parseArgs(argv){
  const o = { mode: 'paper', date: null };
  for(let i = 0; i < argv.length; i++){
    if(argv[i] === '--mode') o.mode = argv[++i];
    if(argv[i] === '--date') o.date = argv[++i];
  }
  return o;
}

// ── killswitch ────────────────────────────────────────────
function isKillswitchActive(){
  return fs.existsSync(CFG.killswitchPath);
}

// ── halt 체크 ─────────────────────────────────────────────
function isHalted(){
  const s = readJson(CFG.statusFile, { status: 'active', peakEquity: 0 });
  return s.status === 'halted';
}
function checkAndUpdateHalt(equity){
  const s = readJson(CFG.statusFile, { status: 'active', peakEquity: 0 });
  const peak = Math.max(s.peakEquity || 0, equity);
  const drawdown = peak > 0 ? (equity - peak) / peak * 100 : 0;
  const halted   = drawdown <= -CFG.haltDrawdownPct;
  writeJson(CFG.statusFile, Object.assign({}, s, { peakEquity: peak, lastEquity: equity, drawdownPct: round2(drawdown), status: halted ? 'halted' : s.status }));
  return { halted, peak, drawdown };
}

// ── 텔레그램 알림 ─────────────────────────────────────────
// [★ 결정 지점] Worker /reconkr/telegram POST 방식 사용. 인증 확인 전까지 console.warn 폴백.
function sendAlert(text){
  console.log('[ALERT]', text);
  // TODO: Worker /reconkr/telegram 인증 방식 확정 후 아래 활성화
  // const body = JSON.stringify({ text });
  // ... https.request(CFG.workerUrl + '/reconkr/telegram', { method:'POST', ... })
}

// ── 장부 기록 ─────────────────────────────────────────────
function appendLedger(row){
  // row: { date, equity, cash, holdValue, realizedPnl }
  if(!fs.existsSync(CFG.ledgerFile))
    fs.writeFileSync(CFG.ledgerFile, '일자,자본,현금,보유평가,실현손익\n');
  fs.appendFileSync(CFG.ledgerFile,
    [row.date, row.equity, row.cash, row.holdValue, row.realizedPnl].join(',') + '\n');
}
function appendFill(fill){
  // fill: { date, code, action, qty, price, notional, cost, requestId }
  if(!fs.existsSync(CFG.fillsFile))
    fs.writeFileSync(CFG.fillsFile, '일자,종목,매수매도,수량,체결가,체결금액,비용,requestId\n');
  fs.appendFileSync(CFG.fillsFile,
    [fill.date, fill.code, fill.action, fill.qty, fill.price,
     fill.notional, round2(fill.cost), fill.requestId || ''].join(',') + '\n');
}

// ── 비용 계산 ─────────────────────────────────────────────
function calcCost(action, notional){
  const c = CFG.costs;
  if(action === 'BUY')  return notional * (c.commissionPct + c.slipPct) / 100;
  if(action === 'SELL') return notional * (c.commissionPct + c.taxSellPct + c.slipPct) / 100;
  return 0;
}

// ── paper 체결 ────────────────────────────────────────────
// dayCandles[0] = 해당일 봉. 없으면 null 반환 → 체결 실패.
function paperFillPrice(order, dayCandles){
  if(!dayCandles || !dayCandles.length) return null;
  const d = dayCandles[0];
  const open  = parseFloat(d.stck_oprc);
  const close = parseFloat(d.stck_clpr);
  if(order.action === 'BUY'){
    // 갭업 스킵: 시가 > entry × (1 + gapSkipPct/100) → 취소
    if(open > order.price * (1 + CFG.gapSkipPct / 100)){
      return { skip: true, reason: '갭업 스킵: 시가 ' + open + ' > entry×1.0' + CFG.gapSkipPct };
    }
    // 계획 무효: 시가 ≤ stop
    if(order.plan && open <= order.plan.stop){
      return { skip: true, reason: '시가(' + open + ') ≤ stop(' + order.plan.stop + ') — 계획 무효' };
    }
    return { price: open };
  }
  if(order.action === 'SELL'){
    return { price: order.urgency === 'close' ? close : open };
  }
  return null;
}

// ── live 체결 (미구현 stub) ───────────────────────────────
function liveFill(order, requestId){ // eslint-disable-line no-unused-vars
  throw new Error('live 모드 미구현 — Worker /order 프록시 연동 후 활성화');
}

// ── positions.json 갱신 ───────────────────────────────────
function applyFillToPositions(positions, fill, order){
  if(fill.action === 'BUY'){
    positions.push({
      code: order.code, name: order.name || order.code,
      mode: 'swing', entry: fill.price, shares: fill.qty, remaining: fill.qty,
      stop: order.plan ? order.plan.stop : null,
      t1: order.plan ? order.plan.t1 : null,
      t2: order.plan ? order.plan.t2 : null,
      date: fill.date, status: 'open', exitState: null,
    });
  } else {
    const idx = positions.findIndex(p => p.code === fill.code && (p.status === 'open' || p.status === 'partial'));
    if(idx === -1) return;
    const pos = positions[idx];
    pos.remaining = Math.max(0, (pos.remaining || pos.shares) - fill.qty);
    if(pos.remaining === 0) pos.status = 'closed';
    else pos.status = 'partial';
  }
}

// ── 메인 ─────────────────────────────────────────────────
async function main(){
  const args = parseArgs(process.argv.slice(2));
  if(args.mode !== 'paper' && args.mode !== 'live'){
    console.error('--mode paper | live'); process.exit(1);
  }
  if(args.mode === 'live'){
    // live 모드: 인터페이스만. 실제 주문 stub은 liveFill()에.
    throw new Error('live 모드 미구현 — 페이퍼 검증 완료 후 활성화');
  }

  const today = args.date || ymdOf(new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })));
  console.log('[executor] mode=' + args.mode + ' date=' + today);

  // 1. 킬스위치
  if(isKillswitchActive()){
    console.log('[KILLSWITCH] ops/killswitch 감지 — 모든 주문 skip');
    return;
  }

  // 2. halt 체크 (이전 ledger 기준)
  if(isHalted()){
    console.log('[HALT] 자본 낙폭 -' + CFG.haltDrawdownPct + '% 초과 상태 — 재개 전까지 skip');
    return;
  }

  // 3. orders 파일 읽기 (없으면 휴장 또는 bot 미실행)
  const ordersFile = path.join(CFG.ordersDir, today + '.json');
  if(!fs.existsSync(ordersFile)){
    console.log('[SKIP] orders/' + today + '.json 없음 — 휴장 또는 bot 미실행');
    return;
  }
  const orders = readJson(ordersFile, null);
  if(!orders){ console.error('orders 파싱 실패'); process.exit(1); }

  // 4. positions.json + 자본
  const positions = readJson(CFG.positionsFile, []);
  const openPos   = positions.filter(p => p && (p.status === 'open' || p.status === 'partial'));
  // 자본: ledger 마지막 행에서 읽거나 account.json 폴백 — [TODO: ledger 파싱 구현]
  let equity = 1000000; // TODO: ledger 최신 행에서 읽기
  let cash   = equity;  // TODO: 보유평가 차감

  // 5. 매도 집행 (exits)
  const fills = [];
  for(const order of (orders.exits || [])){
    const dayCandles = await loadCandles(order.code, 1).catch(() => null);
    const result = args.mode === 'paper' ? paperFillPrice(order, dayCandles) : liveFill(order, null);
    if(!result || result.skip){
      console.log('[SKIP SELL] ' + order.code + ' — ' + (result && result.reason || '봉 없음'));
      continue;
    }
    const notional = result.price * order.qty;
    const cost     = calcCost('SELL', notional);
    const pnl      = notional - cost; // [TODO: 매입원가 차감 실현손익]
    const fill     = { date: today, code: order.code, action: 'SELL', qty: order.qty, price: result.price, notional, cost, requestId: order.requestId || '' };
    fills.push(fill);
    appendFill(fill);
    applyFillToPositions(positions, fill, order);
    cash  += pnl;
    equity = cash; // [TODO: 보유평가 합산]
    console.log('  SELL ' + order.code + ' ' + order.qty + '주 @' + result.price + ' urgency=' + order.urgency);
  }

  // 6. 매수 집행 (entries)
  for(const order of (orders.entries || [])){
    const dayCandles = await loadCandles(order.code, 1).catch(() => null);
    const result = args.mode === 'paper' ? paperFillPrice(order, dayCandles) : liveFill(order, null);
    if(!result || result.skip){
      console.log('[SKIP BUY] ' + order.code + ' — ' + (result && result.reason || '봉 없음'));
      continue;
    }
    const notional = result.price * order.qty;
    const cost     = calcCost('BUY', notional);
    const fill     = { date: today, code: order.code, action: 'BUY', qty: order.qty, price: result.price, notional, cost, requestId: order.requestId || '' };
    fills.push(fill);
    appendFill(fill);
    applyFillToPositions(positions, fill, order);
    cash  -= (notional + cost);
    equity = cash; // [TODO: 보유평가 합산]
    console.log('  BUY  ' + order.code + ' ' + order.qty + '주 @' + result.price);
  }

  // 7. positions.json 저장
  writeJson(CFG.positionsFile, positions);

  // 8. ledger 기록
  const holdValue = 0; // [TODO: openPos 시가 합산]
  appendLedger({ date: today, equity: round2(equity), cash: round2(cash), holdValue, realizedPnl: 0 });

  // 9. halt 재평가
  const { halted, drawdown } = checkAndUpdateHalt(equity);
  if(halted){
    sendAlert('⚠️ RECONKR PAPER HALT — 낙폭 ' + round2(Math.abs(drawdown)) + '% (' + equity.toLocaleString() + '원)');
    console.log('[HALT] 낙폭 ' + round2(Math.abs(drawdown)) + '% — 이후 orders skip');
  }

  console.log('[executor] 완료 · fills=' + fills.length + ' equity=' + equity);
}

module.exports = { CFG, isKillswitchActive, checkAndUpdateHalt, paperFillPrice, calcCost };
if(require.main === module) main().catch(e => { console.error(e); process.exit(1); });
