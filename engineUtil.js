/* ============================================================
 * RECONKR 공유 엔진 유틸 — engineUtil.js
 * 원본: indexreconkr.html 에서 추출 (로직 무변경)
 * 변경점:
 *   1) 전역 G 의존을 _G 폴백으로 명시화 (브라우저: G 그대로, Node: global.G 주입)
 * 포함: getTimeAwareness, parseTradeDate, tradeHoldDays
 * ============================================================ */
'use strict';

// ═══════════════════════════════════════════════════════════════
// TimeAwareness — 엔진이 사용할 시간대 기반 능력 판정 단일 소스
// 모든 엔진(MOMO/SWING/CORE)은 이 함수 결과에 따라 Layer 활성화 결정
// 이전 상태: hasRealtimePrice 같은 변수가 swingEngine 내부에 산발
// 개선 후: 모든 엔진이 동일 유틸 호출 → 일관된 시간대 정책
//
// 반환값 필드:
//   phase:          'PRE'|'ORB'|'EARLY'|'PRIME'|'LATE'|'NXT_AFTER'|'CLOSED'
//   isWeekend:      주말/공휴일
//   isClosed:       정규장 종료 (NXT_AFTER는 false)
//   hasLivePrice:   실시간 가격 신뢰 가능 (PRE 이후 CLOSED 전)
//   hasLiveVolume:  실시간 거래량 완성됨 (EARLY 이후)
//   hasLiveTrigger: 실시간 트리거(양봉/돌파/볼륨) 평가 가능 (EARLY 이후 LATE까지)
//   hasDailyData:   일봉 데이터 신뢰 (장 마감 후 당일 확정, 장중은 전일까지)
//   hasVWAP:        VWAP 계산 가능 (장중만)
//   allowMomoEntry: MOMO 신규 진입 허용 시간대
//   allowSwingEntry: SWING 신규 진입 허용 (장 마감 후엔 "내일 준비"만)
//   allowCoreEntry: CORE 신규 진입 허용 (시간 무관 가능)
// ═══════════════════════════════════════════════════════════════
function getTimeAwareness(gOverride){
  // gOverride: 봇/백테스트가 전역 G 대신 명시 주입하는 컨텍스트 (2026-09 정합 패치)
  var _G = gOverride || ((typeof G !== 'undefined' && G) ? G : {});
  var ph = _G.marketPhase || 'CLOSED';
  var nxtHours = _G._isNxtHours === true;

  // 기본 판정
  var isWeekend = (ph === 'CLOSED' && !nxtHours);  // 평일 장 마감과 주말 구분은 별도 필요시
  var isClosed  = (ph === 'CLOSED');

  // 실시간 가격 신뢰: PRE~LATE 사이 (NXT_AFTER는 NXT 종목만)
  var hasLivePrice = (ph === 'PRE' || ph === 'ORB' || ph === 'EARLY' ||
                      ph === 'PRIME' || ph === 'LATE' || ph === 'NXT_AFTER');

  // 실시간 거래량 완성도: EARLY 이후 (ORB는 5분뿐이라 부분집계)
  var hasLiveVolume = (ph === 'EARLY' || ph === 'PRIME' || ph === 'LATE');

  // 실시간 트리거 평가 가능: 의미있는 거래량 확보된 시간대
  // EARLY 이후 LATE까지. NXT_AFTER는 유동성 너무 낮아 제외.
  var hasLiveTrigger = (ph === 'EARLY' || ph === 'PRIME' || ph === 'LATE');

  // 일봉 데이터: 어느 시간대에서든 '과거 일봉'은 항상 신뢰
  // 장 마감 후면 '오늘 일봉'도 확정됨. 장중이면 오늘 일봉은 미완성
  var hasDailyData        = true;                   // 전일까지 일봉은 항상 있음
  var hasCurrentDayDaily  = (ph === 'CLOSED' && !isWeekend);  // 당일 일봉 완성

  // VWAP: 장중에만 계산 가능 (누적거래대금/거래량)
  var hasVWAP = (ph === 'OPEN' || ph === 'MKT' || ph === 'EARLY' ||
                 ph === 'PRIME' || ph === 'LATE' || ph === 'ORB');

  // 진입 허용 시간대 — 모드별
  //  MOMO: 장중이면서 페이드 구간 직전까지 (LATE 제외)
  //  SWING: 장중 언제든 + 장 마감 후엔 "대기 모드"로만 (ENTER 불가, WATCH만)
  //  CORE: 시간 무관 — 일봉/주봉/월봉 기반이므로 언제든 분석 가능
  var allowMomoEntry  = (ph === 'ORB' || ph === 'EARLY' || ph === 'PRIME');
  var allowSwingEntry = (ph === 'EARLY' || ph === 'PRIME' || ph === 'LATE');
  var allowCoreEntry  = true;  // 항상

  return {
    phase:              ph,
    isWeekend:          isWeekend,
    isClosed:           isClosed,
    isNxtHours:         nxtHours,
    hasLivePrice:       hasLivePrice,
    hasLiveVolume:      hasLiveVolume,
    hasLiveTrigger:     hasLiveTrigger,
    hasDailyData:       hasDailyData,
    hasCurrentDayDaily: hasCurrentDayDaily,
    hasVWAP:            hasVWAP,
    allowMomoEntry:     allowMomoEntry,
    allowSwingEntry:    allowSwingEntry,
    allowCoreEntry:     allowCoreEntry,
  };
}

// ── 안전한 포지션 날짜 파서 (2026-06) ──
// 저장 형식이 toLocaleDateString('ko-KR') = "2026. 6. 12." 이라
// 일부 브라우저(Safari/iOS)에서 new Date()가 "did not match the expected pattern" 예외.
// 모든 trade.date 파싱은 이 함수를 거침.
function parseTradeDate(s){
  if(!s) return null;
  if(s instanceof Date) return isNaN(s) ? null : s;
  var str = String(s).trim();
  // "2026. 6. 12." | "2026.6.12" | "2026-6-12" | "2026/6/12"
  var m = str.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if(m){
    var d = new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10));
    return isNaN(d) ? null : d;
  }
  // "20260612"
  var m2 = str.match(/^(\d{4})(\d{2})(\d{2})$/);
  if(m2){
    var d2 = new Date(parseInt(m2[1],10), parseInt(m2[2],10)-1, parseInt(m2[3],10));
    return isNaN(d2) ? null : d2;
  }
  var d3 = new Date(str);
  return isNaN(d3) ? null : d3;
}
function tradeHoldDays(s, nowMs){
  // nowMs: 결정론 재현용 기준 시각 (백테스트/봇). 생략 시 Date.now()
  var d = parseTradeDate(s);
  if(!d) return 0;
  var now = (typeof nowMs === 'number' && isFinite(nowMs)) ? nowMs : Date.now();
  return Math.max(0, Math.round((now - d.getTime())/86400000));
}


// ── 모듈 export (Node) + 전역 (브라우저) ──
if (typeof module !== 'undefined' && module.exports){
  module.exports = { getTimeAwareness: getTimeAwareness, parseTradeDate: parseTradeDate, tradeHoldDays: tradeHoldDays };
}
if (typeof window !== 'undefined'){
  window.getTimeAwareness = getTimeAwareness;
  window.parseTradeDate   = parseTradeDate;
  window.tradeHoldDays    = tradeHoldDays;
}
