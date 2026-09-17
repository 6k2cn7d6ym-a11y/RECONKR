/* ============================================================
 * RECONKR MOMO 결정 엔진 — momoEngine.js
 * 원본: indexreconkr.html 에서 추출 (로직 무변경)
 * 변경점:
 *   1) 전역 G 의존을 _G 폴백으로 명시화 (브라우저: G 그대로, Node: global.G 주입)
 *   2) DOM 설정값 읽기를 _mCfg(id, fallback)로 — Node에선 fallback 사용
 * 외부 의존: getTimeAwareness (engineUtil.js — 먼저 로드)
 * 포함: calcMomoStop, getWhaleStage, hardFilter, momoEngine
 * ============================================================ */
'use strict';

// ── 환경 가드: 브라우저는 DOM 설정값, Node 봇은 fallback 사용 ──
function _mCfg(id, fallback){
  if(typeof document === 'undefined' || !document.getElementById) return fallback;
  var el = document.getElementById(id);
  return (el && el.textContent != null) ? el.textContent : fallback;
}


// ═══════════════════════════════════════
// MOMO 구조적 손절 계산기
// ═══════════════════════════════════════
function calcMomoStop(entry, ydata, phase){
  // 유효 레벨: entry 대비 0.8%~15% 아래만 손절 후보
  function validLevel(v){
    return typeof v === 'number' &&
           isFinite(v) && v > 0 &&
           v <= entry * 0.992 &&   // 최소 0.8% 아래
           v >= entry * 0.85;      // 최대 15% 아래
  }
  var candidates = [];

  if(phase !== 'PRE'){
    // 장중: ORB 저점 우선
    if(validLevel(ydata.orb_low))
      candidates.push(ydata.orb_low * 0.995);
    // VWAP 2% 아래
    if(ydata.vwap && validLevel(ydata.vwap * 0.98))
      candidates.push(ydata.vwap * 0.98);
  } else {
    // PRE: pm_low (entry 대비 -7% 이내만 — 이상 저점 제외)
    if(ydata.pm_low && validLevel(ydata.pm_low) && ydata.pm_low >= entry * 0.93)
      candidates.push(ydata.pm_low * 0.995);
  }

  // 공통: 최근 지지선
  if(validLevel(ydata.nearest_support))
    candidates.push(ydata.nearest_support * 0.99);

  // 하드스탑 4.5% (항상 존재)
  candidates.push(entry * 0.955);

  // 가장 높은 값 = 가장 타이트한 손절
  return Math.max.apply(null, candidates);
}

// ═══════════════════════════════════════
// 세력 스테이지 판별기 (BLOCK 대신 단계 안내)
// ═══════════════════════════════════════

// ── 세력 6단계 분류 ──
// TOXIC        : 불량세력 (관리종목·횡령·배포말기)   → BLOCK
// DISTRIBUTING : 배포 진행 중 (상한가근접·물량털기)  → BLOCK
// BREAKOUT     : 시세 분출 ★ (팩트공시+거래대금5배) → ENTER + 단계안내
// EARLY_MOVE   : 세력 초기 움직임 (공시없음+거래대금3배) → ENTER + 주의
// SHAKEOUT     : 개미털기 끝물 (거래량감소+지지확인) → WATCH (진입금지)
// ACCUMULATING : 극비매집 초입 (거래대금2~3배+이격낮음) → WATCH
// NORMAL       : 일반 종목                           → 기본 판단

function getWhaleStage(r){
  var _G = (typeof G !== 'undefined' && G) ? G : {};
  var tv   = r.trading_value_ratio  || 0;
  var turn = r.turnover_pct         || 0;
  var gap  = r.gap_pct              || 0;
  var isoK = (r.ma20_gap_pct != null) ? r.ma20_gap_pct : null;  // 미계산(null)을 0%로 오인하지 않도록
  var ul   = r.ulimit_pct;
  var news = (r.news_quality        || 'none');
  var nwTx = (r.newsText            || '').toLowerCase();
  var rvol = r.rvol                 || 0;

  // ── 데이터 없음 (장 마감/시간외) → NORMAL 반환 ──
  // null 데이터가 전부 0으로 처리되면 SHAKEOUT 조건을 만족해버리는 오진 방지
  var hasData = (r.price && r.price > 0) && (r.volume && r.volume > 0);
  if(!hasData){
    return { stage:'NORMAL', action:'WATCH',
      label:(_G.marketPhase==='PRE'?'📊 동시호가 — 체결 전':'📊 데이터 없음 (장 마감)'), warnings:[], cautions:[] };
  }

  // ── TOXIC: 즉시 BLOCK (불량 세력 확실) ──
  if(nwTx.includes('관리종목') || nwTx.includes('투자경고') ||
     nwTx.includes('횡령')     || nwTx.includes('배임')     ||
     nwTx.includes('상장폐지') || nwTx.includes('불성실공시'))
    return { stage:'TOXIC', action:'BLOCK',
      label:'☠ 불량세력 / 위험종목',
      warnings:['관리종목·횡령·상장폐지 관련 — 절대 진입 금지'],
      cautions:[] };

  // ── DISTRIBUTING: 배포 말기 BLOCK ──
  // 3축: 이격 + 거래량소멸 + 고점이탈 (ul<10 경고는 momoEngine에서 별도 처리)
  var refHigh = r.intraday_range_high || r.pm_high || null;
  var highFail  = refHigh !== null && r.price !== undefined && r.price < refHigh * 0.96;
  var volDead   = isoK > 28 && (tv < 2 || rvol < 1.5);   // 이격 크고 거래량 소멸
  var turnSus   = turn > 30 && news === 'none' && isoK > 20; // 회전율 과열 + 공시없음 + 이격

  // 고점이탈 + 이격 2축 조합 (refHigh 없으면 볼륨소멸만으로 판정)
  var distCore  = (isoK > 28 && highFail) || volDead || turnSus;

  if(distCore){
    // wick_ratio 확증 여부
    var wickConfirm = r.breakout_wick_ratio !== null && r.breakout_wick_ratio !== undefined && r.breakout_wick_ratio > 0.5;
    var wickStrong  = r.breakout_wick_ratio !== null && r.breakout_wick_ratio !== undefined && r.breakout_wick_ratio > 0.7;
    return { stage:'DISTRIBUTING', action:'BLOCK',
      label:'📤 세력 배포 구간',
      warnings:[
        volDead  ? 'MA20 이격 +'+isoK+'% + 거래량 소멸 — 세력 고점 배포' : null,
        highFail ? '장중 고점 대비 하락 — 매도 우위 구조' : null,
        turnSus  ? '회전율 '+turn.toFixed(1)+'% + 공시없음 — 배포 의심' : null,
        wickConfirm ? '윗꼬리 비율 '+((r.breakout_wick_ratio||0)*100).toFixed(0)+'% — '+(wickStrong?'배포 강하게 확증':'배포 확증') : null,
      ].filter(Boolean),
      cautions:['배포 이후 급락 패턴 빈번','익일 갭하락 위험'] };
  }

  // ── BREAKOUT: 시세 분출 ★ 핵심 진입 ──
  // 거래대금 5배+ + 팩트공시 + 갭 3~20% (20% 초과는 이미 고점 추격) + 이격 30% 이내 (DART 연동 후 완화)
  var isBreakout = tv >= 5 && news === 'factual' && gap >= 3 && gap <= 20 && isoK <= 30;
  if(isBreakout)
    return { stage:'BREAKOUT', action:'ENTER',
      label:'🚀 세력 시세분출 — 올라타기 구간',
      warnings:[
        isoK > 22 ? 'MA20 이격 +'+isoK+'% — 분출 중반 이후, 진입각 좁음' : null,
        turn > 20  ? '회전율 '+turn.toFixed(1)+'% — 단타 세력 가능성, 당일 청산 원칙' : null,
        gap > 12   ? '갭 '+gap.toFixed(1)+'% — 추격 진입, 손절선 넓게 잡을 것' : null,
      ].filter(Boolean),
      cautions:[
        '거래대금 3배 이상 유지되는 동안만 유효',
        '10:30 이후 거래량 급감 시 즉시 청산',
        news==='factual' ? '팩트공시 확인 — 내용 실질성 재확인' : '공시 내용 반드시 직접 확인',
        ul!==null ? '상한가까지 '+(ul||0).toFixed(1)+'% — 목표가 산정 기준' : null,
      ].filter(Boolean) };

  // ── EARLY_MOVE: 세력 초기 움직임 ──
  // 필수: tv>=3 + gap>=3 + isoK<=18 (DART 연동 후 완화 — 공시 품질로 보완)
  // 강화: price>vwap(필수) + rvol>=2(필수) + vwap_pct<15 or wick<0.5 (1개 필수)
  var emBase = tv >= 3 && gap >= 3 && isoK <= 18 && (news !== 'none' || turn < 15);
  if(emBase){
    // VWAP 필수 — 없으면 탈락
    var hasVwap   = typeof r.vwap === 'number' && r.vwap > 0;
    var aboveVwap = hasVwap && r.price > r.vwap;
    if(!hasVwap || !aboveVwap){
      // VWAP 없거나 아래면 NO_NEWS_SURGE 또는 하위로 처리
      // EARLY_MOVE 탈락 → 아래 단계로 폴스루
    } else {
      // rvol >= 2 필수
      var emRvolOk = rvol >= 2;
      // 추가 필수 1개: vwap_pct<15 OR (wick 있고 <0.5)
      var vwapPct     = r.vwap_pct !== null && r.vwap_pct !== undefined ? r.vwap_pct : null;
      var wickRatio   = r.breakout_wick_ratio !== null && r.breakout_wick_ratio !== undefined ? r.breakout_wick_ratio : null;
      var emQualityOk = (vwapPct !== null && vwapPct < 15) ||
                        (wickRatio !== null && wickRatio < 0.5);

      if(emRvolOk && emQualityOk){
        return { stage:'EARLY_MOVE', action:'ENTER',
          label:'⚡ 세력 초기 움직임 — 소량 선진입',
          warnings:[
            news === 'none' ? '공시 미확인 — 테마/소문 가능성, 포지션 절반 이하' : null,
            tv < 4 ? '거래대금 '+tv.toFixed(1)+'배 — 아직 약함, 5일선 지지 확인 필수' : null,
          ].filter(Boolean),
          cautions:[
            '전체 포지션의 30~50%만 진입',
            '공시 확인 즉시 포지션 증감 결정',
            'VWAP 이탈 시 즉시 손절',
            '2차 분출 확인 후 나머지 추가 진입 전략',
          ] };
      }
      // rvol<2 이거나 품질조건 미충족 → WATCH 수준으로 폴스루
    }
  }

  // ── NO_NEWS_SURGE: 공시없는 거래대금 폭발 ──
  // DART 공시 or 신뢰 뉴스가 있으면 EARLY_MOVE로 격상 가능 → 여기서 걸리지 않음
  var hasDartOrNews = (r.dartDisclosures && r.dartDisclosures.length > 0)
                   || r.dartQuality === 'factual'
                   || (r.newsText && r.newsText.length > 10 && !r.newsText.includes('DART공시 없음'));
  // NO_NEWS_SURGE: rvol>=2 AND isoK>=2 강화 (실제 이동 중인 종목만)
  // 완전 플랫 종목(isoK<2, rvol<2)은 NORMAL로 폴스루
  if(tv >= 3 && rvol >= 2 && news === 'none' && isoK >= 2 && isoK <= 10 && !hasDartOrNews)
    return { stage:'NO_NEWS_SURGE', action:'WATCH',
      label:'🔍 공시없는 거래 폭발 — 확인 전 관망',
      warnings:[
        'DART/뉴스 미확인 — 진입 금지, 공시 확인 후 재스캔',
        '[불확실] 분류 근거: tv '+tv.toFixed(1)+'배 + RVol '+rvol.toFixed(1)+'x + 공시없음',
        '전체 포지션 진입 불가 (WATCH 전용)',
      ],
      cautions:[
        '공시 발표 즉시 재스캔 → BREAKOUT or BLOCK 판단',
        '거래량 소멸 시 관심 제거',
      ] };

  // ── SHAKEOUT: 개미털기 끝물 ──
  // 전일 급등 후 거래량 감소 + 5일선 지지 중
  // SHAKEOUT: 선행 급등 증거 필수 — isoK>=3(이격 존재) OR gap<-1(갭 하락)
  // 증거 없이 거래량만 낮은 평범한 종목은 NORMAL로 폴스루
  var hasShakeoutContext = isoK >= 3 || gap < -1;
  if(tv < 2 && rvol < 1.5 && gap >= -3 && gap <= 3 && isoK <= 8 && hasShakeoutContext)
    return { stage:'SHAKEOUT', action:'WATCH',
      label:'🪤 개미털기 진행 중 — 당일 진입 금지',
      warnings:[
        '거래량 없는 반등은 세력 부재 신호 (RVol '+rvol.toFixed(1)+'x)',
        '[불확실] 판별 근거: tv '+tv.toFixed(1)+'배 + 이격 '+isoK+'% — 확증 어려움',
      ],
      cautions:['5일선 지지 확인 후 익일 관심','거래량 동반 양봉 출현 시 진입 검토'] };

  // ── ACCUMULATING: 극비 매집 초입 ──
  // ACCUMULATING: rvol>=1.0 AND gap>=1 추가 — 완전 플랫 종목 제외
  // tv 2~3배만으로는 매집 판단 불충분 → 최소한의 가격 움직임 필요
  if(tv >= 2 && tv < 3 && rvol >= 1.0 && news === 'none' && isoK < 5 && gap >= 1)
    return { stage:'ACCUMULATING', action:'WATCH',
      label:'🔬 세력 극비 매집 의심 — 다일 추적',
      warnings:[
        '매집 초입 — 시세 분출까지 수일~수주 소요',
        '[불확실] 판별 근거: tv '+tv.toFixed(1)+'배 — 다일 관찰 필수',
      ],
      cautions:['거래대금 점증 확인 후 진입 검토','당일 진입보다 익일 이후 관심'] };

  return { stage:'NORMAL', action:r.action||'WATCH',
    label:'📊 일반 수급', warnings:[], cautions:[] };
}

// ── 메인 하드 필터 (세력 스테이지 반영) ──
function hardFilter(r, mode){
  var _G = (typeof G !== 'undefined' && G) ? G : {};
  // 보유 종목은 진입용 하드필터 건너뜀 (매도/관리 분석이 목적)
  if(r._openTrade) return r.action;

  if(mode === 'core') return r.action;

  if(mode === 'swing'){
    if(_G.spyAboveMA200 === false && r.action === 'ENTER'){
      r.warnings = (r.warnings||[]).concat(['[시장] KOSPI 120일선 아래 — 스윙 진입 WATCH']);
      return 'WATCH';
    }
    if(r.ma20_gap_pct !== null && r.ma20_gap_pct > 20 && r.action === 'ENTER'){
      r.warnings = (r.warnings||[]).concat(['[기술] MA20 이격 +'+r.ma20_gap_pct+'% — 눌림목 대기']);
      return 'WATCH';
    }
    return r.action;
  }

  // ── MOMO 세력 스테이지 판별 ──
  var ws = getWhaleStage(r);
  r._whaleStage      = ws.stage;
  r._whaleLabel      = ws.label;
  r._whaleWarnings   = ws.warnings  || [];
  r._whaleCautions   = ws.cautions  || [];

  // TOXIC / DISTRIBUTING → 무조건 BLOCK
  if(ws.action === 'BLOCK'){
    r.blockers = (r.blockers||[]).concat(
      ['[세력] '+ws.label].concat(ws.warnings)
    );
    return 'BLOCK';
  }

  // 세력 경고·주의사항을 signals에 추가 (BLOCK 아님)
  if(ws.warnings.length > 0)
    r.warnings = (r.warnings||[]).concat(
      ws.warnings.map(function(w){ return '[세력'+ws.stage+'] '+w; })
    );

  // ── 시장 필터 (KOSPI) ──
  if(_G.spyIntraday){
    var spy = _G.spyIntraday;
    if(spy.trend === 'crash'){
      r.blockers = (r.blockers||[]).concat(['[시장] KOSPI 폭락 — MOMO 전종목 BLOCK']);
      return 'BLOCK';
    }
    if(spy.trend === 'down' && ws.action === 'ENTER'){
      r.warnings = (r.warnings||[]).concat(['[시장] KOSPI 하락 중 — 포지션 50% 이하 권고']);
    }
    if((spy.aboveOpen === false || spy.aboveVwap === false) && r.action === 'ENTER'){
      r.warnings = (r.warnings||[]).concat(['[시장] KOSPI '+(spy.aboveOpen===false?'시가':'VWAP')+' 아래 — 당일 약세 주의']);
    }
  }

  // ── 절대 거래대금 하드필터 ──
  var minTvAbs = parseFloat(_mCfg('minTvAbs','10'))||10;
  if(r.trading_value_m !== null && r.trading_value_m !== undefined && r.trading_value_m < minTvAbs && r.action === 'ENTER'){
    r.blockers = (r.blockers||[]).concat(['[유동성] 거래대금 '+r.trading_value_m.toFixed(1)+'억 — 최소 '+minTvAbs+'억 미달, 슬리피지 위험']);
    return 'BLOCK';
  }

  // ── MA20 이격 30% 초과 → BLOCK (단기 과확장, 추격 금지) ──
  if(r.ma20_gap_pct !== null && r.ma20_gap_pct !== undefined && r.ma20_gap_pct > 30 && r.action === 'ENTER'){
    r.blockers = (r.blockers||[]).concat(['[기술] MA20 이격 +'+r.ma20_gap_pct+'% — 단기 과확장 BLOCK, 눌림목 후 재진입 대기']);
    return 'BLOCK';
  }

  // ── RVol 장중 최소 기준 (PRE 제외) ──
  var kstNowHF = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Seoul'}));
  var hmHF = kstNowHF.getHours()*100 + kstNowHF.getMinutes();
  var isMarketOpenNow = kstNowHF.getDay()>0 && kstNowHF.getDay()<6 && hmHF>=900 && hmHF<1530;
  if(isMarketOpenNow && r.action === 'ENTER'){
    var minRvol = parseFloat(_mCfg('minRvol','1.5'))||1.5;
    if(r.rvol !== null && r.rvol !== undefined && r.rvol < minRvol){
      r.warnings = (r.warnings||[]).concat(['[유동성] RVol '+r.rvol.toFixed(1)+'x — '+minRvol+'x 미달, WATCH 다운그레이드']);
      return 'WATCH';
    }
  }

  // ── 시간대 필터 ──
  if(_G.marketPhase === 'ORB' && ws.action === 'ENTER'){
    r.warnings = (r.warnings||[]).concat(['[시간] 9:00~9:05 ORB 형성 중 — 캔들 확정 후 진입']);
    ws.action = 'WATCH';
  }
  if(_G.marketPhase === 'LATE')
    r.warnings = (r.warnings||[]).concat(['[시간] 13:00+ 오후 — 거래대금 급감 시 청산 준비']);

  // ── VWAP 이탈 ──
  if(r.vwap && r.price && r.price < r.vwap * 0.98 && ws.action === 'ENTER'){
    r.warnings = (r.warnings||[]).concat(['[기술] VWAP ₩'+Math.round(r.vwap).toLocaleString()+' 아래 — 매도 구조']);
    ws.action = 'WATCH';
  }

  // ── ORB 덤프 ──
  if(_G.marketPhase !== 'PRE' && r.orb_low && r.price && r.price < r.orb_low * 0.99){
    r.warnings = (r.warnings||[]).concat(['[기술] ORB 저점 이탈 — 개장 덤프 패턴']);
    ws.action = 'WATCH';
  }

  // WATCH/NORMAL이면 원래 action 유지
  if(ws.action === 'WATCH') return 'WATCH';
  return r.action || 'WATCH';
}

// ═══════════════════════════════════════════════════════════════
// ███  결정 엔진 (Deterministic)  ███
// Claude가 아닌 코드가 ENTER/WATCH/BLOCK · 점수 · 포지션 크기 결정
// Claude는 뉴스 해석 + 2줄 설명만 담당
// ═══════════════════════════════════════════════════════════════

// ── MOMO 결정 엔진 ──
function momoEngine(ydata){
  var _G = (typeof G !== 'undefined' && G) ? G : {};
  var r = {
    action:'WATCH', score:0, position_size:'none',
    whale_stage:'NORMAL', whale_label:'', whale_strategy:'',
    blockers:[], warnings:[], signals:[],
    decision_path:[],  // 결정 경로 추적 [{gate,status,note}]
    entry: ydata.entry_calc || ydata.price,
    stop:  ydata.stop_calc  || null,
    target1: ydata.target_calc || null,
    target2: null,
    rr: ydata.rr_calc || null,
    pullback_entry:  ydata.pullback_entry  || null,
    pullback_stop:   ydata.pullback_stop   || null,
    pullback_target: ydata.pullback_target || null,
    pullback_rr:     ydata.pullback_rr     || null,
  };

  // ── 시간대 기록 (MOMO는 장중 실시간 기반) ──
  var _ta = getTimeAwareness();
  r._timeAwareness = {
    phase: _ta.phase,
    livePrice: _ta.hasLivePrice && !!ydata.price,
    liveTrigger: _ta.hasLiveTrigger,
    dailyStructure: _ta.hasDailyData,
  };
  // MOMO는 장외 시간대엔 신규 진입 불가 — 조기 BLOCK (단 분석 자체는 진행)
  // 장중이 아니면 결과에 flag만 남기고 기존 점수 계산은 그대로 진행
  // (사용자가 "어제/내일 이 종목 MOMO로 적합했을까" 참고 가능)
  if(!_ta.allowMomoEntry){
    r.warnings.push('[시간대] '+_ta.phase+' — MOMO 신규 진입 시간 아님 (참고용 분석)');
  }

  var gap  = ydata.gap_pct              || 0;
  var tv   = ydata.trading_value_ratio  || 0;
  var tvM  = ydata.trading_value_m      || 0;
  var rvol = ydata.rvol                 || 0;
  var ul   = ydata.ulimit_pct           !== null && ydata.ulimit_pct !== undefined ? ydata.ulimit_pct : (30 - gap);
  var cap  = ydata.market_cap_b         || 0;
  var isoK = ydata.ma20_gap_pct         || 0;

  // ── 1. 세력 스테이지 판별 ──
  var ws = getWhaleStage(ydata);
  r.whale_stage    = ws.stage;
  r.whale_label    = ws.label;
  r.whale_strategy = ws.cautions ? ws.cautions[0] || '' : '';
  if(ws.warnings && ws.warnings.length) r.warnings = r.warnings.concat(ws.warnings.map(function(w){ return '[세력] '+w; }));

  // ── 2. 즉시 BLOCK ──
  if(ws.action === 'BLOCK'){
    r.action='BLOCK'; r.score=0; r.position_size='none';
    r.blockers = r.blockers.concat(['[세력] '+ws.label]).concat(ws.warnings||[]);
    r.decision_path.push({gate:'세력',status:'block',note:ws.label});
    return r;
  }
  r.decision_path.push({gate:'세력',status:ws.stage==='NORMAL'?'pass':ws.stage,note:ws.label||ws.stage});
  if(ul < 5){ r.action='BLOCK'; r.blockers.push('[상한가] 잔여 '+ul.toFixed(0)+'% — 에너지 소진');
    r.decision_path.push({gate:'하드필터',status:'block',note:'상한가 잔여 '+ul.toFixed(0)+'%'}); return r; }
  if(gap > 20){ r.action='BLOCK'; r.blockers.push('[갭] '+gap.toFixed(1)+'% 초과 — 고점 추격');
    r.decision_path.push({gate:'하드필터',status:'block',note:'갭 '+gap.toFixed(1)+'% 초과'}); return r; }
  if(isoK > 30){ r.action='BLOCK'; r.blockers.push('[이격] MA20 +'+isoK+'% — 단기 과확장');
    r.decision_path.push({gate:'하드필터',status:'block',note:'이격 MA20 +'+isoK+'%'}); return r; }
  r.decision_path.push({gate:'하드필터',status:'pass',note:'갭 '+gap.toFixed(1)+'% · 상한가 '+ul.toFixed(0)+'% · 이격 '+isoK+'%'});

  // ── 추격 방지 플래그 ──
  // BREAKOUT / EARLY_MOVE 는 팩트공시 or 세력 초기이동 기반 → +20%까지 허용 (기존 하드필터 통과한 것)
  // 그 외 (NORMAL / NO_NEWS_SURGE / SHAKEOUT / ACCUMULATING): +12% 초과 시 ENTER 금지
  var _chaseWatchFlag = false;
  if(gap > 12 && ws.stage !== 'BREAKOUT' && ws.stage !== 'EARLY_MOVE'){
    _chaseWatchFlag = true;
    r.warnings.push('[추격방지] +'+gap.toFixed(1)+'% 급등 — 팩트공시 미확인 구조, 점수와 무관하게 ENTER 금지');
    r.decision_path.push({gate:'추격방지',status:'watch',note:'+'+gap.toFixed(1)+'% ('+ws.stage+') — 추격 구조'});
  }

  // ── 2-B. KOSPI 시장 게이트 (점수가 아닌 행동 제한) ──
  var kospiChg = _G.spyIntraday ? _G.spyIntraday.change_pct : null;
  var _kospiBlock  = false;
  var _kospiWatchOnly = false;
  var _kospiHalfCap   = false;
  if(kospiChg !== null){
    if(kospiChg <= -1.5){
      r.action='BLOCK';
      r.blockers.push('[시장] KOSPI '+kospiChg.toFixed(1)+'% — 전종목 BLOCK');
      r.decision_path.push({gate:'시장',status:'block',note:'KOSPI '+kospiChg.toFixed(1)+'% 폭락'});
      return r;
    } else if(kospiChg <= -0.8){
      _kospiWatchOnly = true;
      r.warnings.push('[시장] KOSPI '+kospiChg.toFixed(1)+'% — ENTER 금지, WATCH만 허용');
      r.decision_path.push({gate:'시장',status:'watch',note:'KOSPI '+kospiChg.toFixed(1)+'% — ENTER 금지'});
    } else if(kospiChg <= -0.3){
      _kospiHalfCap = true;
      r.warnings.push('[시장] KOSPI '+kospiChg.toFixed(1)+'% — 포지션 50% 이하 제한');
      r.decision_path.push({gate:'시장',status:'warn',note:'KOSPI '+kospiChg.toFixed(1)+'% — 포지션 50% 캡'});
    } else {
      r.decision_path.push({gate:'시장',status:'pass',note:'KOSPI '+(kospiChg>=0?'+':'')+kospiChg.toFixed(1)+'%'});
    }
    var _kospiWeak = (_G.spyIntraday.aboveOpen === false) || (_G.spyIntraday.aboveVwap === false);
    if(_kospiWeak){
      r.warnings.push('[시장] KOSPI '+(_G.spyIntraday.aboveOpen===false?'시가':'VWAP')+' 아래 — 당일 약세 구조');
    }
  } else {
    r.decision_path.push({gate:'시장',status:'pass',note:'KOSPI 데이터 없음'});
  }

  // ══════════════════════════════════════════
  // 3. 점수 계산 — 핵심 4개 + 세력 보정
  // ══════════════════════════════════════════
  var score = 0;

  // ① 거래대금 배수 (max 35pt) — MOMO 제1 신호
  if(tv >= 10)     { score += 35; r.signals.push('거래대금 '+tv.toFixed(0)+'배 폭발'); }
  else if(tv >= 5) { score += 25; r.signals.push('거래대금 '+tv.toFixed(1)+'배'); }
  else if(tv >= 3) { score += 15; r.signals.push('거래대금 '+tv.toFixed(1)+'배'); }
  // 절대 거래대금 (max +5pt, 보조)
  if(tvM >= 100)     { score += 5; r.signals.push('거래대금 '+tvM.toFixed(0)+'억'); }
  else if(tvM >= 50) { score += 3; }
  else if(tvM >= 10) { score += 1; }

  // ② 갭 (max 15pt)
  if(gap >= 5 && gap <= 12)      { score += 15; r.signals.push('갭 '+gap.toFixed(1)+'%'); }
  else if(gap >= 3 && gap < 5)   { score += 8;  r.signals.push('갭 '+gap.toFixed(1)+'%'); }
  else if(gap > 12 && gap <= 20) { score += 5;  r.warnings.push('갭 '+gap.toFixed(1)+'% — 추격 주의'); }

  // ③ VWAP (+10 / -10)
  var ph = _G.marketPhase || '';
  if(ph !== 'PRE'){
    if(ydata.vwap && ydata.price){
      if(ydata.price > ydata.vwap){
        score += 10; r.signals.push('VWAP 위');
      } else if(ydata.price < ydata.vwap * 0.985){
        score -= 10; r.warnings.push('VWAP 아래 '+(((ydata.vwap-ydata.price)/ydata.vwap)*100).toFixed(1)+'% — 매도 압력');
      }
    }
  }

  // ④ 시간대 (+10 → -15)
  if(ph === 'EARLY')      { score += 10; r.signals.push('골든윈도우'); }
  else if(ph === 'PRIME') { score += 5; }
  else if(ph === 'ORB')   { score -= 10; r.warnings.push('ORB 형성 중 — 점수 -10'); }
  else if(ph === 'LATE')  { score -= 15; r.warnings.push('오후 페이드 — 점수 -15, 소량만'); }

  // ── 세력 스테이지 점수 보정 (판단 주체 아님, 확률 조정용) ──
  if(ws.stage === 'BREAKOUT')      { score += 15; r.signals.push('BREAKOUT — 팩트공시+거래폭발'); }
  else if(ws.stage === 'EARLY_MOVE'){ score += 8;  r.signals.push('EARLY_MOVE — 초기 이동'); }
  else if(ws.stage === 'NO_NEWS_SURGE'){
    score -= 10;
    r.warnings.push('[NO_NEWS_SURGE] 공시 없는 폭발 — 확인 전 확률 낮춤');
  } else if(ws.stage === 'SHAKEOUT'){
    score -= 15;
    r.warnings.push('[SHAKEOUT] 개미털기 패턴 — 확률 대폭 낮춤');
  } else if(ws.stage === 'ACCUMULATING'){
    score -= 5;
    r.warnings.push('[ACCUMULATING] 매집 의심 — 당일 진입 불리');
  }

  // ── 보조 감점 (패널티만, 양수 없음) ──
  // RVol 약하면 체결 어려움
  if(rvol > 0 && rvol < 1.5){
    score -= 8; r.warnings.push('RVol '+rvol.toFixed(1)+'x — 유동성 약함');
  }
  // 시총 너무 작으면 슬리피지 위험
  if(cap > 0 && cap < 200){
    score -= 10; r.warnings.push('시총 '+cap.toFixed(0)+'억 — 초소형 슬리피지 주의');
  }

  // ── 상한가 잔여 5~10% 경고 (점수 영향 없음, 리스크 표시만) ──
  if(ul >= 5 && ul < 10){
    r.warnings.push('[상한가] 잔여 '+ul.toFixed(0)+'% — 에너지 소진 임박, 당일 청산 원칙');
  }

  // ── 모멘텀 소진 (PRIME/LATE — ORB 고점 대비 후퇴) ──
  if((ph==='PRIME'||ph==='LATE') && ydata.orb_high && ydata.price && ydata.orb_high > 0){
    var _orbRetract = (ydata.orb_high - ydata.price) / ydata.orb_high * 100;
    if(_orbRetract > 8){
      score -= 15; r.warnings.push('[소진] ORB 고점 -'+_orbRetract.toFixed(1)+'% — 주요 이동 완료');
    } else if(_orbRetract > 4){
      score -= 8;  r.warnings.push('[소진] ORB 고점 -'+_orbRetract.toFixed(1)+'% — 모멘텀 약화');
    }
  }

  r.score = Math.min(100, Math.max(0, score));

  // Gate 3: 점수 기록
  var _topSig = (r.signals||[]).slice(0,2).join(' · ') || '신호 없음';
  r.decision_path.push({gate:'점수',status:r.score>=60?'pass':r.score>=30?'warn':'block',note:r.score+'pt — '+_topSig});

  // ══════════════════════════════════════════
  // 4. 액션 결정 — 단순 3단계
  // ══════════════════════════════════════════
  if(_kospiWatchOnly && r.score >= 30){
    // KOSPI 약하락 — ENTER 자격 있는 종목만 WATCH로 강등 (저점수는 아래 BLOCK 유지)
    r.action = 'WATCH';
    r.decision_path.push({gate:'트리거',status:'watch',note:'KOSPI 강하락 — ENTER 금지 ('+r.score+'pt)'});
  } else if(_chaseWatchFlag){
    r.action = 'WATCH';
    r.decision_path.push({gate:'트리거',status:'watch',note:'추격방지 +'+gap.toFixed(1)+'% — 점수 '+r.score+'pt이나 ENTER 금지'});
  } else if(!_ta.allowMomoEntry){
    // 장외 시간대 — 점수와 무관하게 신규 진입 불가 (분석은 참고용으로만)
    r.action = 'WATCH';
    r.warnings.push('[시간대] '+_ta.phase+' — 장외 시간, 신규 MOMO 진입 불가 (참고용 점수 '+r.score+'pt)');
    r.decision_path.push({gate:'트리거',status:'watch',note:'장외('+_ta.phase+') — ENTER 불가'});
  } else if(r.score >= 60){
    // ── 단일 하드 트리거: ORB 저점 이탈 (가격 붕괴, 객관적) ──
    if(ph !== 'PRE' && ydata.orb_low && ydata.price && ydata.price < ydata.orb_low * 0.99){
      r.action = 'WATCH';
      r.warnings.push('[트리거] ORB 저점 이탈 — 점수 '+r.score+'pt이나 가격 붕괴');
      r.decision_path.push({gate:'트리거',status:'watch',note:'ORB 저점 이탈'});
    } else {
      r.action = 'ENTER';
      r.decision_path.push({gate:'트리거',status:'pass',note:ph+(ydata.vwap&&ydata.price>ydata.vwap?' · VWAP위':'')});
    }
  } else if(r.score >= 30){
    r.action = 'WATCH';
    r.decision_path.push({gate:'트리거',status:'watch',note:'점수 미달 ('+r.score+'pt < 60)'});
  } else {
    r.action = 'BLOCK';
    r.blockers.push('점수 '+r.score+'pt — 기준 미달 (<30)');
    r.decision_path.push({gate:'트리거',status:'block',note:'점수 미달 ('+r.score+'pt)'});
  }

  // ── 5. action_reason — 단 한 줄 ──
  var _topSigs = (r.signals||[]).slice(0,2).join(' + ');
  var _topWarn = (r.warnings||[]).length ? ' ⚠'+r.warnings[0].replace(/^\[.*?\]\s*/,'').split(' — ')[0] : '';
  r.action_reason = _topSigs + (r.action==='ENTER'?' → 진입':r.action==='WATCH'?' → 대기':' → 차단') + _topWarn;

  // ── 6. 포지션 크기 ──
  // 스테이지 × 점수 매트릭스:
  //   BREAKOUT  + score≥75  → half(50%)   : 팩트공시 + 강한 확증
  //   BREAKOUT  + score<75  → quarter(25%): 팩트공시이나 확증 부족
  //   EARLY_MOVE             → quarter(25%): 초기 이동, 추가 확인 필요
  //   NORMAL    + score≥75  → quarter(25%): 고신뢰 무세력 진입
  //   NORMAL    + score<75  → small(10%)  : 저신뢰 — 탐색용 소량만
  if(r.action === 'ENTER'){
    if(ws.stage === 'BREAKOUT' && r.score >= 75)       r.position_size = 'half(50%)';
    else if(ws.stage === 'BREAKOUT')                    r.position_size = 'quarter(25%)';
    else if(ws.stage === 'EARLY_MOVE')                  r.position_size = 'quarter(25%)';
    else if(r.score >= 75)                              r.position_size = 'quarter(25%)';
    else                                                r.position_size = 'small(10%)';
    if(_kospiHalfCap && r.position_size === 'half(50%)') r.position_size = 'quarter(25%)';

    // 슬리피지 HIGH → WATCH (R:R 구조 붕괴)
    // medium → 전략 변경만 (진입은 허용)
    if(ydata.slippage_risk === 'high'){
      r.action        = 'WATCH';
      r.position_size = 'none';
      r.warnings.push('[슬리피지] '+ydata.slippage_pct+'% — R:R 구조 붕괴, 지정가 확인 후 재진입');
      r.decision_path = r.decision_path.filter(function(s){return s.gate!=='트리거';});
      r.decision_path.push({gate:'트리거',status:'watch',note:'슬리피지 '+ydata.slippage_pct+'% — ENTER→WATCH'});
    } else if(ydata.slippage_risk === 'medium'){
      r.warnings.push('[슬리피지] '+ydata.slippage_pct+'% — 지정가 분할 진입 권장');
    }

    if(r.action === 'ENTER'){
      // ── 구조적 손절 계산 ──
      var structStop = calcMomoStop(r.entry, ydata, ph);
      r.stop = structStop;
      if(r.target1 && r.entry && r.stop && r.entry > r.stop){
        r.rr = parseFloat(((r.target1 - r.entry) / (r.entry - r.stop)).toFixed(1));
      }
    }
  }
  return r;
}

// ── 모듈 export (Node) + 전역 (브라우저) ──
if (typeof module !== 'undefined' && module.exports){
  module.exports = { momoEngine: momoEngine, calcMomoStop: calcMomoStop,
                     getWhaleStage: getWhaleStage, hardFilter: hardFilter };
}
if (typeof window !== 'undefined'){
  window.momoEngine    = momoEngine;
  window.calcMomoStop  = calcMomoStop;
  window.getWhaleStage = getWhaleStage;
  window.hardFilter    = hardFilter;
}
