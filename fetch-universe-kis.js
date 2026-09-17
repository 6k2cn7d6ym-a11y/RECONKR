/* ============================================================
 * KIS 랭킹 API 기반 유니버스 수집 — fetch-universe-kis.js
 * KRX OTP 조회 불가 시 폴백: KIS 복수 랭킹 조합으로 ~200종목 수집.
 * 출처: KOSPI200/KOSDAQ150 공식 구성종목 아님 — KIS 랭킹 풀(시총·거래량·이격도·기관) 합집합.
 * ============================================================ */
'use strict';

const fs   = require('fs');
const path = require('path');
const KIS  = 'https://dart.minon.kr';
const OUT  = process.argv[2] || 'universe.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function kisGet(apiPath, params, trId){
  const qs = new URLSearchParams(params).toString();
  const r  = await fetch(KIS + '/kis' + apiPath + '?' + qs, {
    headers: { 'tr_id': trId, 'custtype': 'P', 'Content-Type': 'application/json' },
  });
  if(!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function fetchWithRetry(label, fn){
  for(let t = 0; t < 3; t++){
    try{
      const d = await fn();
      if(d.rt_cd === '0') return d;
      console.log('[SKIP]', label, d.msg1);
      return null;
    } catch(e){ console.log('[ERR]', label, e.message); await sleep(500); }
  }
  return null;
}

async function main(){
  const all = new Map(); // code -> name
  const add = (list, codeKey, nameKey) => {
    (list||[]).forEach(x => { if(/^\d{6}$/.test(x[codeKey])) all.set(x[codeKey], x[nameKey]||''); });
  };

  // ── 1. 시총 상위 (KOSPI·KOSDAQ 각 30)
  for(const iscd of ['0001','1001']){
    const d = await fetchWithRetry('시총/'+iscd, () => kisGet('/uapi/domestic-stock/v1/ranking/market-cap', {
      fid_cond_mrkt_div_code:'J', fid_cond_scr_div_code:'20174', fid_input_iscd:iscd,
      fid_div_cls_code:'0', fid_blng_cls_code:'0', fid_trgt_cls_code:'111111111',
      fid_trgt_exls_cls_code:'0000000000', fid_input_price_1:'', fid_input_price_2:'', fid_vol_cnt:'',
    }, 'FHPST01770000'));
    if(d) add(d.output, 'mksc_shrn_iscd', 'hts_kor_isnm');
    console.log(`시총(${iscd}) → 누적 ${all.size}종목`); await sleep(400);
  }

  // ── 2. 등락률 상위/하위 (KOSPI·KOSDAQ 각 상·하)
  for(const iscd of ['0001','1001']){
    for(const sortDiv of ['0','1']){
      const d = await fetchWithRetry('등락/'+iscd+'/'+sortDiv, () => kisGet('/uapi/domestic-stock/v1/ranking/fluctuation', {
        fid_cond_mrkt_div_code:'J', fid_cond_scr_div_code:'20170', fid_input_iscd:iscd,
        fid_rank_sort_cls_code:sortDiv, fid_input_cnt_1:'0', fid_prc_cls_code:'0',
        fid_input_price_1:'1000', fid_input_price_2:'', fid_vol_cnt:'30',
        fid_trgt_cls_code:'0', fid_trgt_exls_cls_code:'0', fid_div_cls_code:'0',
        fid_rsfl_rate1:'', fid_rsfl_rate2:'',
      }, 'FHPST01700000'));
      if(d) add(d.output, 'stck_shrn_iscd', 'hts_kor_isnm');
      console.log(`등락(${iscd}/${sortDiv}) → 누적 ${all.size}종목`); await sleep(400);
    }
  }

  // ── 3. 이격도 (MA5/MA20/MA60 기준 낮은 순)
  for(const iscd of ['0001','1001']){
    for(const divCls of ['1','2','3']){ // 5일/20일/60일
      const d = await fetchWithRetry('이격/'+iscd+'/'+divCls, () => kisGet('/uapi/domestic-stock/v1/ranking/disparity', {
        FID_COND_MRKT_DIV_CODE:'J', FID_COND_SCR_DIV_CODE:'20178', FID_INPUT_ISCD:iscd,
        FID_DIV_CLS_CODE:divCls, FID_RANK_SORT_CLS_CODE:'1',
        FID_HOUR_CLS_CODE:'0', FID_TRGT_CLS_CODE:'0', FID_TRGT_EXLS_CLS_CODE:'0',
        FID_INPUT_PRICE_1:'1000', FID_INPUT_PRICE_2:'', FID_VOL_CNT:'30',
      }, 'FHPST01780000'));
      if(d) add(d.output, 'stck_shrn_iscd', 'hts_kor_isnm');
      console.log(`이격(${iscd}/MA${[5,20,60][divCls-1]}) → 누적 ${all.size}종목`); await sleep(400);
    }
  }

  // ── 4. 거래량 상위 (올바른 경로)
  for(const iscd of ['0001','1001']){
    const d = await fetchWithRetry('거래량/'+iscd, () => kisGet('/uapi/domestic-stock/v1/quotations/volume-rank', {
      FID_COND_MRKT_DIV_CODE:'J', FID_COND_SCR_DIV_CODE:'20171', FID_INPUT_ISCD:iscd,
      FID_DIV_CLS_CODE:'0', FID_BLNG_CLS_CODE:'0', FID_TRGT_CLS_CODE:'111111111',
      FID_TRGT_EXLS_CLS_CODE:'000000', FID_INPUT_PRICE_1:'1000', FID_INPUT_PRICE_2:'',
      FID_VOL_CNT:'30', FID_INPUT_DATE_1:'',
    }, 'FHPST01710000'));
    if(d) add(d.output, 'mksc_shrn_iscd', 'hts_kor_isnm');
    console.log(`거래량(${iscd}) → 누적 ${all.size}종목`); await sleep(400);
  }

  // ── 5. 체결강도 상위 (전체 시장)
  const vp = await fetchWithRetry('체결강도', () => kisGet('/uapi/domestic-stock/v1/ranking/volume-power', {
    FID_COND_MRKT_DIV_CODE:'J', FID_COND_SCR_DIV_CODE:'20168', FID_INPUT_ISCD:'0000',
    FID_DIV_CLS_CODE:'0', FID_INPUT_PRICE_1:'1000', FID_INPUT_PRICE_2:'',
    FID_VOL_CNT:'30', FID_TRGT_EXLS_CLS_CODE:'0', FID_TRGT_CLS_CODE:'0',
  }, 'FHPST01680000'));
  if(vp) add(vp.output, 'stck_shrn_iscd', 'hts_kor_isnm');
  console.log(`체결강도 → 누적 ${all.size}종목`); await sleep(400);

  // ── 6. 기관/외인 매매 순매수 (올바른 경로)
  for(const iscd of ['0001','1001']){
    const d = await fetchWithRetry('기관외인/'+iscd, () => kisGet('/uapi/domestic-stock/v1/quotations/foreign-institution-total', {
      FID_COND_MRKT_DIV_CODE:'J', FID_COND_SCR_DIV_CODE:'20437', FID_INPUT_ISCD:iscd,
      FID_DIV_CLS_CODE:'0', FID_RANK_SORT_CLS_CODE:'0', FID_ETC_CLS_CODE:'0',
      FID_TRGT_CLS_CODE:'0', FID_TRGT_EXLS_CLS_CODE:'0',
      FID_INPUT_PRICE_1:'1000', FID_INPUT_PRICE_2:'', FID_VOL_CNT:'30',
    }, 'FHPTJ04400000'));
    if(d) add(d.output, 'mksc_shrn_iscd', 'hts_kor_isnm');
    console.log(`기관/외인(${iscd}) → 누적 ${all.size}종목`); await sleep(400);
  }

  // ── 7. 신고/신저 근접 (SWING 후보 특성)
  for(const iscd of ['0001','1001']){
    const d = await fetchWithRetry('신고근접/'+iscd, () => kisGet('/uapi/domestic-stock/v1/ranking/near-new-highlow', {
      FID_COND_MRKT_DIV_CODE:'J', FID_COND_SCR_DIV_CODE:'20187', FID_INPUT_ISCD:iscd,
      FID_DIV_CLS_CODE:'0', FID_INPUT_CNT_1:'10',
      FID_TRGT_CLS_CODE:'0', FID_TRGT_EXLS_CLS_CODE:'0',
      FID_INPUT_PRICE_1:'1000', FID_INPUT_PRICE_2:'', FID_VOL_CNT:'30',
    }, 'FHPST01870000'));
    if(d) add(d.output, 'mksc_shrn_iscd', 'hts_kor_isnm');
    console.log(`신고근접(${iscd}) → 누적 ${all.size}종목`); await sleep(400);
  }

  const codes = [...all.keys()].sort();
  fs.writeFileSync(OUT, JSON.stringify(codes));
  console.log(`\n→ ${OUT} (${codes.length}종목) [KIS 랭킹 기반 · KOSPI200/KOSDAQ150 공식 구성종목 아님]`);
}

main().catch(e => { console.error(e); process.exit(1); });
