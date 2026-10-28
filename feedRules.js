/* 투자팀 추천 피드 v0.21 규격 검사 — 목업(index.html)과 build-data.js가 같이 쓰는 단일 코드 (UMD, ES5) */
(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FeedRules = factory();
})(this, function(){
  var MODE_KEYS = {momo: 1, swing: 1, core: 1};
  var BASE_KIND = {close: '종가', issue: '관측', entry: '제시'};
  var ISO_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)\+09:00$/;

  function has(v){ return v !== null && v !== undefined; }
  function validPx(v){ return typeof v === 'number' && isFinite(v) && v > 0 && Math.floor(v) === v; }
  function pxState(v){ return !has(v) ? 'none' : (validPx(v) ? 'ok' : 'bad'); }
  function rawTxt(v){
    var s;
    if (v === undefined) return '없음';
    if (typeof v === 'string') return '"' + v + '"';
    if (v !== null && typeof v === 'object') { try { s = JSON.stringify(v); } catch (e) { s = undefined; } return typeof s === 'string' ? s : '표시 불가'; }
    return String(v);
  }
  function isRecObj(r){ return r !== null && typeof r === 'object' && !Array.isArray(r); }
  function isoM(v){
    var m = typeof v === 'string' ? ISO_RE.exec(v) : null;
    if (!m) return null;
    var y = parseInt(v.slice(0, 4), 10), mo = parseInt(m[1], 10), d = parseInt(m[2], 10);
    return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate() ? m : null;
  }
  function isKind(v){ return typeof v === 'string' && Object.prototype.hasOwnProperty.call(BASE_KIND, v); }
  function baseInfo(r){
    var kindOk = isKind(r.baseType);
    var m = isoM(r.baseAt);
    if (!kindOk || !m) return {ok: false, kindOk: kindOk, atOk: !!m, txt: '기준가 종류 불명', tag: '종류 불명'};
    return {ok: true, kindOk: true, atOk: true, tag: BASE_KIND[r.baseType],
      txt: r.baseType === 'close' ? m[1] + '-' + m[2] + ' 종가' : m[3] + ':' + m[4] + (r.baseType === 'issue' ? ' 관측 가격' : ' 제시 진입가')};
  }
  function strNE(v){ return typeof v === 'string' && v.length > 0; }
  function isoOk(v){ return !!isoM(v); }
  function got(v){ return ' (받은 값 ' + rawTxt(v) + ')'; }

  /* 규격 §4 표와 1:1 검사표 — miss: 칸을 빼면 '칸 없음' · opt: 생략 가능 · nullOk: 값 null 허용 */
  var SPEC_FIELDS = [
    {k: 'mode', ok: function(v){ return typeof v === 'string' && Object.prototype.hasOwnProperty.call(MODE_KEYS, v); }, msg: function(v){ return 'mode 값 오류 ' + rawTxt(v); }},
    {k: 'base', ok: validPx, msg: function(v){ return '기준가는 0보다 큰 정수여야 함' + got(v); }},
    {k: 'baseType', ok: isKind, msg: function(v){ return 'baseType은 close·issue·entry 중 하나여야 함' + got(v); }},
    {k: 'baseAt', ok: isoOk, msg: function(v){ return 'baseAt은 ISO 8601 +09:00 형식이어야 함' + got(v); }},
    {k: 'recId', miss: true, ok: strNE, msg: function(v){ return 'recId는 비어 있지 않은 문자열이어야 함' + got(v); }},
    {k: 'rev', miss: true, ok: validPx, msg: function(v){ return 'rev는 1 이상의 정수여야 함' + got(v); }},
    {k: 'issuedAt', miss: true, ok: isoOk, msg: function(v){ return 'issuedAt은 ISO 8601 +09:00 형식이어야 함' + got(v); }},
    {k: 'code', miss: true, ok: function(v){ return typeof v === 'string' && /^\d{6}$/.test(v); }, msg: function(v){ return 'code는 숫자 6자리 문자열이어야 함' + got(v); }},
    {k: 'name', miss: true, ok: strNE, msg: function(v){ return 'name은 비어 있지 않은 문자열이어야 함' + got(v); }},
    {k: 'why', miss: true, ok: function(v){ return typeof v === 'string' && v.length <= 60; }, msg: function(v){ return 'why는 60자 이하 문자열이어야 함' + got(v); }},
    {k: 'stop', miss: true, nullOk: true, ok: validPx, msg: function(v){ return '손절는 비워 두거나 0보다 큰 정수여야 함' + got(v); }},
    {k: 't1', miss: true, nullOk: true, ok: validPx, msg: function(v){ return '목표1는 비워 두거나 0보다 큰 정수여야 함' + got(v); }},
    {k: 't2', miss: true, nullOk: true, ok: validPx, msg: function(v){ return '목표2는 비워 두거나 0보다 큰 정수여야 함' + got(v); }},
    {k: 'horizon', miss: true, nullOk: true, ok: function(v){ return typeof v === 'string'; }, msg: function(v){ return 'horizon은 문자열 또는 null이어야 함' + got(v); }},
    {k: 'horizonDays', miss: true, nullOk: true, ok: validPx, msg: function(v){ return 'horizonDays는 1 이상의 정수 또는 null이어야 함' + got(v); }},
    {k: 'entryStatus', miss: true, ok: function(v){ return v === 'pending' || v === 'met' || v === 'not_met'; }, msg: function(v){ return 'entryStatus는 pending·met·not_met 중 하나여야 함' + got(v); }},
    {k: 'risk', miss: true, nullOk: true, ok: function(v){ return typeof v === 'string'; }, msg: function(v){ return 'risk는 문자열 또는 null이어야 함' + got(v); }},
    {k: 'entryAt', miss: true, nullOk: true, ok: isoOk, msg: function(v){ return 'entryAt은 ISO 8601 +09:00 형식 또는 null이어야 함' + got(v); }},
    {k: 'withdrawn', opt: true, ok: function(v){ return typeof v === 'boolean'; }, msg: function(v){ return 'withdrawn은 true/false 불리언이어야 함' + got(v); }},
    {k: 'revNote', opt: true, ok: function(v){ return typeof v === 'string'; }, msg: function(v){ return 'revNote는 문자열이어야 함' + got(v); }}
  ];

  /* 추천 1건 규격 판정. 현재가(cur)는 투자팀 필드가 아니라 앱이 공급하는 값이라 여기서 판정하지 않는다(quoteOk는 호출 쪽이 붙인다) */
  function judgeRec(r){
    if (!isRecObj(r)) {
      return {state: 'error', errs: ['추천 항목이 객체가 아님'], calcOk: false, baseOk: false, pts: [], modeOk: false,
        nameOk: false, codeOk: false, whyOk: false, horizonOk: false,
        bi: {ok: false, kindOk: false, atOk: false, txt: '기준가 종류 불명', tag: '종류 불명'},
        px: {base: 'absent', stop: 'absent', t1: 'absent', t2: 'absent'}};
    }
    var errs = [], miss = [], bad = {}, px = {}, keys = ['base', 'stop', 't1', 't2'], i, f, v, k, prev = null, ordOk = true, pts, bi = baseInfo(r);
    for (i = 0; i < SPEC_FIELDS.length; i++) {
      f = SPEC_FIELDS[i];
      if (!(f.k in r)) {
        if (f.miss) miss.push(f.k);
        else if (!f.opt) { bad[f.k] = true; errs.push(f.msg(undefined)); }
        continue;
      }
      v = r[f.k];
      if (v === null && f.nullOk) continue;
      if (!f.ok(v)) { bad[f.k] = true; errs.push(f.msg(v)); }
    }
    if (miss.length) errs.push('필수 칸 누락(' + miss.join('·') + ') — 각 필드의 타입에 맞는 값을 입력하세요. null은 허용된 필드에만 사용할 수 있습니다.');
    for (i = 0; i < keys.length; i++) { k = keys[i]; px[k] = (k !== 'base' && !(k in r)) ? 'absent' : pxState(r[k]); }
    var seq = ['stop', 'base', 't1', 't2'];
    for (i = 0; i < seq.length; i++) {
      if (px[seq[i]] !== 'ok') continue;
      if (prev !== null && r[seq[i]] <= prev) { ordOk = false; break; }
      prev = r[seq[i]];
    }
    if (!ordOk) errs.push('가격 순서 위반 (손절 < 기준 < 목표1 < 목표2)');
    var wd = ('withdrawn' in r) && r.withdrawn === true;
    var baseOk = px.base === 'ok' && bi.ok && !wd && !bad.withdrawn;
    var calcOk = baseOk && ordOk;
    pts = [{v: r.base, c: 'base'}];
    if (calcOk) { for (k in {stop: 1, t1: 1, t2: 1}) { if (px[k] === 'ok') pts.push({v: r[k], c: k === 'stop' ? 'stop' : 'tg'}); } }
    return {state: wd ? 'withdrawn' : (errs.length ? 'error' : 'ok'), errs: errs, calcOk: calcOk, baseOk: baseOk, pts: pts,
      modeOk: !bad.mode, nameOk: ('name' in r) && !bad.name, codeOk: ('code' in r) && !bad.code, whyOk: ('why' in r) && !bad.why, horizonOk: !bad.horizon,
      bi: bi, px: px};
  }

  function stable(v){
    var k, ks, i, o;
    if (v === null || typeof v !== 'object') return JSON.stringify(v) === undefined ? 'undefined' : JSON.stringify(v);
    if (Array.isArray(v)) { o = []; for (i = 0; i < v.length; i++) o.push(stable(v[i])); return '[' + o.join(',') + ']'; }
    ks = []; for (k in v) { if (Object.prototype.hasOwnProperty.call(v, k)) ks.push(k); }
    ks.sort(); o = [];
    for (i = 0; i < ks.length; i++) o.push(JSON.stringify(ks[i]) + ':' + stable(v[ks[i]]));
    return '{' + o.join(',') + '}';
  }

  /* recId별 최신 rev 하나만 판정한다. 최신 판이 오류여도 이전 정상 판으로 바꾸지 않는다.
     같은 recId+rev: 내용까지 같으면 재전송이라 무시, 내용이 다르면 그 판을 규격 오류로 처리한다(규격 §94·§162). */
  function pickLatest(recs){
    var groups = Object.create(null), order = [], items = [], i, r, id, g, rev, key, j, e, jd, sig, byRev, revs, maxRev, k, ent;
    if (!Array.isArray(recs)) return items;
    for (i = 0; i < recs.length; i++) {
      r = recs[i];
      if (isRecObj(r) && strNE(r.recId) && validPx(r.rev)) {
        id = r.recId;
        if (!Object.prototype.hasOwnProperty.call(groups, id)) { groups[id] = []; order.push({id: id}); }
        groups[id].push(r);
      } else {
        order.push({solo: r, idx: i});
      }
    }
    for (i = 0; i < order.length; i++) {
      e = order[i];
      if (Object.prototype.hasOwnProperty.call(e, 'solo')) {
        items.push({recId: isRecObj(e.solo) && strNE(e.solo.recId) ? e.solo.recId : null, rev: null, rec: e.solo, judge: judgeRec(e.solo), revs: [], dupIgnored: 0, conflict: false});
        continue;
      }
      g = groups[e.id]; byRev = Object.create(null); revs = []; maxRev = 0;
      for (j = 0; j < g.length; j++) {
        rev = g[j].rev; key = String(rev); sig = stable(g[j]);
        if (!Object.prototype.hasOwnProperty.call(byRev, key)) { byRev[key] = {rec: g[j], sig: sig, dup: 0, conflict: false}; revs.push(rev); if (rev > maxRev) maxRev = rev; }
        else if (byRev[key].sig === sig) byRev[key].dup++;
        else byRev[key].conflict = true;
      }
      revs.sort(function(a, b){ return a - b; });
      ent = byRev[String(maxRev)];
      jd = judgeRec(ent.rec);
      if (ent.conflict) {
        jd.state = 'error'; jd.calcOk = false;
        jd.errs = jd.errs.concat(['같은 recId+rev(' + e.id + ' rev ' + maxRev + ')인데 내용이 다름']);
      }
      items.push({recId: e.id, rev: maxRev, rec: ent.rec, judge: jd, revs: revs, dupIgnored: ent.dup, conflict: ent.conflict});
    }
    return items;
  }

  /* 파일 1개 판정. expectDate = 'YYYYMMDD'(파일명·오늘 KST). 반환 status: error(최상위 구조 오류) / partial(일부 추천만 규격 오류) / ok (broken·none은 읽는 쪽이 정한다) */
  function judgeFeed(obj, expectDate){
    var errs = [], items = [], i, st = 'ok', dm, nErr = 0, nWd = 0;
    if (!isRecObj(obj)) return {status: 'error', errs: ['피드 최상위가 객체가 아님'], items: [], date: null, issuedAt: null, counts: {rec: 0, error: 0, withdrawn: 0}};
    if (obj.feedVersion !== 1) errs.push('feedVersion은 1이어야 함' + got(obj.feedVersion));
    dm = typeof obj.date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(obj.date) : null;
    if (!dm || !isoM(obj.date + 'T00:00:00+09:00')) errs.push('date는 실존하는 YYYY-MM-DD여야 함' + got(obj.date));
    else if (expectDate && dm[1] + dm[2] + dm[3] !== expectDate) errs.push('date(' + obj.date + ')가 파일 날짜(' + expectDate + ')와 다름');
    if (!isoOk(obj.issuedAt)) errs.push('issuedAt은 ISO 8601 +09:00 형식이어야 함' + got(obj.issuedAt));
    if (!Array.isArray(obj.recs)) errs.push('recs는 배열이어야 함' + got(obj.recs));
    else items = pickLatest(obj.recs);
    for (i = 0; i < items.length; i++) { if (items[i].judge.state === 'error') nErr++; else if (items[i].judge.state === 'withdrawn') nWd++; }
    if (errs.length) st = 'error';
    else if (nErr) st = 'partial';
    return {status: st, errs: errs, items: items, date: typeof obj.date === 'string' ? obj.date : null, issuedAt: typeof obj.issuedAt === 'string' ? obj.issuedAt : null,
      counts: {rec: items.length, error: nErr, withdrawn: nWd}};
  }

  /* 보유 계획(§9) 한 항목 검사 — 앱과 빌더가 같은 함수를 쓴다. todayKst = 'YYYY-MM-DD'(호출하는 쪽이 넘기는 KST 오늘). 위반 사유 문자열, 정상이면 null */
  function checkHoldItem(it, todayKst){
    var own = function(o, k){ return Object.prototype.hasOwnProperty.call(o, k); }, keys = ['code', 'name', 'mode', 'stop', 't1', 't2', 't1Done', 'issue', 'addBuy', 'asOf'], i, v, ln = [], d, td;
    var cal = function(iso){ var t; if (!(typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso))) return NaN; t = Date.parse(iso + 'T00:00:00Z'); return !isNaN(t) && new Date(t).toISOString().slice(0, 10) === iso ? t : NaN; };
    if (it === null || typeof it !== 'object' || Array.isArray(it)) return '항목이 객체가 아님';
    if (own(it, 'planErr')) return 'planErr 칸은 빌더 전용 — 투자팀 작성 금지';
    for (i = 0; i < keys.length; i++) if (!own(it, keys[i])) return keys[i] + ' 칸 없음';
    if (!(typeof it.code === 'string' && /^\d{6}$/.test(it.code))) return 'code가 6자리 숫자 문자열이 아님';
    if (!(it.name === null || typeof it.name === 'string')) return 'name이 문자열 또는 null이 아님';
    if (!(it.mode === null || it.mode === 'momo' || it.mode === 'swing' || it.mode === 'core')) return 'mode가 momo/swing/core/null이 아님';
    for (i = 1; i < 4; i++) { v = it[keys[i + 2]]; if (!(v === null || validPx(v))) return keys[i + 2] + '가 0보다 큰 정수 또는 null이 아님'; }
    if (typeof it.t1Done !== 'boolean') return 't1Done이 불리언이 아님';
    if (!(it.issue === null || typeof it.issue === 'string')) return 'issue가 문자열 또는 null이 아님';
    if (!(it.addBuy === null || typeof it.addBuy === 'string')) return 'addBuy가 문자열 또는 null이 아님';
    ['stop', 't1', 't2'].forEach(function(k){ if (it[k] !== null) ln.push(it[k]); });
    for (i = 1; i < ln.length; i++) if (ln[i - 1] >= ln[i]) return '선 순서(손절<목표1<목표2) 위반';
    if (!(typeof it.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(it.asOf))) return 'asOf가 YYYY-MM-DD가 아님';
    d = cal(it.asOf);
    if (isNaN(d)) return 'asOf ' + it.asOf + '가 달력에 없는 날짜';
    td = cal(todayKst);
    if (isNaN(td)) return '오늘(KST) 날짜 인자가 올바르지 않음';
    if (d > td) return 'asOf ' + it.asOf + '가 오늘(KST ' + todayKst + ')보다 미래';
    return null;
  }

  return {MODE_KEYS: MODE_KEYS, BASE_KIND: BASE_KIND, ISO_RE: ISO_RE, SPEC_FIELDS: SPEC_FIELDS, has: has, validPx: validPx, pxState: pxState, rawTxt: rawTxt,
    isRecObj: isRecObj, isoM: isoM, isKind: isKind, baseInfo: baseInfo, strNE: strNE, isoOk: isoOk, got: got,
    judgeRec: judgeRec, pickLatest: pickLatest, judgeFeed: judgeFeed, checkHoldItem: checkHoldItem};
});
