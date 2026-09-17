/* ============================================================
 * RECONKR 지표 계산 엔진 — indicatorEngine.js
 * 원본: indexreconkr.html 에서 추출
 *   - calcDailyStats: 무변경 이식 (2315–2444행)
 *   - buildSwingDataFromKisCandles: _fetchSwingFromKis(6833–6888행)의
 *     "fetch 이후 계산·매핑 부분"을 그대로 재현 (fetch/log만 제거)
 * 목적: 앱(브라우저)과 백테스트(Node)가 같은 지표 코드를 쓰게 함 — 단일 소스
 * ★ 충실 재현 노트: 운영 KIS 경로는 macd/ma20_slope/rs20/close_upper_40pct/
 *   conditions_met 을 채우지 않음 (Yahoo 폴백에만 존재). 백테스트도 동일하게 둠.
 *   이게 실제 엔진이 보는 입력임.
 * ============================================================ */
'use strict';


// ─────────────────────────────────────────
// 확정봉 필터 — 2026-09 정합 패치
//   KIS 일봉 index 0은 장중엔 오늘(미확정) 봉. 오늘 봉은 KST 15:35 이후에만 확정으로 간주.
//   이전엔 calcDailyStats만 오늘봉을 제거하고, bullish_candle/prev3d_high/close_upper_40pct는
//   원본 candles[0](부분봉)을 봐서 "구조는 어제, 트리거는 오늘 부분봉"으로 섞였음.
//   이제 buildSwingDataFromKisCandles가 한 번 걸러 모든 필드가 같은 확정봉을 본다.
//   opts.assumeConfirmed=true : 백테스트/봇 — 넘긴 배열이 전부 확정봉이라고 선언 (시각 검사 생략)
//   opts.nowKst              : 기준 시각 주입 (Date) — 테스트 재현용
// ─────────────────────────────────────────
function confirmedCandles(candles, opts){
  if(!candles || !candles.length) return candles || [];
  if(opts && opts.assumeConfirmed) return candles;
  if(!candles[0] || !candles[0].stck_bsop_date) return candles;
  var kst = (opts && opts.nowKst instanceof Date) ? opts.nowKst
          : new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Seoul'}));
  var p2  = function(x){ return String(x).padStart(2,'0'); };
  var todayYmd = ''+kst.getFullYear()+p2(kst.getMonth()+1)+p2(kst.getDate());
  var hm = kst.getHours()*100 + kst.getMinutes();
  var confirmed = hm >= 1535;
  if(!confirmed && candles[0].stck_bsop_date === todayYmd) return candles.slice(1);
  return candles;
}

// ─────────────────────────────────────────
// 일봉 통계 계산 — MOMO 스코어링/BLOCK용
// candles: fetchKisDailyChart 결과 (최신 index 0)
// ─────────────────────────────────────────
function calcDailyStats(candles, currentPrice, opts){
  // currentPrice: 선택적 — SWING 눌림깊이 계산 시 사용
  // opts: { skipConfirm, nowKst, assumeConfirmed } — confirmedCandles 참조
  if(!candles || candles.length < 5) return null;

  // ★ 2026-06: 장중 미완성 봉 제거 → 2026-09: confirmedCandles()로 단일화
  //   opts.skipConfirm=true 이면 호출자가 이미 확정봉만 넘긴 것 (buildSwingDataFromKisCandles)
  if(!(opts && opts.skipConfirm)) candles = confirmedCandles(candles, opts);
  if(candles.length < 5) return null;

  var n60 = Math.min(candles.length, 65);  // MA60용
  var n20 = Math.min(candles.length, 25);  // MA20용
  var n   = n20;

  var closes = candles.slice(0,n60).map(function(c){ return parseFloat(c.stck_clpr)||0; });
  var opens  = candles.slice(0,n20).map(function(c){ return parseFloat(c.stck_oprc)||0; });
  var highs  = candles.slice(0,n20).map(function(c){ return parseFloat(c.stck_hgpr)||0; });
  var lows   = candles.slice(0,n20).map(function(c){ return parseFloat(c.stck_lwpr)||0; });
  var vols   = candles.slice(0,n20).map(function(c){ return parseFloat(c.acml_vol)||0; });
  var tvs    = candles.slice(0,n20).map(function(c){ return parseFloat(c.acml_tr_pbmn)||0; });

  function avg(arr, len){
    var a = arr.slice(0, Math.min(len, arr.length));
    return a.length ? a.reduce(function(s,v){return s+v;},0)/a.length : 0;
  }

  var ma5  = avg(closes, 5);
  var ma10 = avg(closes, 10);
  var ma20 = avg(closes, 20);
  var ma60 = closes.length >= 60 ? avg(closes, 60) : null;

  // MA60 기울기 (최근 5일 MA60 변화율)
  var ma60_slope = null;
  if(closes.length >= 65){
    var ma60_5ago = avg(closes.slice(5, 65), 60);
    ma60_slope = ma60 && ma60_5ago > 0 ? (ma60 - ma60_5ago) / ma60_5ago * 100 : null;
  }

  var prevClose = closes[0];
  var ma20_gap  = ma20 > 0 ? (prevClose/ma20 - 1)*100 : 0;
  var ma60_gap  = ma60  > 0 ? (prevClose/ma60 - 1)*100 : null;

  var high20     = Math.max.apply(null, highs.slice(0, Math.min(20, highs.length)));
  var box10_high = Math.max.apply(null, highs.slice(0, Math.min(10, highs.length)));

  // MA 정배열: 5>20>60 (SWING 기준) 또는 5>10>20 (MOMO 기준)
  var is_aligned      = (ma5 > ma20) && (ma60 ? ma20 > ma60 : ma10 > ma20); // 5>20>60
  var is_aligned_momo = (ma5 > ma10) && (ma10 > ma20);                        // 5>10>20

  // 전일 양봉
  var prev_bullish = prevClose > opens[0];

  // 거래량 추세
  var vol3r = avg(vols, 3);
  var vol3p = vols.length >= 6 ? avg(vols.slice(3,6), 3) : vol3r;
  var vol_trend = vol3p > 0 ? parseFloat((vol3r/vol3p).toFixed(2)) : 1;

  // 눌림목 거래량 수축: 최근 5일 거래량 < 이전 5일 평균
  var vol5r = avg(vols, 5);
  var vol5p = vols.length >= 10 ? avg(vols.slice(5,10), 5) : vol5r;
  var pullback_vol_quiet = vol5p > 0 && (vol5r / vol5p) < 0.85;

  // 연속 대형 음봉 없음: 최근 3일 중 -3% 이상 음봉이 2연속 없어야
  var no_consecutive_bear = true;
  var bearCount = 0;
  for(var i=0; i<Math.min(4, closes.length); i++){
    var dayChg = opens[i] > 0 ? (closes[i]/opens[i]-1)*100 : 0;
    if(dayChg <= -3) bearCount++;
    else bearCount = 0;
    if(bearCount >= 2){ no_consecutive_bear = false; break; }
  }

  // RSI 14
  var rsi14 = null;
  if(closes.length >= 15){
    var prices = closes.slice(0,15).reverse(); // 오래된 순
    var gains=0, losses=0;
    for(var j=1; j<15; j++){
      var diff = prices[j] - prices[j-1];
      if(diff > 0) gains += diff; else losses -= diff;
    }
    var ag = gains/14, al = losses/14;
    rsi14 = al===0 ? 100 : parseFloat((100 - 100/(1+ag/al)).toFixed(1));
  }

  // 눌림목 깊이: 10일 고점 대비 현재가 (currentPrice 있으면 사용, 없으면 전일 종가)
  var priceRef = currentPrice || prevClose;
  var pullback_depth_pct = box10_high > 0 ? parseFloat(((priceRef/box10_high - 1)*100).toFixed(1)) : null;

  // 상한가 관련 (MOMO용)
  var prev_day_limit = candles[0].prdy_vrss_sign === '1'
    || (closes[1] > 0 && (prevClose/closes[1]-1) >= 0.295);
  var tv_prev   = tvs[0];
  var tv5_base  = avg(tvs.slice(1,6), Math.min(5, tvs.length-1));
  var tv_ratio_prev = tv5_base > 0 ? tv_prev/tv5_base : 0;

  return {
    // 공통
    ma5, ma10, ma20, ma60,
    ma60_slope,         // MA60 기울기 % (양=우상향)
    ma20_gap,           // MA20 이격도 % (양=위)
    ma60_gap,           // MA60 이격도 % (양=위)
    high20,
    box10_high,
    is_aligned,         // 5>20>60 (SWING 기준)
    is_aligned_momo,    // 5>10>20 (MOMO 기준)
    prev_bullish,
    vol_trend,
    // SWING 전용
    pullback_vol_quiet, // 거래량 수축 여부
    no_consecutive_bear,// 연속 대형 음봉 없음
    rsi14,              // RSI 14
    pullback_depth_pct, // 10일 고점 대비 조정폭 %
    // MOMO 전용
    prev_day_limit,
    tv_prev,            // 전일 거래대금 (원 단위)
    tv_ratio_prev,
  };
}
// ── KIS 일봉 → swingData (앱 _fetchSwingFromKis 의 계산·매핑부 재현) ──
//   candles: KIS 형식, 최신이 index 0 (stck_bsop_date 내림차순)
//   price:   분석 시점 가격 (백테스트: 해당 일 종가)
//   opts:    { assumeConfirmed, nowKst } — confirmedCandles 참조. 봇/백테스트는 assumeConfirmed:true
function buildSwingDataFromKisCandles(candles, price, opts){
  var sw = {
    ma5:null, ma20:null, ma60:null, ma120:null,
    rsi14:null, macd:null, macd_signal:null, macd_hist:null, macd_hist_prev:null,
    vol5avg:null, vol20avg:null, vol_ratio:null,
    high10:null, high20:null,
    ma20_5d_ago:null, ma20_slope:null, ma60_slope:null,
    above_ma60:null, above_ma20:null,
    pullback_to_ma20:null, bullish_candle:null,
    ma20_gap_pct:null,
    pullback_depth_pct:null, rs20:null,
    prev3d_high:null, broke_prev3d_high:false,
    close_upper_40pct:false, no_consecutive_bear:true,
    pullback_vol_quiet:false, _kisUpdated:false,
    conditions_met: 0, condition_detail: []
  };
  candles = confirmedCandles(candles, opts);   // ★ 모든 필드가 같은 확정봉 집합을 본다
  if(!candles || candles.length < 20) return sw;
  if(!price) price = candles[0] ? parseFloat(candles[0].stck_clpr) : 0;

  var stats = calcDailyStats(candles, price, { skipConfirm: true });
  if(!stats) return sw;

  sw.ma5         = stats.ma5 || null;
  sw.ma20        = stats.ma20 || null;
  sw.ma60        = stats.ma60 || null;
  sw.high10      = stats.box10_high || null;
  sw.high20      = stats.high20 || null;
  sw.ma60_slope  = stats.ma60_slope !== null && stats.ma60_slope !== undefined ? stats.ma60_slope : null;
  sw.ma20_gap_pct= stats.ma20_gap !== null && stats.ma20_gap !== undefined ? parseFloat(stats.ma20_gap.toFixed(1)) : null;
  sw.above_ma60  = stats.ma60 && price ? price > stats.ma60 : null;
  sw.above_ma20  = stats.ma20 && price ? price > stats.ma20 : null;
  sw.pullback_depth_pct  = stats.pullback_depth_pct !== null && stats.pullback_depth_pct !== undefined ? stats.pullback_depth_pct : null;
  sw.pullback_vol_quiet  = !!stats.pullback_vol_quiet;
  sw.no_consecutive_bear = stats.no_consecutive_bear !== false;
  sw.rsi14               = stats.rsi14 || null;
  sw.vol_ratio           = stats.vol_trend || null;

  if(candles[0]){
    var todayClose = parseFloat(candles[0].stck_clpr) || 0;
    var todayOpen  = parseFloat(candles[0].stck_oprc) || 0;
    sw.bullish_candle = todayClose > todayOpen;
    // ★ 2026-09: D4 트리거 복구 — 종가가 캔들 상단 40% 이내 (= 저가 기준 60% 이상)
    //   기존엔 KIS 경로에서 항상 false → 트리거 최대 10점 → Grade A(15점) 구조적 불가였음.
    var todayHigh = parseFloat(candles[0].stck_hgpr) || 0;
    var todayLow  = parseFloat(candles[0].stck_lwpr) || 0;
    var cRng = todayHigh - todayLow;
    sw.close_upper_40pct = (cRng > 0 && todayClose >= todayLow) ? ((todayClose - todayLow) / cRng >= 0.60) : false;
  }
  if(candles.length >= 4){
    sw.prev3d_high = Math.max.apply(null, candles.slice(1, 4).map(function(c){return parseFloat(c.stck_hgpr)||0;}));
    sw.broke_prev3d_high = price > sw.prev3d_high;
  }
  sw._kisUpdated = true;
  sw._fallbackSource = 'KIS';
  return sw;
}

// ── 모듈 export (Node) + 전역 (브라우저) ──
if (typeof module !== 'undefined' && module.exports){
  module.exports = { calcDailyStats: calcDailyStats, buildSwingDataFromKisCandles: buildSwingDataFromKisCandles, confirmedCandles: confirmedCandles };
}
if (typeof window !== 'undefined'){
  window.calcDailyStats = calcDailyStats;
  window.buildSwingDataFromKisCandles = buildSwingDataFromKisCandles;
  window.confirmedCandles = confirmedCandles;
}
