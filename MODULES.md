# RECONKR 함수 인덱스 (15,216줄 단일 HTML)

> **2026-04-24 기준** (legacyCardHTML 정리 후) · 다음 세션 시작 시 이 파일 업로드하면 grep 시간 절약

---

## 🗺 영역별 분포 (라인 범위)

| 라인 | 영역 | 비고 |
|------|------|------|
| ~980 | HTML/CSS/UI 정의 | 헤더, 탭, 스타일 |
| 981–2272 | UI 라우팅 + KIS API + 시간 인지 | 모드 전환, KIS 인증/시세/일봉 |
| 2273–3160 | 스크리너 인프라 + 점수 계산 | 후보 풀, hardCut, score_*, predict |
| 3213–3640 | runScreener + UI 렌더링 | 스크리너 실행, 결과 표시 |
| 3660–3940 | DART API | 공시 + 재무제표 |
| 3941–5430 | 데이터 통합 fetcher | Yahoo, SwingData, CoreData |
| 5433–5934 | makePrompt | AI 프롬프트 생성 |
| 5935–6250 | MOMO 지원 함수 | 손절, 세력, 하드필터 |
| 6252–7367 | **3개 엔진** | momoEngine, swingEngine, coreEngine |
| 7007–7367 | **엣지 테스트** | runSwing/Core/TimeAwareness EdgeTests |
| 7768–8424 | runSingleScan + saveToHistory | 분석 메인 흐름 |
| 8425–8920 | 카드 유틸 + MOMO 카드 | history, calcSellTargets, momoCardHTML |
| 9234–9844 | **카드 라우터 + SWING/CORE 카드** | 신규 분리 카드 시스템 |
| 9776–9845 | _legacyCardHTML | hold + 폴백 (정리 완료, 100줄) |
| 9846–10360 | hold 카드 + 거래 기록 | calcSwingExitSignals, holdCardHTML |
| 10395–14500 | 거래 일지 + 알림 + 설정 + UI 잡다 | journal, ntfy, search, master |
| 14738–15000 | 시장/매크로 로드 | KOSPI, sectors, KisFlow |
| 15003–15216 | 보유 포지션 동기화 | holdSync, Telegram 통합 |

---

## 🔧 영역별 함수 인덱스 (주요)

### [1] UI 라우팅 + 시간 인지

```
981   switchMode(mode)              모드 탭 전환
1031  rescanOpenTrade(mode, ticker) 보유 포지션 재분석
1058  renderOpenPositions(mode)     보유 포지션 카드 렌더
1103  switchSubTab(sub)             서브탭 전환
1129  updateKeyStatus()             API 키 상태
1144  updateClock()                 시계 + 시장 phase
1230  getTimeAwareness()            ★ 시간대 → hasLivePrice/hasLiveTrigger
```

### [2] KIS API

#### 인증/HTTP
```
1290  fetchWithProxy(url)
1302  fetchTextWithProxy(url)
1337  kisGet / 1348 kisPost
1362  getKisToken / 1393 kisAuthHeaders
```

#### 시세/일봉
```
1408  fetchKisPrice(stockCode)         ★ 시세 + PER/PBR/시총/업종명
1665  fetchKisDailyChart(symbol)
1689  fetchKisDailyChartLong(s, n)     ★ 일봉 260건
1895  fetchKisSectorDailyChart(c, n)   ★ 업종 지수
1952  fetchKisInvestorHistory(s)       투자자 30일
1976  calcInvestorFlow(data)
2049  fetchKisStockInfo(symbol)
2064  calcDailyStats(candles, price)
```

#### 랭킹/필터링
```
1443  fetchKisVolumeRanking(market)
1479  fetchKisNearNewHigh(market)
1511  fetchKisInstitutionFlow
1556  fetchKisVolumePower
1589  fetchKisDisparity(market)
1622  fetchKisFluctuationRanking
2177  fetchKisCandidates(mode)
```

#### 섹터 매핑 (★ 신규)
```
1752  _loadSectorMapCache
1766  buildSectorMap(force)            ★ 동적 매핑 빌드
1836  kisSectorCodeFromName(name)
1862  showSectorMap                    ★ 디버그
1877  rebuildSectorMap                 ★ 강제 재빌드
```

### [3] 스크리너

```
2273  loadMarketData / 2306 loadFearGreed
2354  saveKis / 2365 testKisConnection / 2394 updateKisStatus
2407–2425 toggleAutoScan / startAutoScan / stopAutoScan
2430  switchScreenerTab(mode)
2439  fetchCandidatePool(mode)

# 하드컷
2467  hardCut_momo / 2508 hardCut_swing / 2541 hardCut_core

# 점수 계산
2565  score_momo                       ★ MOMO 점수
2659  score_swing                      ★ SWING 점수
3147  score_core                       ★ CORE 점수

# 트랙 (성과)
2731  loadTrack(mode) / 2736 saveTrackResults / 2803 checkTrackUpdates
2846  calcPerformanceStats(mode)       ★ 모드별 통계
2922  showPerformanceStats             ★ 디버그 대시보드
2972  simulateFilter / 3006 compareSwingThresholds / 3031 validateTVGate

3213  runScreener(mode)                ★ 메인
3467  predictSwingScore / 3501 checkBlockRisk / 3546 renderScreenerResults
```

### [4] DART

```
3660  fetchDart / 3672 saveDart / 3770 updateDartStatus / 3777 testDartConnection
3688  fetchDartFinancials(code)        ★ 재무제표
3800  fetchDartCorpCode / 3812 fetchDartDisclosures
3848  classifyDartDisclosures
3865  loadDartFeed / 3911 toggleDartFilter / 3923 applyDartFilterAndRender
```

### [5] 데이터 통합 fetcher

```
3941  fetchYahooData(ticker)           ★ Yahoo 1분봉
4540  fetchSwingData(t, kp)            ★ SWING 데이터
4823  _enrichSwingWithYahooBenchmark
4850  _fetchSwingFromKis
4914  _computeCoreIndicatorsFromValid  CORE 지표 (down_vol/up_down 등)
5095  _computeCoreRSFromKospi
5131  _computeCore8Conditions
5174  _kisCandlesToValid
5189  _fetchCoreFromKis(t, cd)         ★ KIS + 섹터RS + 재무
5325  _fetchCoreFromYahoo
5361  fetchCoreData(ticker)            ★ CORE 진입점
```

### [6] AI 프롬프트

```
5433  makePrompt                        ★ 보유 관리용
7768  makeExplainPrompt                 ★ 신규 진입 설명
```

### [7] 엔진 + 지원 함수

#### MOMO 지원
```
5935  calcMomoStop
5982  getWhaleStage(r)                  ★ 7단계 세력 감지
6141  hardFilter
```

#### ★★★ 핵심 엔진 ★★★
```
6252  momoEngine(ydata)                 ★ MOMO
6509  swingEngine(ydata, swingData)     ★ SWING (4레이어)
7367  coreEngine(ydata, coreData)       ★ CORE
```

#### 엣지 테스트
```
7007  runSwingEdgeTests                 18개
7108  runTimeAwarenessTests             7개
7145  runCoreEdgeTests                  13개 (모두 pass)
7348  runAllEngineTests                 통합
```

### [8] 분석 메인 흐름

```
7796  runModeScan(mode)
7835  resolveKoreanName
7925  runSingleScan(m, t, ae, re)       ★★ 단일 분석 (3엔진 동시 평가)
8425  saveToHistory
8454  renderHistory / 8468 clearHistory / 8479 applyHistory
```

### [9] 카드 시스템 (★ 2026-04-24 재설계)

#### 유틸
```
8498  calcEntryAction
8514  _calcEntryActionInner
8696  calcSellTargets                   ★ T1/T2 (SWING은 엔진 값 신뢰)
8746  getPMZone
8761  toggleCardDetail
8781  renderDartDisclosures
8816  buildMomoTags
8879  buildDecisionPathHTML
```

#### 모드별 카드 (★ 분리)
```
8922  momoCardHTML                      ★ MOMO 전용 + footer
9234  cardHTML(r, mode)                 ★ 라우터
9250  _cardHoldBanner                   공통: 보유 배너
9270  _cardSignalLines                  공통: 신호 라인
9282  _cardTimestamp                    공통: 타임스탬프
9294  _compatibilityFooter              ★ 다른 엔진 적합성
9375  swingCardHTML                     ★ SWING 전용
9523  _swingLayersBlock                 4레이어 + 결정 경로
9600  coreCardHTML                      ★ CORE + 섹터RS + 밸류에이션
9776  _legacyCardHTML                   hold + 폴백 (100줄로 축소)
```

### [10] 보유 포지션

```
9846  calcSwingExitSignals(r, sw, t)   SWING 청산 신호
9919  holdCardHTML(r, mode, trade)      보유 카드
10128 openTradeLog / 10153 saveTradeLog
10179 openPartialSell / 10229 setPartialQty / 10254 confirmPartialSell
10289 markTradeClosed / 10292 openPartialBuy / 10362 confirmPartialBuy
10396 rerunCard

# Telegram/Worker (15003+)
15003 holdGetKey / 15007 holdLoad / 15011 holdRender
15039 holdAdd                           ★ 수동 등록
15066 holdFromAnalysis                  ★ 분석 카드에서 등록
15123 holdDelete / 15136 holdShowStatus
15144 holdSync                          ★ Worker → KV → 텔레그램
15169 holdTestTg
```

### [11] 알림 + 설정

```
10406 fireAlert / 10420 toggleAlerts / 10427 renderAlerts
10441 updateBadge / 10442 clearAlerts
10447 testNtfy / 10455 sendNtfy / 10461 playBeep
10478 save / 10480 cycle / 10488 restoreSettings
10502 renderUsage / 10511 resetUsage
10524–10859 거래 일지 (journal, edit, recalc)
10866 clearAllData / 10874 showToast
```

### [12] 스테일 배너 + 검색

```
10893–10946 스테일 배너 (checkStaleBanners 등)
14496 _initMaster / 14510 masterByCode / 14516 searchMaster
14536 onTickerInput / 14545 doTickerSearch / 14663 renderSearchDrop
14699 selectTicker / 14706 hideSearchDrop
```

### [13] 시장/매크로

```
14738 loadAllMarket / 14745 checkMarketRegime
14825 loadMacroData
14866 loadKisSectors
14934 loadKisFlow
```

---

## 🔑 자주 찾는 함수 빠른 참조

| 작업 | 함수 |
|------|------|
| 종목 분석 시작 | `runSingleScan` (7925) |
| MOMO 의사결정 | `momoEngine` (6252) |
| SWING 의사결정 | `swingEngine` (6509) |
| CORE 의사결정 | `coreEngine` (7367) |
| SWING 데이터 fetch | `fetchSwingData` (4540) |
| CORE 데이터 fetch | `fetchCoreData` (5361) |
| AI 프롬프트 (신규) | `makeExplainPrompt` (7768) |
| AI 프롬프트 (보유) | `makePrompt` (5433) |
| MOMO 카드 | `momoCardHTML` (8922) |
| SWING 카드 | `swingCardHTML` (9375) |
| CORE 카드 | `coreCardHTML` (9600) |
| 호환성 footer | `_compatibilityFooter` (9294) |
| 보유 등록 | `holdFromAnalysis` (15066) |
| 보유 동기화 | `holdSync` (15144) |
| 섹터 매핑 빌드 | `buildSectorMap` (1766) |
| DART 재무 | `fetchDartFinancials` (3688) |

---

## 🛠 디버그 콘솔 명령

```javascript
// 엔진 테스트
runAllEngineTests()
runSwingEdgeTests()
runCoreEdgeTests()
runTimeAwarenessTests()

// 성과 통계
showPerformanceStats()
calcPerformanceStats('swing')
compareSwingThresholds()
validateTVGate()

// 섹터 매핑
await buildSectorMap()
await showSectorMap()
await rebuildSectorMap()
```

---

## 📌 작업 시 참고 사항

### 변경 자주 일어나는 핫스팟 (조심)
- `runSingleScan` (7925) — 데이터 fetch 흐름 변경 시
- `swingEngine` / `coreEngine` — 점수 가중치 조정 시
- 카드 함수들 — UI 변경 시 (회귀 가능성 ↑)

### 수정 시 동시 확인 필요한 짝
- `swingEngine` 의 T1/T2 ↔ `calcSellTargets` (불일치 시 UI/RR 깨짐)
- `holdFromAnalysis` ↔ `G.screenerResults` + `G.{mode}History` (둘 다 검색 필요)
- `_fetchCoreFromKis` 의 cd 필드 추가 ↔ `coreEngine` propagate ↔ `coreCardHTML` 표시

### 정리 완료 (2026-04-24)
- ✅ `_legacyCardHTML` 671줄 → 100줄 축소
- ✅ MOMO/SWING/CORE 카드 분리
- ✅ 호환성 footer (3엔진 동시 평가)

### 다음 세션 후보
- 인라인 스타일 → CSS 클래스 (점진적)
- SWING 엣지 테스트 환경 한계 (document.getElementById mock)
- score_momo/score_swing/score_core 의 일부 중복 로직 통합

---

## 🔧 영역별 함수 인덱스

### [1] UI 라우팅 + 시간 인지 (981–1289)

```
981   switchMode(mode)              모드 탭 전환
1031  rescanOpenTrade(mode, ticker) 보유 포지션 재분석
1058  renderOpenPositions(mode)     보유 포지션 카드 렌더
1103  switchSubTab(sub)             서브탭 전환 (검색/히스토리/일지)
1129  updateKeyStatus()             API 키 상태 표시
1144  updateClock()                 시계 + 시장 phase 업데이트
1230  getTimeAwareness()            ★ 시간대 → hasLivePrice/hasLiveTrigger
```

### [2] KIS API (1290–2272)

#### 인증/HTTP
```
1290  fetchWithProxy(url)           Cloudflare Worker 경유 GET
1302  fetchTextWithProxy(url)       텍스트 응답 (마스터 파일용)
1337  kisGet(path, params, headers) KIS GET
1348  kisPost(path, body, headers)  KIS POST
1362  getKisToken()                 토큰 발급 + 캐싱
1393  kisAuthHeaders(trId)          헤더 생성
```

#### 시세/일봉
```
1408  fetchKisPrice(stockCode)       ★ 시세 + PER/PBR/시총/업종명
1665  fetchKisDailyChart(symbol)     일봉 100건
1689  fetchKisDailyChartLong(s, n)   ★ 일봉 260건 (CORE/SWING용)
1895  fetchKisSectorDailyChart(c, n) ★ 업종 지수 일봉 (섹터 RS용)
1952  fetchKisInvestorHistory(s)     투자자 30일 이력
1976  calcInvestorFlow(data)         외인/기관 누적
2049  fetchKisStockInfo(symbol)      종목 기본정보
2064  calcDailyStats(candles, price) 일봉 통계 → swingData
```

#### 랭킹/필터링
```
1443  fetchKisVolumeRanking(market)  거래량 상위
1479  fetchKisNearNewHigh(market)    신고가 근접
1511  fetchKisInstitutionFlow(m)     기관 매수
1556  fetchKisVolumePower()          거래량 분석
1589  fetchKisDisparity(market)      이격도
1622  fetchKisFluctuationRanking()   등락 + 업종 (★ buildSectorMap 활용)
2177  fetchKisCandidates(mode)       모드별 후보 풀
```

#### 섹터 매핑 (★ 신규 2026-04-24)
```
1752  _loadSectorMapCache()          24h localStorage 캐시
1766  buildSectorMap(force)          ★ 동적 매핑 빌드
1836  kisSectorCodeFromName(name)    한글명 → 코드
1862  showSectorMap()                ★ 디버그 (콘솔)
1877  rebuildSectorMap()             ★ 강제 재빌드
```

### [3] 스크리너 (2273–3640)

```
2273  loadMarketData()              KOSPI/KOSDAQ + sectors + flow
2306  loadFearGreed()               공포탐욕지수
2354  saveKis() / 2365 testKisConnection() / 2394 updateKisStatus()
2407  toggleAutoScan() 2413 startAutoScan() 2425 stopAutoScan()
2430  switchScreenerTab(mode)       스크리너 모드 전환
2439  fetchCandidatePool(mode)      후보 통합 fetch

# 하드컷 (조건 미달 즉시 제외)
2467  hardCut_momo(q, cfg)
2508  hardCut_swing(q)
2541  hardCut_core(q)

# 점수 계산
2565  score_momo(s)                 ★ MOMO 점수 (실시간 변동성)
2659  score_swing(s)                ★ SWING 점수 (구조+눌림)
3147  score_core(s)                 ★ CORE 점수 (베이스+RS+수급)

# 트랙 (성과 추적)
2731  loadTrack(mode) / 2736 saveTrackResults(mode, c) / 2803 checkTrackUpdates(mode)
2846  calcPerformanceStats(mode)    ★ 모드별 성과 통계
2922  showPerformanceStats()        ★ 디버그 대시보드
2972  simulateFilter(mode, fn, l)   필터 시뮬레이터
3006  compareSwingThresholds()      ★ A/B 테스트
3031  validateTVGate()              거래대금 게이트 검증

3213  runScreener(mode)             ★ 스크리너 메인
3467  predictSwingScore(s)
3501  checkBlockRisk(s, mode)
3546  renderScreenerResults(mode)   결과 카드 렌더
```

### [4] DART (3660–3940)

```
3660  fetchDart(apiPath, params)     기본 fetch
3672  saveDart() / 3770 updateDartStatus() / 3777 testDartConnection()
3688  fetchDartFinancials(code)      ★ 재무제표 → 매출/영업/순이익
3800  fetchDartCorpCode(code)        종목코드 → corp_code
3812  fetchDartDisclosures(code)     공시 목록
3848  classifyDartDisclosures(list)  팩트/모호/부정 분류
3865  loadDartFeed()                 공시 피드 화면
3911  toggleDartFilter(mode) / 3923 applyDartFilterAndRender(mode)
```

### [5] 데이터 통합 fetcher (3941–5430)

```
3941  fetchYahooData(ticker)         ★ Yahoo 1분봉 + 메타 (가격/갭/RVol)
4540  fetchSwingData(t, kisPrice)    ★ SWING 데이터 (KIS 우선, Yahoo 보조)
4823  _enrichSwingWithYahooBenchmark RS 보강
4850  _fetchSwingFromKis(t, kp, sw)  KIS 일봉 → swingData
4914  _computeCoreIndicatorsFromValid CORE 지표 계산 (down_vol/up_down 등)
5095  _computeCoreRSFromKospi(v, cd) KOSPI 대비 RS
5131  _computeCore8Conditions(cd)    8조건 체크
5174  _kisCandlesToValid(candles)    KIS → 표준 valid[]
5189  _fetchCoreFromKis(t, cd)       ★ CORE KIS 경로 (+ 섹터RS + 재무)
5325  _fetchCoreFromYahoo(t, cd)     CORE Yahoo 폴백
5361  fetchCoreData(ticker)          ★ CORE 데이터 진입점
```

### [6] AI 프롬프트 (5433–5934, 7768)

```
5433  makePrompt(mode, t, y, sw, oT, cd)  ★ 보유 관리용 프롬프트
7768  makeExplainPrompt(m, t, y, dec)     ★ 신규 진입 설명 프롬프트
```

### [7] 엔진 + 지원 함수 (5935–7367)

#### MOMO 지원
```
5935  calcMomoStop(entry, ydata, phase)  진입가 → 손절 계산
5982  getWhaleStage(r)                   ★ 7단계 세력 감지
6141  hardFilter(r, mode)                중복 필터
```

#### ★★★ 핵심 엔진 ★★★
```
6252  momoEngine(ydata)                  ★ MOMO 의사결정
6509  swingEngine(ydata, swingData)      ★ SWING 의사결정 (4레이어)
7367  coreEngine(ydata, coreData)        ★ CORE 의사결정 (수급+RS+구조+보조)
```

#### 엣지 테스트
```
7007  runSwingEdgeTests()           18개
7108  runTimeAwarenessTests()       7개
7145  runCoreEdgeTests()            13개 (모두 pass)
7348  runAllEngineTests()           통합
```

### [8] 분석 메인 흐름 (7796–8424)

```
7796  runModeScan(mode)              모드별 스캔 트리거
7835  resolveKoreanName(name, el)    한글명 → 코드 변환
7925  runSingleScan(m, t, ae, re)    ★★ 단일 종목 분석 (3엔진 동시 평가)
8425  saveToHistory(mode, card)
8454  renderHistory(mode)
8468  clearHistory(mode)
8479  applyHistory(r)                과거 분석 카드 다시 보기
```

### [9] 카드 시스템 (★ 2026-04-24 재설계)

#### 유틸
```
8498  calcEntryAction(r)             진입 액션 텍스트
8514  _calcEntryActionInner(r)
8696  calcSellTargets(r)             ★ T1/T2 (SWING은 엔진 값 신뢰)
8746  getPMZone(r)                   PM 구간 표시
8761  toggleCardDetail(id)
8781  renderDartDisclosures(r)
8816  buildMomoTags(r)               MOMO 태그
8879  buildDecisionPathHTML(r)
```

#### 모드별 카드 (★ 분리됨)
```
8922  momoCardHTML(r)                ★ MOMO 전용 + footer
9234  cardHTML(r, mode)              ★ 라우터 (3개 분기)
9250  _cardHoldBanner(r)             공통: 보유 배너
9270  _cardSignalLines(r, opts)      공통: signals/warnings/blockers
9282  _cardTimestamp(r)              공통: 타임스탬프
9294  _compatibilityFooter(m, cs, p) ★ 다른 엔진 적합성 footer
9375  swingCardHTML(r)               ★ SWING 전용 카드
9523  _swingLayersBlock(r)           4레이어 점수 + 결정 경로
9600  coreCardHTML(r)                ★ CORE 전용 + 섹터 RS + 밸류에이션
9774  _legacyCardHTML(r, mode)       ⚠ 정리 대상 (hold 폴백)
```

### [10] 보유 포지션 (10455–10970, 15612–15825)

```
10455 calcSwingExitSignals(r, sw, t) SWING 청산 신호
10528 holdCardHTML(r, mode, trade)   보유 카드 메인
10737 openTradeLog(ticker, price)    거래 기록 모달
10762 saveTradeLog(ticker)
10788 openPartialSell(tradeId)       부분 매도
10838 setPartialQty(tradeId, pct)
10863 confirmPartialSell(tradeId)
10898 markTradeClosed(tradeId)
10901 openPartialBuy(tradeId)        부분 매수
11005 rerunCard(ticker, mode)        보유 카드 재분석

# Telegram/Worker 동기화
15612 holdGetKey() / 15616 holdLoad() / 15620 holdRender()
15648 holdAdd()                      ★ 수동 등록
15675 holdFromAnalysis(ticker)       ★ 분석 카드에서 등록 (버그 수정 2026-04-24)
15732 holdDelete(i)
15745 holdShowStatus(msg, type)
15753 holdSync()                     ★ Worker POST → KV → 텔레그램
15778 holdTestTg()                   텔레그램 테스트
```

### [11] 알림 + 설정 (11015–11500)

```
11015 fireAlert(r, type) / 11029 toggleAlerts() / 11036 renderAlerts()
11050 updateBadge() / 11051 clearAlerts()
11056 testNtfy() / 11064 sendNtfy(ch, t, type, msg) / 11070 playBeep(s)
11087 save(k, v) / 11089 cycle(id, vals) / 11097 restoreSettings()
11111 renderUsage() / 11120 resetUsage()
11133–11468  거래 일지 (journal, edit, recalc)
11475 clearAllData()
11483 showToast(msg)
```

### [12] 스테일 배너 + 검색 (11502+, 15145+)

```
11502 checkStaleBanners(old, new)
11513 showStaleBanner(m, oP, nP, t)
11550 hideStaleBanner(mode)
11555 rescanStale(mode, ticker)

15105 _initMaster() / 15119 masterByCode(code) / 15125 searchMaster(q)
15145 onTickerInput(el, mode)
15154 doTickerSearch(inputId, q, mode)
15272 renderSearchDrop(inputId, mode, q)
15308 selectTicker(inputId, symbol, mode)
15315 hideSearchDrop(inputId)
```

### [13] 시장/매크로 (15347+)

```
15347 loadAllMarket()
15354 checkMarketRegime()           ★ 120일선 기준 시장 국면
15434 loadMacroData()
15475 loadKisSectors()              스크리너용 섹터 데이터
15543 loadKisFlow()
```

---

## 🔑 자주 찾는 함수 빠른 참조

| 작업 | 함수 |
|------|------|
| 종목 분석 시작 | `runSingleScan` (7925) |
| MOMO 의사결정 | `momoEngine` (6252) |
| SWING 의사결정 | `swingEngine` (6509) |
| CORE 의사결정 | `coreEngine` (7367) |
| SWING 데이터 fetch | `fetchSwingData` (4540) |
| CORE 데이터 fetch | `fetchCoreData` (5361) |
| AI 프롬프트 (신규) | `makeExplainPrompt` (7768) |
| AI 프롬프트 (보유) | `makePrompt` (5433) |
| MOMO 카드 | `momoCardHTML` (8922) |
| SWING 카드 | `swingCardHTML` (9375) |
| CORE 카드 | `coreCardHTML` (9600) |
| 호환성 footer | `_compatibilityFooter` (9294) |
| 보유 등록 | `holdFromAnalysis` (15675) |
| 보유 동기화 | `holdSync` (15753) |
| 섹터 매핑 빌드 | `buildSectorMap` (1766) |
| DART 재무 | `fetchDartFinancials` (3688) |

---

## 🛠 디버그 콘솔 명령

```javascript
// 엔진 테스트
runAllEngineTests()
runSwingEdgeTests()
runCoreEdgeTests()
runTimeAwarenessTests()

// 성과 통계
showPerformanceStats()
calcPerformanceStats('swing')
compareSwingThresholds()
validateTVGate()

// 섹터 매핑
await buildSectorMap()
await showSectorMap()
await rebuildSectorMap()
```

---

## 📌 작업 시 참고 사항

### 변경 자주 일어나는 핫스팟 (조심)
- `runSingleScan` (7925) — 데이터 fetch 흐름 변경 시
- `swingEngine` / `coreEngine` — 점수 가중치 조정 시
- 카드 함수들 — UI 변경 시 (회귀 가능성 높음)

### 수정 시 동시 확인 필요한 짝
- `swingEngine` 의 T1/T2 로직 ↔ `calcSellTargets` (불일치 시 UI/RR 깨짐)
- `holdFromAnalysis` ↔ `G.screenerResults` + `G.{mode}History` (둘 다 검색 필요)
- `_fetchCoreFromKis` 의 cd 필드 추가 ↔ `coreEngine` 에서 `r` 로 propagate ↔ `coreCardHTML` 에서 표시

### 정리 대상 (다음 세션 후보)
- `_legacyCardHTML` 600줄 → hold 만 처리하면 100줄로 축소 가능
- 인라인 스타일 → CSS 클래스 (점진적)
- SWING 엣지 테스트 환경 한계 (document.getElementById mock 필요)
