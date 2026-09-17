/* ============================================================
 * RECONKR 엔진 회귀 테스트 — engineTests.js
 * 원본: indexreconkr.html 에서 추출 (로직 무변경)
 * 사용: 브라우저 콘솔 또는 Node에서 runAllEngineTests()
 * 외부 의존: swingEngine, coreEngine, getTimeAwareness, 전역 G
 * ============================================================ */
'use strict';

// ═══════════════════════════════════════════════════════════════
// B2: 엣지 케이스 자동 테스트 (SWING)
// 콘솔에서 `runSwingEdgeTests()` 호출로 실행
// 예상 동작 vs 실제 동작 비교 → 회귀 방지
// ═══════════════════════════════════════════════════════════════
function runSwingEdgeTests(){
  var cases = [
    {
      name: '거래대금 미달 BLOCK (G2)',
      ydata: { price: 10000, trading_value_m: 30 },
      swingData: { ma5:10500, ma20:10300, ma60:9800, ma60_slope:1, ma20_gap_pct:0, rs20:0 },
      expect: { action: 'BLOCK', includes: '거래대금' }
    },
    {
      name: 'MA60 이탈 BLOCK (G1)',
      ydata: { price: 9500, trading_value_m: 100 },
      swingData: { ma5:9800, ma20:9600, ma60:10000, ma60_slope:0 },
      expect: { action: 'BLOCK', includes: 'MA60' }
    },
    {
      name: '완벽한 ENTER A 조건 (장중)',
      ydata: { price: 11000, trading_value_m: 200 },
      swingData: {
        ma5:10900, ma20:10500, ma60:10000, ma60_slope:3,
        ma20_gap_pct: 2, rs20: 8, pullback_depth_pct: -4,
        pullback_vol_quiet: true, no_consecutive_bear: true, rsi14: 55,
        bullish_candle: true, vol_ratio: 1.8, broke_prev3d_high: true,
        close_upper_40pct: true, _kisUpdated: true
      },
      expect: { scoreMin: 80, trigMin: 15 }  // 장중 조건 안맞을 수 있어 점수만 체크
    },
    {
      name: 'TOXIC 키워드 즉시 BLOCK',
      ydata: { price: 10000, trading_value_m: 100, newsText: '관리종목 지정' },
      swingData: { ma5:10500, ma20:10300, ma60:9800, ma60_slope:1, ma20_gap_pct:0 },
      expect: { action: 'BLOCK', includes: 'TOXIC' }
    },
    {
      name: '일봉 데이터 없을 때',
      ydata: { price: 10000 },
      swingData: null,
      expect: { action: 'BLOCK', includes: '데이터 부족' }
    },
    {
      name: '빈 swingData',
      ydata: { price: 10000 },
      swingData: {},
      expect: { decisionPathMin: 3 }  // 게이트 몇 개 통과 로그 필수
    },
  ];

  var results = [];
  cases.forEach(function(tc){
    try{
      var r = swingEngine(tc.ydata, tc.swingData);
      var pass = true;
      var reasons = [];
      var e = tc.expect;

      if(e.action && r.action !== e.action){
        pass = false;
        reasons.push('action '+r.action+' (expected '+e.action+')');
      }
      if(e.includes){
        var haystack = (r.blockers||[]).concat(r.warnings||[]).join(' | ');
        if(!haystack.includes(e.includes)){
          pass = false;
          reasons.push("'"+e.includes+"' not in blockers/warnings");
        }
      }
      if(e.scoreMin !== undefined && r.score < e.scoreMin){
        pass = false;
        reasons.push('score '+r.score+' < '+e.scoreMin);
      }
      if(e.trigMin !== undefined){
        var tScore = r.swing_score_layers ? (r.swing_score_layers.trigger||0) : 0;
        if(tScore < e.trigMin){
          pass = false;
          reasons.push('trigger '+tScore+' < '+e.trigMin);
        }
      }
      if(e.decisionPathMin !== undefined){
        var dp = (r.decision_path||[]).length;
        if(dp < e.decisionPathMin){
          pass = false;
          reasons.push('decision_path '+dp+' < '+e.decisionPathMin);
        }
      }
      results.push({ name: tc.name, pass: pass, score: r.score, action: r.action, reasons: reasons });
    } catch(err){
      results.push({ name: tc.name, pass: false, reasons: ['THROWN: '+err.message] });
    }
  });

  var passCount = results.filter(function(r){ return r.pass; }).length;
  console.log('═══ SWING Edge Tests: '+passCount+'/'+results.length+' pass ═══');
  results.forEach(function(r){
    var icon = r.pass ? '✅' : '❌';
    console.log(icon, r.name, r.pass?'':'| ' + r.reasons.join(' · '), r.pass?'(score='+r.score+' action='+r.action+')':'');
  });
  return results;
}

// ═══════════════════════════════════════════════════════════════
// B2: TimeAwareness 자가검증 (시간대 로직이 의도대로 작동하는지)
// ═══════════════════════════════════════════════════════════════
function runTimeAwarenessTests(){
  var phases = ['CLOSED','PRE','ORB','EARLY','PRIME','LATE','NXT_AFTER'];
  var origPhase = G.marketPhase;
  var results = [];

  phases.forEach(function(ph){
    G.marketPhase = ph;
    var ta = getTimeAwareness();
    // 불변식:
    //  - hasLiveTrigger는 항상 hasLivePrice 부분집합
    //  - allowMomoEntry는 hasLiveTrigger 부분집합 (LATE는 예외 — MOMO는 LATE 진입 금지)
    //  - allowCoreEntry는 항상 true
    //  - hasStructure는 항상 true (일봉은 언제나 있음)
    var invariants = [
      { name: 'MOMO 진입 → 실시간 트리거 필요', pass: !ta.allowMomoEntry || ta.hasLiveTrigger || ph==='ORB' },
      { name: 'CORE 진입은 항상 허용', pass: ta.allowCoreEntry === true },
      { name: '일봉 데이터는 항상 가능', pass: ta.hasDailyData === true },
      { name: 'PRE/ORB에는 Volume 완성 아님', pass: (ph!=='PRE' && ph!=='ORB') || !ta.hasLiveVolume },
    ];
    var fails = invariants.filter(function(i){ return !i.pass; });
    results.push({ phase: ph, pass: fails.length===0, fails: fails.map(function(i){return i.name;}) });
  });

  G.marketPhase = origPhase;  // 원상복귀

  var passCount = results.filter(function(r){ return r.pass; }).length;
  console.log('═══ TimeAwareness Tests: '+passCount+'/'+results.length+' pass ═══');
  results.forEach(function(r){
    var icon = r.pass ? '✅' : '❌';
    console.log(icon, r.phase, r.pass?'':'| fails: '+r.fails.join(', '));
  });
  return results;
}

// ═══════════════════════════════════════════════════════════════
// B3: CORE 엣지 케이스 테스트
// ═══════════════════════════════════════════════════════════════
function runCoreEdgeTests(){
  var cases = [
    {
      name: 'Mode A 물밑 증거 부족 → BLOCK',
      ydata: { price: 50000 },
      coreData: { core_mode:'A', conditions_met:1, ad_line_slope:0, rs_13w:2, higher_lows:false, stage:'Stage 2 (상승 추세)' },
      expect: { action: 'BLOCK', includes: '물밑' }
    },
    {
      name: 'RS+A/D 동시 하락 → BLOCK',
      ydata: { price: 50000 },
      coreData: { core_mode:'A', conditions_met:4, rs_declining:true, ad_bullish_div:false, ad_line_slope:-2 },
      expect: { action: 'BLOCK', includes: 'RS+A/D' }
    },
    {
      name: '베이스 깊이 -40% → BLOCK',
      ydata: { price: 50000 },
      coreData: { core_mode:'B', conditions_met:5, base_depth_pct:-40, ad_line_slope:1, rs_13w:3 },
      expect: { action: 'BLOCK', includes: '베이스 깊이' }
    },
    {
      name: '완벽한 ENTER 조건 (proxy 폴백 모드)',
      ydata: { price: 50000 },
      coreData: {
        core_mode:'A', conditions_met:6,
        ad_line_slope: 2, obv_bullish_div: true,
        rs_13w: 8, rs_trend: true, rs_declining: false,
        higher_lows: true, stage: 'Stage 1→2 (전환 초입)',
        up_down_vol_ratio: 1.5, ma60_slope: 1.2, down_vol_exhaustion: true,
        base_breakout_ready: true,
        flow_confidence: 'none',  // 수급 직접 데이터 없음 → proxy 경로
      },
      expect: { action: 'ENTER', scoreMin: 65 }
    },
    {
      name: 'coreData 자체 없음',
      ydata: { price: 50000 },
      coreData: null,
      expect: { action: 'BLOCK', includes: '물밑 지표' }
    },
    // ── 신규: 수급 직접 데이터 시나리오 ──
    {
      name: '외국인+기관 동반 강한 매집 → ENTER 수급 만점',
      ydata: { price: 50000 },
      coreData: {
        core_mode:'A', conditions_met:5,
        flow_confidence: 'full',
        foreign_net_20d: 500000, foreign_days_positive_20d: 15, foreign_net_trend: 1,
        inst_net_20d:    200000, inst_days_positive_20d:    13, inst_net_trend:    1,
        both_accumulating: true,
        ad_line_slope: 1.5, obv_bullish_div: true,  // proxy도 동의
        rs_13w: 6, rs_trend: true, rs_declining: false,
        higher_lows: true, stage: 'Stage 1→2 (전환 초입)',
        up_down_vol_ratio: 1.3, ma60_slope: 0.8, down_vol_exhaustion: true,
        base_breakout_ready: false, base_depth_pct: -8, base_weeks: 4,
      },
      expect: { action: 'ENTER', scoreMin: 65 }
    },
    {
      name: '외국인+기관 동반 매도 + RS 하락 → BLOCK (직접 관찰)',
      ydata: { price: 50000 },
      coreData: {
        core_mode:'A', conditions_met:3,
        flow_confidence: 'full',
        foreign_net_20d: -800000, foreign_days_positive_20d: 4, foreign_net_trend: -1,
        inst_net_20d:    -300000, inst_days_positive_20d:    5, inst_net_trend:    -1,
        both_accumulating: false,
        ad_line_slope: 0.5, ad_bullish_div: true,  // proxy는 다른 방향
        rs_13w: -3, rs_trend: false, rs_declining: true,
        higher_lows: false, stage: 'Stage 3→4 (하락 전환)',
      },
      expect: { action: 'BLOCK', includes: '외국인+기관' }
    },
    {
      name: '수급 proxy vs direct 불일치 → WARNING',
      ydata: { price: 50000 },
      coreData: {
        core_mode:'A', conditions_met:4,
        flow_confidence: 'full',
        foreign_net_20d: 300000, foreign_days_positive_20d: 13, foreign_net_trend: 0,
        inst_net_20d:    50000,  inst_days_positive_20d:    10, inst_net_trend:    0,
        both_accumulating: true,
        ad_line_slope: -1.2, ad_bullish_div: false,  // proxy는 반대 방향
        obv_bullish_div: false,
        rs_13w: 2, rs_trend: true, rs_declining: false,
        higher_lows: true, stage: 'Stage 1→2 (전환 초입)',
        up_down_vol_ratio: 0.9, ma60_slope: 0.3,
      },
      expect: { includesWarning: 'proxy 불일치' }
    },
    {
      name: '외국인 약한 매도 (5/20일) + 기관 중립 → 감점 but WATCH',
      ydata: { price: 50000 },
      coreData: {
        core_mode:'A', conditions_met:3,
        flow_confidence: 'full',
        foreign_net_20d: -100000, foreign_days_positive_20d: 3, foreign_net_trend: 0,
        inst_net_20d:    50000,   inst_days_positive_20d:    9, inst_net_trend:    0,
        both_accumulating: false,
        ad_line_slope: 0.3, obv_bullish_div: false,
        rs_13w: 1, rs_trend: true, rs_declining: false,
        higher_lows: true, stage: 'Stage 1→2 (전환 초입)',
        up_down_vol_ratio: 1.0, ma60_slope: 0.1,
      },
      expect: { action: 'WATCH', includesWarning: '외국인 20일 누적 순매도' }
    },
    // ── 신규: 섹터 RS (업종 지수 기반) 시나리오 ──
    {
      name: '섹터 RS 듀얼 leadership (KOSPI+섹터 모두 강세) → ENTER 만점',
      ydata: { price: 50000 },
      coreData: {
        core_mode:'A', conditions_met:5,
        ad_line_slope:2, obv_bullish_div:true,
        rs_13w:6, rs_trend:true, rs_declining:false,
        sector_name:'전기.전자', sector_code:'1013', rs_sector_13w:8, sector_rs_confidence:'full',
        higher_lows:true, stage:'Stage 1→2 (전환 초입)',
        ma60_slope:1.0, up_down_vol_ratio:1.3, down_vol_exhaustion:true,
      },
      expect: { action:'ENTER', scoreMin:85 }
    },
    {
      name: '코리아 착시 (KOSPI RS+ but 섹터 RS-) → 경고 표시',
      ydata: { price: 50000 },
      coreData: {
        core_mode:'A', conditions_met:4,
        ad_line_slope:1.5, obv_bullish_div:true,
        rs_13w:8, rs_trend:true, rs_declining:false,
        sector_name:'화학', sector_code:'1008', rs_sector_13w:-5, sector_rs_confidence:'full',
        higher_lows:true, stage:'Stage 1→2 (전환 초입)',
        ma60_slope:0.5, up_down_vol_ratio:1.0, down_vol_exhaustion:false,
      },
      expect: { includesWarning: '착시' }
    },
    {
      name: '섹터 매핑 결측 → 폴백 경로 (KOSPI RS만 + warning)',
      ydata: { price: 50000 },
      coreData: {
        core_mode:'A', conditions_met:5,
        ad_line_slope:2, obv_bullish_div:true,
        rs_13w:6, rs_trend:true, rs_declining:false,
        sector_name:'전기.전자', sector_code:null, rs_sector_13w:null, sector_rs_confidence:'mapping_missing',
        higher_lows:true, stage:'Stage 1→2 (전환 초입)',
        ma60_slope:1.0, up_down_vol_ratio:1.3, down_vol_exhaustion:true,
      },
      expect: { action:'ENTER', includesWarning: '매핑 미지정' }
    },
    {
      name: '섹터 내 심각 약세 (-12%p) → BLOCK 유도',
      ydata: { price: 50000 },
      coreData: {
        core_mode:'A', conditions_met:2,
        ad_line_slope:0.5, obv_bullish_div:false,
        rs_13w:1, rs_trend:false, rs_declining:false,
        sector_name:'제약', sector_code:'1009', rs_sector_13w:-12, sector_rs_confidence:'full',
        higher_lows:false, stage:'Stage 2 (상승 추세)',
        ma60_slope:0.2, up_down_vol_ratio:0.9, down_vol_exhaustion:false,
      },
      expect: { action:'BLOCK', includesWarning: '업종 내 약세' }
    },
  ];

  var results = [];
  cases.forEach(function(tc){
    try{
      var r = coreEngine(tc.ydata, tc.coreData);
      var pass = true;
      var reasons = [];
      var e = tc.expect;

      if(e.action && r.action !== e.action){
        pass = false; reasons.push('action '+r.action+' (expected '+e.action+')');
      }
      if(e.includes){
        var haystack = (r.blockers||[]).concat(r.warnings||[]).join(' | ');
        if(!haystack.includes(e.includes)){
          pass = false; reasons.push("'"+e.includes+"' not in blockers/warnings");
        }
      }
      if(e.includesWarning){
        var warnHay = (r.warnings||[]).join(' | ');
        if(!warnHay.includes(e.includesWarning)){
          pass = false; reasons.push("'"+e.includesWarning+"' not in warnings");
        }
      }
      if(e.scoreMin !== undefined && r.score < e.scoreMin){
        pass = false; reasons.push('score '+r.score+' < '+e.scoreMin);
      }
      results.push({ name:tc.name, pass:pass, score:r.score, action:r.action, reasons:reasons });
    } catch(err){
      results.push({ name:tc.name, pass:false, reasons:['THROWN: '+err.message] });
    }
  });

  var passCount = results.filter(function(r){ return r.pass; }).length;
  console.log('═══ CORE Edge Tests: '+passCount+'/'+results.length+' pass ═══');
  results.forEach(function(r){
    var icon = r.pass ? '✅' : '❌';
    console.log(icon, r.name, r.pass?'':'| ' + r.reasons.join(' · '), r.pass?'(score='+r.score+' action='+r.action+')':'');
  });
  return results;
}

// 모든 테스트 한 번에
function runAllEngineTests(){
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('RECONKR 엔진 회귀 테스트');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  var r1 = runSwingEdgeTests();
  console.log('');
  var r2 = runCoreEdgeTests();
  console.log('');
  var r3 = runTimeAwarenessTests();
  var total = r1.length + r2.length + r3.length;
  var pass  = r1.filter(function(r){return r.pass;}).length +
              r2.filter(function(r){return r.pass;}).length +
              r3.filter(function(r){return r.pass;}).length;
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('전체: '+pass+'/'+total+' (' + Math.round(pass/total*100) + '%)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  return { swing: r1, core: r2, timeAwareness: r3, passRate: pass/total };
}

// ── 모듈 export (Node) + 전역 (브라우저) ──
if (typeof module !== 'undefined' && module.exports){
  module.exports = { runAllEngineTests: runAllEngineTests, runSwingEdgeTests: runSwingEdgeTests,
                     runCoreEdgeTests: runCoreEdgeTests, runTimeAwarenessTests: runTimeAwarenessTests };
}
if (typeof window !== 'undefined'){
  window.runAllEngineTests     = runAllEngineTests;
  window.runSwingEdgeTests     = runSwingEdgeTests;
  window.runCoreEdgeTests      = runCoreEdgeTests;
  window.runTimeAwarenessTests = runTimeAwarenessTests;
}
