/* ============================================================
 * RECONKR SWING 백테스트 — backtest-swing-kr.js (Node 전용)
 *
 * 원칙: 엔진 코드를 복제하지 않는다. 추출된 swingEngine.js를 그대로 로드해
 *   실제 운영과 동일한 판단을 재생한다. 지표도 indicatorEngine.js(앱과 단일 소스).
 *
 * 시뮬레이션 모델 (가정은 전부 여기 명시 — 결과 해석 시 참조):
 *   [평가]  D일 확정 일봉 기준, 장중(PRIME) 평가로 근사 (앱의 15:20 장 마감 직전 분석 재현)
 *   [진입]  ENTER 시 D+1 시가 체결. 시가가 엔진 entry보다 gapSkipPct% 이상 위면 미체결 스킵.
 *           시가가 이미 손절선 아래면 계획 무효 스킵.
 *   [청산]  exitEngine 사다리를 일봉 OHLC로 미러링 (동시터치는 손절 우선 — 보수적):
 *           P0 스탑(저가 터치, 갭이면 시가 체결) → P1/P2 T2/T1(고가 터치, 갭업이면 시가)
 *           → P3 MA5×0.995 종가 이탈(T1 후) → P4 트레일링(전일까지 고점 기준 — 룩어헤드 방지)
 *           → P5 시간청산(보유 timeDays↑ & 손익 < timeMinPnl%, 종가)
 *   [비용]  매수: 수수료+슬리피지 / 매도: 수수료+거래세+슬리피지 (CFG.costs)
 *   [시장]  KOSPI 지수 일봉(data/kr-index/0001.json) 연동 — D일 기준 MA120 위/아래 + 당일 등락률 (2026-09)
 *           --no-index 이면 중립(null) — 이전 버전과 동일
 *   [레벨]  stop/T1/T2 = swingEngine 계산값 (앱 initExitState도 2026-09부터 trade-plan 우선 → 앱=백테스트=봇)
 *   [한계]  뉴스 없음(TOXIC 필터 중립) · rs20 없음(운영 KIS 경로와 동일) ·
 *           calcSwingExitSignals 중 MA5 외 신호 미반영 · 수정주가('1') 기준
 *
 * 실행:  node backtest-swing-kr.js                       (universe.json 전 종목)
 *        node backtest-swing-kr.js 005930 000660          (지정 종목만)
 *        node backtest-swing-kr.js --universe kospi200.json
 *        node backtest-swing-kr.js --no-index             (KOSPI 게이트 중립 — 구버전 비교)
 *   평가 로직은 swingEval.js — 라이브 봇(bot-live.js)과 동일 함수 사용
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

// ── 브라우저 전역 스텁 (엔진 로드 전 필수) ──
global.G = { marketPhase: 'PRIME', spyAboveMA200: null, spyIntraday: null, _isNxtHours: false };  // spyAboveMA200은 main()에서 CFG 반영
global.document = { getElementById: () => null };   // 엔진 설정값은 _swCfg fallback 사용
global.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
global.saveJournal = () => {};

const { getTimeAwareness } = require('./engineUtil.js');
global.getTimeAwareness = getTimeAwareness;
const { EXIT_CFG } = require('./exitEngine.js');
const { loadCandles, loadIndexCandles } = require('./kisData.js');
const { confirmedCandles } = require('./indicatorEngine.js');
const { buildIndexMap, buildEngineCtx, evaluateEntry, planFromResult } = require('./swingEval.js');

// ── 설정 ──
const CFG = {
  historyDays: 780,          // 확보할 일봉 수 (~3년)
  warmup: 60,                // 지표 안정화 기간 (MA60)
  gapSkipPct: 3,             // D+1 시가가 엔진 entry 대비 +3% 이상 갭업 → 미체결
  costs: {
    commissionPct: 0.015,    // 편도 수수료 %
    taxSellPct:    0.20,     // 매도 거래세+농특세 % (시장/연도별로 조정할 것)
    slipPct:       0.10,     // 편도 슬리피지 %
  },
  exit: Object.assign({}, EXIT_CFG.swing),  // 운영 기본값 그대로 (stopPct -3.5, t1R 1.5, t2R 3.0, trailPct 7, timeDays 14, timeMinPnl 1)
  t1SellPctVariants: [50, 100],  // US 백테스트 핵심 질문 재현: T1 절반 vs 전량
  useEngineStops: true,      // true: 엔진이 준 stop/t1/t2 사용. false: EXIT_CFG R배수로 재계산 (앱 initExitState 방식)
  kospiAboveMA200: null,     // --no-index 일 때만 사용되는 고정 가정 (true/false/null)
  useIndex: true,            // KOSPI 지수 시계열 연동 (기본 on)
  indexCode: '0001',         // 0001 KOSPI / 1001 KOSDAQ
  // 통과 기준 — 이걸 못 넘으면 100만원도 넣지 않는다
  pass: { minTrades: 100, minAvgPnl: 0.0, minPF: 1.3, maxMDD: -15 },
};

const N = v => (typeof v === 'number' && isFinite(v)) ? v : null;
const f2 = v => Math.round(v * 100) / 100;

// KIS 캔들 → 숫자 바 (백테스트 내부용)
function bar(c){
  return {
    ymd: c.stck_bsop_date,
    o: parseFloat(c.stck_oprc), h: parseFloat(c.stck_hgpr),
    l: parseFloat(c.stck_lwpr), c: parseFloat(c.stck_clpr),
    v: parseFloat(c.acml_vol) || 0,
    tv: parseFloat(c.acml_tr_pbmn) || 0,   // 누적 거래대금 (원)
  };
}

// MA5 (종가, day index j 기준 — candles 최신 index 0, j 포함 5일)
function ma5At(bars, j){
  if(j + 5 > bars.length) return null;
  let s = 0; for(let k = j; k < j + 5; k++) s += bars[k].c;
  return s / 5;
}

// ATR20 (True Range 20일 평균 — V1/V2/V3 손절 재배치용)
function atr20At(bars, j){
  if(j + 21 > bars.length) return null;
  let sum = 0;
  for(let k = j; k < j + 20; k++){
    const prev_c = bars[k + 1].c;
    const tr = Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - prev_c), Math.abs(bars[k].l - prev_c));
    sum += tr;
  }
  return sum / 20;
}

// ── 한 종목 백테스트 ──
// variant: null=기존, 'v1'=ATR stop, 'v2'=v1+score≥80, 'v3'=v1+pullback_to_ma20
function backtestTicker(code, candles, t1SellPct, trades, indexMap, variant){
  const bars = candles.map(bar);
  const total = candles.length;
  if(total < CFG.warmup + 10) return;

  let openPos = null;  // 동시 1포지션 (앱 사용 패턴)

  // 시간 역행 방지: j = 과거(큰 index) → 현재(작은 index)
  for(let j = total - 1 - CFG.warmup; j >= 1; j--){
    const today = bars[j];

    // ══ 1. 보유 중이면 청산 사다리 (오늘 봉으로) ══
    if(openPos){
      const p = openPos;
      const dayN = p.entryJ - j;                       // 보유 영업일
      // 트레일링 라인은 "전일까지의 고점" 기준 (룩어헤드 방지)
      const trailLine = p.t1Done ? p.hw * (1 - CFG.exit.trailPct / 100) : -Infinity;
      const effStop = Math.max(p.stop, p.t1Done ? trailLine : -Infinity);

      let exited = false;
      // P0/P4: 스탑·트레일 (저가 터치 — 갭 하향 시 시가 체결)
      if(today.l <= effStop){
        const fill = today.o < effStop ? today.o : effStop;
        closeOut(p, fill, today.ymd, p.t1Done ? (trailLine > p.stop ? 'trail' : 'stop_be') : 'stop', trades, t1SellPct);
        exited = true;
      }
      // P1/P2: T2 / T1 (고가 터치 — 갭업 시 시가 체결)
      if(!exited && today.h >= p.t2 && (!p.t1Done || true)){
        if(t1SellPct >= 100 || p.t1Done){
          closeOut(p, Math.max(today.o, p.t2), today.ymd, 't2', trades, t1SellPct);
        } else {
          // 같은 봉에서 T1→T2 순차 도달 가정 (상승 봉)
          p.t1Fill = Math.max(today.o, p.t1); p.t1Ymd = today.ymd; p.t1Done = true;
          closeOut(p, Math.max(today.o, p.t2), today.ymd, 't1+t2', trades, t1SellPct);
        }
        exited = true;
      }
      if(!exited && !p.t1Done && today.h >= p.t1){
        if(t1SellPct >= 100){
          closeOut(p, Math.max(today.o, p.t1), today.ymd, 't1_full', trades, t1SellPct);
          exited = true;
        } else {
          p.t1Fill = Math.max(today.o, p.t1); p.t1Ymd = today.ymd;
          p.t1Done = true;
          if(p.stop < p.entryFill) p.stop = p.entryFill;   // BE 이동 (앱 P2와 동일)
          p.hw = Math.max(p.hw, today.h);
        }
      }
      // P3: T1 이후 MA5 종가 이탈
      if(!exited && p.t1Done){
        const m5 = ma5At(bars, j);
        if(m5 && today.c < m5 * 0.995){
          closeOut(p, today.c, today.ymd, 'ma5_close', trades, t1SellPct);
          exited = true;
        }
      }
      // P5: 시간 청산
      if(!exited){
        const pnlNow = (today.c / p.entryFill - 1) * 100;
        if(dayN >= CFG.exit.timeDays && pnlNow < CFG.exit.timeMinPnl){
          closeOut(p, today.c, today.ymd, 'time', trades, t1SellPct);
          exited = true;
        }
      }
      if(!exited){ p.hw = Math.max(p.hw, today.h); continue; }
      openPos = null;
      continue;  // 청산한 날은 신규 진입 안 함 (앱 사용 패턴)
    }

    // ══ 2. 신규 진입 판정 (D일 확정봉 · swingEval — 봇과 동일 함수) ══
    if(j < 2) break;                       // D+1 필요
    const hist = candles.slice(j);         // [D일, D-1, ...] — 최신 index 0 (전부 확정봉)
    var ctxOverride = indexMap ? null : { spyAboveMA200: CFG.kospiAboveMA200 };
    if(variant === 'v1b') ctxOverride = Object.assign({}, ctxOverride || {}, { spyIntraday: null });
    const ctx  = buildEngineCtx(indexMap, today.ymd, ctxOverride);
    const { r, price, sw } = evaluateEntry(hist, ctx);
    if(r.action !== 'ENTER') continue;
    if(variant === 'v2' && r.score < 80) continue;           // V2: 고점수 필터
    if(variant === 'v3' && !sw.pullback_to_ma20) continue;   // V3: 눌림목 필터

    // 레벨 확정 (variant있으면 ATR20 → V1 stop, 없으면 swingEngine 값 우선)
    const atrArg = variant ? atr20At(bars, j) : null;
    const plan = planFromResult(r, price, CFG.exit, atrArg);
    if(!plan) continue;
    const { entry, stop, t1, t2 } = plan;

    // D+1 시가 체결
    const nb = bars[j - 1];
    if(nb.o > entry * (1 + CFG.gapSkipPct / 100)) continue; // 갭업 미체결
    if(nb.o <= stop) continue;                              // 시가가 이미 손절 아래 — 계획 무효

    openPos = {
      code, entryYmd: nb.ymd, entryJ: j - 1,
      entryFill: nb.o, plan: { entry, stop, t1, t2 },
      stop, t1, t2, t1Done: false, t1Fill: null, t1Ymd: null,
      hw: nb.o,
      score: r.score, grade: r.swing_grade || null, condMet: r.conditions_met, planSrc: plan.src,
    };
    // 진입 당일 잔여 구간 청산 체크는 다음 루프(j-1)에서 오늘 봉으로 수행됨
  }
  if(openPos) closeOut(openPos, bars[0].c, bars[0].ymd, 'eod_open', trades, 999); // 기간 종료 시 미청산 — 마지막 종가 평가
}

// ── 청산 확정 + 비용 반영 손익 ──
function closeOut(p, finalFill, ymd, reason, trades, t1SellPct){
  const c = CFG.costs;
  const buyCost  = (c.commissionPct + c.slipPct) / 100;
  const sellCost = (c.commissionPct + c.taxSellPct + c.slipPct) / 100;
  const leg = (fill) => (fill * (1 - sellCost)) / (p.entryFill * (1 + buyCost)) - 1;

  let pnl;
  if(p.t1Done && p.t1Fill != null && t1SellPct < 100 && t1SellPct !== 999){
    const w = t1SellPct / 100;
    pnl = w * leg(p.t1Fill) + (1 - w) * leg(finalFill);
  } else {
    pnl = leg(finalFill);
  }
  trades.push({
    code: p.code, entryYmd: p.entryYmd, exitYmd: ymd, reason,
    entry: p.entryFill, exit: finalFill, t1Fill: p.t1Fill,
    stop: p.plan.stop, t1: p.plan.t1, t2: p.plan.t2,
    pnlPct: f2(pnl * 100),
    score: p.score, grade: p.grade, condMet: p.condMet,
    t1Hit: p.t1Done || reason.startsWith('t1') || reason === 't2',
  });
}

// ── 통계 ──
function summarize(label, trades){
  const closed = trades.filter(t => t.reason !== 'eod_open');
  const n = closed.length;
  if(!n){ console.log(label + ': 거래 없음'); return; }
  const pnls = closed.map(t => t.pnlPct);
  const wins = pnls.filter(p => p > 0);
  const sum = a => a.reduce((x, y) => x + y, 0);
  const avg = sum(pnls) / n;
  const winRate = wins.length / n * 100;
  const gross = sum(wins), loss = sum(pnls.filter(p => p <= 0));
  const pf = loss < 0 ? gross / -loss : Infinity;
  // 누적 곡선 MDD (거래 순서 = 진입일 순)
  closed.sort((a, b) => a.entryYmd.localeCompare(b.entryYmd));
  let eq = 0, peak = 0, mdd = 0;
  for(const t of closed){ eq += t.pnlPct; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq - peak); }
  const t1Rate = closed.filter(t => t.t1Hit).length / n * 100;
  const byReason = {};
  closed.forEach(t => { byReason[t.reason] = (byReason[t.reason] || 0) + 1; });

  console.log('\n══ ' + label + ' ══');
  console.log('거래 ' + n + '건 · 승률 ' + f2(winRate) + '% · 거래당 기대값(비용차감) ' + (avg >= 0 ? '+' : '') + f2(avg) + '%');
  console.log('PF ' + f2(pf) + ' · 누적 ' + f2(eq) + '% · MDD ' + f2(mdd) + '%p · T1 도달률 ' + f2(t1Rate) + '%');
  console.log('청산 사유:', JSON.stringify(byReason));
  // 점수 버킷
  [[70, 80], [80, 90], [90, 101]].forEach(([lo, hi]) => {
    const b = closed.filter(t => t.score >= lo && t.score < hi);
    if(b.length >= 5) console.log('  score ' + lo + '~' + (hi - 1) + ': ' + b.length + '건, 평균 ' + f2(sum(b.map(t => t.pnlPct)) / b.length) + '%, 승률 ' + f2(b.filter(t => t.pnlPct > 0).length / b.length * 100) + '%');
  });
  // 등급 버킷 (Grade A/B — D4 트리거 복구 후 A가 실제로 나오는지 확인용)
  ['A', 'B', null].forEach(g => {
    const b = closed.filter(t => (t.grade || null) === g);
    if(b.length >= 5) console.log('  grade ' + (g || '-') + ': ' + b.length + '건, 평균 ' + f2(sum(b.map(t => t.pnlPct)) / b.length) + '%, 승률 ' + f2(b.filter(t => t.pnlPct > 0).length / b.length * 100) + '%');
  });
  // 통과 판정
  const P = CFG.pass;
  const checks = [
    ['거래수 ≥ ' + P.minTrades, n >= P.minTrades],
    ['기대값 > ' + P.minAvgPnl + '%', avg > P.minAvgPnl],
    ['PF > ' + P.minPF, pf > P.minPF],
    ['MDD ≥ ' + P.maxMDD + '%p', mdd >= P.maxMDD],
  ];
  const passed = checks.every(c => c[1]);
  console.log((passed ? '✅ PASS' : '❌ FAIL') + ' — ' + checks.map(c => (c[1] ? '○' : '✗') + c[0]).join(' · '));
  return { label, n, winRate: f2(winRate), avg: f2(avg), pf: f2(pf), cum: f2(eq), mdd: f2(mdd), t1Rate: f2(t1Rate), byReason, passed };
}

function toCsv(trades){
  const head = 'code,entryYmd,exitYmd,reason,entry,exit,t1Fill,stop,t1,t2,pnlPct,score,grade,condMet,t1Hit';
  return head + '\n' + trades.map(t =>
    [t.code, t.entryYmd, t.exitYmd, t.reason, t.entry, t.exit, t.t1Fill ?? '', t.stop, t.t1, t.t2, t.pnlPct, t.score, t.grade ?? '', t.condMet, t.t1Hit].join(',')
  ).join('\n');
}

// ── 학습/검증 분리 요약 (V1/V2/V3용) ──
function summarizeSplit(label, trades){
  const CUTOFF = '20260101';
  const closed = trades.filter(t => t.reason !== 'eod_open');
  if(!closed.length){ console.log(label + ': 거래 없음'); return null; }

  function stats(arr){
    if(!arr.length) return null;
    const pnls = arr.map(t => t.pnlPct);
    const wins = pnls.filter(p => p > 0);
    const sum = a => a.reduce((x,y)=>x+y,0);
    const avg = sum(pnls)/arr.length;
    const pf = -sum(pnls.filter(p=>p<=0)) > 0 ? sum(wins) / -sum(pnls.filter(p=>p<=0)) : Infinity;
    arr.sort((a,b)=>a.entryYmd.localeCompare(b.entryYmd));
    let eq=0,peak=0,mdd=0;
    arr.forEach(t=>{eq+=t.pnlPct;peak=Math.max(peak,eq);mdd=Math.min(mdd,eq-peak);});
    return { n:arr.length, winRate:f2(wins.length/arr.length*100), avg:f2(avg), pf:f2(pf), cum:f2(eq), mdd:f2(mdd) };
  }

  const train = closed.filter(t=>t.entryYmd < CUTOFF);
  const test  = closed.filter(t=>t.entryYmd >= CUTOFF);
  const tr = stats(train), te = stats(test);

  console.log('\n══ ' + label + ' ══');
  if(tr) console.log('[학습 ~2025] ' + tr.n + '건 · 승률 ' + tr.winRate + '% · EV ' + (tr.avg>=0?'+':'') + tr.avg + '% · PF ' + tr.pf + ' · MDD ' + tr.mdd + '%p');
  if(te) console.log('[검증 2026]  ' + te.n + '건 · 승률 ' + te.winRate + '% · EV ' + (te.avg>=0?'+':'') + te.avg + '% · PF ' + te.pf + ' · MDD ' + te.mdd + '%p' + (te.avg > 0 ? ' ✅' : ' ❌'));

  // 손절폭 버킷
  [[0,1.5,'<1.5%'],[1.5,2.5,'1.5~2.5%'],[2.5,3.5,'2.5~3.5%'],[3.5,Infinity,'≥3.5%']].forEach(([lo,hi,lbl])=>{
    const bk = closed.filter(t=>{const sp = t.entry>0?(t.entry-t.stop)/t.entry*100:0; return sp>=lo&&sp<hi;});
    if(!bk.length) return;
    const pnls=bk.map(t=>t.pnlPct), wins=pnls.filter(p=>p>0);
    console.log('  손절폭 ' + lbl + ': ' + bk.length + '건 · EV ' + (pnls.reduce((s,p)=>s+p,0)/bk.length>=0?'+':'') + f2(pnls.reduce((s,p)=>s+p,0)/bk.length) + '% · 승률 ' + f2(wins.length/bk.length*100) + '%');
  });

  const passed = te && te.avg > 0;
  console.log(passed ? '✅ 검증구간 기대값 양수' : '❌ 검증구간 기대값 음수');
  return { label, train: tr, test: te, passed };
}

// ── 연도별 통계 (V1/V1b 비교용) ──
function summarizeYearly(label, trades){
  const YEARS = ['2023', '2024', '2025', '2026'];
  const closed = trades.filter(t => t.reason !== 'eod_open');
  if(!closed.length) return null;
  const sum = a => a.reduce((x,y)=>x+y,0);
  const result = {};
  console.log('[연도별] ' + label);
  YEARS.forEach(function(yr){
    const arr = closed.filter(t => t.entryYmd.startsWith(yr));
    if(!arr.length){ result[yr] = null; return; }
    const pnls = arr.map(t=>t.pnlPct);
    const wins = pnls.filter(p=>p>0);
    const losses = pnls.filter(p=>p<=0);
    const avg = sum(pnls)/arr.length;
    const pf  = losses.length && sum(losses) < 0 ? f2(sum(wins)/-sum(losses)) : Infinity;
    arr.sort((a,b)=>a.entryYmd.localeCompare(b.entryYmd));
    let eq=0,peak=0,mdd=0;
    arr.forEach(t=>{eq+=t.pnlPct;peak=Math.max(peak,eq);mdd=Math.min(mdd,eq-peak);});
    result[yr] = { n:arr.length, winRate:f2(wins.length/arr.length*100), avg:f2(avg), pf: pf===Infinity?'inf':pf, mdd:f2(mdd), pass:avg>=0 };
    const mark = avg>=0 ? '✅' : '❌';
    console.log('  ' + yr + ': ' + arr.length + '건 · 승률 ' + f2(wins.length/arr.length*100) + '% · EV ' + (avg>=0?'+':'') + f2(avg) + '% · PF ' + (pf===Infinity?'∞':pf) + ' · MDD ' + f2(mdd) + '%p ' + mark);
  });
  return result;
}

// ── 메인 ──
if(process.env.BT_KOSPI !== undefined) CFG.kospiAboveMA200 = process.env.BT_KOSPI === '1' ? true : process.env.BT_KOSPI === '0' ? false : null;

function parseArgs(argv){
  const out = { codes: [], universeFile: null, noIndex: false };
  for(let i = 0; i < argv.length; i++){
    const a = argv[i];
    if(a === '--universe'){ out.universeFile = argv[++i]; }
    else if(a === '--no-index'){ out.noIndex = true; }
    else if(/^\d{6}$/.test(a)){ out.codes.push(a); }
  }
  return out;
}

async function main(){
  const args = parseArgs(process.argv.slice(2));
  let universe;
  if(args.codes.length){ universe = args.codes; }
  else {
    const uf = args.universeFile ? path.resolve(args.universeFile) : path.join(__dirname, 'universe.json');
    if(!fs.existsSync(uf)){ console.error(uf + ' 없음 — 종목코드를 인자로 주거나 universe.json 생성 (universe-from-csv.js 참조)'); process.exit(1); }
    universe = JSON.parse(fs.readFileSync(uf, 'utf-8'));
  }
  if(args.noIndex) CFG.useIndex = false;
  global.G.spyAboveMA200 = CFG.kospiAboveMA200;
  console.log('유니버스 ' + universe.length + '종목 · 기간 ~' + CFG.historyDays + '영업일 · 비용 매수 ' +
    (CFG.costs.commissionPct + CFG.costs.slipPct) + '% / 매도 ' + (CFG.costs.commissionPct + CFG.costs.taxSellPct + CFG.costs.slipPct) + '%' +
    ' · 수정주가 · KOSPI 게이트 ' + (CFG.useIndex ? '시계열 연동' : '고정 ' + String(CFG.kospiAboveMA200)));

  let indexMap = null;
  if(CFG.useIndex){
    process.stdout.write('  KOSPI 지수 일봉 로드 ... ');
    try{
      const ic = await loadIndexCandles(CFG.indexCode, CFG.historyDays + 130);   // MA120 워밍업 여유
      indexMap = buildIndexMap(ic);
      console.log(ic.length + '봉');
    }catch(e){ console.log('실패: ' + e.message + ' → 중립 게이트로 진행'); indexMap = null; }
  }

  const candleMap = {};
  for(const code of universe){
    process.stdout.write('  일봉 로드 ' + code + ' ... ');
    try{
      const c = await loadCandles(code, CFG.historyDays);
      candleMap[code] = confirmedCandles(c, {});
      console.log(c.length + '봉');
    }catch(e){ console.log('실패: ' + e.message); }
  }

  const results = [];
  for(const pct of CFG.t1SellPctVariants){
    const trades = [];
    for(const code of Object.keys(candleMap)) backtestTicker(code, candleMap[code], pct, trades, indexMap);
    results.push(summarize('T1 ' + pct + '% 매도 모드', trades));
    const out = path.join(__dirname, 'backtest-trades-t1_' + pct + '.csv');
    fs.writeFileSync(out, toCsv(trades));
    console.log('→ ' + out);
  }
  fs.writeFileSync(path.join(__dirname, 'backtest-summary.json'), JSON.stringify({ ranAt: new Date().toISOString(), cfg: CFG, universeSize: universe.length, results }, null, 2));
  console.log('\n[가정] PRIME 규약(D일 확정봉)·D+1 시가 진입·동시터치 손절우선·뉴스/rs20 중립 · 수정주가 · KOSPI 게이트=' + (indexMap ? '시계열' : String(CFG.kospiAboveMA200)) + ' — 파일 상단 주석 참조');

  // ── V1 / V2 / V3 변형 실행 ──
  console.log('\n\n══════════════ 변형 실험 (V1/V2/V3) ══════════════');
  const VARIANTS = [
    { key: 'v1',  label: 'V1 ATR stop (MA5/MA20 후보 제거)' },
    { key: 'v1b', label: 'V1b ATR stop (당일 등락 제거)' },
    { key: 'v2',  label: 'V2 score≥80 + ATR stop' },
    { key: 'v3',  label: 'V3 눌림목(pullback_to_ma20) + ATR stop' },
  ];
  const variantResults = {};
  for(const vd of VARIANTS){
    console.log('\n\n──── ' + vd.label + ' ────');
    variantResults[vd.key] = {};
    for(const pct of CFG.t1SellPctVariants){
      const vtrades = [];
      for(const code of Object.keys(candleMap)) backtestTicker(code, candleMap[code], pct, vtrades, indexMap, vd.key);
      const sr = summarizeSplit(vd.label + ' · T1 ' + pct + '%', vtrades);
      const yr = summarizeYearly(vd.label + ' · T1 ' + pct + '%', vtrades);
      if(sr) sr.yearly = yr;
      variantResults[vd.key]['t1_' + pct] = sr;
      const out = path.join(__dirname, 'backtest-trades-' + vd.key + '-t1_' + pct + '.csv');
      fs.writeFileSync(out, toCsv(vtrades));
      console.log('→ ' + out);
    }
  }
  fs.writeFileSync(
    path.join(__dirname, 'backtest-summary-variants.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), cfg: CFG, universeSize: universe.length, variants: variantResults }, null, 2)
  );
  console.log('\n→ backtest-summary-variants.json 저장');
}

module.exports = { CFG, backtestTicker, summarize, toCsv, bar };
if(require.main === module) main().catch(e => { console.error(e); process.exit(1); });
