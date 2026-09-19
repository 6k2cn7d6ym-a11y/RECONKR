/* ============================================================
 * RECONKR 백테스트용 KIS 일봉 페처 — kisData.js (Node 전용)
 * 앱의 fetchKisDailyChartLong 로직을 Node로 이식.
 *   - dart.minon.kr(Oracle VM) 경유 — 서버가 KIS 키/토큰 주입 (키 불필요)
 *   - 100일 윈도우 페이지네이션, stck_bsop_date 중복 제거, 최신 index 0
 *   - 로컬 파일 캐시: data/kr/{code}.json (같은 날 재실행 시 API 호출 0)
 * KIS 유량 제한 대응: 호출 간 기본 350ms 대기
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const KIS_URL = process.env.KIS_PROXY_URL || 'https://dart.minon.kr';
const ADJ_PRC = process.env.KIS_ADJ_PRC || '1';        // '1' 수정주가(기본) / '0' 원주가(앱 비교용)
const CACHE_DIR = path.join(__dirname, 'data', 'kr' + (ADJ_PRC === '1' ? '' : '-raw'));
const CACHE_DIR_IDX = path.join(__dirname, 'data', 'kr-index');
const SLEEP_MS = 350;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function fmt(d){
  return d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
}

async function kisGet(apiPath, params, trId){
  const qs = new URLSearchParams(params).toString();
  const resp = await fetch(KIS_URL + '/kis' + apiPath + '?' + qs, {
    headers: { 'Content-Type': 'application/json', 'tr_id': trId || 'FHKST03010100', 'custtype': 'P' },
  });
  if(!resp.ok) throw new Error('HTTP ' + resp.status);
  return resp.json();
}

// 일봉 장기 조회 — targetDays 영업일 확보 목표 (페이지당 ~100일 캘린더 윈도우)
async function fetchDailyCandlesLong(code, targetDays){
  const want = targetDays || 780;             // 기본 ~3년 영업일
  const maxPages = Math.ceil(want / 60) + 2;  // 주말/공휴일 감안 여유
  const allCandles = [];
  const seen = {};
  let endDate = new Date();

  for(let page = 0; page < maxPages; page++){
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 100);
    let data;
    try{
      data = await kisGet('/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice', {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD:          code,
        FID_INPUT_DATE_1:        fmt(startDate),
        FID_INPUT_DATE_2:        fmt(endDate),
        FID_PERIOD_DIV_CODE:    'D',
        FID_ORG_ADJ_PRC:        ADJ_PRC,   // ★ 2026-09: 기본 '1'(수정주가). 3년 백테스트에 액면분할·무상증자 왜곡 차단
      });
    }catch(e){
      console.warn('[kisData]', code, 'page', page, '예외:', e.message);
      break;
    }
    if(data.rt_cd !== '0'){ console.warn('[kisData]', code, 'page', page, '실패:', data.msg1); break; }
    const pageCandles = data.output2 || [];
    if(!pageCandles.length) break;
    for(const c of pageCandles){
      const d = c.stck_bsop_date;
      if(d && !seen[d] && parseFloat(c.stck_clpr) > 0){ seen[d] = true; allCandles.push(c); }
    }
    if(allCandles.length >= want) break;
    endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() - 1);
    await sleep(SLEEP_MS);
  }
  allCandles.sort((a, b) => b.stck_bsop_date.localeCompare(a.stck_bsop_date)); // 최신 index 0
  return allCandles;
}

// 캐시 우선 로드 — 캐시가 오늘자면 재사용, 아니면 새로 받고 저장
// opts.confirmedToday=true: 오늘 15:35 이후 캐시만 사용 (부분봉 오염 방지)
async function loadCandles(code, targetDays, opts){
  opts = opts || {};
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, code + '.json');
  const todayYmd = fmt(new Date());
  if(fs.existsSync(file)){
    try{
      const cached = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const enoughCandles = (cached.candles || []).length >= Math.min(targetDays || 0, 200);
      const freshToday    = cached.fetchedYmd === todayYmd;
      const freshEnough   = !opts.confirmedToday || (cached.fetchedHm || '0000') >= '1535';
      if(freshToday && freshEnough && enoughCandles) return cached.candles;
    }catch(e){ /* 캐시 손상 → 재수집 */ }
  }
  const candles = await fetchDailyCandlesLong(code, targetDays);
  if(candles.length){
    const now = new Date();
    const nowHm = ('0' + now.getHours()).slice(-2) + ('0' + now.getMinutes()).slice(-2);
    fs.writeFileSync(file, JSON.stringify({ fetchedYmd: todayYmd, fetchedHm: nowHm, code, candles }));
  }
  await sleep(SLEEP_MS);
  return candles;
}

// ── KOSPI 지수 일봉 (업종/지수 차트) — 시장 게이트 시계열용 (2026-09) ──
//   KIS: /uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice · tr_id FHKUP03500100
//   FID_COND_MRKT_DIV_CODE 'U', FID_INPUT_ISCD '0001'(KOSPI) / '1001'(KOSDAQ)
//   output2 필드: stck_bsop_date, bstp_nmix_prpr(종가), bstp_nmix_oprc, bstp_nmix_hgpr, bstp_nmix_lwpr
//   ★ 필드명은 KIS 문서 기준 — 프록시 응답에서 1회 실측 확인 필요 (kr-index 캐시 파일 열어보면 됨)
async function fetchIndexCandlesLong(indexCode, targetDays){
  const want = targetDays || 780;
  const maxPages = Math.ceil(want / 60) + 2;
  const all = []; const seen = {};
  let endDate = new Date();
  for(let page = 0; page < maxPages; page++){
    const startDate = new Date(endDate); startDate.setDate(startDate.getDate() - 100);
    let data;
    try{
      data = await kisGet('/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice', {
        FID_COND_MRKT_DIV_CODE: 'U',
        FID_INPUT_ISCD:          indexCode || '0001',
        FID_INPUT_DATE_1:        fmt(startDate),
        FID_INPUT_DATE_2:        fmt(endDate),
        FID_PERIOD_DIV_CODE:    'D',
      }, 'FHKUP03500100');
    }catch(e){ console.warn('[kisData:index]', indexCode, 'page', page, '예외:', e.message); break; }
    if(data.rt_cd !== '0'){ console.warn('[kisData:index]', indexCode, 'page', page, '실패:', data.msg1); break; }
    const rows = data.output2 || [];
    if(!rows.length) break;
    for(const c of rows){
      const d = c.stck_bsop_date;
      const close = parseFloat(c.bstp_nmix_prpr);
      if(d && !seen[d] && close > 0){
        seen[d] = true;
        // 종목 캔들과 같은 키로 정규화 → indicatorEngine/MA 계산 공용
        all.push({ stck_bsop_date: d, stck_clpr: c.bstp_nmix_prpr, stck_oprc: c.bstp_nmix_oprc,
                   stck_hgpr: c.bstp_nmix_hgpr, stck_lwpr: c.bstp_nmix_lwpr, acml_vol: c.acml_vol || '0', acml_tr_pbmn: c.acml_tr_pbmn || '0' });
      }
    }
    if(all.length >= want) break;
    endDate = new Date(startDate); endDate.setDate(endDate.getDate() - 1);
    await sleep(SLEEP_MS);
  }
  all.sort((a, b) => b.stck_bsop_date.localeCompare(a.stck_bsop_date));
  return all;
}

async function loadIndexCandles(indexCode, targetDays){
  fs.mkdirSync(CACHE_DIR_IDX, { recursive: true });
  const code = indexCode || '0001';
  const file = path.join(CACHE_DIR_IDX, code + '.json');
  const todayYmd = fmt(new Date());
  if(fs.existsSync(file)){
    try{
      const cached = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if(cached.fetchedYmd === todayYmd && (cached.candles || []).length >= Math.min(targetDays || 0, 200)) return cached.candles;
    }catch(e){}
  }
  const candles = await fetchIndexCandlesLong(code, targetDays);
  if(candles.length) fs.writeFileSync(file, JSON.stringify({ fetchedYmd: todayYmd, code, candles }));
  await sleep(SLEEP_MS);
  return candles;
}

module.exports = { fetchDailyCandlesLong, loadCandles, fetchIndexCandlesLong, loadIndexCandles, KIS_URL, ADJ_PRC };

/* ★ 수정주가 (2026-09 변경): 기본 '1'(수정주가). 캐시는 data/kr/ (수정) · data/kr-raw/ (원주가) 분리.
 * 앱과 동일 조건(원주가) 비교가 필요하면 KIS_ADJ_PRC=0 으로 실행. */
