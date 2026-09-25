/* ============================================================
 * RECONKR SWING 라이브 봇 — bot-live.js (Node)
 *
 * "백테스트의 라이브 모드". 새 판단 코드를 만들지 않는다:
 *   - 진입: swingEval.evaluateEntry (backtest-swing-kr.js와 동일 함수·동일 규약)
 *   - 청산: exitEngine (앱과 동일 엔진, trade-plan 레벨)
 *   - 사이징: sizeEngine (원 단위 · 정수 주)
 *
 * 실행 시각: KST 15:40 이후 (당일 봉 확정 후). 그 전에 돌리면 confirmedCandles가 오늘봉을 버려
 *   "어제 기준 평가"가 되므로 --force-today 없이는 경고 후 중단.
 *
 * 입출력 (Firestore/디스패처 연동은 이 파일 밖 — 계약만 고정):
 *   입력  positions.json   보유 포지션 배열 [{code,name,mode,entry,shares,remaining,stop,t1,t2,date,status,exitState}]
 *   입력  account.json     { equity, cashAvailable }   (없으면 --equity 인자)
 *   출력  signals/YYYYMMDD.json
 *         { asOf, market:{kospiClose, aboveMA120, chgPct}, entries:[...], exits:[...], skipped:[...] }
 *         entries[i] = { code, action:'BUY', orderType:'limit', price:entry, qty, validFor:'next_open',
 *                        plan:{entry,stop,t1,t2,src}, grade, score, sizing, decision_path }
 *         exits[i]   = { code, action:'SELL', qty, pct, urgency, reason, engine:{hold_action,stop,t1,t2} }
 *   --emit-orders  : 위 entries/exits를 orders/YYYYMMDD.json 로도 기록 (실행기가 읽어 requestId 부여)
 *   --paper        : 기본. 기록만 한다. 이 파일은 어떤 모드에서도 주문 API를 직접 호출하지 않는다.
 *
 * 사용:
 *   node bot-live.js                              (universe.json · positions.json · account.json)
 *   node bot-live.js --equity 1000000 --emit-orders
 *   node bot-live.js --universe kospi200.json --asof 20260915   (특정 확정일 기준 재현)
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

// ── 브라우저 전역 스텁 (엔진 로드 전) ──
global.G = { marketPhase: 'PRIME', spyAboveMA200: null, spyIntraday: null, _isNxtHours: false };
global.document = { getElementById: () => null };
global.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
global.saveJournal = () => {};
const u = require('./engineUtil.js');
global.getTimeAwareness = u.getTimeAwareness; global.tradeHoldDays = u.tradeHoldDays; global.parseTradeDate = u.parseTradeDate;

const { exitEngine, EXIT_CFG, setExitPersist } = require('./exitEngine.js');
const { sizeEngine } = require('./sizeEngine.js');
const { loadCandles, loadIndexCandles } = require('./kisData.js');
const { confirmedCandles } = require('./indicatorEngine.js');
const { buildIndexMap, buildEngineCtx, evaluateEntry, planFromResult, atr20FromKisCandles, f2 } = require('./swingEval.js');

const CFG = {
  historyDays: 200,                    // MA120·RSI 워밍업 충분
  indexCode: '0001',
  size: { riskPctPerTrade: 1.5, maxPositionPct: 20, allowFractional: false, minShares: 1, currency: '₩' },
  paperInitialEquity: 1000000,         // ledger 첫 행 전 초기 자본 (executor.js readLatestLedger(1000000)과 동일값)
  maxNewEntriesPerDay: 2,              // 100만원 실험: 하루 신규 진입 상한
  maxOpenPositions: 4,                 // 20% 캡 × 4 = 80% 이하
  t1SellPct: 100,                      // T1 도달 시 전량 익절 (백테스트 V1 T1-100 기준)
  gradeToType: { A: 'A', B: 'B' },     // swing_grade → sizeEngine typeRiskMult (A×1.0, B×0.6)
};

function parseArgs(argv){
  const o = { universeFile: null, positionsFile: 'positions.json', accountFile: 'account.json', equity: null, asof: null, emitOrders: false, forceToday: false };
  for(let i = 0; i < argv.length; i++){
    const a = argv[i];
    if(a === '--universe') o.universeFile = argv[++i];
    else if(a === '--positions') o.positionsFile = argv[++i];
    else if(a === '--account') o.accountFile = argv[++i];
    else if(a === '--equity') o.equity = parseFloat(argv[++i]);
    else if(a === '--asof') o.asof = argv[++i];
    else if(a === '--emit-orders') o.emitOrders = true;
    else if(a === '--force-today') o.forceToday = true;
  }
  return o;
}
const readJson = (p, dflt) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch(e){ return dflt; } };
// executor가 기록한 ledger.csv 마지막 행(일자,자본,현금,...)에서 계좌 복원. 헤더뿐이거나 없으면 null.
function readLedgerAccount(){
  try{
    const lines = fs.readFileSync(path.join(__dirname, 'ledger.csv'), 'utf-8').trim().split('\n');
    const last = lines[lines.length - 1];
    if(!last || last.startsWith('일자')) return null;
    const c = last.split(',');
    const equity = parseFloat(c[1]), cash = parseFloat(c[2]);
    return equity > 0 ? { equity: equity, cashAvailable: cash >= 0 ? cash : equity } : null;
  }catch(e){ return null; }
}
function kstNow(){ return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })); }
const ymdOf = d => d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');

// asof 기준으로 캔들 자르기 (재현용) + 확정봉 필터
function asOfCandles(candles, asof){
  let c = confirmedCandles(candles, {});           // 15:35 전이면 오늘봉 제거
  if(asof) c = c.filter(x => x.stck_bsop_date <= asof);
  return c;
}

async function main(){
  const args = parseArgs(process.argv.slice(2));
  const now = kstNow();
  const hm = now.getHours() * 100 + now.getMinutes();
  if(!args.asof && hm < 1535 && !args.forceToday){
    console.error('⚠ KST 15:35 이전 — 오늘 봉 미확정. 평가 기준이 "어제"가 됩니다. 재현이 목적이면 --asof YYYYMMDD, 그래도 돌리려면 --force-today.');
    process.exit(2);
  }

  const universeFile = args.universeFile ? path.resolve(args.universeFile) : path.join(__dirname, 'universe.json');
  const universe = readJson(universeFile, null);
  if(!universe){ console.error(universeFile + ' 없음'); process.exit(1); }
  const positions = readJson(path.resolve(args.positionsFile), []);
  let src = 'account.json';
  let account = readJson(path.resolve(args.accountFile), null);
  if(!account && args.equity > 0){ account = { equity: args.equity, cashAvailable: args.equity }; src = '--equity'; }
  if(!account){ account = readLedgerAccount(); src = 'ledger.csv'; }
  if(!account){ account = { equity: CFG.paperInitialEquity, cashAvailable: CFG.paperInitialEquity }; src = 'paperInitialEquity'; }
  console.log('[account] source=' + src + ' equity=' + account.equity + ' cash=' + account.cashAvailable);
  if(!(account.equity > 0)){ console.error('계좌 평가액 없음 — account.json 또는 --equity'); process.exit(1); }
  const openPos = positions.filter(p => p && (p.status === 'open' || p.status === 'partial'));

  // 시장 컨텍스트
  let indexMap = null, asOfYmd = args.asof;
  try{
    const ic = asOfCandles(await loadIndexCandles(CFG.indexCode, CFG.historyDays + 130), args.asof);
    indexMap = buildIndexMap(ic);
    if(!asOfYmd && ic.length) asOfYmd = ic[0].stck_bsop_date;
  }catch(e){ console.warn('KOSPI 지수 로드 실패 → 중립 게이트:', e.message); }
  const mkt = (indexMap && asOfYmd && indexMap[asOfYmd]) || null;
  const out = {
    asOf: asOfYmd, ranAt: new Date().toISOString(), regime: 'PRIME(확정봉)',
    market: mkt ? { kospiClose: mkt.close, aboveMA120: mkt.aboveMA120, chgPct: mkt.chgPct } : null,
    account: { equity: account.equity, cashAvailable: account.cashAvailable ?? account.equity, openPositions: openPos.length },
    entries: [], exits: [], skipped: [],
  };

  // ── 1. 보유 포지션 청산 판정 (D일 종가 기준) ──
  setExitPersist(() => {});   // 봇은 여기서 저장하지 않음 — exitState 변이는 출력 JSON으로 전달
  for(const pos of openPos){
    let candles;
    try{ candles = asOfCandles(await loadCandles(pos.code, 40, {confirmedToday:true}), args.asof); }
    catch(e){ out.skipped.push({ code: pos.code, why: '일봉 로드 실패: ' + e.message }); continue; }
    if(!candles.length){ out.skipped.push({ code: pos.code, why: '일봉 없음' }); continue; }
    const close = parseFloat(candles[0].stck_clpr);
    const ma5 = candles.slice(0, 5).reduce((s, c) => s + parseFloat(c.stck_clpr), 0) / Math.min(5, candles.length);
    const nowMs = args.asof ? new Date(asOfYmd.slice(0, 4), +asOfYmd.slice(4, 6) - 1, +asOfYmd.slice(6, 8), 15, 40).getTime() : Date.now();
    const trade = Object.assign({}, pos, { mode: pos.mode || 'swing' });
    const r = exitEngine(trade.mode, trade, { price: close, now: nowMs, hm: 1540, swingData: { ma5 } });
    const rem = trade.remaining || trade.shares || 0;
    if(r.hold_action === 'SELL_ALL' || r.hold_action === 'SELL_HALF'){
      const pct = r.hold_action === 'SELL_ALL' ? 100 : 50;
      out.exits.push({
        code: pos.code, name: pos.name || null, action: 'SELL', orderType: 'market', validFor: 'next_open',
        qty: Math.max(1, Math.floor(rem * pct / 100)), pct, urgency: r.urgency, reason: r.reason,
        engine: { hold_action: r.hold_action, stop: r.stop, t1: r.t1, t2: r.t2, trailing_stop: r.trailing_stop },
        exitState: trade.exitState, closeUsed: close, decision_path: r.decision_path,
      });
    }
  }

  // ── 2. 신규 진입 평가 (유니버스 전체 · 백테스트와 동일 함수) ──
  const heldCodes = new Set(openPos.map(p => p.code));
  const candidates = [];
  for(const code of universe){
    if(heldCodes.has(code)) continue;
    let candles;
    try{ candles = asOfCandles(await loadCandles(code, CFG.historyDays, {confirmedToday:true}), args.asof); }
    catch(e){ out.skipped.push({ code, why: '일봉 로드 실패: ' + e.message }); continue; }
    if(candles.length < 65){ out.skipped.push({ code, why: '일봉 부족 ' + candles.length }); continue; }
    if(candles[0].stck_bsop_date !== asOfYmd){ out.skipped.push({ code, why: '최신 봉 날짜 불일치 ' + candles[0].stck_bsop_date + ' ≠ ' + asOfYmd + ' (거래정지·데이터 지연 의심)' }); continue; }
    const ctx = buildEngineCtx(indexMap, asOfYmd);
    const { r, price } = evaluateEntry(candles, ctx);
    if(r.action !== 'ENTER') continue;
    const atr20 = atr20FromKisCandles(candles);
    const plan = planFromResult(r, price, EXIT_CFG.swing, atr20);
    if(!plan){ out.skipped.push({ code, why: 'ENTER지만 레벨 무효 (stop≥entry 또는 t1≤entry)' }); continue; }
    candidates.push({ code, r, plan, price });
  }
  // 점수 높은 순, 하루 상한·보유 상한 적용
  candidates.sort((a, b) => b.r.score - a.r.score);
  const slots = Math.max(0, Math.min(CFG.maxNewEntriesPerDay, CFG.maxOpenPositions - openPos.length + out.exits.filter(e => e.pct === 100).length));
  let cash = account.cashAvailable ?? account.equity;
  for(const c of candidates){
    if(out.entries.length >= slots){ out.skipped.push({ code: c.code, why: '일일/보유 상한 도달 (score ' + c.r.score + ')' }); continue; }
    const sz = sizeEngine(
      { ticker: c.code, entry: c.plan.entry, stop: c.plan.stop, type: CFG.gradeToType[c.r.swing_grade] || null, action: 'ENTER' },
      { equity: account.equity, cashAvailable: cash },
      CFG.size
    );
    if(sz.skip){ out.skipped.push({ code: c.code, why: '사이징 스킵: ' + sz.reasons.join(' / ') }); continue; }
    cash -= sz.notional;
    out.entries.push({
      code: c.code, action: 'BUY', orderType: 'limit', price: c.plan.entry, qty: sz.shares, validFor: 'next_open',
      plan: c.plan, t1SellPct: CFG.t1SellPct, grade: c.r.swing_grade, score: c.r.score, layers: c.r.swing_score_layers,
      sizing: { notional: sz.notional, riskAmount: sz.riskAmount, riskPctActual: sz.riskPctActual, boundBy: sz.boundBy, note: sz.multNote },
      closeUsed: c.price, signals: c.r.signals, warnings: c.r.warnings, decision_path: c.r.decision_path,
    });
  }

  // ── 3. 출력 ──
  fs.mkdirSync(path.join(__dirname, 'signals'), { recursive: true });
  const sigFile = path.join(__dirname, 'signals', (asOfYmd || ymdOf(now)) + '.json');
  fs.writeFileSync(sigFile, JSON.stringify(out, null, 2));
  if(args.emitOrders){
    fs.mkdirSync(path.join(__dirname, 'orders'), { recursive: true });
    const ordFile = path.join(__dirname, 'orders', (asOfYmd || ymdOf(now)) + '.json');
    fs.writeFileSync(ordFile, JSON.stringify({ asOf: out.asOf, source: 'bot-live', entries: out.entries, exits: out.exits }, null, 2));
    console.log('→ 주문 제안 기록: ' + ordFile + ' (실행기가 requestId 부여 후 프록시 호출)');
  }
  console.log('asOf ' + out.asOf + ' · KOSPI ' + (mkt ? (mkt.aboveMA120 ? 'MA120 위' : 'MA120 아래') + ' ' + (mkt.chgPct ?? '?') + '%' : '중립'));
  console.log('보유 ' + openPos.length + ' · 청산 ' + out.exits.length + ' · 신규 ' + out.entries.length + ' · 스킵 ' + out.skipped.length);
  out.exits.forEach(e => console.log('  SELL ' + e.code + ' ' + e.qty + '주 (' + e.pct + '%) — ' + e.reason));
  out.entries.forEach(e => console.log('  BUY  ' + e.code + ' ' + e.qty + '주 @' + e.price + ' [' + (e.grade || '-') + ' ' + e.score + 'pt] stop ' + e.plan.stop + ' t1 ' + e.plan.t1 + ' t2 ' + e.plan.t2));
  console.log('→ ' + sigFile);
}

module.exports = { CFG, asOfCandles };
if(require.main === module) main().catch(e => { console.error(e); process.exit(1); });
