/* ============================================================
 * RECONKR SWING 결정 엔진 — swingEngine.js
 * 원본: indexreconkr.html 에서 추출 (로직 무변경)
 * 변경점:
 *   1) 전역 G 의존을 _G 폴백으로 명시화 (브라우저: G 그대로, Node: global.G 주입)
 *   2) DOM 설정값 읽기를 _swCfg(id, fallback)로 — Node에선 fallback 사용
 * 외부 의존: getTimeAwareness (engineUtil.js — 먼저 로드)
 * 포함: swingEngine
 * ============================================================ */
'use strict';

// ── 환경 가드: 브라우저는 DOM 설정값, Node 봇은 fallback 사용 (US swingEngine.js 동일 패턴) ──
function _swCfg(id, fallback){
  if(typeof document === 'undefined' || !document.getElementById) return fallback;
  var el = document.getElementById(id);
  return (el && el.textContent != null) ? el.textContent : fallback;
}

// ── SWING 결정 엔진 v2 — 4레이어 (시장20 + 구조30 + 눌림목30 + 트리거20) ──
// ctx (선택): { marketPhase, spyIntraday:{change_pct}, spyAboveMA200, _isNxtHours }
//   - 브라우저: 생략 → 전역 G 사용 (기존 동작 무변경)
//   - 봇/백테스트: 명시 주입 → 전역 상태에 의존하지 않는 결정론 평가 (2026-09 정합 패치)
function swingEngine(ydata, swingData, ctx){
  var _G = ctx || ((typeof G !== 'undefined' && G) ? G : {});
  var r = {
    action:'WATCH', score:0, position_size:'none',
    blockers:[], warnings:[], signals:[],
    entry:null, stop:null, target1:null, target2:null, rr:null, rr2:null,
    conditions_met:0, swing_detail:[],
    swing_grade:null,        // 'A' | 'B' | null
    wait_reason:null,        // 'structure' | 'trigger'
    swing_score_layers:null, // {market, structure, pullback, trigger}
    decision_path: [],       // B1: 결정 경로 추적
  };
  if(!swingData){
    r.blockers.push('기술 데이터 부족'); r.action='BLOCK';
    r.decision_path.push({gate:'입력',status:'block',note:'swingData 없음'});
    return r;
  }
  r.decision_path.push({gate:'입력',status:'pass',note:'일봉/시세 데이터 확인'});

  r.conditions_met = swingData.conditions_met || 0;
  r.swing_detail   = swingData.condition_detail || [];

  var ma5  = swingData.ma5;
  var ma20 = swingData.ma20;
  var ma60 = swingData.ma60;
  var price = ydata.price;
  var swingMinRR  = parseFloat(_swCfg('swingMinRR','1.5')||'1.5');
  var swingMinTV  = parseFloat(_swCfg('swingMinTV','50'))||50;
  var swingRsiMax = parseFloat(_swCfg('swingRsiMax','70'))||70;
  var swingPbMax  = parseFloat((_swCfg('swingPbMax','10%')||'10%').replace('%',''))||10;
  var swingMa20Max= parseFloat((_swCfg('swingMa20Max','10%')||'10%').replace('%',''))||10;
  var tv_m = ydata.trading_value_m || 0;

  // ── 시간대 인식 (TimeAwareness 유틸) ──
  // Layer C (눌림목 품질) — 일봉 기반이므로 장 마감 후에도 계산 가능
  // Layer D (실시간 트리거) — 장 중 거래량/양봉 기반이라 장 마감 후 불가
  var _ta = getTimeAwareness(ctx || undefined);
  var hasLivePrice   = _ta.hasLivePrice && price && price > 0;
  var hasLiveTrigger = _ta.hasLiveTrigger && price && price > 0;
  var hasStructure   = _ta.hasDailyData;  // Layer C: 일봉 기반 (항상 가능)
  r._swingScoreType  = (hasLivePrice && hasLiveTrigger) ? 'LIVE' : hasStructure ? 'PREP' : 'UNAVAILABLE';
  r._timeAwareness   = {
    phase: _ta.phase,
    livePrice: hasLivePrice,
    liveTrigger: hasLiveTrigger,
    dailyStructure: hasStructure,
  };

  // ════════════════════════════════════════
  // 진입각 계산 (게이트 전에 필요)
  // ════════════════════════════════════════
  if(price){
    var sEntry;
    if(ma20 && swingData.pullback_to_ma20)             sEntry = parseFloat((ma20*1.003).toFixed(0));
    else if(ma60 && Math.abs((price-ma60)/ma60)<=0.03) sEntry = parseFloat((ma60*1.005).toFixed(0));
    else if(ma20 && price > ma20*1.05)                 sEntry = parseFloat(price.toFixed(0));
    else if(ma20)                                       sEntry = parseFloat((ma20*1.01).toFixed(0));
    else                                                sEntry = parseFloat(price.toFixed(0));

    var ma5sw = ma5;
    var stopCandidates = [parseFloat((sEntry*0.965).toFixed(0))]; // 하드스톱 -3.5%
    if(ma5sw && ma5sw < sEntry)  stopCandidates.push(parseFloat((ma5sw *0.995).toFixed(0)));
    if(ma20  && ma20  < sEntry)  stopCandidates.push(parseFloat((ma20  *0.995).toFixed(0)));
    var sStop = Math.max.apply(null, stopCandidates.filter(function(s){return s < sEntry;}));
    if(!sStop||isNaN(sStop)||sStop>=sEntry) sStop = parseFloat((sEntry*0.965).toFixed(0));
    var sRisk = sEntry - sStop;
    // ── T1 재설계 (2026-04-24): 10일 고점 돌파 확증 우선 ──
    // 이전: max(2R, 5%) → 대부분 +3~5% 수준, 수수료·세금 감안 시 실익 미미
    // 신규: max(10일 고점×1.02, 2R, entry+5%)
    //   · 10일 고점 × 1.02 = 직전 저항 돌파 확증 지점 (눌림목 SWING 본질)
    //   · 2R = 리스크 대비 최소 보상
    //   · entry + 5% = 절대 최소 수익 보장
    var t1_2r      = parseFloat((sEntry + sRisk*2).toFixed(0));
    var t1_min5pct = parseFloat((sEntry * 1.05).toFixed(0));
    var t1_highBreak = (swingData.high10 && swingData.high10 > sEntry)
      ? parseFloat((swingData.high10 * 1.02).toFixed(0)) : 0;
    var sT1 = Math.max(t1_2r, t1_min5pct, t1_highBreak);
    // ── T2 재설계: T1×1.10, 4R, 25% cap ──
    // 한국 SWING 2-4주 현실: +25% 가 상한. 더 큰 타깃은 CORE 모드에서 포착
    //   · T1×1.10 = T1 돌파 후 +10% (T1에서 50% 익절 후 잔량 익절 타깃)
    //   · 4R = 리스크 대비 보상 4배
    //   · entry×1.25 = 한국 SWING 현실적 상한
    var t2_fromT1 = parseFloat((sT1 * 1.10).toFixed(0));
    var t2_from4R = parseFloat((sEntry + sRisk*4).toFixed(0));
    var t2Cap     = parseFloat((sEntry * 1.25).toFixed(0));
    var sT2       = Math.min(Math.max(t2_fromT1, t2_from4R), t2Cap);
    // 안전장치: T2 >= T1 * 1.05 (최소 5% 이상 간격)
    if(sT2 < sT1 * 1.05) sT2 = parseFloat((sT1 * 1.05).toFixed(0));
    var sRR  = sRisk>0 ? parseFloat(((sT1-sEntry)/sRisk).toFixed(1)) : null;
    var sRR2 = sRisk>0 ? parseFloat(((sT2-sEntry)/sRisk).toFixed(1)) : null;
    r.entry=sEntry; r.stop=sStop; r.target1=sT1; r.target2=sT2; r.rr=sRR; r.rr2=sRR2;
  }

  // ════════════════════════════════════════
  // GATE — 하나라도 실패하면 즉시 BLOCK
  // ════════════════════════════════════════
  // G1. MA60 위 (기관 수급선 위) — 스윙은 일봉 기준이므로 항상 체크
  if(ma60 && price && price < ma60){
    r.blockers.push('[G1] MA60(₩'+Math.round(ma60).toLocaleString()+') 아래 — 수급선 이탈');
    r.action='BLOCK';
    r.decision_path.push({gate:'G1 MA60',status:'block',note:'MA60 이탈 (가격 '+price+' < '+Math.round(ma60)+')'});
    return r;
  }
  r.decision_path.push({gate:'G1 MA60',status:'pass',note: ma60 ? 'MA60 '+Math.round(ma60)+' 위' : 'MA60 데이터 없음'});

  // G2. 최소 거래대금
  if(tv_m > 0 && tv_m < swingMinTV){
    r.blockers.push('[G2] 거래대금 '+tv_m+'억 — 최소 '+swingMinTV+'억 미달');
    r.action='BLOCK';
    r.decision_path.push({gate:'G2 거래대금',status:'block',note:tv_m+'억 < '+swingMinTV+'억'});
    return r;
  }
  r.decision_path.push({gate:'G2 거래대금',status:'pass',note: tv_m>0 ? tv_m+'억 ≥ '+swingMinTV+'억' : '데이터 없음 (스킵)'});

  // G3. 최소 R:R
  if(r.rr !== null && r.rr < swingMinRR){
    r.blockers.push('[G3] R:R '+r.rr+' — 최소 '+swingMinRR+' 미달');
    r.action='BLOCK';
    r.decision_path.push({gate:'G3 R:R',status:'block',note:'R:R '+r.rr+' < '+swingMinRR});
    return r;
  }
  r.decision_path.push({gate:'G3 R:R',status:'pass',note: r.rr!==null ? 'R:R '+r.rr : '가격 없음 (계산 불가)'});

  // G4. 시장 CRASH 수준 (당일 -1.5%+ 폭락)
  var kospiChgSW = _G.spyIntraday ? _G.spyIntraday.change_pct : null;
  if(kospiChgSW !== null && kospiChgSW <= -1.5){
    r.blockers.push('[G4] KOSPI '+kospiChgSW.toFixed(1)+'% — 시장 충격, 신규 SWING 금지');
    r.action='BLOCK';
    r.decision_path.push({gate:'G4 시장충격',status:'block',note:'KOSPI '+kospiChgSW.toFixed(1)+'%'});
    return r;
  }
  r.decision_path.push({gate:'G4 시장충격',status:'pass',note: kospiChgSW!==null ? 'KOSPI '+(kospiChgSW>=0?'+':'')+kospiChgSW.toFixed(1)+'%' : '데이터 없음'});

  // ════════════════════════════════════════
  // Layer A — 시장 점수 (20점)
  // ════════════════════════════════════════
  var mktScore = 0;
  // A1. 중기 레짐: KOSPI 120일선 위 (+8)
  if(_G.spyAboveMA200 === true)       { mktScore += 8; r.signals.push('KOSPI 120일선 위'); }
  else if(_G.spyAboveMA200 === false) { r.warnings.push('KOSPI 120일선 아래 — 약세 구조'); }
  // A2+A3 통합: 당일 KOSPI 레짐 점수 (최대 12pt)
  // A2와 A3는 같은 "당일 시장 방향"을 중복 측정하고 있어 하나로 합침
  if(kospiChgSW !== null){
    if(kospiChgSW > 0.8)       { mktScore += 12; }
    else if(kospiChgSW > 0.3)  { mktScore += 10; }
    else if(kospiChgSW > -0.3) { mktScore += 7;  }
    else if(kospiChgSW > -0.8) { mktScore += 3;  r.warnings.push('KOSPI '+kospiChgSW.toFixed(1)+'% — 시장 약세'); }
    else                        { /* -0.8 ~ -1.5%: G4 아래에서 경고, 여기선 0점 */ r.warnings.push('KOSPI '+kospiChgSW.toFixed(1)+'% — 포지션 50% 제한'); }
  } else { mktScore += 7; } // 데이터 없으면 중립 (보합 수준)

  // Layer A breakdown
  r.layer_breakdown = { market: [], structure: [], pullback: [], trigger: [] };
  r.layer_breakdown.market.push({
    label: 'KOSPI 120일선 위',
    got: _G.spyAboveMA200===true?8:0, max:8,
    ok: _G.spyAboveMA200===true
  });
  var _kospiPts = kospiChgSW===null?7 : kospiChgSW>0.8?12 : kospiChgSW>0.3?10 : kospiChgSW>-0.3?7 : kospiChgSW>-0.8?3 : 0;
  r.layer_breakdown.market.push({
    label: '당일 KOSPI 레짐'+(kospiChgSW===null?' (데이터없음)':' ('+kospiChgSW.toFixed(1)+'%)'),
    got: _kospiPts, max: 12,
    ok: _kospiPts >= 7
  });

  // ════════════════════════════════════════
  // Layer B — 구조 점수 (30점)
  // ════════════════════════════════════════
  var strScore = 0;
  // B1. MA20 > MA60 (추세 정배열 핵심) (+8)
  if(ma20 && ma60 && ma20 > ma60) { strScore += 8; r.signals.push('MA20>MA60 구조'); }
  // B2. 현재가 > MA60 + 3% (G1은 ma60 위만 보장 — 여기선 의미있는 이격 요구) (+8)
  if(ma60 && price && price > ma60 * 1.03) { strScore += 8; r.signals.push('MA60 위 +3% 안착'); }
  else if(ma60 && price && price > ma60)   { strScore += 4; } // MA60 직상단 (눌림목 가능)
  // B3. MA60 기울기 ≥ 0 (+4)
  if(swingData.ma60_slope !== null && swingData.ma60_slope >= 0) { strScore += 4; }
  // B4. MA20 이격도 -5%~+10% 범위 (+4) [한국 시장 연구 기반, 검증 예정]
  // -10~+15%에서 -5~+10%로 타이트하게 — 정배열 구조에서 MA20 -5% 이하는 구조 흔들림
  if(swingData.ma20_gap_pct !== null && swingData.ma20_gap_pct >= -5 && swingData.ma20_gap_pct <= swingMa20Max){ strScore += 4; }
  else if(swingData.ma20_gap_pct > swingMa20Max && swingData.ma20_gap_pct <= swingMa20Max+5){ r.warnings.push('MA20 이격 +'+swingData.ma20_gap_pct+'% — 허용폭('+swingMa20Max+'%) 초과, 추격 주의'); }
  else if(swingData.ma20_gap_pct > 15){ r.warnings.push('MA20 이격 +'+swingData.ma20_gap_pct+'% — 과확장, 진입 재고'); }
  else if(swingData.ma20_gap_pct < -5){ r.warnings.push('MA20 이격 '+swingData.ma20_gap_pct+'% — 정배열 흔들림 신호'); }
  // B5. 거래대금 충분 (+3)
  if(tv_m >= 100) strScore += 3;
  else if(tv_m >= 50) strScore += 1;
  // B6. RS20 상대강도 (+3/0/-2)
  if(swingData.rs20 !== null){
    if(swingData.rs20 >= 5)      { strScore += 3; r.signals.push('RS20 +'+swingData.rs20+'%p 아웃퍼폼'); }
    else if(swingData.rs20 >= 0) { strScore += 1; }
    else if(swingData.rs20 < -3) { strScore -= 2; r.warnings.push('RS20 '+swingData.rs20+'%p — 상대 약세'); }
  }

  // Layer B breakdown — A3 데이터 신뢰도 필드 추가
  // confidence: 'full' = 데이터 있고 조건 평가됨
  //             'missing' = 데이터 누락으로 평가 불가 (조건 실패와 구분)
  //             'partial' = 부분 데이터만 사용
  var _b1 = (ma20&&ma60&&ma20>ma60) ? 8 : 0;
  var _b2 = (ma60&&price&&price>ma60*1.03) ? 8 : (ma60&&price&&price>ma60 ? 4 : 0);
  var _b3 = (swingData.ma60_slope!==null&&swingData.ma60_slope>=0) ? 4 : 0;
  var _b4 = (swingData.ma20_gap_pct!==null&&swingData.ma20_gap_pct>=-5&&swingData.ma20_gap_pct<=swingMa20Max) ? 4 : 0;
  var _b5 = tv_m>=100 ? 3 : (tv_m>=50 ? 1 : 0);
  var _b6 = swingData.rs20===null ? 0 : swingData.rs20>=5 ? 3 : swingData.rs20>=0 ? 1 : swingData.rs20<-3 ? -2 : 0;
  r.layer_breakdown.structure.push({
    label:'MA20>MA60 정배열', got:_b1, max:8, ok:_b1>0,
    confidence: (ma20&&ma60) ? 'full' : 'missing'
  });
  r.layer_breakdown.structure.push({
    label:'현재가 MA60 +3% 이상', got:_b2, max:8, ok:_b2===8, partial:_b2===4,
    confidence: (ma60&&price) ? 'full' : 'missing'
  });
  r.layer_breakdown.structure.push({
    label:'MA60 기울기 우상향', got:_b3, max:4, ok:_b3>0,
    confidence: swingData.ma60_slope!==null ? 'full' : 'missing'
  });
  r.layer_breakdown.structure.push({
    label:'MA20 이격도 적정(-5%~+'+swingMa20Max+'%)', got:_b4, max:4, ok:_b4>0,
    confidence: swingData.ma20_gap_pct!==null ? 'full' : 'missing'
  });
  r.layer_breakdown.structure.push({
    label:'거래대금'+(tv_m>0?' '+Math.round(tv_m)+'억':''), got:_b5, max:3, ok:_b5===3, partial:_b5===1,
    confidence: tv_m>0 ? 'full' : 'missing'
  });
  r.layer_breakdown.structure.push({
    label:'RS20 상대강도'+(swingData.rs20!==null?' '+swingData.rs20+'%p':''), got:_b6, max:3, ok:_b6>=3, partial:_b6>0,
    confidence: swingData.rs20!==null ? 'full' : 'missing'
  });

  // ════════════════════════════════════════
  // Layer C — 눌림목 품질 (30점)
  // ════════════════════════════════════════
  // Layer C — 눌림목 품질 (30점)
  // 일봉 기반이므로 장 마감 후에도 작동 (hasStructure 필요)
  // ════════════════════════════════════════
  var pbScore = 0;
  if(hasStructure){
  // C1. 고점 대비 조정폭 — 한국 시장 기준 [연구 기반, 검증 예정]
  // 최적: -3~-7% / 허용: -7~-10% / 얕은눌림: 0~-3% / 과도: <-10%
  var depthPct = swingData.pullback_depth_pct;
  if(depthPct !== null){
    if(depthPct >= -7 && depthPct <= -3)       { pbScore += 10; r.signals.push('조정폭 '+depthPct+'% — 최적 눌림'); }
    else if(depthPct > -3 && depthPct <= 0)    { pbScore += 6;  r.signals.push('조정폭 '+depthPct+'% — 얕은 눌림'); }
    else if(depthPct < -7 && depthPct >= -10)  { pbScore += 6;  r.warnings.push('조정폭 '+depthPct+'% — 다소 깊음, 지지 확인 필요'); }
    else if(depthPct <= -(swingPbMax))          { pbScore += 2;  r.warnings.push('조정폭 '+depthPct+'% — 허용폭('+swingPbMax+'%) 초과, MA60 지지 확인'); }
    else if(depthPct > 0)                      { r.warnings.push('신고가 근처 — 눌림목 미형성'); }
  }
  // C2. MA20 대비 위치 [한국 시장 연구 기반, 검증 예정]
  // 0~3%: 최적 / 3~7%: 양호 / 7~10%: 허용 (B4 경계) / -2~0%: 일시이탈 / -5~-2%: 경계
  var gap20 = swingData.ma20_gap_pct;
  if(gap20 !== null){
    if(gap20 >= 0 && gap20 <= 3)          { pbScore += 8; r.signals.push('MA20 위 +'+gap20.toFixed(1)+'% — 최적 눌림'); }
    else if(gap20 > 3 && gap20 <= 7)      { pbScore += 5; r.signals.push('MA20 위 +'+gap20.toFixed(1)+'%'); }
    else if(gap20 > 7 && gap20 <= 10)     { pbScore += 3; r.warnings.push('MA20 +'+gap20.toFixed(1)+'% — 상단 경계'); }
    else if(gap20 >= -2 && gap20 < 0)     { pbScore += 3; r.warnings.push('MA20 -'+Math.abs(gap20).toFixed(1)+'% — 일시 이탈'); }
    else if(gap20 >= -5 && gap20 < -2)    { pbScore += 1; r.warnings.push('MA20 -'+Math.abs(gap20).toFixed(1)+'% — 이탈 경계'); }
  }
  // C3. 최근 5일 거래량 감소 (조용한 눌림목) (+5)
  if(swingData.pullback_vol_quiet) { pbScore += 5; r.signals.push('조용한 눌림목 (거래량 감소)'); }
  // C4. 연속 대형 음봉 없음 (+4)
  if(swingData.no_consecutive_bear) { pbScore += 4; }
  else { r.warnings.push('연속 대형 음봉 감지 — 하락 지속 가능성'); }
  // C5. RSI — swingRsiMax 설정값 연동 (하한 40 고정, 상한 설정값)
  if(swingData.rsi14 !== null){
    if(swingData.rsi14 >= 40 && swingData.rsi14 <= swingRsiMax)  { pbScore += 3; }
    else if(swingData.rsi14 < 40)  { r.warnings.push('RSI '+swingData.rsi14+' — 과매도, 추가 하락 가능'); }
    else if(swingData.rsi14 > swingRsiMax){ r.warnings.push('RSI '+swingData.rsi14+' — 과매수 (기준 '+swingRsiMax+'), 눌림 기다릴 것'); }
  }

  // Layer C breakdown — 데이터 신뢰도 포함
  var _c1 = depthPct===null?0 : (depthPct>=-7&&depthPct<=-3)?10 : (depthPct>-3&&depthPct<=0)?6 : (depthPct<-7&&depthPct>=-10)?6 : (depthPct<=-swingPbMax)?2 : 0;
  var _c2 = gap20===null?0 : (gap20>=0&&gap20<=3)?8 : (gap20>3&&gap20<=7)?5 : (gap20>7&&gap20<=10)?3 : (gap20>=-2&&gap20<0)?3 : (gap20>=-5&&gap20<-2)?1 : 0;
  var _c3 = swingData.pullback_vol_quiet ? 5 : 0;
  var _c4 = swingData.no_consecutive_bear ? 4 : 0;
  var _c5 = (swingData.rsi14!==null&&swingData.rsi14>=40&&swingData.rsi14<=swingRsiMax) ? 3 : 0;
  r.layer_breakdown.pullback.push({
    label:'조정폭 적정(-3%~-7%)'+(depthPct!==null?' '+depthPct.toFixed(1)+'%':''),
    got:_c1, max:10, ok:_c1===10, partial:_c1>0&&_c1<10,
    confidence: depthPct!==null ? 'full' : 'missing'
  });
  r.layer_breakdown.pullback.push({
    label:'MA20 위치 최적(0~3%)'+(gap20!==null?' '+gap20.toFixed(1)+'%':''),
    got:_c2, max:8, ok:_c2===8, partial:_c2>0&&_c2<8,
    confidence: gap20!==null ? 'full' : 'missing'
  });
  r.layer_breakdown.pullback.push({
    label:'눌림 거래량 수축', got:_c3, max:5, ok:_c3>0,
    confidence: swingData.pullback_vol_quiet!==undefined ? 'full' : 'missing'
  });
  r.layer_breakdown.pullback.push({
    label:'연속 대형 음봉 없음', got:_c4, max:4, ok:_c4>0,
    confidence: swingData.no_consecutive_bear!==undefined ? 'full' : 'missing'
  });
  r.layer_breakdown.pullback.push({
    label:'RSI 정상범위(40~'+swingRsiMax+')'+(swingData.rsi14!==null?' '+swingData.rsi14:''),
    got:_c5, max:3, ok:_c5>0,
    confidence: swingData.rsi14!==null ? 'full' : 'missing'
  });
  } // end hasStructure (Layer C)

  // ════════════════════════════════════════
  // Layer D — 트리거 (최대 15pt)
  // 실시간 가격+거래량 필요 — 장 마감 후·NXT 시간대에는 0점
  // ════════════════════════════════════════
  var trigScore = 0;
  var kisConnected = !!(swingData._kisUpdated);
  var trigCap = 15;
  if(hasLiveTrigger){
  // D1/D3 통합: 계단형 점수
  if(swingData.bullish_candle && swingData.vol_ratio && swingData.vol_ratio >= 1.3){
    trigScore += 5; r.signals.push('거래량 동반 양봉 ('+swingData.vol_ratio.toFixed(2)+'x)');
  } else if(swingData.bullish_candle){
    trigScore += 2;
  }
  // D2. 최근 3일 고가 돌파 (+5)
  if(swingData.broke_prev3d_high) { trigScore += 5; r.signals.push('최근 3일 고가 돌파'); }
  // D4. 종가 캔들 상단 40% 이내 (+5)
  if(swingData.close_upper_40pct) { trigScore += 5; r.signals.push('종가 캔들 상단 마감'); }
  trigScore = Math.min(trigScore, trigCap);
  if(!kisConnected && trigScore >= 10){
    r.warnings.push('KIS 미연결 — 트리거 판단 야후 일봉 기준 (장중 미완성 캔들 주의)');
  }

  // Layer D breakdown — 장외시간엔 confidence='unavailable' (시간대 제약)
  var _d1 = (swingData.bullish_candle&&swingData.vol_ratio&&swingData.vol_ratio>=1.3) ? 5 : (swingData.bullish_candle ? 2 : 0);
  var _d2 = swingData.broke_prev3d_high ? 5 : 0;
  var _d3 = swingData.close_upper_40pct ? 5 : 0;
  r.layer_breakdown.trigger.push({
    label:'거래량 동반 양봉(1.3x↑)'+(swingData.vol_ratio?' '+swingData.vol_ratio.toFixed(2)+'x':''),
    got:_d1, max:5, ok:_d1===5, partial:_d1===2,
    confidence: 'full'
  });
  r.layer_breakdown.trigger.push({
    label:'최근 3일 고가 돌파', got:_d2, max:5, ok:_d2>0, confidence:'full'
  });
  r.layer_breakdown.trigger.push({
    label:'종가 캔들 상단 40%', got:_d3, max:5, ok:_d3>0, confidence:'full'
  });
  } // end hasLiveTrigger (Layer D)

  // hasLiveTrigger = false 일 때도 breakdown 항목 3개 채워줌 (카드에 "장외 시간" 이유 표시)
  if(!hasLiveTrigger){
    r.layer_breakdown.trigger.push({ label:'거래량 동반 양봉', got:0, max:5, ok:false, confidence:'unavailable' });
    r.layer_breakdown.trigger.push({ label:'최근 3일 고가 돌파', got:0, max:5, ok:false, confidence:'unavailable' });
    r.layer_breakdown.trigger.push({ label:'종가 캔들 상단 40%', got:0, max:5, ok:false, confidence:'unavailable' });
  }

  // PREP/UNAVAILABLE 시간대 안내 — 사용자에게 투명하게 공개
  if(!hasLiveTrigger){
    if(hasStructure){
      r.warnings.push('[PREP] 장외 시간대 — 구조(A+B+C 80점) 기반 분석, 트리거(D)는 장중 재평가 필요');
    } else {
      r.warnings.push('[UNAVAILABLE] 일봉 데이터 부족 — 분석 제한');
    }
  }

  // ════════════════════════════════════════
  // Layer E — TOXIC/DISTRIBUTING 하드블록 (SWING 전용 단순화)
  // getWhaleStage는 당일 단기 데이터 기반 → 다주간 스윙에 부적합
  // TOXIC/DISTRIBUTING (관리종목·배포말기)만 차단, 나머지 보너스 제거
  // ════════════════════════════════════════
  var whaleBonus = 0;
  var whaleR = { stage:'NORMAL' };
  if(ydata){
    // TOXIC만 판별 (뉴스 키워드 기반 — 시간 무관하게 항상 체크)
    var _nwTx = (ydata.newsText || '').toLowerCase();
    if(_nwTx.includes('관리종목') || _nwTx.includes('투자경고') ||
       _nwTx.includes('횡령')     || _nwTx.includes('배임')     ||
       _nwTx.includes('상장폐지') || _nwTx.includes('불성실공시')){
      whaleR.stage = 'TOXIC';
    }
    r._whaleStage = whaleR.stage;
  }

  // ════════════════════════════════════════
  // 총점 합산
  // ════════════════════════════════════════
  var totalScore = mktScore + strScore + pbScore + trigScore; // Layer E 제거
  r.score = Math.min(100, Math.max(0, totalScore));
  r.swing_score_layers = { market:mktScore, structure:strScore, pullback:pbScore, trigger:trigScore };

  // ════════════════════════════════════════
  // 세력 BLOCK (점수 관계없이 강제)
  // TOXIC/DISTRIBUTING: 분배 구간 진입 절대 금지
  // ════════════════════════════════════════
  if(whaleR.stage === 'TOXIC'){
    r.action = 'BLOCK';
    r.blockers.push('[TOXIC] 관리종목·횡령·투자경고 감지 — 스윙 진입 금지');
    return r;
  }

  // ════════════════════════════════════════
  // 액션 결정 (C 하이브리드)
  // [0] TOXIC         → BLOCK (이미 위에서 처리)
  // [1] 명시적 위험   → BLOCK (이유 명확: 과확장/과열/연속음봉)
  // [2] 점수 < 40     → BLOCK (심각한 구조 손상)
  // [3] ENTER_A:      총점 80+ AND 트리거 15+   (장중만, 즉시 진입)
  // [4] ENTER_B:      총점 70+ AND 트리거 10+   (장중만, 소량 진입)
  // [5] READY:        구조점수(A+B+C) 55+ + 장외시간 (트리거 확인 대기)
  // [6] WATCH:        총점 40+ (낮은 점수 관찰 or 트리거 부족)
  // [7] BLOCK:        그 외
  // ════════════════════════════════════════
  var posSize = 'none';
  // 시장 약세 시 포지션 50% 캡
  var mktHalfCap = (kospiChgSW !== null && kospiChgSW <= -0.8 && kospiChgSW > -1.5);

  // 구조 점수(A+B+C) — 장외 시간대 판정용 (트리거 D 제외 총 80점 만점)
  var structureScore = mktScore + strScore + pbScore;

  // ── [1] 명시적 위험 조건 검사 (점수와 무관하게 BLOCK) ──
  // 임계값 근거:
  //   MA20 이격 > swingMa20Max + 5 : 허용폭보다 크게 벗어난 "과확장"
  //   RSI14 > swingRsiMax + 10     : 사용자 기준보다 크게 과열 (기본 설정 시 80 초과)
  //   연속 대형 음봉                  : 하락 지속 구간 (눌림목 SWING 부적합)
  // 철학: "더 갈 수는 있지만 기대값 음수" — 단일 종목 집착 대신 다른 후보 찾기
  var criticalRisks = [];
  if(swingData.ma20_gap_pct !== null && swingData.ma20_gap_pct > swingMa20Max + 5){
    criticalRisks.push('MA20 이격 +'+swingData.ma20_gap_pct.toFixed(1)+'% — 20일 평균 대비 과확장');
  }
  if(swingData.rsi14 !== null && swingData.rsi14 > swingRsiMax + 10){
    criticalRisks.push('RSI '+swingData.rsi14.toFixed(1)+' — 과매수 극단 (통계적 조정 임박)');
  }
  if(swingData.no_consecutive_bear === false){
    criticalRisks.push('연속 대형 음봉 감지 — 하락 지속 구간');
  }

  if(criticalRisks.length > 0){
    r.action = 'BLOCK';
    r.swing_grade = null;
    // 첫 번째 blocker는 요약, 나머지는 개별 위험
    r.blockers.push('기대값 음수 구간 — 다른 후보 검토 권장');
    criticalRisks.forEach(function(reason){
      r.blockers.push('· '+reason);
    });
    r.decision_path.push({gate:'액션',status:'block',note:'BLOCK · 기대값 음수 ('+criticalRisks.length+'건) · '+r.score+'pt'});
    r.position_size = posSize;
    return r;
  }

  // ── [2] 점수 < 40 (심각한 구조 손상) → BLOCK ──
  if(r.score < 40){
    r.action = 'BLOCK';
    r.swing_grade = null;
    r.blockers.push('[점수] '+r.score+'pt — 구조 손상 심각 (최소 40pt)');
    r.decision_path.push({gate:'액션',status:'block',note:'BLOCK · '+r.score+'pt < 40 (심각)'});
    r.position_size = posSize;
    return r;
  }

  // ── [3]~[6] 기존 액션 로직 (임계값 50 → 40 완화) ──
  if(hasLiveTrigger && r.score >= 80 && trigScore >= 15){
    // 장중 + 고점수 + 강한 트리거 → ENTER A
    r.action = 'ENTER';
    r.swing_grade = 'A';
    posSize = mktHalfCap ? 'quarter(25%)' : 'half(50%)';
    r.decision_path.push({gate:'액션',status:'enter',note:'ENTER A · '+r.score+'pt · 트리거 '+trigScore+'/15'});
  } else if(hasLiveTrigger && r.score >= 70 && trigScore >= 10){
    // 장중 + 중점수 + 중간 트리거 → ENTER B
    r.action = 'ENTER';
    r.swing_grade = 'B';
    posSize = 'quarter(25%)';
    r.decision_path.push({gate:'액션',status:'enter',note:'ENTER B · '+r.score+'pt · 트리거 '+trigScore+'/10'});
  } else if(!hasLiveTrigger && hasStructure && structureScore >= 55){
    // 장외 + 구조 55+ → READY (다음 장에서 트리거 확인 대상)
    // ★ 2026-06: READY를 정식 액션으로 승격 — WATCH와 시각적으로 구분
    r.action = 'READY';
    r.swing_grade = null;
    r.wait_reason = 'market_closed';
    r.ready_for_next_session = true;
    r.warnings.push('[READY] 구조 '+structureScore+'/80pt — 다음 장에서 트리거(D) 확인 대기');
    r.decision_path.push({gate:'액션',status:'ready',note:'READY · 구조 '+structureScore+'/80 · 다음장 트리거 대기'});
  } else if(r.score >= 40){
    // 40+ → WATCH (낮은 점수는 관찰, 과확장·과열 없음)
    r.action = 'WATCH';
    r.swing_grade = null;
    r.wait_reason = trigScore < 10 ? 'trigger' : 'structure';
    var waitMsg;
    if(r.score < 50){
      waitMsg = '낮은 점수 ('+r.score+'pt) — 구조·눌림 조건 보완 관찰';
      r.warnings.push('[LOW_SCORE] '+waitMsg);
    } else {
      waitMsg = r.wait_reason === 'trigger'
        ? '구조 양호 — 트리거 대기 (양봉/거래량/고가돌파 확인 후 진입)'
        : '종목 후보 — 눌림목/이격 조건 보완 중';
      r.warnings.push('[WAIT] '+waitMsg);
    }
    r.decision_path.push({gate:'액션',status:'watch',note:'WATCH · '+r.score+'pt · '+r.wait_reason+' 보완 중'});
  } else {
    // (도달 불가 — 위 [2]에서 처리됨, 방어적 fallback)
    r.action = 'BLOCK';
    r.blockers.push('[점수] '+r.score+'pt — SWING 기준 미달');
    r.decision_path.push({gate:'액션',status:'block',note:'BLOCK · '+r.score+'pt'});
  }

  r.position_size = posSize;
  return r;
}

// ── 모듈 export (Node) + 전역 (브라우저) ──
if (typeof module !== 'undefined' && module.exports){
  module.exports = { swingEngine: swingEngine };
}
if (typeof window !== 'undefined'){
  window.swingEngine = swingEngine;
}
