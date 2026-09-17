/* ============================================================
 * 유니버스 생성 — universe-from-csv.js
 *   KRX 정보데이터시스템(data.krx.co.kr) 에서 내려받은 CSV(들)에서 6자리 종목코드를 추출해 universe.json 생성.
 *   권장: [지수] → 구성종목 → KOSPI 200 + KOSDAQ 150 CSV 두 개.
 *   CSV 인코딩이 EUC-KR(cp949)이면 --cp949 옵션. 헤더에 '종목코드' 또는 '단축코드' 열이 있으면 그 열, 없으면 6자리 숫자 토큰 전부.
 *
 * 사용: node universe-from-csv.js kospi200.csv kosdaq150.csv --out universe.json [--cp949] [--exclude 000000,111111]
 * ============================================================ */
'use strict';
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
let out = 'universe.json', cp949 = false, exclude = new Set(); const files = [];
for(let i = 0; i < args.length; i++){
  if(args[i] === '--out') out = args[++i];
  else if(args[i] === '--cp949') cp949 = true;
  else if(args[i] === '--exclude') args[++i].split(',').forEach(c => exclude.add(c.trim()));
  else files.push(args[i]);
}
if(!files.length){ console.error('CSV 파일 경로를 주세요'); process.exit(1); }
const decode = buf => cp949 ? new TextDecoder('euc-kr').decode(buf) : buf.toString('utf-8');
const codes = new Set();
for(const f of files){
  const text = decode(fs.readFileSync(f));
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
  const col = header.findIndex(h => /종목코드|단축코드|code/i.test(h));
  for(const line of lines.slice(1)){
    const cells = line.split(',').map(c => c.replace(/"/g, '').trim());
    if(col >= 0){ const c = cells[col]; if(/^\d{6}$/.test(c)) codes.add(c); }
    else cells.forEach(c => { if(/^\d{6}$/.test(c)) codes.add(c); });
  }
  console.log(path.basename(f) + ': 누적 ' + codes.size + '종목');
}
const list = [...codes].filter(c => !exclude.has(c)).sort();
fs.writeFileSync(out, JSON.stringify(list));
console.log('→ ' + out + ' (' + list.length + '종목)');
