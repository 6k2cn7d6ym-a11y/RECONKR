// ── 매도 알림 설정 ──
const ALERT_CFG = {
  stopCooldownMin: 30,      // 손절 알림 쿨다운 (한 번 떠도 30분간 억제)
  t1CooldownMin:   60,      // T1 알림 쿨다운
  t2CooldownMin:   60,      // T2 알림 쿨다운
  momoRemindHour:  14,      // MOMO 오후 리마인더 KST 시각
};

// Webull 요청 공통 헤더
const WB_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.webull.com/',
  'Origin': 'https://www.webull.com',
};

// SEC 캐싱 TTL
const SEC_CACHE = {
  FACTS_TTL_SEC:  24 * 3600,   // companyfacts 24시간
  CIKMAP_TTL_SEC: 7 * 24 * 3600, // ticker→CIK 7일
};

// TRACK 최대 보관 개수 (모드당)
const TRACK_MAX = 500;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        }
      });
    }

    const url = new URL(request.url);

    if (url.pathname.startsWith('/sec/facts/')) {
      const ticker = url.pathname.slice('/sec/facts/'.length).toUpperCase().trim();
      if (!ticker || !/^[A-Z.\-]{1,10}$/.test(ticker)) {
        return jsonResp({ error: 'invalid ticker' }, 400);
      }
      return await handleSecFacts(ticker, env, url.searchParams.get('nocache') === '1');
    }

    if (url.pathname === '/sec/ticker-cik') {
      return await handleSecTickerCik(env, url.searchParams.get('nocache') === '1');
    }

    // ════════════════════════════════════════
    // ★ RECON Claude API 프록시 (2026-06 신규)
    //   브라우저가 Anthropic API 키를 직접 보유하지 않아도 됨.
    //   API 키는 Cloudflare 시크릿(env.ANTHROPIC_API_KEY)에만 저장.
    //   요청: POST { model, max_tokens, temperature, messages }
    //   응답: Anthropic /v1/messages 응답 그대로 통과
    //   2026-07: /reconkr/ai 별칭 추가 — 구버전 RECONKR 프론트(캐시)도 동작하도록
    // ════════════════════════════════════════
    if ((url.pathname === '/recon/claude' || url.pathname === '/reconkr/ai') && request.method === 'POST') {
      const apiKey = env.ANTHROPIC_API_KEY;
      if (!apiKey) return jsonResp({ error: 'API key not configured' }, 503);

      let body;
      try { body = await request.json(); } catch { return jsonResp({ error: 'invalid JSON' }, 400); }

      // 허용 모델만 통과 (의도치 않은 고비용 모델 호출 차단)
      const ALLOWED_MODELS = [
        'claude-sonnet-4-6',
        'claude-sonnet-4-5',
        'claude-haiku-4-5',
        'claude-haiku-4-5-20251001',
      ];
      if (!ALLOWED_MODELS.includes(body.model)) {
        return jsonResp({ error: 'model not allowed: ' + body.model }, 400);
      }

      // max_tokens 상한 (과금 폭주 방지)
      const MAX_TOKENS_LIMIT = 2000;
      if ((body.max_tokens || 0) > MAX_TOKENS_LIMIT) {
        return jsonResp({ error: 'max_tokens exceeds limit ' + MAX_TOKENS_LIMIT }, 400);
      }

      // messages 필드 존재 확인
      if (!Array.isArray(body.messages) || !body.messages.length) {
        return jsonResp({ error: 'messages required' }, 400);
      }

      try {
        const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model:       body.model,
            max_tokens:  body.max_tokens  || 500,
            temperature: body.temperature ?? 0.2,
            messages:    body.messages,
          }),
        });
        const data = await anthropicResp.text();
        return new Response(data, {
          status: anthropicResp.status,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      } catch (e) {
        return jsonResp({ error: 'upstream error: ' + e.message }, 502);
      }
    }

    if (url.pathname === '/recon/positions') {
      if (request.method === 'POST') {
        const body = await request.json();
        const mode = body.mode || 'momo';
        // ── 유령 포지션 강제 제거: { clear:true } 또는 { removeTickers:[...] } ──
        //   앱↔서버 tombstone 동기화가 깨졌을 때 서버 KV를 직접 정리.
        if (body.clear === true) {
          await env.RECONKR_KV.put(`us_positions_${mode}`, JSON.stringify([]));
          return jsonResp({ ok: true, cleared: true, positions: [] });
        }
        if (Array.isArray(body.removeTickers) && body.removeTickers.length) {
          const key = `us_positions_${mode}`;
          const raw = await env.RECONKR_KV.get(key);
          const cloud = raw ? JSON.parse(raw) : [];
          const rm = new Set(body.removeTickers.map(t => String(t).toUpperCase()));
          const kept = cloud.filter(r => r && r.ticker && !rm.has(String(r.ticker).toUpperCase()));
          await env.RECONKR_KV.put(key, JSON.stringify(kept));
          return jsonResp({ ok: true, removed: body.removeTickers, positions: kept });
        }
        if (body.positions !== undefined) {
          const key = `us_positions_${mode}`;
          const raw = await env.RECONKR_KV.get(key);
          const cloud = raw ? JSON.parse(raw) : [];
          const merged = mergePositions(cloud, body.positions);
          await env.RECONKR_KV.put(key, JSON.stringify(merged));
          return jsonResp({ ok: true, positions: merged });
        }
        return jsonResp({ ok: true });
      }
      if (request.method === 'GET') {
        const mode = url.searchParams.get('mode') || 'momo';
        const raw  = await env.RECONKR_KV.get(`us_positions_${mode}`);
        return jsonResp({ positions: raw ? JSON.parse(raw) : [] });
      }
    }

    if (url.pathname === '/recon/journal') {
      if (request.method === 'POST') {
        const body = await request.json();
        const mode = body.mode || 'momo';
        if (body.trades !== undefined) {
          const key = `us_journal_${mode}`;
          const raw = await env.RECONKR_KV.get(key);
          const cloud = raw ? JSON.parse(raw) : [];
          const merged = mergeJournal(cloud, body.trades);
          await env.RECONKR_KV.put(key, JSON.stringify(merged));
          return jsonResp({ ok: true, trades: merged });
        }
        return jsonResp({ ok: true });
      }
      if (request.method === 'GET') {
        const mode = url.searchParams.get('mode') || 'momo';
        const raw  = await env.RECONKR_KV.get(`us_journal_${mode}`);
        return jsonResp({ trades: raw ? JSON.parse(raw) : [] });
      }
    }

    if (url.pathname === '/recon/track') {
      if (request.method === 'POST') {
        const body = await request.json();
        const mode = body.mode;
        if (!['momo','swing','core'].includes(mode)) {
          return jsonResp({ ok: false, error: 'invalid mode' }, 400);
        }
        if (!Array.isArray(body.track)) {
          return jsonResp({ ok: false, error: 'invalid track' }, 400);
        }
        const key = `us_track_${mode}`;
        const raw = await env.RECONKR_KV.get(key);
        const cloud = raw ? JSON.parse(raw) : [];
        const merged = mergeTrack(cloud, body.track);
        await env.RECONKR_KV.put(key, JSON.stringify(merged));
        return jsonResp({ ok: true, count: merged.length, track: merged });
      }
      if (request.method === 'GET') {
        const mode = url.searchParams.get('mode') || '';
        if (!['momo','swing','core'].includes(mode)) {
          return jsonResp({ ok: false, error: 'invalid mode' }, 400);
        }
        const raw = await env.RECONKR_KV.get(`us_track_${mode}`);
        const track = raw ? JSON.parse(raw) : [];
        return jsonResp({ ok: true, track });
      }
      return jsonResp({ ok: false, error: 'method not allowed' }, 405);
    }

    if (url.pathname === '/recon/test-telegram') {
      const tgResult = await sendTelegramDebug('✅ RECON (US) 텔레그램 연결 테스트 성공!', env);
      return jsonResp(tgResult);
    }

    if (url.pathname === '/recon/telegram' && request.method === 'POST') {
      const body = await request.json();
      const emoji = body.type === 'ENTER' ? '🟢' : body.type === 'BLOCK' ? '🔴' : '🔔';
      const msg = `${emoji} RECON ${body.ticker}\n${body.msg || ''}`;
      await sendTelegram(msg, env);
      return jsonResp({ ok: true });
    }

    if (url.pathname === '/reconkr/positions') {
      if (request.method === 'POST') {
        const body = await request.json();
        const mode = body.mode || 'momo';
        // ★ 2026-07: 유령 감시 강제 제거 (US와 동일) — { clear:true }
        if (body.clear === true) {
          await env.RECONKR_KV.put(`positions_${mode}`, JSON.stringify([]));
          return jsonResp({ ok: true, cleared: true, positions: [] });
        }
        if (body.positions !== undefined) {
          // ★ 2026-07: 덮어쓰기 → 머지 (US /recon/positions 와 동일 구조).
          //   저널 투영(syncJournalWatch)의 tombstone(deleted/deletedAt)이 동작하려면 머지 필수.
          const key = `positions_${mode}`;
          const raw = await env.RECONKR_KV.get(key);
          const cloud = raw ? JSON.parse(raw) : [];
          const merged = mergeKRPositions(cloud, body.positions);
          await env.RECONKR_KV.put(key, JSON.stringify(merged));
          if (!body.kisAppKey && !body.kisAppSecret) return jsonResp({ ok: true, positions: merged });
        }
        // ★ 2026-07: 프론트 KIS 서버이관 후 'SERVER' 표식이 실키를 오염시키는 것 방지
        if (body.kisAppKey    && body.kisAppKey    !== 'SERVER') await env.RECONKR_KV.put('kis_appkey',    body.kisAppKey);
        if (body.kisAppSecret && body.kisAppSecret !== 'SERVER') await env.RECONKR_KV.put('kis_appsecret', body.kisAppSecret);
        return jsonResp({ ok: true });
      }
      if (request.method === 'GET') {
        const mode = url.searchParams.get('mode') || 'momo';
        const raw  = await env.RECONKR_KV.get(`positions_${mode}`);
        return jsonResp({ positions: raw ? JSON.parse(raw) : [] });
      }
    }

    // ★ 2026-07 신규: KR 저널 PC↔모바일 동기화 (US /recon/journal 과 동일 구조)
    //   프론트 pushJournal/pullJournal 이 사용. id별 머지, tombstone 모델.
    if (url.pathname === '/reconkr/journal') {
      if (request.method === 'POST') {
        const body = await request.json();
        const mode = body.mode || 'momo';
        if (body.trades !== undefined) {
          const key = `journal_${mode}`;
          const raw = await env.RECONKR_KV.get(key);
          const cloud = raw ? JSON.parse(raw) : [];
          const merged = mergeJournal(cloud, body.trades);
          await env.RECONKR_KV.put(key, JSON.stringify(merged));
          return jsonResp({ ok: true, trades: merged });
        }
        return jsonResp({ ok: true });
      }
      if (request.method === 'GET') {
        const mode = url.searchParams.get('mode') || 'momo';
        const raw  = await env.RECONKR_KV.get(`journal_${mode}`);
        return jsonResp({ trades: raw ? JSON.parse(raw) : [] });
      }
    }

    if (url.pathname === '/reconkr/track') {
      if (request.method === 'POST') {
        const body = await request.json();
        const mode = body.mode;
        if (!['momo','swing','core'].includes(mode)) {
          return jsonResp({ ok: false, error: 'invalid mode' }, 400);
        }
        if (!Array.isArray(body.track)) {
          return jsonResp({ ok: false, error: 'invalid track' }, 400);
        }
        const key = `track_${mode}`;
        const raw = await env.RECONKR_KV.get(key);
        const cloud = raw ? JSON.parse(raw) : [];
        const merged = mergeTrack(cloud, body.track);
        await env.RECONKR_KV.put(key, JSON.stringify(merged));
        return jsonResp({ ok: true, count: merged.length });
      }
      if (request.method === 'GET') {
        const mode = url.searchParams.get('mode') || '';
        if (!['momo','swing','core'].includes(mode)) {
          return jsonResp({ ok: false, error: 'invalid mode' }, 400);
        }
        const raw = await env.RECONKR_KV.get(`track_${mode}`);
        const track = raw ? JSON.parse(raw) : [];
        return jsonResp({ ok: true, track });
      }
      return jsonResp({ ok: false, error: 'method not allowed' }, 405);
    }

    if (url.pathname === '/reconkr/test-telegram') {
      await sendTelegram('✅ RECONKR 텔레그램 연결 테스트 성공!', env);
      return jsonResp({ ok: true });
    }

    if (url.pathname.startsWith('/kis/')) {
      const kisPath = url.pathname.slice(4);
      const kisUrl  = 'https://openapi.koreainvestment.com:9443' + kisPath + url.search;
      const fwdHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
      for (const h of ['Authorization', 'appkey', 'appsecret', 'tr_id', 'custtype']) {
        const v = request.headers.get(h);
        if (v) fwdHeaders[h] = v;
      }
      try {
        const kisResp = await fetch(kisUrl, {
          method:  request.method,
          headers: fwdHeaders,
          body:    request.method !== 'GET' ? await request.text() : undefined,
        });
        const body = await kisResp.text();
        return new Response(body, {
          status:  kisResp.status,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
    }

    if (url.pathname.startsWith('/dart/')) {
      const dartPath = url.pathname.slice(5);
      const dartUrl  = 'https://opendart.fss.or.kr' + dartPath + url.search;
      try {
        const dartResp = await fetch(dartUrl, {
          headers: {
            'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept':          'application/json, text/plain, */*',
            'Accept-Language': 'ko-KR,ko;q=0.9',
            'Referer':         'https://opendart.fss.or.kr/',
          }
        });
        const body = await dartResp.text();
        return new Response(body, {
          status:  dartResp.status,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
    }

    if (url.pathname === '/us-premarket') {
      const pageSize = url.searchParams.get('pageSize') || '50';
      try {
        const wbResp = await fetch(
          `https://quotes-gw.webullfintech.com/api/wlas/ranking/v9/rise?regionId=6&rankType=preMarket&pageIndex=1&pageSize=${pageSize}`,
          { headers: WB_HEADERS }
        );
        const wbData = await wbResp.json();
        const quotes = (wbData.data || []).map(item => {
          const t = item.ticker || {};
          const v = item.values || {};
          const chgRatio = parseFloat(v.changeRatio || '0');
          const price = parseFloat(v.price || '0');
          const preClose = parseFloat(v.preClose || '0');
          const pmPrice = parseFloat(v.pprice || '0');
          const pmChgRatio = preClose > 0 ? (pmPrice - preClose) / preClose : 0;
          return {
            symbol: t.symbol || '',
            shortName: t.name || '',
            exchangeCode: t.disExchangeCode || '',
            regularMarketPrice: parseFloat(v.close || '0'),
            regularMarketChangePercent: chgRatio * 100,
            preMarketPrice: pmPrice || price,
            preMarketChangePercent: pmChgRatio * 100 || chgRatio * 100,
            regularMarketVolume: parseInt(v.volume || '0'),
            marketCap: parseInt(v.marketValue || '0'),
            turnoverRate: parseFloat(v.turnoverRate || '0'),
            high: parseFloat(v.high || '0'),
            low: parseFloat(v.low || '0'),
          };
        });
        return jsonResp({ quotes, count: quotes.length, source: 'webull' });
      } catch (e) {
        return jsonResp({ quotes: [], count: 0, error: e.message, source: 'webull' });
      }
    }

    if (url.pathname === '/us-movers-raw') {
      const session = url.searchParams.get('session') || 'regular';
      const pageSize = url.searchParams.get('pageSize') || '3';
      const rankTypeMap = { pre:'preMarket', regular:'1d', after:'afterMarket' };
      const rankType = rankTypeMap[session] || '1d';
      try {
        const wbResp = await fetch(
          `https://quotes-gw.webullfintech.com/api/wlas/ranking/v9/rise?regionId=6&rankType=${rankType}&pageIndex=1&pageSize=${pageSize}`,
          { headers: WB_HEADERS }
        );
        const wbData = await wbResp.json();
        return jsonResp({ rankType, sample: (wbData.data || []).slice(0, 3), raw_count: (wbData.data || []).length });
      } catch (e) {
        return jsonResp({ error: e.message });
      }
    }

    if (url.pathname === '/us-rankprobe') {
      const pageSize = url.searchParams.get('pageSize') || '2';

      const v9candidates = [
        'afterMarket','postMarket','afterHours','extendedHours','extended','post','after','ah',
      ];
      const altEndpoints = [
        'https://quotes-gw.webullfintech.com/api/wlas/ranking/topGainers?regionId=6',
        'https://quotes-gw.webullfintech.com/api/wlas/ranking/afterMarket?regionId=6&userRegionId=6',
        'https://quotes-gw.webullfintech.com/api/wlas/ranking/afterMarket?regionId=6&pageIndex=1&pageSize='+pageSize,
        'https://quotes-gw.webullfintech.com/api/wlas/ranking/postMarket?regionId=6&pageIndex=1&pageSize='+pageSize,
        'https://quotes-gw.webullfintech.com/api/wlas/ranking/latestActivityPc?regionId=6',
        'https://quotes-gw.webullfintech.com/api/wlas/ranking/latestActivityPc/faList?regionId=6',
        'https://quotes-gw.webullfintech.com/api/wlas/ranking/afterhours?regionId=6&pageIndex=1&pageSize='+pageSize,
        'https://quotes-gw.webullfintech.com/api/wlas/ranking/after?regionId=6&pageIndex=1&pageSize='+pageSize,
      ];

      const results = { v9: {}, alt: {} };

      for (const rt of v9candidates) {
        try {
          const resp = await fetch(
            `https://quotes-gw.webullfintech.com/api/wlas/ranking/v9/rise?regionId=6&rankType=${rt}&pageIndex=1&pageSize=${pageSize}`,
            { headers: WB_HEADERS }
          );
          const data = await resp.json();
          const items = (data.data || []).slice(0, 2);
          results.v9[rt] = {
            status: resp.status,
            count: (data.data || []).length,
            first_symbol: items[0]?.ticker?.symbol || null,
            first_values: items[0]?.values || null,
            error_msg: data.msg || data.message || null,
          };
        } catch (e) {
          results.v9[rt] = { error: e.message };
        }
      }

      for (const url2 of altEndpoints) {
        const key = url2.split('/wlas/ranking/')[1].split('?')[0].substring(0, 30);
        try {
          const resp = await fetch(url2, { headers: WB_HEADERS });
          const text = await resp.text();
          let parsed;
          try { parsed = JSON.parse(text); } catch { parsed = text.substring(0, 300); }
          results.alt[key] = {
            url: url2,
            status: resp.status,
            body_type: typeof parsed,
            is_array: Array.isArray(parsed),
            sample: typeof parsed === 'string' ? parsed : JSON.stringify(parsed).substring(0, 500),
          };
        } catch (e) {
          results.alt[key] = { url: url2, error: e.message };
        }
      }

      return jsonResp({ results });
    }

    if (url.pathname === '/us-movers') {
      const session = url.searchParams.get('session') || 'regular';
      const pageSize = url.searchParams.get('pageSize') || '50';
      const rankTypeMap = {
        pre:     'preMarket',
        regular: '1d',
        after:   'afterMarket',
      };
      const rankType = rankTypeMap[session] || '1d';

      try {
        const wbResp = await fetch(
          `https://quotes-gw.webullfintech.com/api/wlas/ranking/v9/rise?regionId=6&rankType=${rankType}&pageIndex=1&pageSize=${pageSize}`,
          { headers: WB_HEADERS }
        );
        const wbData = await wbResp.json();
        let quotes = (wbData.data || []).map(item => {
          const t = item.ticker || {};
          const v = item.values || {};
          const chgRatio = parseFloat(v.changeRatio || '0');
          const pchRatio = parseFloat(v.pchRatio    || '0');
          const price    = parseFloat(v.price    || '0');
          const close    = parseFloat(v.close    || '0');
          const preClose = parseFloat(v.preClose || '0');
          const pprice   = parseFloat(v.pprice   || '0');
          const aprice   = parseFloat(v.aprice   || '0');

          let pmPrice = 0, pmChgRatio = 0;
          let afPrice = 0, afChgRatio = 0;

          if (session === 'after') {
            afPrice    = price;
            afChgRatio = chgRatio;
            pmPrice    = 0;
            pmChgRatio = 0;
          } else if (session === 'pre') {
            pmPrice    = price;
            pmChgRatio = chgRatio;
            afPrice    = 0;
            afChgRatio = 0;
          } else {
            pmPrice = pprice;
            afPrice = aprice;
            pmChgRatio = preClose > 0 && pmPrice > 0 ? (pmPrice - preClose) / preClose : 0;
            afChgRatio = close    > 0 && afPrice > 0 ? (afPrice - close)    / close    : 0;
          }

          return {
            symbol: t.symbol || '',
            shortName: t.name || '',
            exchangeCode: t.disExchangeCode || '',
            regularMarketPrice: close || price,
            regularMarketChangePercent: session === 'regular'
              ? chgRatio * 100
              : (preClose > 0 ? (close - preClose) / preClose * 100 : chgRatio * 100),
            preMarketPrice: pmPrice || price,
            preMarketChangePercent: pmChgRatio * 100,
            afterMarketPrice: afPrice || price,
            afterMarketChangePercent: afChgRatio * 100,
            regularMarketVolume: parseInt(v.volume || '0'),
            marketCap: parseInt(v.marketValue || '0'),
            turnoverRate: parseFloat(v.turnoverRate || '0'),
            high: parseFloat(v.high || '0'),
            low: parseFloat(v.low || '0'),
            session: session,
          };
        });

        if (session === 'after') {
          quotes.sort((a, b) => (b.afterMarketChangePercent || 0) - (a.afterMarketChangePercent || 0));
        } else if (session === 'pre') {
          quotes.sort((a, b) => (b.preMarketChangePercent || 0) - (a.preMarketChangePercent || 0));
        }

        return jsonResp({ quotes, count: quotes.length, source: 'webull', session });
      } catch (e) {
        return jsonResp({ quotes: [], count: 0, error: e.message, source: 'webull', session });
      }
    }

    if (url.pathname === '/us-quote') {
      const symbol = (url.searchParams.get('symbol') || '').toUpperCase().trim();
      if (!symbol) return jsonResp({ error: 'symbol required' });

      const wb = await getWebullQuote(symbol, env);
      if (!wb) return jsonResp({ error: 'quote failed', symbol });
      if (wb.error) return jsonResp({ error: wb.error, symbol });

      return jsonResp({
        symbol,
        tickerId:               wb.tickerId,
        price:                  wb.close,
        preMarketPrice:         wb.pPrice,
        afterMarketPrice:       wb.aPrice,
        preClose:               wb.preClose,
        change_pct:             wb.chgRatio * 100,
        preMarketChange_pct:    wb.pChRatio * 100,
        afterMarketChange_pct:  wb.aChRatio * 100,
        volume:                 wb.volume,
        high:                   wb.high,
        low:                    wb.low,
        open:                   wb.open,
        bid:                    wb.bid || 0,
        ask:                    wb.ask || 0,
        spread_pct:             (wb.bid > 0 && wb.ask > 0 && wb.ask >= wb.bid)
                                  ? Math.round((wb.ask - wb.bid) / ((wb.ask + wb.bid) / 2) * 10000) / 100
                                  : null,
        status:                 wb.status,
        active_price:           pickActivePrice(wb),
        active_session:         classifySession(wb),
        source:                 'webull',
      });
    }

    if (url.pathname === '/us-indicators') {
      const symbol = (url.searchParams.get('symbol') || '').toUpperCase().trim();
      if (!symbol) return jsonResp({ error: 'symbol required' });
      const requestedRange = url.searchParams.get('range') || '1y';

      // MA200 + Wilder warm-up 위해 항상 2y fetch
      const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2y`;
      let chart;
      try {
        const res = await fetch(yahooUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        });
        const json = await res.json();
        chart = json?.chart?.result?.[0];
        if (!chart) return jsonResp({ error: 'chart parse failed', symbol });
      } catch (e) {
        return jsonResp({ error: e.message, symbol });
      }

      const timestamps = chart.timestamp || [];
      const q = chart.indicators?.quote?.[0] || {};
      const rawClose  = q.close  || [];
      const rawHigh   = q.high   || [];
      const rawLow    = q.low    || [];
      const rawVolume = q.volume || [];

      // null candle 제외
      const rows = [];
      for (let i = 0; i < timestamps.length; i++) {
        if (rawClose[i] == null) continue;
        rows.push({
          t: timestamps[i],
          c: rawClose[i],
          h: rawHigh[i]   ?? rawClose[i],
          l: rawLow[i]    ?? rawClose[i],
          v: rawVolume[i] ?? 0,
        });
      }

      const closes  = rows.map(r => r.c);
      const highs   = rows.map(r => r.h);
      const lows    = rows.map(r => r.l);
      const volumes = rows.map(r => r.v);
      const warnings = [];

      function sma(arr, period) {
        if (arr.length < period) return null;
        const sl = arr.slice(arr.length - period);
        return sl.reduce((s, v) => s + v, 0) / period;
      }

      // Wilder RSI(14): 첫 14봉 단순평균 seed → 이후 Wilder smoothing (alpha=1/14)
      function wilderRSI(arr, period) {
        if (arr.length < period + 1) return null;
        let ag = 0, al = 0;
        for (let i = 1; i <= period; i++) {
          const d = arr[i] - arr[i - 1];
          if (d > 0) ag += d; else al += Math.abs(d);
        }
        ag /= period; al /= period;
        for (let i = period + 1; i < arr.length; i++) {
          const d = arr[i] - arr[i - 1];
          ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
          al = (al * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
        }
        if (al === 0) return 100;
        return 100 - 100 / (1 + ag / al);
      }

      // Wilder ATR(14): TrueRange seed 단순평균 → Wilder smoothing
      function wilderATR(h, l, c, period) {
        if (c.length < period + 1) return null;
        const trs = [];
        for (let i = 1; i < c.length; i++) {
          trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
        }
        if (trs.length < period) return null;
        let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
        for (let i = period; i < trs.length; i++) {
          atr = (atr * (period - 1) + trs[i]) / period;
        }
        return atr;
      }

      function avgVol(arr, period) {
        if (arr.length < period) return null;
        const sl = arr.slice(arr.length - period);
        return sl.reduce((s, v) => s + v, 0) / period;
      }

      const r4 = v => v == null ? null : Math.round(v * 10000) / 10000;

      const sma20Val  = sma(closes, 20);
      const sma50Val  = sma(closes, 50);
      const sma200Val = sma(closes, 200);
      const rsiVal    = wilderRSI(closes, 14);
      const atrVal    = wilderATR(highs, lows, closes, 14);
      const avgV20    = avgVol(volumes, 20);
      const h52 = highs.length ? Math.max(...highs.slice(Math.max(0, highs.length - 252))) : null;
      const l52 = lows.length  ? Math.min(...lows.slice(Math.max(0, lows.length - 252)))   : null;

      if (sma20Val  == null) warnings.push('sma20: insufficient data');
      if (sma50Val  == null) warnings.push('sma50: insufficient data');
      if (sma200Val == null) warnings.push('sma200: insufficient data');
      if (rsiVal    == null) warnings.push('rsi14_wilder: insufficient data');
      if (atrVal    == null) warnings.push('atr14_wilder: insufficient data');
      if (avgV20    == null) warnings.push('avg_volume20: insufficient data');

      const asof = rows.length ? new Date(rows[rows.length - 1].t * 1000).toISOString().slice(0, 10) : null;

      return jsonResp({
        symbol,
        asof,
        source:               'Yahoo/recon',
        requested_range:      requestedRange,
        calculation_lookback: '2y',
        sample_count:         rows.length,
        last_close:           r4(closes[closes.length - 1] ?? null),
        sma20:                r4(sma20Val),
        sma50:                r4(sma50Val),
        sma200:               r4(sma200Val),
        rsi14_wilder:         rsiVal != null ? Math.round(rsiVal * 100) / 100 : null,
        atr14_wilder:         r4(atrVal),
        avg_volume20:         avgV20 != null ? Math.round(avgV20) : null,
        high_52w:             r4(h52),
        low_52w:              r4(l52),
        ...(warnings.length ? { warnings } : {}),
      });
    }

    const target = url.searchParams.get('url');
    if (!target) {
      return new Response('RECON Worker OK', {
        headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' },
      });
    }
    if (!target.includes('yahoo.com') && !target.includes('finviz.com') && !target.includes('dataviz.cnn.io')) {
      return new Response('허용되지 않은 URL', { status: 403 });
    }
    if (target.includes('finance.yahoo.com/v10/')) return await fetchYahooV10(target);
    try {
      const res  = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9' } });
      const data = await res.text();
      return new Response(data, { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
  },

  async scheduled(event, env) {
    await checkKRPositions(env);
    await checkUSPositions(env);
  }
};

function secHeaders(env) {
  const ua = env.SEC_USER_AGENT || 'RECON Research research@example.com';
  return {
    'User-Agent': ua,
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip, deflate',
  };
}

function padCIK(cik) {
  const n = String(cik).replace(/\D/g, '');
  return n.padStart(10, '0');
}

async function handleSecTickerCik(env, nocache = false) {
  const cacheKey = 'sec_cikmap_v1';

  if (!nocache) {
    const cached = await env.RECONKR_KV.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'X-Cache': 'HIT',
        }
      });
    }
  }

  try {
    const resp = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: secHeaders(env),
    });
    if (!resp.ok) {
      return jsonResp({ error: `SEC fetch failed: ${resp.status}` }, 502);
    }
    const raw = await resp.json();

    const map = {};
    for (const key of Object.keys(raw)) {
      const row = raw[key];
      if (row && row.ticker && row.cik_str) {
        map[row.ticker.toUpperCase()] = padCIK(row.cik_str);
      }
    }

    const body = JSON.stringify({ map, count: Object.keys(map).length, cached_at: new Date().toISOString() });
    await env.RECONKR_KV.put(cacheKey, body, { expirationTtl: SEC_CACHE.CIKMAP_TTL_SEC });

    return new Response(body, {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'X-Cache': 'MISS',
      }
    });
  } catch (e) {
    return jsonResp({ error: e.message }, 502);
  }
}

async function handleSecFacts(ticker, env, nocache = false) {
  const cacheKey = `sec_facts_${ticker}_v1`;

  if (!nocache) {
    const cached = await env.RECONKR_KV.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'X-Cache': 'HIT',
          'X-Ticker': ticker,
        }
      });
    }
  }

  try {
    let cik = null;
    const mapRaw = await env.RECONKR_KV.get('sec_cikmap_v1');
    if (mapRaw) {
      const m = JSON.parse(mapRaw);
      cik = m.map?.[ticker];
    }

    if (!cik) {
      // ★ FIX 2026-06: 기존엔 nocache=false라 같은 stale 캐시를 다시 읽어 신규 상장이 7일간 404.
      //   강제 갱신 후 재조회. 오타/비상장 해머링 방지로 6시간 negative cache.
      const negKey = `sec_unknown_${ticker}`;
      const neg = await env.RECONKR_KV.get(negKey);
      if (neg) return jsonResp({ error: `ticker not found: ${ticker}`, cached: true }, 404);
      await handleSecTickerCik(env, true);
      const mapRaw2 = await env.RECONKR_KV.get('sec_cikmap_v1');
      if (mapRaw2) {
        const m2 = JSON.parse(mapRaw2);
        cik = m2.map?.[ticker];
      }
      if (!cik) await env.RECONKR_KV.put(negKey, '1', { expirationTtl: 6 * 3600 });
    }

    if (!cik) {
      return jsonResp({ error: `ticker not found: ${ticker}` }, 404);
    }

    const factsUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
    const resp = await fetch(factsUrl, { headers: secHeaders(env) });

    if (resp.status === 404) {
      return jsonResp({ error: 'no facts available', ticker, cik }, 404);
    }
    if (!resp.ok) {
      return jsonResp({ error: `SEC facts fetch failed: ${resp.status}`, ticker, cik }, 502);
    }

    const text = await resp.text();

    const sizeKB = Math.round(text.length / 1024);
    if (sizeKB > 24000) {
      return new Response(text, {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'X-Cache': 'SKIP-TOO-LARGE',
          'X-Ticker': ticker,
          'X-CIK': cik,
          'X-Size-KB': String(sizeKB),
        }
      });
    }

    await env.RECONKR_KV.put(cacheKey, text, { expirationTtl: SEC_CACHE.FACTS_TTL_SEC });

    return new Response(text, {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'X-Cache': 'MISS',
        'X-Ticker': ticker,
        'X-CIK': cik,
        'X-Size-KB': String(sizeKB),
      }
    });
  } catch (e) {
    return jsonResp({ error: e.message, ticker }, 502);
  }
}

async function checkUSPositions(env) {
  // ★ FIX 2026-06: 기존 게이트(etHM<400 || etHM>=930)는 프리마켓에만 동작
  //   → 정규장(9:30~16:00)·애프터(16:00~20:00)에 T1/손절 알림이 전혀 안 나가던 버그.
  //   pickActivePrice가 세션별 가격을 이미 처리하므로 4:00~20:00 전 구간 + 평일만 감시.
  const etHM = _getETHM();
  const etDay = _getETDay(); // 0=일 ~ 6=토 (ET 기준)
  if (etDay === 0 || etDay === 6) return;
  if (etHM < 400 || etHM >= 2000) return;

  const now = new Date();
  const kstHour  = (now.getUTCHours() + 9) % 24;
  const kstMin   = now.getUTCMinutes();

  if (kstHour === 21 && kstMin < 5) {
    const posStr = await env.RECONKR_KV.get('us_positions_momo');
    if (posStr) {
      const positions = JSON.parse(posStr);
      if (positions.length) {
        const dateStr = now.toISOString().slice(0, 10);
        const reminderKey = `us_reminder_afternoon_${dateStr}`;
        const alreadySent = await env.RECONKR_KV.get(reminderKey);
        if (!alreadySent) {
          const names = positions.map(p => p.name || p.ticker).join(', ');
          await sendTelegram(`⏰ RECON MOMO 포지션 점검\n📋 ${names}`, env);
          await env.RECONKR_KV.put(reminderKey, '1', { expirationTtl: 86400 });
        }
      }
    }
  }

  const intervals = { momo: 5, swing: 60, core: 360 };
  for (const mode of ['momo', 'swing', 'core']) {
    const lastKey = `us_lastcheck_${mode}`;
    const lastCheck = await env.RECONKR_KV.get(lastKey);
    if (lastCheck && Date.now() - parseInt(lastCheck) < intervals[mode] * 60 * 1000) continue;
    await env.RECONKR_KV.put(lastKey, Date.now().toString(), { expirationTtl: 86400 });

    const posStr = await env.RECONKR_KV.get(`us_positions_${mode}`);
    if (!posStr) continue;
    const positions = JSON.parse(posStr);
    if (!positions.length) continue;

    for (const pos of positions) {
      try {
        if (!pos.ticker) continue;
        if (pos.deleted) continue;

        const wb = await getWebullQuote(pos.ticker, env);
        if (!wb || wb.error) continue;
        const price = pickActivePrice(wb);
        if (!price || price <= 0) continue;

        const session = classifySession(wb);
        const label = mode.toUpperCase();
        const name  = pos.name || pos.ticker;
        const pnlPct = pos.entryPrice > 0
          ? ((price - pos.entryPrice) / pos.entryPrice * 100).toFixed(2) : null;
        const pnlStr = pnlPct !== null ? `수익률: ${pnlPct > 0 ? '+' : ''}${pnlPct}%` : '';
        const sessionTag = session === 'PM' ? ' [PRE]' : session === 'AH' ? ' [AH]' : '';

        if (pos.stop > 0 && price <= pos.stop) {
          // ★ FIX 2026-06-13: 손절선이 진입가 이상(BE 이동/트레일링)이거나 수익 중이면
          //   '손절'이 아니라 '이익 보호선 터치' — 라벨/액션 분리. 알림은 하루 1회.
          const raisedStop = pos.entryPrice > 0 && pos.stop >= pos.entryPrice;
          const inProfit   = pnlPct !== null && parseFloat(pnlPct) > 0;
          const protective = raisedStop || inProfit;
          await alertWithCooldown(`us_stop_${mode}_${pos.ticker}_${_getETDateStr()}`,
            (protective
              ? `🟢 ${label} 이익 실현${sessionTag} — ${name}\n\n` +
                `현재가: $${price.toFixed(2)}\n` +
                `추적손절선: $${pos.stop} (이 아래로 내려옴)\n` +
                `진입가: $${pos.entryPrice}\n${pnlStr}\n\n📤 이익 실현 검토 — 앱에서 재분석으로 펀더 확인`
              : `🔴 ${label} 손절${sessionTag} — ${name}\n\n` +
                `현재가: $${price.toFixed(2)}\n` +
                `손절선: $${pos.stop}\n` +
                `진입가: $${pos.entryPrice}\n${pnlStr}\n\n⚠️ 즉시 매도 확인`),
            1440, env);  // 같은 ET 날짜엔 1회만 (체크 주기마다 재발송 방지)
        }
        if (pos.t1 > 0 && price >= pos.t1 && (pos.t2 <= 0 || price < pos.t2)) {
          await alertWithCooldown(`us_t1_${mode}_${pos.ticker}_${_getETDateStr()}`,
            `🟡 ${label} T1 도달${sessionTag} — ${name}\n\n` +
            `현재가: $${price.toFixed(2)}\n` +
            `T1 목표: $${pos.t1}\n` +
            `진입가: $${pos.entryPrice}\n${pnlStr}\n\n📤 절반 매도 + 손절 BE 이동`,
            1440, env);
        }
        if (pos.t2 > 0 && price >= pos.t2) {
          await alertWithCooldown(`us_t2_${mode}_${pos.ticker}_${_getETDateStr()}`,
            `🟢 ${label} T2 도달${sessionTag} — ${name}\n\n` +
            `현재가: $${price.toFixed(2)}\n` +
            `T2 목표: $${pos.t2}\n` +
            `진입가: $${pos.entryPrice}\n${pnlStr}\n\n📤 잔량 전량 매도`,
            1440, env);
        }
      } catch (e) {
        console.error(`[US ${mode}] ${pos.ticker}:`, e.message);
      }
    }
  }
}

async function getWebullQuote(symbol, env) {
  try {
    let tickerId = await env.RECONKR_KV.get(`wb_id_${symbol}`);
    if (!tickerId) {
      const searchUrl =
        `https://quotes-gw.webullfintech.com/api/search/pc/tickers` +
        `?keyword=${encodeURIComponent(symbol)}&pageIndex=1&pageSize=10&regionId=6`;
      const searchResp = await fetch(searchUrl, { headers: WB_HEADERS });
      if (!searchResp.ok) return { error: 'search failed: ' + searchResp.status };
      const searchData = await searchResp.json();
      const list = searchData.data || [];
      const match =
        list.find(t => (t.symbol || '').toUpperCase() === symbol && t.regionId === 6) ||
        list.find(t => (t.symbol || '').toUpperCase() === symbol) ||
        list[0];
      if (!match || !match.tickerId) return { error: 'ticker not found' };
      tickerId = String(match.tickerId);
      await env.RECONKR_KV.put(`wb_id_${symbol}`, tickerId, { expirationTtl: 86400 * 30 });
    }

    const quoteUrl =
      `https://quotes-gw.webullfintech.com/api/bgw/quote/realtime` +
      `?ids=${tickerId}&includeSecu=1&includeQuote=1&more=1`;
    const quoteResp = await fetch(quoteUrl, { headers: WB_HEADERS });
    if (!quoteResp.ok) return { error: 'quote failed: ' + quoteResp.status };
    const quoteData = await quoteResp.json();
    const q = Array.isArray(quoteData) ? quoteData[0] : quoteData;
    if (!q) return { error: 'empty quote' };

    // ── bid/ask 추출 (★ 2026-06 신규 — 스프레드 필터/슬리피지용) ──
    //   Webull realtime 응답은 시간대/종목에 따라 호가 필드 위치가 다름:
    //   askList/bidList: [{price,volume}], depth.ntvAggAskList/ntvAggBidList, 또는 단일 필드.
    //   어디에도 없으면 0 → 프론트는 Finviz 폴백 사용.
    const _lvl1 = (arr) => {
      if (!Array.isArray(arr) || !arr.length) return 0;
      const p = parseFloat(arr[0] && (arr[0].price !== undefined ? arr[0].price : arr[0]));
      return (p > 0) ? p : 0;
    };
    const ask =
      parseFloat(q.askPrice || q.ask || '0') ||
      _lvl1(q.askList) ||
      _lvl1(q.depth && q.depth.ntvAggAskList) ||
      _lvl1(q.depth && q.depth.askList) || 0;
    const bid =
      parseFloat(q.bidPrice || q.bid || '0') ||
      _lvl1(q.bidList) ||
      _lvl1(q.depth && q.depth.ntvAggBidList) ||
      _lvl1(q.depth && q.depth.bidList) || 0;

    return {
      tickerId,
      status:   q.status || '',
      close:    parseFloat(q.close    || '0'),
      pPrice:   parseFloat(q.pPrice   || '0'),
      aPrice:   parseFloat(q.aPrice   || '0'),
      preClose: parseFloat(q.preClose || '0'),
      chgRatio: parseFloat(q.changeRatio || '0'),
      pChRatio: parseFloat(q.pChRatio    || '0'),
      aChRatio: parseFloat(q.aChRatio    || '0'),
      volume:   parseInt(q.volume || '0'),
      high:     parseFloat(q.high || '0'),
      low:      parseFloat(q.low  || '0'),
      open:     parseFloat(q.open || '0'),
      bid:      bid,
      ask:      ask,
    };
  } catch (e) {
    return { error: e.message };
  }
}

function classifySession(wb) {
  if (!wb) return 'UNKNOWN';
  const etHM = _getETHM();
  if (etHM >= 400  && etHM < 930)  return 'PM';
  if (etHM >= 930  && etHM < 1600) return 'REG';
  if (etHM >= 1600 && etHM < 2000) return 'AH';
  return 'CLOSED';
}

function _getETHM() {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date());
    const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
    return h * 100 + m;
  } catch {
    const now = new Date();
    const etH = (now.getUTCHours() - 4 + 24) % 24;
    return etH * 100 + now.getUTCMinutes();
  }
}

// ET 기준 날짜 문자열 (YYYY-MM-DD) — 알림 하루 1회 dedupe 키용
function _getETDateStr() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// ET 기준 요일 (0=일 ~ 6=토) — 주말 stale 시세로 인한 오알림 방지
function _getETDay() {
  try {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' })
      .format(new Date());
    return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd] ?? new Date().getUTCDay();
  } catch {
    return new Date().getUTCDay();
  }
}

function pickActivePrice(wb) {
  if (!wb) return null;
  const session = classifySession(wb);

  if (session === 'PM') {
    return wb.pPrice > 0 ? wb.pPrice : null;
  }
  if (session === 'REG') {
    return wb.close > 0 ? wb.close : null;
  }
  if (session === 'AH') {
    return wb.aPrice > 0 ? wb.aPrice : (wb.close > 0 ? wb.close : null);
  }
  if (wb.pPrice > 0) return wb.pPrice;
  if (wb.aPrice > 0) return wb.aPrice;
  if (wb.close > 0)  return wb.close;
  return null;
}

async function getYahooChart(ticker, range, interval) {
  try {
    const resp = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}&includePrePost=true`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
    );
    const data = await resp.json();
    const res  = data?.chart?.result?.[0];
    if (!res) return null;
    const meta   = res.meta || {};
    const qdata  = res.indicators?.quote?.[0] || {};
    const opens  = qdata.open   || [];
    const closes = qdata.close  || [];
    const highs  = qdata.high   || [];
    const lows   = qdata.low    || [];
    const vols   = qdata.volume || [];
    const candles = [];
    for (let i = 0; i < closes.length; i++) {
      if (opens[i] && closes[i] && highs[i] && lows[i] && vols[i]) {
        candles.push({ open: opens[i], close: closes[i], high: highs[i], low: lows[i], volume: vols[i] });
      }
    }
    const lastCandle = candles.length ? candles[candles.length - 1].close : 0;
    const regPrice   = meta.regularMarketPrice || 0;
    const price      = lastCandle > 0 ? lastCandle : regPrice;
    return { price, candles };
  } catch { return null; }
}

async function checkKRPositions(env) {
  const now      = new Date();
  const kstHour  = (now.getUTCHours() + 9) % 24;
  const kstMin   = now.getUTCMinutes();
  const kstTotal = kstHour * 60 + kstMin;
  if (kstTotal < 540 || kstTotal > 930) return;

  // ★ 2026-07: KIS 직접 호출 → Oracle VM(dart.minon.kr) 경유로 전환.
  //   Oracle이 토큰/appkey/appsecret 주입 — 워커는 KIS 키 불필요.
  //   (기존: KV kis_appkey 없음 + Cloudflare IP가 KIS에 차단 → 감시가 조용히 죽어 있었음)
  const token = null, creds = null;

  if (kstHour === ALERT_CFG.momoRemindHour && kstMin < 5) {
    const posStr = await env.RECONKR_KV.get('positions_momo');
    if (posStr) {
      const positions = JSON.parse(posStr);
      if (positions.length) {
        const reminderKey = `reminder_afternoon_${now.toISOString().slice(0, 10)}`;
        const alreadySent = await env.RECONKR_KV.get(reminderKey);
        if (!alreadySent) {
          const names = positions.map(p => p.name || p.code).join(', ');
          await sendTelegram(`⏰ 오후 2시 — MOMO 포지션 점검\n📋 ${names}`, env);
          await env.RECONKR_KV.put(reminderKey, '1', { expirationTtl: 86400 });
        }
      }
    }
  }

  for (const mode of ['momo', 'swing', 'core']) {
    const posStr = await env.RECONKR_KV.get(`positions_${mode}`);
    if (!posStr) continue;
    const positions = JSON.parse(posStr);
    if (!positions.length) continue;

    for (const pos of positions) {
      try {
        await checkKRPosition(pos, mode, token, creds, env);
      } catch (e) {
        console.error(`[KR ${mode}] ${pos.code}:`, e.message);
      }
    }
  }
}

async function checkKRPosition(pos, mode, token, creds, env) {
  if (!pos.code) return;
  if (pos.deleted) return;  // ★ 2026-07: tombstone(청산/삭제) 감시 제외
  const quote = await getKisQuote(pos.code, token, creds);
  if (!quote || !quote.price) return;

  const price = quote.price;
  const name  = pos.name || pos.code;
  const label = mode.toUpperCase();
  const pnlPct = pos.entryPrice > 0
    ? ((price - pos.entryPrice) / pos.entryPrice * 100).toFixed(2) : null;
  const pnlStr = pnlPct !== null ? `수익률: ${pnlPct > 0 ? '+' : ''}${pnlPct}%` : '';

  const fmt = (v) => Math.round(v).toLocaleString() + '원';

  if (pos.stop > 0 && price <= pos.stop) {
    // ★ FIX 2026-06-13: 손절선이 진입가 이상(BE 이동/트레일링)이거나 수익 중이면
    //   '손절'이 아니라 '이익 보호선 터치'. 알림은 하루 1회 (KST 날짜 기준).
    const raisedStop = pos.entryPrice > 0 && pos.stop >= pos.entryPrice;
    const inProfit   = pnlPct !== null && parseFloat(pnlPct) > 0;
    const protective = raisedStop || inProfit;
    const kstDate = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    await alertWithCooldown(`kr_stop_${mode}_${pos.code}_${kstDate}`,
      (protective
        ? `🟢 ${label} 이익 실현 — ${name}\n\n` +
          `현재가: ${fmt(price)}\n` +
          `추적손절선: ${fmt(pos.stop)} (이 아래로 내려옴)\n` +
          `진입가: ${fmt(pos.entryPrice)}\n${pnlStr}\n\n📤 이익 실현 검토 — 앱에서 재분석으로 펀더 확인`
        : `🔴 ${label} 손절 — ${name}\n\n` +
          `현재가: ${fmt(price)}\n` +
          `손절선: ${fmt(pos.stop)}\n` +
          `진입가: ${fmt(pos.entryPrice)}\n${pnlStr}\n\n⚠️ 즉시 매도 확인`),
      1440, env);
  }

  if (pos.t1 > 0 && price >= pos.t1 && (pos.t2 <= 0 || price < pos.t2)) {
    {
    const kstDate = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    await alertWithCooldown(`kr_t1_${mode}_${pos.code}_${kstDate}`,
      `🟡 ${label} T1 도달 — ${name}\n\n` +
      `현재가: ${fmt(price)}\n` +
      `T1 목표: ${fmt(pos.t1)}\n` +
      `진입가: ${fmt(pos.entryPrice)}\n${pnlStr}\n\n📤 절반 익절 + 손절 BE 이동`,
      1440, env);
  }
  }

  if (pos.t2 > 0 && price >= pos.t2) {
    {
    const kstDate = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    await alertWithCooldown(`kr_t2_${mode}_${pos.code}_${kstDate}`,
      `🟢 ${label} T2 도달 — ${name}\n\n` +
      `현재가: ${fmt(price)}\n` +
      `T2 목표: ${fmt(pos.t2)}\n` +
      `진입가: ${fmt(pos.entryPrice)}\n${pnlStr}\n\n📤 잔량 전량 매도`,
      1440, env);
  }
  }
}

async function getKisToken(env) {
  const cached = await env.RECONKR_KV.get('kis_token');
  if (cached) {
    const { token, expires_at } = JSON.parse(cached);
    if (Date.now() < expires_at - 60000) return token;
  }
  const appKey    = await env.RECONKR_KV.get('kis_appkey');
  const appSecret = await env.RECONKR_KV.get('kis_appsecret');
  if (!appKey || !appSecret) return null;
  const resp = await fetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret }),
  });
  const data = await resp.json();
  if (!data.access_token) return null;
  const tokenData = { token: data.access_token, expires_at: Date.now() + (data.expires_in || 86400) * 1000 };
  await env.RECONKR_KV.put('kis_token', JSON.stringify(tokenData));
  return tokenData.token;
}

async function getKisQuote(code, token, creds) {
  // ★ 2026-07: Oracle VM(dart.minon.kr) 경유 — 서버가 토큰/appkey/appsecret 주입.
  //   token/creds 파라미터는 시그니처 호환용으로 유지 (미사용).
  try {
    const resp = await fetch(
      `https://dart.minon.kr/kis/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`,
      { headers: { 'Content-Type': 'application/json', 'tr_id': 'FHKST01010100', 'custtype': 'P' } }
    );
    const data = await resp.json();
    const o    = data.output;
    if (!o) return null;
    return {
      price:   parseFloat(o.stck_prpr),
      open:    parseFloat(o.stck_oprc),
      high:    parseFloat(o.stck_hgpr),
      low:     parseFloat(o.stck_lwpr),
      volume:  parseFloat(o.acml_vol),
      prevVol: parseFloat(o.prdy_vol),
    };
  } catch { return null; }
}

function kisHeaders(token, creds, trId) {
  return {
    'Content-Type':  'application/json',
    'authorization': `Bearer ${token}`,
    'appkey':        creds.appKey,
    'appsecret':     creds.appSecret,
    'tr_id':         trId,
    'custtype':      'P',
  };
}

async function alertWithCooldown(key, msg, cooldownMin, env) {
  const last = await env.RECONKR_KV.get(key);
  if (last && Date.now() - parseInt(last) < cooldownMin * 60 * 1000) return;
  await sendTelegram(msg, env);
  await env.RECONKR_KV.put(key, Date.now().toString(), { expirationTtl: cooldownMin * 60 * 2 });
}

async function sendTelegram(text, env) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
  });
}

async function sendTelegramDebug(text, env) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
  });
  const body = await res.json().catch(() => ({}));
  return { httpStatus: res.status, telegram: body };
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

// ★ 2026-07: KR 감시 머지 — code(6자리) 키 기준. US mergePositions(ticker 기준)의 KR판.
//   tombstone(deleted)은 30일 보존 후 자동 소멸.
function mergeKRPositions(cloud, incoming) {
  const stamp = r => Math.max(r.updatedAt || 0, r.deletedAt || 0);
  const byC = {};
  (cloud || []).forEach(r => { if (r && r.code) byC[r.code] = r; });
  (incoming || []).forEach(r => {
    if (!r || !r.code) return;
    const ex = byC[r.code];
    if (!ex || stamp(r) >= stamp(ex)) byC[r.code] = r;
  });
  const now = Date.now();
  return Object.values(byC).filter(r => !(r.deleted && r.deletedAt && (now - r.deletedAt > 30 * 24 * 3600 * 1000)));
}

function mergePositions(cloud, incoming) {
  const stamp = r => Math.max(r.updatedAt || 0, r.deletedAt || 0);
  const byT = {};
  (cloud || []).forEach(r => { if (r && r.ticker) byT[r.ticker] = r; });
  (incoming || []).forEach(r => {
    if (!r || !r.ticker) return;
    const ex = byT[r.ticker];
    if (!ex || stamp(r) >= stamp(ex)) byT[r.ticker] = r;
  });
  const now = Date.now();
  return Object.values(byT).filter(r => !(r.deleted && r.deletedAt && (now - r.deletedAt > 30 * 24 * 3600 * 1000)));
}

function mergeJournal(cloud, incoming) {
  const stamp = r => Math.max(r.updatedAt || 0, r.deletedAt || 0);
  const byId = {};
  (cloud || []).forEach(r => { if (r && r.id != null) byId[r.id] = r; });
  (incoming || []).forEach(r => {
    if (!r || r.id == null) return;
    const ex = byId[r.id];
    if (!ex || stamp(r) >= stamp(ex)) byId[r.id] = r;
  });
  const now = Date.now();
  return Object.values(byId).filter(r => !(r.deleted && r.deletedAt && (now - r.deletedAt > 30 * 24 * 3600 * 1000)));
}

function mergeTrack(a, b) {
  // status 진행도 랭크 — 더 진행된 쪽을 절대 잃지 않음
  const rank = s => s === 'complete' ? 2 : s === 'p1_done' ? 1 : 0;
  const byId = {};
  a.forEach(t => { byId[t.id] = t; });
  b.forEach(t => {
    const ex = byId[t.id];
    if (!ex) { byId[t.id] = t; return; }
    const merged = Object.assign({}, ex, t);
    // ── 레거시 (RECONKR p1/p2 형식): 어느 한 쪽에 있으면 보존 ──
    if (ex.p1 && !t.p1) merged.p1 = ex.p1;
    if (ex.p2 && !t.p2) merged.p2 = ex.p2;
    // ── 신형 (RECON US eval 형식): 검증 결과는 어느 한 쪽에 있으면 보존 ──
    //   ★ FIX 2026-06: Object.assign이 미검증 기기의 eval:null로 검증결과를 덮어쓰던 문제
    if (ex.eval && !t.eval) merged.eval = ex.eval;
    // ── features 스냅샷도 보존 (한 쪽에만 있을 수 있음) ──
    if (ex.features && !t.features) merged.features = ex.features;
    // ── status: 레거시 재계산 + 다운그레이드 금지 ──
    if (merged.p2)      merged.status = 'complete';
    else if (merged.p1 && rank(merged.status) < 1) merged.status = 'p1_done';
    if (rank(ex.status) > rank(merged.status)) merged.status = ex.status;
    byId[t.id] = merged;
  });
  const out = Object.values(byId);
  out.sort((x, y) => y.scannedAt - x.scannedAt);
  return out.slice(0, TRACK_MAX);
}

async function fetchYahooV10(targetUrl) {
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  try {
    const cookieResp = await fetch('https://fc.yahoo.com', { redirect: 'follow', headers: { 'User-Agent': UA, 'Accept': '*/*' } });
    let cookieParts  = [];
    for (const [hName, hVal] of cookieResp.headers.entries()) {
      if (hName.toLowerCase() === 'set-cookie') {
        const part = hVal.split(';')[0].trim();
        if (part) cookieParts.push(part);
      }
    }
    const cookieHeader = cookieParts.join('; ');
    const crumbResp    = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, 'Cookie': cookieHeader, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9' } });
    const crumb        = (await crumbResp.text()).trim();
    if (!crumb || crumb.length > 30 || crumb.includes('{')) throw new Error('crumb 획득 실패');
    const sep    = targetUrl.includes('?') ? '&' : '?';
    const v10Url = targetUrl + sep + 'crumb=' + encodeURIComponent(crumb);
    const res    = await fetch(v10Url, { headers: { 'User-Agent': UA, 'Cookie': cookieHeader, 'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9' } });
    const data   = await res.text();
    return new Response(data, { status: res.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'v10_crumb_error: ' + e.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
}