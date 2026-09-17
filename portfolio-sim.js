'use strict';
/* ============================================================
 * V1 포트폴리오 시뮬레이션
 * 가정:
 *   - 초기 자본 100만원
 *   - 진입 사이즈: 리스크 1.5% / stop폭, 최대 자본 20%
 *   - 동시 최대 4종목 슬롯
 *   - 하루 신규 2건 상한 (같은 날 후보 여러 개면 score 내림차순)
 *   - 슬롯 없으면 버림
 *   - 비용: 이미 pnlPct에 반영된 값 사용 (backtest-swing-kr.js CFG.costs와 동일)
 *   - EOD 미청산: 마지막 종가(pnlPct) 그대로 청산 처리
 *
 * 실행: node portfolio-sim.js
 * ============================================================ */
const fs   = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname);
const f2   = v => Math.round(v * 100) / 100;

function parseCsv(file){
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const hdr   = lines[0].split(',');
  const idx   = h => hdr.indexOf(h);
  return lines.slice(1).map(line => {
    const f = line.split(',');
    return {
      code:     f[idx('code')],
      entryYmd: f[idx('entryYmd')],
      exitYmd:  f[idx('exitYmd')],
      reason:   f[idx('reason')],
      entry:    parseFloat(f[idx('entry')]),
      stop:     parseFloat(f[idx('stop')]),
      pnlPct:   parseFloat(f[idx('pnlPct')]),
      score:    parseInt(f[idx('score')]) || 0,
    };
  }).filter(t =>
    t.reason !== 'eod_open' &&
    t.entryYmd && t.exitYmd &&
    !isNaN(t.entry) && !isNaN(t.stop) && !isNaN(t.pnlPct)
  );
}

function simulate(csvFile, label, capital0){
  if(!capital0) capital0 = 1000000;
  const trades = parseCsv(csvFile);

  // 날짜별 신호 (score 내림차순)
  var byEntry = {};
  for(var ti = 0; ti < trades.length; ti++){
    var t = trades[ti];
    if(!byEntry[t.entryYmd]) byEntry[t.entryYmd] = [];
    byEntry[t.entryYmd].push(t);
  }
  Object.keys(byEntry).forEach(function(d){
    byEntry[d].sort(function(a,b){ return b.score - a.score; });
  });

  // 이벤트 날짜 수집
  var allDates = {};
  trades.forEach(function(t){ allDates[t.entryYmd] = true; allDates[t.exitYmd] = true; });
  var dates = Object.keys(allDates).sort();

  var cash   = capital0;
  var open   = [];   // [{ trade, alloc }]
  var taken  = [];
  var rejected = [];
  var curve  = [];   // [{ ymd, capital }]

  for(var di = 0; di < dates.length; di++){
    var ymd = dates[di];

    // 1. 이 날 청산
    var still = [];
    for(var oi = 0; oi < open.length; oi++){
      var pos = open[oi];
      if(pos.trade.exitYmd === ymd){
        var pnl = pos.alloc * pos.trade.pnlPct / 100;
        cash += pos.alloc + pnl;
        taken.push({ trade: pos.trade, alloc: pos.alloc, pnl: pnl });
      } else {
        still.push(pos);
      }
    }
    open = still;

    // 자본 추산 (cash + 투자 원금)
    var invested = 0;
    for(var oi2 = 0; oi2 < open.length; oi2++) invested += open[oi2].alloc;
    curve.push({ ymd: ymd, capital: Math.round(cash + invested) });

    // 2. 이 날 신규 진입
    var signals  = byEntry[ymd] || [];
    var newToday = 0;

    for(var si = 0; si < signals.length; si++){
      var sig = signals[si];

      if(open.length >= 4){
        rejected.push({ trade: sig, why: 'slot_full' }); continue;
      }
      if(newToday >= 2){
        rejected.push({ trade: sig, why: 'daily_limit' }); continue;
      }

      var riskRatio = (sig.entry - sig.stop) / sig.entry;
      if(riskRatio <= 0){
        rejected.push({ trade: sig, why: 'invalid_stop' }); continue;
      }

      var totalCap = cash;
      for(var oi3 = 0; oi3 < open.length; oi3++) totalCap += open[oi3].alloc;
      var alloc = Math.min(totalCap * 0.015 / riskRatio, totalCap * 0.20);

      if(alloc > cash){
        rejected.push({ trade: sig, why: 'insufficient_cash' }); continue;
      }

      cash -= alloc;
      open.push({ trade: sig, alloc: alloc });
      newToday++;
    }
  }

  // 미청산 마감
  for(var oi4 = 0; oi4 < open.length; oi4++){
    var pos2 = open[oi4];
    cash += pos2.alloc + pos2.alloc * pos2.trade.pnlPct / 100;
  }

  var finalCapital = Math.round(cash);
  var totalReturn  = f2((finalCapital - capital0) / capital0 * 100);

  // 자본 MDD
  var peak = capital0, mdd = 0;
  for(var ci = 0; ci < curve.length; ci++){
    if(curve[ci].capital > peak) peak = curve[ci].capital;
    var dd = f2((curve[ci].capital - peak) / peak * 100);
    if(dd < mdd) mdd = dd;
  }

  // 연도별 자본 (curve 기준 시작/끝)
  var yrCap = {};
  for(var ci2 = 0; ci2 < curve.length; ci2++){
    var yr = curve[ci2].ymd.slice(0, 4);
    if(!yrCap[yr]) yrCap[yr] = { start: curve[ci2].capital, end: curve[ci2].capital };
    yrCap[yr].end = curve[ci2].capital;
  }
  // 연도별 취한 거래 수
  var yrCount = {};
  for(var ti2 = 0; ti2 < taken.length; ti2++){
    var yr2 = taken[ti2].trade.entryYmd.slice(0, 4);
    yrCount[yr2] = (yrCount[yr2] || 0) + 1;
  }

  // 연도별 수익률 (curve book value 기준)
  var yrReturn = {};
  var YEARS = ['2023', '2024', '2025', '2026'];
  YEARS.forEach(function(yr3){
    if(yrCap[yr3]){
      yrReturn[yr3] = f2((yrCap[yr3].end - yrCap[yr3].start) / yrCap[yr3].start * 100);
    }
  });

  // 통과 기준
  var train = ['2023', '2024', '2025'];
  var trainPass = train.every(function(yr4){ return yrReturn[yr4] === undefined || yrReturn[yr4] >= -5; });
  // 2023~2025 누적 자본 > 초기
  var yr25End = yrCap['2025'] ? yrCap['2025'].end : null;
  var cumulPass = yr25End ? yr25End > capital0 : true;
  var passMDD   = mdd >= -15;
  var passAll   = trainPass && cumulPass && passMDD;

  // 출력
  console.log('\n══ ' + label + ' ══');
  console.log('초기 ' + capital0.toLocaleString() + '원 → 최종 ' + finalCapital.toLocaleString() + '원 (' + (totalReturn >= 0 ? '+' : '') + totalReturn + '%)');
  console.log('잡은 거래 ' + taken.length + '건 / 버린 신호 ' + rejected.length + '건 (slot_full:' +
    rejected.filter(function(r){ return r.why === 'slot_full'; }).length + ' daily_limit:' +
    rejected.filter(function(r){ return r.why === 'daily_limit'; }).length + ' cash:' +
    rejected.filter(function(r){ return r.why === 'insufficient_cash'; }).length + ')');
  console.log('자본 MDD: ' + mdd + '% ' + (passMDD ? '✅' : '❌ (기준 ≥ -15%)'));

  YEARS.forEach(function(yr5){
    var r = yrReturn[yr5];
    if(r === undefined) return;
    var n = yrCount[yr5] || 0;
    var ok = r >= -5;
    console.log('  ' + yr5 + ': ' + (r >= 0 ? '+' : '') + r + '% (' + n + '건)' + (ok ? ' ✅' : ' ❌'));
  });
  console.log('2023~2025 누적 자본 > 초기: ' + (cumulPass ? '✅' : '❌') + '  연도별 ≥ -5%: ' + (trainPass ? '✅' : '❌'));
  console.log((passAll ? '✅ B 통과 기준 통과' : '❌ B 통과 기준 미통과'));

  // 결과 반환 (curve 제외해서 별도 저장)
  var res = {
    label: label,
    capital0: capital0,
    finalCapital: finalCapital,
    totalReturnPct: totalReturn,
    takenCount: taken.length,
    rejectedCount: rejected.length,
    mddPct: mdd,
    yearlyReturn: yrReturn,
    yearlyTrades: yrCount,
    passMDD: passMDD,
    passTrainReturn: trainPass,
    passCumul2325: cumulPass,
    passAll: passAll,
  };
  return { result: res, curve: curve };
}

// ── 실행 ──
var RUNS = [
  { csv: 'backtest-trades-v1-t1_50.csv',  label: 'V1 T1-50%'  },
  { csv: 'backtest-trades-v1-t1_100.csv', label: 'V1 T1-100%' },
];

console.log('[포트폴리오 시뮬] 자본 100만원 · 리스크 1.5% · 종목당 20% · 최대 4종목 · 하루 신규 2건 · score 내림차순');

var allResults = {};

for(var ri = 0; ri < RUNS.length; ri++){
  var run = RUNS[ri];
  var fp  = path.join(BASE, run.csv);
  if(!fs.existsSync(fp)){ console.warn('파일 없음: ' + fp); continue; }
  var out = simulate(fp, run.label, 1000000);
  allResults[run.label] = out.result;

  // 자본 곡선 CSV
  var key    = run.csv.replace('backtest-trades-', '').replace('.csv', '');
  var csvOut = 'ymd,capital\n' + out.curve.map(function(c){ return c.ymd + ',' + c.capital; }).join('\n');
  var cf     = path.join(BASE, 'portfolio-curve-' + key + '.csv');
  fs.writeFileSync(cf, csvOut);
  console.log('→ ' + path.basename(cf) + ' (' + out.curve.length + '행) 저장');
}

fs.writeFileSync(path.join(BASE, 'portfolio-sim-results.json'), JSON.stringify(allResults, null, 2));
console.log('→ portfolio-sim-results.json 저장');
console.log('\n[가정] book value(cash + 투자 원금) 기준 자본 곡선 · 미실현 손익 미반영 · 비용은 pnlPct에 포함');
