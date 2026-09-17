/* ============================================================
 * RECONKR SWING 평가 공용 모듈 — swingEval.js (Node)
 *
 * 목적: 백테스트(backtest-swing-kr.js)와 라이브 봇(bot-live.js)이
 *   "같은 함수"로 진입을 판정하게 한다. 규약이 갈리면 백테스트 성적은 봇의 성적이 아니다.
 *
 * 평가 규약 (백테스트 = 봇):
 *   - D일 확정 일봉만 사용 (assumeConfirmed: 호출자가 확정봉만 넘김)
 *   - marketPhase 'PRIME' 주입 → Layer D 트리거를 D일 확정봉으로 평가
 *   - 시장 게이트: KOSPI 지수 일봉에서 D일 기준 MA120 위/아래 + 당일 등락률 (없으면 중립)
 *   - 진입은 D+1 시가 (백테스트: 시가 체결 / 봇: 09:00 지정가 entry — 시가가 entry 아래면 시가 체결)
 * ============================================================ */
'use strict';

const { swingEngine } = require('./swingEngine.js');
const { buildSwingDataFromKisCandles } = require('./indicatorEngine.js');

const N  = v => (typeof v === 'number' && isFinite(v)) ? v : null;
const f2 = v => Math.round(v * 100) / 100;

// ATR20 (KIS 캔들 형식 · index 0 = D일 확정봉 포함 · 20일 TR 평균)
function atr20FromKisCandles(candles){
  if(!candles || candles.length < 22) return null;
  var sum = 0;
  for(var k = 0; k < 20; k++){
    var h = parseFloat(candles[k].stck_hgpr) || 0;
    var l = parseFloat(candles[k].stck_lwpr) || 0;
    var prev_c = parseFloat(candles[k + 1].stck_clpr) || 0;
    var tr = Math.max(h - l, Math.abs(h - prev_c), Math.abs(l - prev_c));
    sum += tr;
  }
  return sum / 20;
}

// ── KOSPI 지수 일봉 → 날짜별 시장 컨텍스트 맵 ──
//   candles: kisData.loadIndexCandles 결과 (최신 index 0, stck_clpr = 지수 종가)
//   반환: { [ymd]: { close, ma120, aboveMA120: bool|null, chgPct: number|null } }
function buildIndexMap(candles){
  const map = {};
  if(!candles || !candles.length) return map;
  const asc = candles.slice().sort((a, b) => a.stck_bsop_date.localeCompare(b.stck_bsop_date));
  const closes = asc.map(c => parseFloat(c.stck_clpr) || 0);
  let sum = 0;
  for(let i = 0; i < asc.length; i++){
    sum += closes[i];
    if(i >= 120) sum -= closes[i - 120];
    const ma120 = i >= 119 ? sum / 120 : null;
    const prev  = i > 0 ? closes[i - 1] : null;
    map[asc[i].stck_bsop_date] = {
      close: closes[i],
      ma120,
      aboveMA120: ma120 ? closes[i] > ma120 : null,
      chgPct: prev ? f2((closes[i] / prev - 1) * 100) : null,
    };
  }
  return map;
}

// ── 엔진 컨텍스트 (전역 G 대체) ──
//   indexMap 없거나 해당 날짜 없으면 중립: spyAboveMA200 null(+0), change_pct null(7점 중립)
function buildEngineCtx(indexMap, ymd, override){
  const m = (indexMap && ymd && indexMap[ymd]) || null;
  const ctx = {
    marketPhase: 'PRIME',            // 확정봉 트리거 평가 규약
    _isNxtHours: false,
    spyAboveMA200: m ? m.aboveMA120 : null,
    spyIntraday: (m && m.chgPct !== null) ? { change_pct: m.chgPct } : null,
    _kospi: m,
  };
  return Object.assign(ctx, override || {});
}

// ── 한 종목·한 날짜 진입 평가 ──
//   hist: KIS 캔들, index 0 = 평가일 D (확정봉). 최소 60개 권장.
//   ctx:  buildEngineCtx 결과
//   반환: { r, sw, ydata, price, tv_m }
function evaluateEntry(hist, ctx){
  const today = hist[0];
  const price = parseFloat(today.stck_clpr) || 0;
  const tv    = parseFloat(today.acml_tr_pbmn) || 0;
  const sw    = buildSwingDataFromKisCandles(hist, price, { assumeConfirmed: true });
  const ydata = { price, trading_value_m: f2(tv / 100_000_000), newsText: '' };
  let r;
  try { r = swingEngine(ydata, sw, ctx); }
  catch(e){ r = { action: 'BLOCK', blockers: ['엔진 예외: ' + e.message], score: 0 }; }
  return { r, sw, ydata, price, tv_m: ydata.trading_value_m };
}

// ── 결과 → 주문 계획 (stop/T1/T2) ──
//   atr20: 숫자이면 V1 ATR stop (stop = min(entry×0.965, entry − 2×ATR20), t1/t2 = exitCfg R배수)
//          null/undefined이면 swingEngine 값(r.stop/r.target1) 우선, 없으면 exitCfg R배수 폴백
function planFromResult(r, price, exitCfg, atr20){
  var entry = N(r.entry) || price;
  var stop, t1, t2, src;
  if(typeof atr20 === 'number' && isFinite(atr20)){
    // V1: ATR 기반 손절
    var rawStop = Math.min(entry * 0.965, entry - 2 * atr20);
    stop = f2(rawStop);
    var risk = entry - stop;
    t1 = f2(entry + risk * exitCfg.t1R);
    t2 = f2(entry + risk * exitCfg.t2R);
    src = 'v1-atr';
  } else if(N(r.stop) && N(r.target1)){
    // swingEngine 계산값 사용
    stop = r.stop; t1 = r.target1;
    t2 = N(r.target2) || f2(Math.max(t1 * 1.10, entry + (entry - stop) * exitCfg.t2R));
    src = 'swing-engine';
  } else {
    // EXIT_CFG R배수 폴백
    stop = f2(entry * (1 + exitCfg.stopPct / 100));
    var risk2 = entry - stop;
    t1 = f2(entry + risk2 * exitCfg.t1R);
    t2 = f2(entry + risk2 * exitCfg.t2R);
    src = 'engine-default';
  }
  if(!(stop < entry && t1 > entry)) return null;
  return { entry, stop, t1, t2, src };
}

module.exports = { buildIndexMap, buildEngineCtx, evaluateEntry, planFromResult, atr20FromKisCandles, f2, N };
