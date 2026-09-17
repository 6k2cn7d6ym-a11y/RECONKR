/* ============================================================
 * RECONKR 청산 엔진 — exitEngine.js
 * 원본: indexreconkr.html 에서 추출 (로직 무변경)
 * 변경점:
 *   1) 전역 G 의존을 _G 폴백으로 명시화
 *   2) EXIT_CFG의 localStorage 읽기에 환경 가드 (Node 안전)
 *   3) persistExitState → saveJournal 존재할 때만 호출 (Node 안전)
 * ★ 주의: US exitEngine과 달리 이 엔진은 trade.exitState를 직접 변이하고
 *   persistExitState()로 저널 저장까지 호출함 (순수 함수 아님).
 *   순수화(결정/실행 분리)는 별도 단계에서 백테스트·테스트 통과 후 진행할 것.
 * 외부 의존: tradeHoldDays (engineUtil.js — 먼저 로드), saveJournal (index.html)
 * 포함: EXIT_CFG, initExitState, persistExitState, exitEngine, calcSwingExitSignals
 * ============================================================ */
'use strict';

// ═══════════════════════════════════════════════════════════════
// EXIT ENGINE — 결정론적 청산 엔진 (2026-06)
//
// 원칙:
//  1. 레벨(손절/T1/T2)은 포지션에 1회 고정(exitState) — Claude가 매번 새로 정하지 않음
//  2. 갱신은 코드 규칙만: T1 도달 → 절반 매도 + 손절 BE 이동 / 트레일링 고점 추적
//  3. 우선순위 결정 트리 — 손절(P0)이 모든 것에 우선
//  4. SWING MA 이탈은 종가 확정(15:20+) 기준 청산 — 장중엔 경고만 (휩쏘 방지)
//  5. Claude는 해설 전용 — API 실패해도 카드는 엔진만으로 완전체
//
// 조정: localStorage.setItem('exitCfg', JSON.stringify({...})) 후 새로고침
// ═══════════════════════════════════════════════════════════════
var EXIT_CFG = (function(){
  var def = {
    momo:  { stopPct:-4.5, t1R:1.0, t2R:2.0, trailPct:3,  timeDays:2,  timeMinPnl:0 },
    swing: { stopPct:-3.5, t1R:1.5, t2R:3.0, trailPct:7,  timeDays:14, timeMinPnl:1 },
    core:  { stopPct:-7.0, t1R:2.0, t2R:4.0, trailPct:10, timeDays:56, timeMinPnl:0 },
  };
  try{
    var ov = (typeof localStorage !== 'undefined') ? JSON.parse(localStorage.getItem('exitCfg')||'null') : null;
    if(ov) ['momo','swing','core'].forEach(function(m){ if(ov[m]) Object.assign(def[m], ov[m]); });
  }catch(e){}
  return def;
})();

// 포지션 청산 상태 초기화 (1회) — 이후 모든 스캔은 이 상태를 기준으로 판정
function initExitState(trade, mode){
  if(trade.exitState && trade.exitState.ver === 1) return trade.exitState;
  var cfg   = EXIT_CFG[mode] || EXIT_CFG.momo;
  var entry = trade.entry;
  // ★ 2026-09 정합 패치: 레벨 출처 단일화
  //   기존: 항상 EXIT_CFG R배수로 재계산 → swingEngine이 계산한 stop/T1/T2(MA5·MA20·10일고점 기반)는
  //         카드에만 표시되고 실제 청산 판정엔 쓰이지 않았음 (앱 ≠ 백테스트 useEngineStops:true).
  //   이제: trade에 유효한 계획(stop<entry<t1<=t2)이 있으면 그것을 1순위로 고정 (src:'trade-plan').
  //         없거나 무효면 기존 EXIT_CFG 기본값 (src:'engine-default').
  var pStop = parseFloat(trade.stop), pT1 = parseFloat(trade.t1), pT2 = parseFloat(trade.t2);
  var planOk = isFinite(pStop) && isFinite(pT1) && pStop > 0 && pStop < entry && pT1 > entry;
  var stop, t1, t2, src;
  if(planOk){
    stop = parseFloat(pStop.toFixed(2));
    t1   = parseFloat(pT1.toFixed(2));
    t2   = (isFinite(pT2) && pT2 > t1) ? parseFloat(pT2.toFixed(2))
         : parseFloat(Math.max(t1 * 1.10, entry + (entry - stop) * cfg.t2R).toFixed(2));
    src  = 'trade-plan';
  } else {
    stop = parseFloat((entry * (1 + cfg.stopPct/100)).toFixed(2));
    var risk = entry - stop;
    t1   = parseFloat((entry + risk * cfg.t1R).toFixed(2));
    t2   = parseFloat((entry + risk * cfg.t2R).toFixed(2));
    src  = 'engine-default';
  }
  var x = {
    ver: 1,
    stop:        stop,
    initialStop: stop,
    t1:          t1,
    t2:          t2,
    t1Done:      trade.status === 'partial',  // 이미 분할매도 했으면 T1 완료 취급
    beMoved:     false,
    highWater:   entry,
    setAt:       Date.now(),
    src:         src,
  };
  // 이미 분할매도 상태면 손절선을 본전으로
  if(x.t1Done && x.stop < entry){ x.stop = entry; x.beMoved = true; }
  trade.exitState = x;
  return x;
}

// 영속 훅 — 브라우저: saveJournal / 봇: setExitPersist(fn)으로 Firestore 등 주입 (2026-09)
var EXIT_HOOKS = { persist: null };
function setExitPersist(fn){ EXIT_HOOKS.persist = (typeof fn === 'function') ? fn : null; }
function persistExitState(trade){
  if (EXIT_HOOKS.persist) { try { EXIT_HOOKS.persist(trade); } catch(e){} return; }
  if (typeof saveJournal === 'function') saveJournal();
}

// ── 메인 엔진 ──
// ctx: { price, ydata, swingData, coreData, holdEngine(momo 재평가), exitSig(swing 신호), hm }
function exitEngine(mode, trade, ctx){
  var _G = (typeof G !== 'undefined' && G) ? G : {};
  var cfg   = EXIT_CFG[mode] || EXIT_CFG.momo;
  var x     = initExitState(trade, mode);
  var price = ctx.price;
  var entry = trade.entry;
  var r = {
    _engineExit: true,
    hold_action: 'HOLD', urgency: 'monitor',
    stop: x.stop, t1: x.t1, t2: x.t2, trailing_stop: null,
    score: ctx.holdEngine ? ctx.holdEngine.score : null,
    reason: '', summary: '',
    signals: [], warnings: [], decision_path: [],
    _exitStage: x.t1Done ? 'RISK_FREE' : 'INITIAL',
  };
  if(!(price > 0) || !(entry > 0)){
    r.reason = '가격 데이터 없음 — 판정 보류';
    r.summary = '시세 미수신 — 다음 스캔에서 재평가';
    return r;
  }
  var pnlPct   = (price/entry - 1) * 100;
  var holdDays = tradeHoldDays(trade.date, ctx.now);   // ctx.now: 봇/백테스트 기준 시각 주입 (결정론)
  var hm = ctx.hm != null ? ctx.hm : (function(){
    var k = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Seoul'}));
    return k.getHours()*100 + k.getMinutes();
  })();
  var fmtW = function(v){ return '₩'+Math.round(v).toLocaleString(); };
  var dp = function(gate, status, note){ r.decision_path.push({gate:gate, status:status, note:note}); };

  // ── 트레일링 고점 추적 (판정 전에 갱신·영속) ──
  if(x.t1Done && price > x.highWater){
    x.highWater = price;
    persistExitState(trade);
  }

  // ════════ P0. 하드 스탑 — 모든 것에 우선 ════════
  if(price <= x.stop){
    r.hold_action = 'SELL_ALL'; r.urgency = 'immediate';
    var stopKind = x.beMoved ? '본전 스탑' : '손절선';
    r.reason  = stopKind+' '+fmtW(x.stop)+' 이탈 ('+pnlPct.toFixed(1)+'%) — 규칙상 즉시 전량 매도';
    r.summary = '⛔ '+stopKind+' 이탈 — 즉시 전량 매도';
    r.warnings.push('손절은 협상 대상이 아님 — 미루면 평균 손실이 커짐');
    dp('P0 스탑', 'block', stopKind+' '+fmtW(x.stop)+' ≥ 현재가');
    return r;
  }
  dp('P0 스탑', 'pass', fmtW(x.stop)+' 위 ('+((price/x.stop-1)*100).toFixed(1)+'% 여유)');

  // ════════ P1. T2 도달 — 잔량 전량 익절 ════════
  if(price >= x.t2){
    r.hold_action = 'SELL_ALL'; r.urgency = 'today';
    r.reason  = 'T2 '+fmtW(x.t2)+' 도달 ('+pnlPct.toFixed(1)+'%) — 계획된 최종 목표, 잔량 전량 매도';
    r.summary = '🎯 T2 도달 — 잔량 전량 익절';
    r.signals.push('최종 목표 도달 — 계획 완수');
    dp('P1 T2', 'pass', 'T2 '+fmtW(x.t2)+' 도달');
    return r;
  }

  // ════════ P2. T1 도달 — 절반 매도 + BE 이동 ════════
  if(!x.t1Done && price >= x.t1){
    x.t1Done = true;
    if(x.stop < entry){ x.stop = entry; x.beMoved = true; }
    x.highWater = Math.max(x.highWater, price);
    persistExitState(trade);
    r.stop = x.stop;
    r._exitStage = 'RISK_FREE';
    r.hold_action = 'SELL_HALF'; r.urgency = 'today';
    r.reason  = 'T1 '+fmtW(x.t1)+' 도달 ('+pnlPct.toFixed(1)+'%) — 절반 익절 + 손절선 본전('+fmtW(entry)+') 이동. 이후 잔량은 무위험';
    r.summary = '🟡 T1 도달 — 절반 매도, 스탑→본전';
    r.signals.push('T1 달성 — 원금 리스크 제거');
    dp('P2 T1', 'pass', '절반 매도 + BE 이동');
    return r;
  }

  // ════════ P3. 구조 붕괴 (모드별) ════════
  if(mode === 'momo'){
    // 엔진 재평가 BLOCK = 모멘텀 사망
    if(ctx.holdEngine && ctx.holdEngine.action === 'BLOCK'){
      r.hold_action = 'SELL_ALL'; r.urgency = 'today';
      var blk = (ctx.holdEngine.blockers||[]).slice(0,2).join(' / ');
      r.reason  = 'MOMO 엔진 재평가 BLOCK — '+blk+'. 모멘텀 근거 소멸, 잔량 정리';
      r.summary = '⚡ 엔진 BLOCK — 모멘텀 소멸, 전량 매도';
      r.warnings = (ctx.holdEngine.blockers||[]).concat(r.warnings);
      dp('P3 구조', 'block', '엔진 BLOCK');
      return r;
    }
    // 당일 진입분: ORB 저점 이탈
    if(holdDays === 0 && ctx.ydata && ctx.ydata.orb_low && price < ctx.ydata.orb_low * 0.99){
      r.hold_action = 'SELL_ALL'; r.urgency = 'immediate';
      r.reason  = 'ORB 저점 '+fmtW(ctx.ydata.orb_low)+' 이탈 — 당일 모멘텀 실패 구조';
      r.summary = '⛔ ORB 저점 이탈 — 전량 매도';
      dp('P3 구조', 'block', 'ORB 저점 이탈');
      return r;
    }
    // VWAP -1% 이탈 + 오후 = 모멘텀 소멸
    if(ctx.ydata && ctx.ydata.vwap && price < ctx.ydata.vwap * 0.99 &&
       (_G.marketPhase === 'PRIME' || _G.marketPhase === 'LATE')){
      r.hold_action = 'SELL_ALL'; r.urgency = 'today';
      r.reason  = 'VWAP '+fmtW(ctx.ydata.vwap)+' -1% 이탈 + 오후 — 세력 평균단가 아래, 모멘텀 소멸';
      r.summary = '📉 VWAP 이탈 — 전량 정리';
      dp('P3 구조', 'block', 'VWAP -1% 이탈 (오후)');
      return r;
    }
    dp('P3 구조', 'pass', 'VWAP/ORB 유지');
  }
  if(mode === 'swing' && ctx.swingData){
    var ma5s = ctx.swingData.ma5;
    // T1 이후 잔량: MA5 종가 이탈 = 청산 (종가 확정 기준 — 휩쏘 방지)
    if(x.t1Done && ma5s && price < ma5s * 0.995){
      if(hm >= 1520 || hm < 900){
        r.hold_action = 'SELL_ALL'; r.urgency = 'today';
        r.reason  = 'MA5 '+fmtW(ma5s)+' 종가 이탈 — T1 이후 잔량 청산 기준 충족';
        r.summary = '📉 MA5 종가 이탈 — 잔량 청산';
        dp('P3 구조', 'block', 'MA5 종가 이탈');
        return r;
      } else {
        r.warnings.push('MA5 '+fmtW(ma5s)+' 이탈 진행 중 — 15:20 종가 확정 시 잔량 청산 (휩쏘 방지로 장중 보류)');
        dp('P3 구조', 'warn', 'MA5 이탈 진행 — 종가 대기');
      }
    } else {
      dp('P3 구조', 'pass', ma5s ? 'MA5 '+fmtW(ma5s)+' 위' : 'MA5 데이터 없음');
    }
    // JS 청산 신호 (거래량 소멸/위꼬리) — T1 이후면 격상, 이전엔 경고
    if(ctx.exitSig){
      if(ctx.exitSig.critical && ctx.exitSig.critical.length){
        if(x.t1Done && r.hold_action === 'HOLD'){
          r.hold_action = 'SELL_ALL'; r.urgency = 'today';
          r.reason  = ctx.exitSig.critical[0]+' — T1 이후 잔량 보호 우선';
          r.summary = '⚠ 청산 신호 — 잔량 정리';
          dp('P3 신호', 'block', ctx.exitSig.critical[0].split(' — ')[0]);
          return r;
        }
        r.warnings = r.warnings.concat(ctx.exitSig.critical);
      }
      if(ctx.exitSig.warning) r.warnings = r.warnings.concat(ctx.exitSig.warning);
    }
  }
  if(mode === 'core' && ctx.coreData){
    var vs120 = ctx.coreData.price_vs_ma120_pct;
    if(vs120 != null && vs120 < -2){
      r.hold_action = 'SELL_ALL'; r.urgency = 'this_week';
      r.reason  = '경기선(120일선) '+vs120.toFixed(1)+'% 이탈 — CORE 보유 근거 붕괴';
      r.summary = '📉 경기선 이탈 — CORE 근거 소멸, 전량 정리';
      dp('P3 구조', 'block', '120일선 '+vs120.toFixed(1)+'%');
      return r;
    }
    dp('P3 구조', 'pass', vs120 != null ? '경기선 대비 '+(vs120>=0?'+':'')+vs120.toFixed(1)+'%' : '경기선 데이터 없음');
  }

  // ════════ P4. 트레일링 (T1 이후) ════════
  if(x.t1Done){
    var trailLine = parseFloat((x.highWater * (1 - cfg.trailPct/100)).toFixed(2));
    r.trailing_stop = Math.max(trailLine, x.stop);
    r._exitStage = 'TRAILING';
    if(price <= r.trailing_stop && price > x.stop){
      r.hold_action = 'SELL_ALL'; r.urgency = 'today';
      r.reason  = '트레일링 스탑 '+fmtW(r.trailing_stop)+' 이탈 (고점 '+fmtW(x.highWater)+' 대비 -'+cfg.trailPct+'%) — 추세 종료, 잔량 확정';
      r.summary = '🔻 트레일링 이탈 — 잔량 전량 매도';
      dp('P4 트레일링', 'block', '고점 -'+cfg.trailPct+'% 이탈');
      return r;
    }
    dp('P4 트레일링', 'pass', fmtW(r.trailing_stop)+' (고점 '+fmtW(x.highWater)+')');
  }

  // ════════ P5. 시간 손절 ════════
  if(holdDays >= cfg.timeDays && pnlPct < cfg.timeMinPnl){
    r.hold_action = 'SELL_ALL'; r.urgency = mode==='momo' ? 'today' : 'this_week';
    r.reason  = '보유 '+holdDays+'일 / 수익 '+pnlPct.toFixed(1)+'% — '+
      (mode==='momo' ? 'MOMO는 1~2일 전략, 모멘텀 부재' : '시간 손절 기준 충족, 자본 회전 우선');
    r.summary = '⏱ 시간 손절 — 자본 회전';
    r.warnings.push('횡보 포지션은 기회비용 — 더 좋은 자리로 이동');
    dp('P5 시간', 'block', holdDays+'일 / '+pnlPct.toFixed(1)+'%');
    return r;
  }
  dp('P5 시간', 'pass', '보유 '+holdDays+'일 / '+(pnlPct>=0?'+':'')+pnlPct.toFixed(1)+'%');

  // ════════ P6. HOLD ════════
  r.hold_action = 'HOLD'; r.urgency = 'monitor';
  var stageLabel = r._exitStage === 'TRAILING' ? '무위험 트레일링 중' :
                   r._exitStage === 'RISK_FREE' ? '본전 스탑 — 무위험' : '초기 구간';
  var nextUp   = x.t1Done ? 'T2 '+fmtW(x.t2)+' ('+((x.t2/price-1)*100).toFixed(1)+'%↑)' : 'T1 '+fmtW(x.t1)+' ('+((x.t1/price-1)*100).toFixed(1)+'%↑)';
  var nextDown = r.trailing_stop ? '트레일링 '+fmtW(r.trailing_stop) : '스탑 '+fmtW(x.stop);
  r.reason  = '['+stageLabel+'] 위로 '+nextUp+' / 아래로 '+nextDown+' — 규칙 충족 전까지 홀드';
  r.summary = '🟢 홀드 — '+stageLabel;
  r.signals.push(stageLabel+' · 다음 레벨: '+nextUp);
  dp('P6 홀드', 'pass', stageLabel);
  return r;
}

function calcSwingExitSignals(result, swingData, trade){
  var out = { critical:[], warning:[], override:false };
  if(!swingData || !result.price || !trade.entry) return out;

  var price   = result.price;
  var entry   = trade.entry;
  var ma5     = swingData.ma5;
  var vr      = swingData.vol_ratio;
  var pbDepth = swingData.pullback_depth_pct; // (price - high10) / high10 * 100, ≤ 0
  var pnlPct  = (price - entry) / entry * 100;
  var closedUpper = swingData.close_upper_40pct; // true = 상단 마감 (좋음)
  var broke3d     = swingData.broke_prev3d_high;

  // ─────────────────────────────────────
  // 신호 1: MA5 이탈 (잔량 청산 기준)
  // T1 이후 잔량은 MA5가 손절선
  // ─────────────────────────────────────
  if(ma5 && price < ma5 * 0.995){
    var ma5dist = ((ma5 - price) / ma5 * 100).toFixed(1);
    // 수익권에서 MA5 이탈 → 잔량 즉시 청산
    if(pnlPct > 0){
      out.critical.push('MA5(₩'+Math.round(ma5).toLocaleString()+') 이탈 '+ma5dist+'% — T1 이후 잔량 청산 신호');
    } else {
      // 손실권에서 MA5 이탈 → 경고 (손절선 따로 있음)
      out.warning.push('MA5(₩'+Math.round(ma5).toLocaleString()+') 이탈 — 추세 약화, 손절선 재확인');
    }
  } else if(ma5 && price < ma5 * 1.005 && price >= ma5 * 0.995){
    out.warning.push('MA5(₩'+Math.round(ma5).toLocaleString()+') 접근 중 — 이탈 시 잔량 청산');
  }

  // ─────────────────────────────────────
  // 신호 2: 거래량 소멸 + 신고점 실패
  // 에너지 소진 — 상승 동력 고갈
  // ─────────────────────────────────────
  if(vr !== null && vr !== undefined){
    var volDead  = vr < 0.6;           // 거래량 40%+ 감소
    var noBreak  = !broke3d;           // 3일 고점 못 돌파
    var elevated = pnlPct > 3;         // 이미 수익권 (소진 의미 있을 때)
    var pullback = pbDepth !== null && pbDepth < -2; // 10일 고점 2%+ 후퇴

    if(volDead && noBreak && elevated && pullback){
      out.critical.push('거래량 소멸('+vr.toFixed(1)+'x) + 3일 고점 미돌파 + 조정 '+pbDepth.toFixed(1)+'% — 에너지 소진, 잔량 정리 검토');
    } else if(volDead && noBreak && elevated){
      out.warning.push('거래량 줄며('+vr.toFixed(1)+'x) 신고점 갱신 실패 — 매수 동력 약화');
    } else if(volDead && elevated){
      out.warning.push('거래량 감소('+vr.toFixed(1)+'x) — 모멘텀 점검 필요');
    }
  }

  // ─────────────────────────────────────
  // 신호 3: 위꼬리 장대 캔들
  // 신고점 부근에서 종가가 아래로 → 세력 매도
  // ─────────────────────────────────────
  if(!closedUpper && pbDepth !== null){
    var nearHigh = pbDepth > -2.5;     // 10일 고점 2.5% 이내 (근처였음)
    var profitable = pnlPct > 2;       // 의미 있는 수익권

    if(nearHigh && profitable){
      out.critical.push('위꼬리 캔들 + 고점 근처('+pbDepth.toFixed(1)+'%) 종가 하단 마감 — 매도세 확인, 잔량 청산 고려');
    } else if(nearHigh){
      out.warning.push('위꼬리 캔들 + 고점 부근 — 저항 강함, 다음 캔들 확인');
    } else if(!closedUpper && pnlPct < -1){
      out.warning.push('하단 마감 캔들 — 하락 압력 지속');
    }
  }

  // override: critical 신호 있고 Claude가 HOLD 줬으면 → SELL_ALL 권고
  if(out.critical.length > 0 && (result.hold_action === 'HOLD')){
    out.override = true;
  }

  return out;
}

// ── 모듈 export (Node) + 전역 (브라우저) ──
if (typeof module !== 'undefined' && module.exports){
  module.exports = { EXIT_CFG: EXIT_CFG, initExitState: initExitState, persistExitState: persistExitState,
                     exitEngine: exitEngine, calcSwingExitSignals: calcSwingExitSignals, setExitPersist: setExitPersist };
}
if (typeof window !== 'undefined'){
  window.EXIT_CFG             = EXIT_CFG;
  window.setExitPersist       = setExitPersist;
  window.initExitState        = initExitState;
  window.persistExitState     = persistExitState;
  window.exitEngine           = exitEngine;
  window.calcSwingExitSignals = calcSwingExitSignals;
}
if (typeof window !== 'undefined'){
  window.KR_ENGINE_VERSION = '2026-07-08-extract';  // 배포 확인용 — 콘솔에서 window.KR_ENGINE_VERSION
  console.log('[RECONKR] engines loaded:', window.KR_ENGINE_VERSION);
}
