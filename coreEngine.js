/* ============================================================
 * RECONKR CORE 결정 엔진 — coreEngine.js
 * 원본: indexreconkr.html 에서 추출 (로직 무변경)
 * 외부 의존: getTimeAwareness (engineUtil.js — 먼저 로드)
 * 포함: coreEngine
 * ============================================================ */
'use strict';

function coreEngine(ydata, coreData, babylonKR){
  var r = {
    action:'WATCH', score:0, position_size:'none',
    blockers:[], warnings:[], signals:[],
    entry:null, stop:null, target1:null, rr:null,
    underground_score:0, core_mode:'A', core_detail:[],
    babylonKR: babylonKR || null,  // 펀더 평가 결과 (시각화용)
  };
  if(!coreData){ r.blockers.push('물밑 지표 데이터 부족'); r.action='BLOCK'; return r; }

  // ── 시간대 기록 (CORE는 일봉/주봉 기반이라 시간 무관하게 작동) ──
  var _ta = getTimeAwareness();
  r._timeAwareness = {
    phase: _ta.phase,
    livePrice: _ta.hasLivePrice && !!ydata.price,
    liveTrigger: false,       // CORE는 실시간 트리거 미사용
    dailyStructure: _ta.hasDailyData,
  };

  r.underground_score = coreData.conditions_met || 0;
  r.core_mode         = coreData.core_mode || 'A';
  r.core_detail       = coreData.condition_detail || [];
  // 밸류에이션/성장 (표시+AI용, 엔진 영향 없음)
  r.per              = coreData.per;
  r.pbr              = coreData.pbr;
  r.psr              = coreData.psr;
  r.revenue_yoy      = coreData.revenue_yoy;
  r.op_margin        = coreData.op_margin;
  r.fin_report_label = coreData.fin_report_label;
  r.fin_confidence   = coreData.fin_confidence;

  // ── 진입각 계산 ──
  if(ydata.price){
    var cEntry = parseFloat((ydata.price*1.005).toFixed(2));
    var fw = ydata.fiftyTwoWeekHigh;
    var cStop, cTarget;
    if(r.core_mode==='A'){
      cStop   = parseFloat((cEntry*0.93).toFixed(2));
      cTarget = Math.max(
        fw&&fw>cEntry ? parseFloat((fw*0.75).toFixed(2)) : 0,
        parseFloat((cEntry*1.30).toFixed(2))
      ); // 항상 진입가 +30% 이상 보장 (52주고가×0.75가 진입가 아래로 가는 버그 방지)
    } else {
      var baseLow = coreData.recent6wHigh&&coreData.base_depth_pct ? coreData.recent6wHigh*(1+coreData.base_depth_pct/100) : null;
      cStop   = baseLow ? parseFloat((baseLow*0.98).toFixed(2)) : parseFloat((cEntry*0.93).toFixed(2));
      cTarget = fw&&fw>cEntry ? parseFloat((fw*1.10).toFixed(2)) : parseFloat((cEntry*1.20).toFixed(2));
    }
    var cRisk = cEntry-cStop;
    r.entry  = cEntry; r.stop = cStop; r.target1 = cTarget;
    r.rr     = cRisk>0 ? parseFloat(((cTarget-cEntry)/cRisk).toFixed(1)) : null;
  }

  // ── 점수 계산 — 축별 점수 추적 (최소기준 게이트용) ──
  var _scoreSupply = 0;  // 수급축 max 30
  var _scoreRS     = 0;  // RS축: max 25
  var _scoreStruct = 0;  // 구조축 (HL+Stage): max 25
  var _scoreAux    = 0;  // 보조축 (vol+MA): max 20

  // ① 수급 지표 (30pt) — 한국 시장: 외국인/기관 직접 관찰값 우선, A/D·OBV는 proxy로 보조
  var _hasFlow   = coreData.flow_confidence && coreData.flow_confidence !== 'none'
                   && coreData.foreign_net_20d !== null;
  var _supplyBreakdown = { src: _hasFlow ? 'direct' : 'proxy' };

  if(_hasFlow){
    // ── [A] 외국인 누적 순매수 (max 12pt) ──
    var fDays = coreData.foreign_days_positive_20d || 0;
    var fNet  = coreData.foreign_net_20d;
    var _fPts = 0;
    if(fNet > 0){
      if(fDays >= 12)      { _fPts=12; r.signals.push('외국인 20일 누적 순매수 ('+fDays+'/20일 매수)'); }
      else if(fDays >= 8)  { _fPts=8;  r.signals.push('외국인 누적 순매수 중 ('+fDays+'/20일)'); }
      else                 { _fPts=4;  }
    } else if(fNet < 0 && fDays < 5){
      _fPts = -5;
      r.warnings.push('외국인 20일 누적 순매도 ('+fDays+'/20일만 매수)');
    }
    _supplyBreakdown.foreign_pts = _fPts;
    _scoreSupply += _fPts;

    // ── [B] 기관 누적 순매수 (max 8pt) ──
    var iDays = coreData.inst_days_positive_20d || 0;
    var iNet  = coreData.inst_net_20d;
    var _iPts = 0;
    if(iNet > 0){
      if(iDays >= 12)      { _iPts=8; r.signals.push('기관 20일 누적 순매수 ('+iDays+'/20일)'); }
      else if(iDays >= 8)  { _iPts=5; }
      else                 { _iPts=2; }
    } else if(iNet < 0 && iDays < 5){
      _iPts = -3;
      r.warnings.push('기관 20일 누적 순매도 ('+iDays+'/20일만 매수)');
    }
    _supplyBreakdown.inst_pts = _iPts;
    _scoreSupply += _iPts;

    // ── [C] 동반 매집 + 추세 가속 보너스 (max 5pt) ──
    var _bPts = 0;
    if(coreData.both_accumulating && coreData.foreign_net_trend === 1){
      _bPts = 5; r.signals.push('외국인+기관 동반 매집 + 매수 가속 ★');
    } else if(coreData.both_accumulating){
      _bPts = 3; r.signals.push('외국인+기관 동반 매집');
    }
    _supplyBreakdown.both_pts = _bPts;
    _scoreSupply += _bPts;

    // ── [D] A/D + OBV proxy 교차 검증 (max 5pt) ──
    var adUp  = coreData.ad_line_slope !== null && coreData.ad_line_slope > 0;
    var obvOk = coreData.obv_bullish_div === true;
    var _proxyPts = 0;
    if(fNet > 0 && adUp && obvOk){
      _proxyPts = 5; r.signals.push('A/D+OBV proxy 동반 확인 (수급 교차검증)');
    } else if(adUp || obvOk){
      _proxyPts = 2;
    }
    // 불일치 경고: 직접 매수 but proxy 하락 → 대형 매도호가 지속 의심
    if(fNet > 0 && !adUp && coreData.ad_line_slope !== null && coreData.ad_line_slope < -0.5){
      r.warnings.push('외국인 매수 but A/D Line 하락 — proxy 불일치 (대형 매도호가/분배 의심)');
    }
    _supplyBreakdown.proxy_pts = _proxyPts;
    _scoreSupply += _proxyPts;

  } else {
    // ── 폴백: 수급 직접 데이터 결측 → A/D + OBV proxy 만으로 (기존 로직) ──
    var _adPts = 0;
    if(coreData.ad_line_slope!==null && coreData.ad_line_slope > 0){
      _adPts = 15; r.signals.push('A/D Line 상승 ('+coreData.ad_line_slope+'%) [proxy]');
    } else if(coreData.ad_line_slope!==null && coreData.ad_line_slope > -1){
      _adPts = 5;
    }
    var _obvPts = coreData.obv_bullish_div === true ? 15 : 0;
    if(_obvPts) r.signals.push('OBV 불리시 다이버전스 [proxy]');

    _supplyBreakdown.ad_pts  = _adPts;
    _supplyBreakdown.obv_pts = _obvPts;
    _scoreSupply += _adPts + _obvPts;

    r.warnings.push('수급 직접 데이터 결측 (Yahoo 폴백 모드) — A/D·OBV proxy만으로 판단, 신뢰도 하락');
  }
  r._supplyBreakdown = _supplyBreakdown;

  // ② RS 지표 (25pt) — KOSPI RS + 섹터 RS 이중 벤치마크
  // 한국 시장은 업종 로테이션이 지배적 → 업종 내 leadership 이 중요
  // 섹터 RS 있음: KOSPI 8 + 섹터 12 + 추세 5 = 25
  // 섹터 RS 없음(매핑 결측 or fetch 실패): 기존 방식 15 + 10 = 25 (폴백)
  var _hasSectorRS = coreData.sector_rs_confidence === 'full' && coreData.rs_sector_13w !== null;
  var _rsBreakdown = { src: _hasSectorRS ? 'dual' : 'kospi_only' };

  if(_hasSectorRS){
    // KOSPI RS (max 8pt)
    var _rsKospiPts = 0;
    if(coreData.rs_13w!==null){
      if(coreData.rs_13w>5)        { _rsKospiPts = 8; r.signals.push('KOSPI RS +'+coreData.rs_13w+'%p — 시장 대비 강세'); }
      else if(coreData.rs_13w>0)   { _rsKospiPts = 5; r.signals.push('KOSPI RS +'+coreData.rs_13w+'%p'); }
      else if(coreData.rs_13w>-5)  { _rsKospiPts = 2; }
      else                         { _rsKospiPts = -3; r.warnings.push('KOSPI RS '+coreData.rs_13w+'%p — 시장 대비 약세'); }
    }
    _scoreRS += _rsKospiPts;
    _rsBreakdown.kospi_pts = _rsKospiPts;

    // 섹터 RS (max 12pt) — 한국 시장 핵심: 업종 내 leadership
    var _rsSectorPts = 0;
    var secRS = coreData.rs_sector_13w;
    if(secRS > 5)         { _rsSectorPts = 12; r.signals.push('섹터 RS +'+secRS+'%p — 업종 내 리더십 ('+coreData.sector_name+')'); }
    else if(secRS > 0)    { _rsSectorPts = 7;  r.signals.push('섹터 RS +'+secRS+'%p ('+coreData.sector_name+')'); }
    else if(secRS > -5)   { _rsSectorPts = 2; }
    else                  { _rsSectorPts = -8; r.warnings.push('섹터 RS '+secRS+'%p — 업종 내 약세 ('+coreData.sector_name+')'); }
    _scoreRS += _rsSectorPts;
    _rsBreakdown.sector_pts = _rsSectorPts;

    // 일치/불일치 메타 경고 — 코리아 착시 체크
    if(coreData.rs_13w > 3 && secRS < -3){
      r.warnings.push('KOSPI RS 상승 but 섹터 RS 하락 — 업종 내 약세 (시장 대비 착시 가능)');
    }

  } else {
    // 섹터 RS 폴백: 기존 KOSPI 단일 RS
    if(coreData.rs_13w!==null){
      if(coreData.rs_13w>5)        { _scoreRS+=15; r.signals.push('RS13w +'+coreData.rs_13w+'%p — 강한 아웃퍼폼'); }
      else if(coreData.rs_13w>0)   { _scoreRS+=10; r.signals.push('RS13w +'+coreData.rs_13w+'%p'); }
      else if(coreData.rs_13w>-5)  { _scoreRS+=3; }
      else                         { _scoreRS-=5;  r.warnings.push('RS13w '+coreData.rs_13w+'%p — 상대약세'); }
    }
    _rsBreakdown.kospi_pts = _scoreRS;
    if(coreData.sector_rs_confidence === 'mapping_missing' && coreData.sector_name){
      r.warnings.push('[섹터 RS] "'+coreData.sector_name+'" 매핑 미지정 — KOSPI RS만 사용 (업종 로테이션 반영 불가)');
    } else if(coreData.sector_rs_confidence === 'fetch_failed'){
      r.warnings.push('[섹터 RS] 업종 지수 조회 실패 — KOSPI RS만 사용');
    }
  }

  // RS 추세 (듀얼 경로: +5pt, 폴백 경로: +10pt — 전체 25pt 유지) — 경로 관계 없이 rs_declining 은 동일한 -15pt
  var _trendPts = 0;
  if(coreData.rs_trend===true){
    _trendPts = _hasSectorRS ? 5 : 10;
    _scoreRS += _trendPts;
    r.signals.push('RS 추세 개선 중');
  }
  if(coreData.rs_declining===true){ _scoreRS-=15; r.warnings.push('RS 하락 중 — 상대강도 약화'); _trendPts -= 15; }
  _rsBreakdown.trend_pts = _trendPts;
  r._rsBreakdown = _rsBreakdown;

  // ③ 구조 지표 (25pt)
  if(coreData.higher_lows===true){ _scoreStruct+=15; r.signals.push('Higher Lows (12주 확인)'); }
  if(coreData.stage==='Stage 1→2 (전환 초입)'){ _scoreStruct+=10; r.signals.push('Stage 1→2 전환 초입'); }
  else if(coreData.stage==='Stage 2 (상승 추세)'){ _scoreStruct+=5; }
  else if(coreData.stage==='Stage 3→4 (하락 전환)'||coreData.stage==='Stage 4 (하락)'){
    _scoreStruct-=10; r.warnings.push('Stage 하락 구간 — CORE 진입 불가');
  }

  // ④ 보조 지표 (20pt)
  if(coreData.down_vol_exhaustion===true){ _scoreAux+=7; r.signals.push('하락일 거래량 고갈'); }
  if(coreData.up_down_vol_ratio!==null&&coreData.up_down_vol_ratio>=1.2){ _scoreAux+=7; r.signals.push('Up/Down 거래량 '+coreData.up_down_vol_ratio+'x'); }
  else if(coreData.up_down_vol_ratio!==null&&coreData.up_down_vol_ratio>=1.0){ _scoreAux+=3; }
  if(coreData.ma60_slope!==null&&coreData.ma60_slope>0){ _scoreAux+=6; }

  // ⑤ 베이스 트리거 보너스 (보조에 합산)
  if(coreData.base_breakout_ready){
    _scoreAux+=12;
    r.signals.push('베이스 돌파 준비 — 상단 '+coreData.base_top_tests+'회 테스트 + 거래량 수축');
  } else if(coreData.base_top_tests>=2 && coreData.base_depth_pct!==null && coreData.base_depth_pct>=-5){
    _scoreAux+=5;
    r.signals.push('베이스 상단 접근 중 ('+coreData.base_top_tests+'회 테스트)');
  } else if(coreData.base_depth_pct!==null && coreData.base_depth_pct>=-10 && coreData.base_weeks>=3){
    _scoreAux+=2; // 베이스는 있는데 아직 멀어
  }

  var score = _scoreSupply + _scoreRS + _scoreStruct + _scoreAux;
  r.score = Math.min(100, Math.max(0, score));
  // 축별 점수 저장 (카드 표시 + 최소기준 게이트용)
  r._coreAxes = { supply:_scoreSupply, rs:_scoreRS, struct:_scoreStruct, aux:_scoreAux };

  // B3: CORE 레이어 breakdown (SWING과 동일 구조 — 데이터 신뢰도 포함)
  // 수급축은 flow_confidence에 따라 direct/proxy 두 가지 breakdown 제공
  var _supplyLayer;
  if(_hasFlow){
    _supplyLayer = [
      { label:'외국인 20일 누적' + (coreData.foreign_net_20d!==null?' ('+(coreData.foreign_days_positive_20d||0)+'/20일 매수)':''),
        got: _supplyBreakdown.foreign_pts||0, max: 12,
        ok: (coreData.foreign_net_20d>0 && coreData.foreign_days_positive_20d>=12),
        partial: (coreData.foreign_net_20d>0),
        confidence: 'full' },
      { label:'기관 20일 누적' + (coreData.inst_net_20d!==null?' ('+(coreData.inst_days_positive_20d||0)+'/20일 매수)':''),
        got: _supplyBreakdown.inst_pts||0, max: 8,
        ok: (coreData.inst_net_20d>0 && coreData.inst_days_positive_20d>=12),
        partial: (coreData.inst_net_20d>0),
        confidence: 'full' },
      { label:'동반 매집 + 가속',
        got: _supplyBreakdown.both_pts||0, max: 5,
        ok: (coreData.both_accumulating && coreData.foreign_net_trend===1),
        partial: coreData.both_accumulating,
        confidence: 'full' },
      { label:'A/D+OBV proxy 교차검증',
        got: _supplyBreakdown.proxy_pts||0, max: 5,
        ok: (_supplyBreakdown.proxy_pts===5),
        partial: (_supplyBreakdown.proxy_pts>=2),
        confidence: (coreData.ad_line_slope!==null || coreData.obv_bullish_div!==undefined) ? 'full' : 'missing' },
    ];
  } else {
    _supplyLayer = [
      { label:'A/D Line 상승 [proxy]' + (coreData.ad_line_slope!==null?' ('+coreData.ad_line_slope+'%)':''),
        got: _supplyBreakdown.ad_pts||0, max: 15,
        ok: coreData.ad_line_slope!==null&&coreData.ad_line_slope>0,
        confidence: coreData.ad_line_slope!==null ? 'partial' : 'missing' },
      { label:'OBV 불리시 다이버전스 [proxy]',
        got: _supplyBreakdown.obv_pts||0, max: 15,
        ok: coreData.obv_bullish_div===true,
        confidence: coreData.obv_bullish_div!==undefined ? 'partial' : 'missing' },
      { label:'외국인/기관 직접값',
        got: 0, max: 0, ok: false, confidence: 'missing' },
    ];
  }

  r.layer_breakdown = {
    supply: _supplyLayer,
    rs: _hasSectorRS ? [
      { label:'KOSPI RS13w' + (coreData.rs_13w!==null?' '+coreData.rs_13w+'%p':''),
        got: _rsBreakdown.kospi_pts||0, max: 8,
        ok: coreData.rs_13w>5, partial: coreData.rs_13w>0,
        confidence: coreData.rs_13w!==null ? 'full' : 'missing' },
      { label:'섹터 RS13w' + (coreData.sector_name?' ('+coreData.sector_name+')':'') + (coreData.rs_sector_13w!==null?' '+coreData.rs_sector_13w+'%p':''),
        got: _rsBreakdown.sector_pts||0, max: 12,
        ok: coreData.rs_sector_13w>5, partial: coreData.rs_sector_13w>0,
        confidence: 'full' },
      { label:'RS 추세',
        got: _rsBreakdown.trend_pts||0, max: 5,
        ok: coreData.rs_trend===true,
        confidence: (coreData.rs_trend!==undefined||coreData.rs_declining!==undefined) ? 'full' : 'missing' },
    ] : [
      { label:'RS13w (KOSPI only)' + (coreData.rs_13w!==null?' '+coreData.rs_13w+'%p':''),
        got: coreData.rs_13w===null?0 : coreData.rs_13w>5?15 : coreData.rs_13w>0?10 : coreData.rs_13w>-5?3 : -5,
        max: 15, ok: coreData.rs_13w>5, partial: coreData.rs_13w>0,
        confidence: coreData.rs_13w!==null ? 'full' : 'missing' },
      { label:'RS 추세 개선',
        got: coreData.rs_trend===true ? 10 : coreData.rs_declining===true ? -15 : 0,
        max: 10, ok: coreData.rs_trend===true,
        confidence: (coreData.rs_trend!==undefined||coreData.rs_declining!==undefined) ? 'full' : 'missing' },
      { label:'섹터 RS',
        got: 0, max: 0, ok: false,
        confidence: coreData.sector_rs_confidence || 'missing' },
    ],
    struct: [
      { label:'Higher Lows (12주)',
        got: coreData.higher_lows===true ? 15 : 0, max: 15, ok: coreData.higher_lows===true,
        confidence: coreData.higher_lows!==undefined ? 'full' : 'missing' },
      { label:'Stage' + (coreData.stage ? ' '+coreData.stage.split(' ')[0] : ''),
        got: coreData.stage==='Stage 1→2 (전환 초입)' ? 10 : coreData.stage==='Stage 2 (상승 추세)' ? 5 : (coreData.stage==='Stage 3→4 (하락 전환)'||coreData.stage==='Stage 4 (하락)') ? -10 : 0,
        max: 10, ok: coreData.stage==='Stage 1→2 (전환 초입)', partial: coreData.stage==='Stage 2 (상승 추세)',
        confidence: coreData.stage ? 'full' : 'missing' },
    ],
    aux: [
      { label:'하락일 거래량 고갈',
        got: coreData.down_vol_exhaustion===true ? 7 : 0, max: 7, ok: coreData.down_vol_exhaustion===true,
        confidence: coreData.down_vol_exhaustion!==undefined ? 'full' : 'missing' },
      { label:'Up/Down 거래량' + (coreData.up_down_vol_ratio!==null?' '+coreData.up_down_vol_ratio+'x':''),
        got: coreData.up_down_vol_ratio===null?0 : coreData.up_down_vol_ratio>=1.2?7 : coreData.up_down_vol_ratio>=1.0?3 : 0,
        max: 7, ok: coreData.up_down_vol_ratio>=1.2, partial: coreData.up_down_vol_ratio>=1.0,
        confidence: coreData.up_down_vol_ratio!==null ? 'full' : 'missing' },
      { label:'MA60 우상향',
        got: coreData.ma60_slope!==null&&coreData.ma60_slope>0 ? 6 : 0, max: 6, ok: coreData.ma60_slope!==null&&coreData.ma60_slope>0,
        confidence: coreData.ma60_slope!==null ? 'full' : 'missing' },
      { label:'베이스 돌파 준비',
        got: coreData.base_breakout_ready ? 12 : (coreData.base_top_tests>=2 && coreData.base_depth_pct!==null && coreData.base_depth_pct>=-5) ? 5 : (coreData.base_depth_pct!==null && coreData.base_depth_pct>=-10 && coreData.base_weeks>=3) ? 2 : 0,
        max: 12, ok: coreData.base_breakout_ready, partial: coreData.base_top_tests>=2,
        confidence: (coreData.base_breakout_ready!==undefined || coreData.base_depth_pct!==null) ? 'full' : 'missing' },
    ],
  };

  // B1: CORE decision_path
  r.decision_path = [
    { gate:'입력', status:'pass', note:'coreData 확인 (mode='+r.core_mode+', 물밑='+r.underground_score+'/8, 수급='+(_hasFlow?'직접':'proxy')+')' },
    { gate:'수급축', status: _scoreSupply>=15?'pass':_scoreSupply>=5?'warn':'fail',
      note: (_hasFlow ? '외국인+기관 직접 ' : 'A/D+OBV proxy ')+_scoreSupply+'/30pt' },
    { gate:'RS축', status: _scoreRS>=15?'pass':_scoreRS>=0?'warn':'fail',
      note: (_hasSectorRS ? 'KOSPI+섹터('+coreData.sector_name+') ' : 'KOSPI only ')+_scoreRS+'/25pt' },
    { gate:'구조축', status: _scoreStruct>=15?'pass':_scoreStruct>=5?'warn':'fail', note:'HL+Stage '+_scoreStruct+'/25pt' },
    { gate:'보조축', status: _scoreAux>=10?'pass':'warn', note:'볼륨+베이스 '+_scoreAux+'/20pt' },
  ];

  // ── BLOCK 조건 ──
  if(r.core_mode==='overextended'){
    r.action='BLOCK'; r.blockers.push('[CORE] 베이스 없이 과확장 — 베이스 형성 후 재진입');
    r.decision_path.push({gate:'BLOCK',status:'block',note:'베이스 없이 과확장'});
    return r;
  }
  // NEW: 외국인+기관 동반 20일 순매도 + RS 하락 → 직접 관찰 분배 구간
  // (proxy A/D 기반 기존 조건보다 강한 증거)
  if(_hasFlow && coreData.foreign_net_20d < 0 && coreData.inst_net_20d < 0
     && coreData.foreign_days_positive_20d < 8 && coreData.rs_declining){
    r.action='BLOCK';
    r.blockers.push('[CORE] 외국인+기관 동반 20일 순매도 + RS 하락 — 분배 구간 (직접 관찰)');
    r.decision_path.push({gate:'BLOCK',status:'block',note:'외인+기관 동반 매도 + RS하락'});
    return r;
  }
  if(coreData.rs_declining && coreData.ad_bullish_div===false){
    r.action='BLOCK'; r.blockers.push('[CORE] RS+A/D 동시 하락 — 기관 분배 구간 (proxy)');
    r.decision_path.push({gate:'BLOCK',status:'block',note:'RS+A/D 동시하락 (proxy 분배)'});
    return r;
  }
  if(coreData.base_depth_pct!==null && coreData.base_depth_pct < -35){
    r.action='BLOCK'; r.blockers.push('[CORE] 베이스 깊이 '+coreData.base_depth_pct+'% — 수급 손상');
    r.decision_path.push({gate:'BLOCK',status:'block',note:'베이스깊이 '+coreData.base_depth_pct+'%'});
    return r;
  }
  if(r.core_mode==='A' && r.underground_score<=1){
    r.action='BLOCK'; r.blockers.push('[CORE] Mode A 물밑 신호 '+r.underground_score+'/8 — 증거 부족');
    r.decision_path.push({gate:'BLOCK',status:'block',note:'물밑 '+r.underground_score+'/8 부족'});
    return r;
  }

  // ── 축별 최소기준 게이트 (총점 전에 먼저 체크) ──
  // 한 축이 완전히 비어있으면 "균형 없는 CORE" — ENTER 불가
  var _axisGatePass = true;
  var _axisGateFail = [];
  if(_scoreSupply < 5)  { _axisGatePass=false; _axisGateFail.push('수급 '+_scoreSupply+'pt < 5pt 최소'); }
  if(_scoreRS < 0)      { _axisGatePass=false; _axisGateFail.push('RS '+_scoreRS+'pt — 음수'); }
  if(_scoreStruct < 5)  { _axisGatePass=false; _axisGateFail.push('구조(HL+Stage) '+_scoreStruct+'pt < 5pt 최소'); }

  // ═══════════════════════════════════════
  // BabylonKR 펀더 게이트 (사용 가능한 경우)
  // ═══════════════════════════════════════
  // (a) BabylonKR BLOCK = 무조건 BLOCK (재무 악화/거버넌스 등 펀더 함정)
  // (b) ENTER 시 BabylonKR verdict 로 position_size 차등
  // (c) BabylonKR 가 차트보다 우선 (BabylonKR BLOCK = 차트 ENTER 무시)
  if(babylonKR){
    if(babylonKR.verdict === 'BLOCK'){
      r.action = 'BLOCK';
      r.blockers.push('[BabylonKR] 펀더 BLOCK — ' + babylonKR.evidence);
      r.decision_path.push({gate:'BabylonKR', status:'block', note:'펀더 게이트 차단 (점수 '+babylonKR.score.toFixed(0)+')'});
      return r;
    }
  }

  // ── 액션 결정 ──
  if(r.score >= 65 && r.underground_score >= 4 && !coreData.rs_declining && _axisGatePass){
    r.action='ENTER';

    // BabylonKR verdict 별 기본 사이즈 (없으면 기존 로직)
    if(babylonKR){
      if(babylonKR.verdict === 'ENTER_SUPERCYCLE'){
        r.position_size = 'full(100%)';
        r.signals.push('🚀 BabylonKR SUPERCYCLE + 차트 진입 = 만점 (펀더 점수 '+babylonKR.score.toFixed(0)+')');
      } else if(babylonKR.verdict === 'ENTER_BREAKOUT'){
        r.position_size = 'half(50%)';
        r.signals.push('🟢 BabylonKR BREAKOUT (펀더 점수 '+babylonKR.score.toFixed(0)+')');
      } else if(babylonKR.verdict === 'ENTER_BUILDING'){
        r.position_size = 'quarter(25%)';
        r.signals.push('🟡 BabylonKR BUILDING (펀더 점수 '+babylonKR.score.toFixed(0)+') — 작은 비중');
      } else if(babylonKR.verdict === 'WATCH_EARLY'){
        r.position_size = 'eighth(12.5%)';
        r.signals.push('⚠ BabylonKR WATCH (펀더 점수 '+babylonKR.score.toFixed(0)+') — 매우 작은 비중');
      } else {
        // verdict 없거나 기타 — 기존 로직
        r.position_size = coreData.base_breakout_ready ? 'half(50%)' : 'quarter(25%)';
      }
    } else {
      // BabylonKR 데이터 없을 때 기존 로직
      r.position_size = coreData.base_breakout_ready ? 'half(50%)' : 'quarter(25%)';
    }

    r.decision_path.push({gate:'액션',status:'enter',note:'ENTER · '+r.score+'pt · 물밑 '+r.underground_score+'/8 · '+r.position_size + (babylonKR ? ' · BabylonKR='+babylonKR.verdict : '')});
  } else if(r.score >= 45 || r.underground_score >= 3){
    r.action='WATCH';
    if(!_axisGatePass){
      r.warnings.push('[축 불균형] '+_axisGateFail.join(' / ')+' — 전 축 확인 후 재진입');
    }
    if(coreData.rs_declining) r.warnings.push('[WATCH] RS 하락 중 — 개선 확인 후 재판단');
    // 베이스 돌파 준비 + WATCH → "진입 임박" 표시
    if(coreData.base_breakout_ready){
      r.signals.push('📦 베이스 돌파 임박 — 거래량 확인 후 진입 고려');
    }
    // BabylonKR 강력 신호 시 격상 힌트
    if(babylonKR && (babylonKR.verdict === 'ENTER_SUPERCYCLE' || babylonKR.verdict === 'ENTER_BREAKOUT')){
      r.signals.push('💎 펀더 강함 ('+babylonKR.verdict+', '+babylonKR.score.toFixed(0)+'pt) — 차트 개선 시 우선 후보');
    }
    r.decision_path.push({gate:'액션',status:'watch',note:'WATCH · '+r.score+'pt · '+(_axisGatePass?'점수 부족':'축 불균형') + (babylonKR ? ' · 펀더='+babylonKR.verdict : '')});
  } else {
    r.action='BLOCK';
    r.blockers.push('[CORE] 점수 '+r.score+'pt/물밑 '+r.underground_score+'/8 — 매집 증거 부족');
    r.decision_path.push({gate:'액션',status:'block',note:'BLOCK · '+r.score+'pt · 매집 증거 부족'});
  }

  return r;
}

// ── 모듈 export (Node) + 전역 (브라우저) ──
if (typeof module !== 'undefined' && module.exports){
  module.exports = { coreEngine: coreEngine };
}
if (typeof window !== 'undefined'){
  window.coreEngine = coreEngine;
}
