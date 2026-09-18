# RECONKR — Claude Code / 팀 세션 작업 가이드

한국 주식 스크리닝·트레이딩 PWA. 단일 HTML(`index.html`, ~15,467줄 · GitHub Pages 배포) + Cloudflare Worker(`worker.js`) + 모듈화된 엔진 파일들(루트 `*.js`).

이 문서는 **두 청중이 함께 본다:**
1. **Jim이 Claude Code로 직접 이 리포에서 코딩할 때** — 아래 규칙을 그대로 따른다.
2. **민온 디스패처 팀 세션이 이 프로젝트 방을 열 때** — 팀들이 현재 상태·아키텍처·규칙을 파악한다.

---

## 0. 가장 중요한 것 (어기면 작업 거부당함)

1. **결과물은 항상 완성된 `index.html` 하나로 준다.** JS 조각 파일, 패치 diff, "이 부분을 이렇게 바꾸세요" 식 설명만 주는 것 전부 금지. 대표님은 파일을 통째로 받아서 GitHub Pages에 배포한다. 부분 수정본이 오면 다시 작업해야 하므로 시간 낭비.
2. **문법 검증 없이 파일 주지 않는다.** 모든 변경 후 반드시 `<script>` 추출 → `node --check`로 문법 통과 확인하고, 통과한 것만 전달한다. (절차는 §6에)
3. **"문제없으면 바꾸지 마."** 요청한 것만 고친다. 시키지 않은 리팩토링, 변수명 정리, "겸사겸사" 개선, 인접 코드 스타일 통일 전부 금지. 잘 도는 코드를 임의로 건드리는 건 대표님이 가장 싫어하는 행동.
4. **추측으로 "고쳤다"고 하지 않는다.** 변경 후 실제로 grep/검증해서 적용됐는지 확인하고 말한다. 과거에 "고쳤다"고 했는데 실제 파일엔 반영 안 된 적이 있어 신뢰를 크게 잃었다. **항상 코드로 증명한다.**
5. **데이터를 절대 깨지 마.** 빈 데이터가 기존 데이터를 덮어쓰는 일이 생기면 안 된다. TRACK 저장·holdSync·거래일지 recalc 등 저장/동기화 로직은 극도로 보수적으로 다룬다. 빈 배열·undefined·404 응답이 정상 데이터를 밀어내는 경로가 하나라도 있으면 사고.
6. **점수 공식·엔진 임계값을 함부로 바꾸지 마.** TRACK v2 측정 중이라 기준이 바뀌면 데이터가 오염된다. 튜닝이 정말 필요하면 대표님께 옵션·트레이드오프 제시 후 결정 받는다.

---

## 1. 작업자(Jim) 프로필

- 한국 주식 단타/스윙 트레이더 + 1인 개발자. 유한회사 MINON 대표. **여성.**
- 실전 트레이더 관점에서 **신랄하게 비판**받기를 원한다. 좋은 말만 하면 화낸다.
- 제안에 결함이 있으면 **반박하라.** 동의만 하는 어시스턴트를 싫어함. 단, 반박은 근거와 함께.
- **결정은 직접 내리고 싶어함.** 설계 결정이 필요하면 옵션·트레이드오프 제시하고 **물어봄** — 멋대로 정하지 않는다.
- 주력 언어 JS(라이브 도구), 리서치/백테스트는 Python(pykrx, FinanceDataReader, pandas) 가능.
- 감정 없는 논리·빠른 반복. 장황한 토론보다 결정·실행.
- 총무 업무(한울회·한빛회 테니스 클럽 회계)도 병행 중 — 엑셀 회계 파일도 다룸.

---

## 2. 아키텍처

```
ReconKR/
├── *.js / universe.json      ★ 루트 = 실행·캐시·정본 (cron·봇·백테스트 전부 여기서)
│   ├── swingEval.js          백테스트·봇 공통 진입 평가 모듈
│   ├── bot-live.js           라이브 봇 (신호 JSON 생성)
│   ├── executor.js           paper 실행기 (orders/YYYYMMDD.json → 체결·ledger·halt · live stub)
│   ├── backtest-swing-kr.js  로컬 백테스트 (Node 전용 · node backtest-swing-kr.js --universe universe.json)
│   ├── portfolio-sim.js      포트폴리오 시뮬
│   ├── momoEngine.js / swingEngine.js / coreEngine.js / exitEngine.js
│   ├── indicatorEngine.js / engineUtil.js / kisData.js / sizeEngine.js
│   ├── engineTests.js / verifyEngines.node.js   회귀 테스트
│   ├── universe.json         219종목 유니버스 정본
│   └── data/                 KIS 캔들 캐시
│
├── index.html                앱 HTML (~15,467줄 · GitHub Pages 배포는 대표님 직접)
├── MODULES.md                함수 인덱스 (2026-04-24 기준, 라인 번호는 당시 기준)
├── worker.js                 (Cloudflare Worker · recon.miinonnnn.workers.dev)
│   ├── /reconkr/ai           Anthropic 프록시 (키는 env.ANTHROPIC_API_KEY)
│   │   └── /recon/claude     구버전 별칭 (동일 핸들러)
│   ├── /reconkr/track        TRACK 멀티디바이스 KV 동기화
│   ├── /reconkr/positions    보유 포지션 KV (머지 모델 · 2026-07 강화)
│   ├── /reconkr/journal      거래 일지 PC↔모바일 동기화 (★ 2026-07 신규)
│   ├── /kis/*                KIS 프록시 (dart.minon.kr Oracle VM 경유)
│   ├── /dart/*               DART 프록시 (throttle 8/s)
│   └── scheduled             포지션 감시 + 텔레그램 알림 (stop/T1/T2)
│
├── sandbox/                  팸(개발팀 사원) 실험 공간 (.gitignore · 결재 불요)
│
├── worklog/                  날짜별 워크로그 (worklog/YYYY-MM-DD.md)
│   └── README.md
│
└── ROADMAP_DONE.md           Phase A~C 완료 로그 (2026-04-20 기준)
```

### 핵심 설계 원칙 (합의됨 · 어기지 마)

- **엔진 = 부작용 없는 순수 함수.** `(입력 데이터) → (신호)`. DOM·fetch·전역 의존 없음. 라이브와 백테스트가 같은 코드로 돌아야 한다. (단, exitEngine은 trade.exitState 직접 변이 — 순수화 미완)
- **AI는 자문, 판정은 코드.** 진입(ENTER/WATCH/READY/BLOCK)도 청산(SELL_ALL/SELL_HALF/HOLD)도 전부 엔진이 정한다. Claude API는 뉴스·공시 **해설 전용**. API가 죽어도 카드는 엔진만으로 완성돼야 한다.
- **거래일 달력 = KIS 캔들 자체.** 공휴일 테이블 안 둔다. 최신 일봉 날짜가 진실.
- **점수 공식 변경 = 측정 데이터 오염.** 바꾸면 TRACK 통계가 시간대별로 의미가 달라진다. 꼭 바꿔야 하면 기존 데이터는 v1으로 격리하고 새로 쌓기 시작한다.
- **루트 = 유일한 코드·실행·배포 경로.** cron·봇·백테스트·배포 전부 루트에서. 날짜 폴더는 `git tag snap-YYMMDD`로 대체 (필요 시 `git archive` zip으로 리포 밖 보관).
- **모든 시크릿은 서버에.** KIS appkey/secret은 Oracle VM(dart-proxy) .env에만 보관 — 브라우저는 `'SERVER'` 표식만 갖는다 (★ 2026-07-08 이관 완료). Anthropic 키는 Worker 시크릿.

---

## 3. 신호 어휘 (절대 혼용 금지)

카드의 **1차 상태는 엔진 액션 하나뿐**이다:

| 액션 | 의미 | 색 |
|------|------|-----|
| ENTER | 진입 가능 | 녹색 |
| READY | 다음 장 대기 (구조 양호, 트리거만 미확인 — SWING 전용) | 시안/파랑 |
| WATCH | 관망 | 핑크 |
| BLOCK | 차단 | 빨강 |

- 보유 카드는 별도 체계: SELL_ALL / SELL_HALF / HOLD (`exitEngine` 출력).
- **GO/WAIT/AVOID 같은 "타이밍 신호"(`calcEntryAction`)는 ENTER 카드에서만** 보조로 표시. WATCH/BLOCK/READY에 타이밍 신호 띄우면 "진입가능인데 기다려" 모순 발생 — 과거 이걸로 크게 헷갈렸으니 부활 금지.
- 호환성 footer는 "참고 · 다른 전략 기준 (위 판정과 별개)"로 메인 점수와 명확히 분리.

---

## 4. exitEngine — 청산 우선순위 트리

`exitEngine(mode, trade, ctx)`. 첫 매치가 액션. **레벨은 `trade.exitState`에 1회 고정 저장**되고 매 스캔마다 새로 정하지 않는다.

| 순위 | 조건 | 액션 |
|------|------|------|
| P0 | 현재가 ≤ 손절선 | SELL_ALL (즉시 · 최우선) |
| P1 | 현재가 ≥ T2 | SELL_ALL (잔량 익절) |
| P2 | 현재가 ≥ T1 & 미실행 | SELL_HALF + 손절선→본전(BE) 자동 이동 |
| P3 | 구조 붕괴 | MOMO: ORB저점/VWAP이탈/엔진BLOCK · SWING: T1 후 MA5 **종가확정** 이탈 · CORE: 120일선 -2% |
| P4 | 트레일링 (T1 이후) | 고점 대비 MOMO -3% / SWING -7% / CORE -10% 이탈 → SELL_ALL |
| P5 | 시간 손절 | MOMO 2일 / SWING 14일 / CORE 56일 무수익 |
| P6 | — | HOLD (스테이지: 초기 → 본전스탑 → 트레일링) |

- **SWING MA 이탈은 종가 확정(KST 15:20+)에만 청산.** 장중엔 경고만. 휩쏘 방지 = 승률 보호.
- `EXIT_CFG`로 모드별 `stopPct/t1R/t2R/trailPct/timeDays` 조정 (`localStorage.exitCfg`).
- **런너(꼭지 안 찍고 계속 간 종목) 포함 필수.** 살린 saves만 세고 일찍 자른 cuts 안 세면 모든 런너 죽이는 룰이 나온다. 대표님이 반복 강조.
- **트레일링 스탑 컨벤션:** stop > entry 는 오류 아님 — 이익 확정 락. "규칙 위반" 지적 금지.

---

## 5. 데이터 흐름

### KIS (한국투자증권 시세·랭킹)

- 토큰: `getKisToken()` → 발급 후 6h 캐싱. 헤더는 `kisAuthHeaders(trId)`.
- 호출 경로: 브라우저 → Worker(`/kis/*`) → `dart.minon.kr` Oracle VM → KIS (Cloudflare IP 차단 우회).
- **★ KIS appkey/secret은 Oracle VM(dart-proxy) .env에만 보관. 브라우저 KIS 객체는 `appKey:'SERVER'`·`appSecret:'SERVER'` 표식만 갖는다. (2026-07-08 완료)**
- 대표적 함수: `fetchKisPrice` (시세+PER/PBR/시총), `fetchKisDailyChartLong` (일봉 260건), `fetchKisSectorDailyChart` (섹터 지수), `fetchKisInvestorHistory` (투자자 30일), `fetchKisCandidates(mode)` (모드별 후보 풀).

### DART (공시·재무)

- Worker 프록시 `/dart/*`, **throttle 8/s** (과거 크래시 루프 원인). 안정화됨.
- `fetchDartFinancials(code)` → 매출/영업/순이익, `fetchDartDisclosures(code)` → 공시 목록, `classifyDartDisclosures` → 팩트/모호/부정 분류.
- **★ DART API 키도 Oracle VM 서버 관리.** `G.dartApiKey = 'SERVER'` 표식으로 기존 게이트 통과.

### Yahoo (폴백)

- KIS가 못 주는 것만: 1분봉 프리마켓·세션 전체, 뉴스 헤드라인, 벤치마크 RS 보강.
- `fetchYahooData(ticker)`, `_enrichSwingWithYahooBenchmark`.

### TRACK v2 (성과 측정 → 튜닝 근거)

- **자동 저장**: `saveTrackResults` (리스트 오른 종목 · `scoreType:'list'`), `trackFromAnalysis` (엔진 ENTER/WATCH/READY · `scoreType:'engine'`). BLOCK·보유 제외. 24h 내 동일 종목 중복 제외.
- **사후 검증**: `verifyTrack(mode)` — MOMO 1·3일 / SWING 5·10일 / CORE 20·60일 후 종가를 KIS 일봉으로 조회. **KIS 연결 필수.** 오늘 봉은 KST 15:35 이후에만 확정.
- **경로 지표**: MAE(최대 역행 → 스탑폭 적정성), MFE(최대 순행 → T1 목표 설계 근거), 스탑 터치 여부/일자.
- **성과 통계** `calcPerformanceStats(mode)`: 비용 차감 EV(왕복 0.20% 기본), 승률, Profit Factor, 지수(0001/1001) 대비 α, 스탑 규율 반영 EV(`stopAdj`), 경로 분포(`pathStats`), scoreType별 분리(`byType`), 점수 구간별 승률(n<10 lowConf 회색).
- **동기화**: `trackSync` → Worker KV push, `trackPullAndMerge` → 앱 시작 시 + 5분마다 pull+merge. **status 진행도 낮은 기기가 검증 결과 덮어쓰지 않음** (`trackMerge` 규칙).
- 튜닝 원칙: 초기 소표본(n<수십)으로 엔진 만지지 말 것. 배포 직후 검증 건수 0부터 다시 쌓이는 것 정상.

### 거래 일지 동기화 (★ 2026-07 신규)

- `pushJournal(mode)` / `pullJournal(mode)` → Worker `/reconkr/journal` (POST/GET).
- saveJournal() 호출 시 800ms 디바운스 후 자동 push. 앱 시작 시 pull.
- id별 머지 + tombstone(deleted/deletedAt) 모델 — 삭제도 멀티디바이스 동기화됨.

---

## 6. 코드 컨벤션

- **ES5 스타일 유지.** `var`, `function(){}`, 문자열 연결(`'a'+b`). 화살표 함수·템플릿 리터럴·`const/let`을 기존 코드에 새로 섞지 않는다 (단일 파일 일관성).
- **통화는 원(₩).** `'₩'+Math.round(v).toLocaleString()`. 달러($) 표기 절대 금지 (RECON US 복붙 잔재).
- **날짜 파싱은 반드시 `parseTradeDate()` 사용.** 저장 형식이 `toLocaleDateString('ko-KR')` = `"2026. 6. 12."`라 iOS Safari에서 `new Date()`가 "did not match the expected pattern" 예외 던짐. `new Date(trade.date)` 직접 쓰지 말 것.
- **innerHTML XSS 주의.** 사용자/외부 데이터 삽입 시 이스케이프.
- 라벨·UI 텍스트는 한국어. 대표님 존칭 사용.

---

## 7. 변경 후 필수 검증 절차

```bash
# 1. <script> 추출 → node 문법 검사
python3 -c "
import re
html=open('index.html',encoding='utf-8').read()
scripts=re.findall(r'<script[^>]*>(.*?)</script>',html,re.DOTALL)
js='\n'.join(s for s in scripts if s.strip() and 'src=' not in s[:80])
open('/tmp/chk.js','w',encoding='utf-8').write(js)
"
node --check /tmp/chk.js   # 반드시 통과

# 2. 변경이 실제 반영됐는지 grep으로 증명 (추측 금지)
grep -n "방금_추가한_고유문자열" index.html

# 3. 로직 변경이면 격리 단위 테스트 (Node로 함수만 떼서 시나리오 검증)
node verifyEngines.node.js

# 4. SWING 백테스트 (엔진 변경 시) — 루트에서 실행
node backtest-swing-kr.js --universe universe.json
```

엔진/청산/측정처럼 로직이 걸린 변경은 **반드시 단위 테스트로 시나리오 돌려보고** 통과한 것만 전달. 예: exitEngine은 P0~P6 + BE 이동 + 트레일링 + 중복 발동 방지 케이스 검증.

**콘솔 회귀 테스트:**

```javascript
runAllEngineTests()          // SWING 18 + CORE 13 + TimeAwareness 7
runSwingEdgeTests() / runCoreEdgeTests() / runTimeAwarenessTests()
showPerformanceStats()       // TRACK 대시보드
compareSwingThresholds()     // 50/60/70/80 임계값 A/B
validateTVGate()             // 거래대금 게이트 정당성
```

---

## 8. 배포

- `index.html` → **GitHub Pages**. `main` 브랜치 push 즉시 반영. 빌드 없음. 반영까지 1~3분.
- `worker.js` → **Cloudflare Worker** (`recon.miinonnnn.workers.dev`). `wrangler deploy` 또는 대시보드. 시크릿 등록됨(`ANTHROPIC_API_KEY`).
- 배포 후 흰 화면 = 거의 항상 **PWA 캐시** 또는 GitHub Pages 반영 지연. Cmd+Shift+R 강제 새로고침 안내.
- **워커 변경 없으면 "워커 변경 없음"이라고 명시**해서 불필요한 배포 막는다.

### 브랜치 운영 규칙 (★ 2026-09-18 확립)

- **push = 즉시 배포.** `main`에 push하는 순간 GitHub Pages가 반영된다.
- **팀(Claude Code 세션) 작업은 `dev` 브랜치에서만.** `git push origin dev`. `main` 직접 push 금지 — GitHub 브랜치 보호로 차단(대표가 Settings에서 설정).
- **`main` 머지는 대표 승인 후.** 대표가 GitHub에서 PR 머지 또는 직접 push.
- **`archive/*` 브랜치는 읽기 전용 이력.** `archive/pre-260918` 등 과거 스냅샷. `main`·`dev`에서 직접 머지 금지. 참조만 가능.

### 페이퍼 트레이딩 워크트리 (★ 2026-09-18 확립)

- **런타임과 개발 트리 분리.** `git worktree add ../reconkr-paper main` — cron·pm2는 `../reconkr-paper`에서만 실행. 개발은 기존 폴더(dev 브랜치).
- **`../reconkr-paper` 는 런타임 전용. 수정·실행 금지(cron 제외).** 10영업일 페이퍼 종료 후 `git worktree remove ../reconkr-paper`로 삭제.
- **data/·positions/·ledger는 reconkr-paper 폴더 것이 정본.** 개발 폴더의 같은 파일과 혼동 금지.

### 페이퍼 개시 체크리스트

1. `git worktree add ../reconkr-paper main` 실행 확인
2. `../reconkr-paper/positions.json` → 빈 배열 `[]`
3. `../reconkr-paper/ops/status.json` → `{"status":"active","peakEquity":1000000}`
4. `../reconkr-paper/ledger.csv` → 헤더만 (`일자,자본,현금,보유평가,실현손익`)
5. pm2 cron 경로를 `../reconkr-paper`로 변경 확인
6. 합성 테스트 잔재(positions.json에 closed 포지션 등) 없는지 확인
7. 첫 영업일 15:40 bot-live 실행 후 signals 파일 대표께 첨부 — 첫날 신호로 파이프라인 정합 확인

---

## 9. 현재 상태 (2026-09-17 기준)

### ✅ 완료 (Phase A~C · 재작업 금지)

- **Phase A 대청소** — 시간대 정책 통일(`getTimeAwareness`), 점수 함수 통합(리스트=카드, 트리거 20pt만 차이), 데이터 신뢰도 필드(`confidence` 5단계 아이콘).
- **Phase B 정밀 감사** — `decision_path` 완전 추적(SWING G1~G4 · CORE 4축), 엣지 케이스 자동 테스트 18+13+7, CORE 4축 게이트 전면 검증.
- **Phase C 계측 인프라** — TRACK v2 작동, `calcPerformanceStats` 대시보드(EV/PF/α/구간별 승률/최근 30일 vs 전체), A/B 프레임워크(`simulateFilter`, `compareSwingThresholds`, `validateTVGate`).
- **청산 엔진(`exitEngine`)** — P0~P6 우선순위 트리, BE 이동, 트레일링, 시간 손절, `EXIT_CFG` 튜닝.
- **카드 재설계** — MOMO/SWING/CORE 분리, `_legacyCardHTML` 671줄 → 100줄, 호환성 footer 3엔진 동시 평가.
- **DART/KIS 안정화** — throttle 8/s, EGW00201 0건.
- **매도 알림** — stop/T1/T2 가격 레벨 감시 + 텔레그램.
- **섹터 매핑 동적 빌드** — `buildSectorMap` 24h 캐시.
- **iOS 날짜 파싱** — `parseTradeDate` 통일.
- **Anthropic 키 Worker 이관.**
- **★ KIS appkey/secret Worker 이관 완료 (2026-07-08)** — 브라우저는 `'SERVER'` 표식만 보유. Oracle VM(dart-proxy) .env에서 실키 주입. XSS 유출 위험 제거.
- **★ DART API 키 서버 이관 완료 (2026-07-08)** — `G.dartApiKey = 'SERVER'` 표식.
- **★ 거래 일지 멀티디바이스 동기화 (2026-07-08)** — `pushJournal`/`pullJournal` + Worker `/reconkr/journal`. id별 머지 + tombstone.
- **★ 보유 포지션 머지 모델 강화 (2026-07-08)** — `/reconkr/positions` 덮어쓰기 → 머지. 유령 감시 강제 제거(`clear:true`) 지원.
- **표시 버그 7건** — CORE 음수RR / T2<T1 / 장외ENTER / $표기 / MA200라벨 / NXT배지 / PRE오표시.
- **엔진 모듈 분리** (루트 `*.js`) — momoEngine·swingEngine·coreEngine·exitEngine·indicatorEngine·engineUtil·kisData 파일로 추출, `engineTests.js` + `verifyEngines.node.js`로 회귀.
- **백테스트 인프라** — 루트 `backtest-swing-kr.js` Node 실행 가능. `node backtest-swing-kr.js --universe universe.json`으로 219종목 또는 지정 종목 시뮬.
- **executor.js (paper 모드)** — orders/YYYYMMDD.json 일별 집행, ledger/fills/positions 관리, halt(-10% drawdown) + 킬스위치(ops/killswitch), 텔레그램 alert. 343줄. 자연 halt 재현 검증 완료 (002070 20260731 시가 -50% · drawdown -16.19% · Worker POST HTTP 200).

### ⏳ 진행 중 / 부분

- **엔진 모듈화 완료** — 루트 `*.js`가 실행 정본. 앱 HTML(`index.html`)과 모듈 간 sync 유지 필요. 앱 HTML을 완전히 모듈 기반으로 전환할 시점은 대표님 결정 대기.
- **로컬 백테스트 파이프라인** — `backtest-swing-kr.js` 실행 가능하나 리포트 형식·자동화 다듬는 중.
- **셀엔진 백테스트(Python) 미완** — KOSPI200+유동성 코스닥 10~15년 일봉으로 포물선/추세 에피소드 추출 → 후보 룰 forward 시뮬 → 분포 측정(포착%/반납%/조기청산%) · walk-forward 검증.
- **투자팀 파이프라인 연동** (minon-dispatcher 쪽) — RECONKR 신호를 팀 방에서 참조하는 흐름 설계.

### 🔴 알려진 이슈 (우선순위 순)

1. **`exitEngine` 순수함수화 미완** — 현재 `trade.exitState` 직접 변이 + `persistExitState()` 저널 저장 호출(순수 함수 아님). 백테스트·테스트 통과 후 결정/실행 분리 예정.
2. **PRE(동시호가) 점수가 예상체결가 기반** — 허수호가에 취약.
3. **상한가 호가단위 폴백 근사** — KIS `stck_mxpr` 있으면 정확, 폴백 경로는 추산.
4. **innerHTML 69곳 무이스케이프** — KIS 키 이관으로 치명도 낮아짐. 여전히 XSS 잠재 위험은 있으나 우선순위 하향.
5. **MODULES.md 라인 번호 구식** — 2026-04-24 기준이라 현재 15,467줄 index.html과 번호 불일치. 참고용으로만 쓸 것.

### 이미 닫힌 것 (재작업 금지)

측정 시스템(TRACK v2), Anthropic 키 보안, KIS appkey/secret 보안, DART API 키 보안, 신호 어휘 통일, 장중 미완성 봉 오염, 공휴일 판별, KOSPI 시장 게이트 KIS 전환, 청산 엔진(exitEngine), iOS 날짜 파싱, 표시 버그 7건, 거래 일지 멀티디바이스 동기화.

---

## 10. 주요 함수 위치 (참고 · 상세는 루트 `MODULES.md`)

> MODULES.md는 2026-04-24 기준. 현재 index.html과 라인 번호 차이 있음. grep으로 실제 위치 확인 권장.

| 함수 | 대략 라인 | 역할 |
|------|------|------|
| `momoEngine` | ~6252 | MOMO 진입 판정 |
| `swingEngine` | ~6509 | SWING 진입 판정 (4레이어) |
| `coreEngine` | ~7367 | CORE 진입 판정 (수급+RS+구조) |
| `exitEngine` / `EXIT_CFG` | — | 청산 판정 + 설정 |
| `runSingleScan` | ~7925 | 단일 종목 분석 메인 (3엔진 동시) |
| `getTimeAwareness` | ~1230 | 시간대 → hasLivePrice/hasLiveTrigger |
| `calcDailyStats` | ~2064 | 일봉 지표 (미완성 봉 제거 내장) |
| `checkMarketRegime` | ~15347 | 시장 게이트 (KIS 우선, 공휴일) |
| `fetchKisPrice` / `fetchKisDailyChartLong` | ~1408 / ~1689 | KIS 시세·일봉 |
| `fetchSwingData` / `fetchCoreData` | ~4540 / ~5361 | SWING/CORE 데이터 통합 |
| `saveTrackResults` / `verifyTrack` / `calcPerformanceStats` | ~2736 / ~2803 / ~2846 | TRACK v2 |
| `pushJournal` / `pullJournal` | ~1099 / ~1114 | 거래 일지 동기화 (★ 신규) |
| `syncJournalWatch` | ~1033 | 저널 → 텔레그램 감시 투영 |
| `momoCardHTML` / `swingCardHTML` / `coreCardHTML` | ~8922 / ~9375 / ~9600 | 카드 렌더 |
| `holdCardHTML` / `holdFromAnalysis` / `holdSync` | ~10528 / ~15675 / ~15753 | 보유 포지션 |
| `parseTradeDate` | — | 안전 날짜 파서 (필수) |
| `buildSectorMap` | ~1766 | 섹터 매핑 동적 빌드 |
| `fetchDartFinancials` | ~3688 | DART 재무 |

상수: `WORKER_URL`(`recon.miinonnnn.workers.dev`), `KIS_URL`(`dart.minon.kr`, Oracle VM 경유).

---

## 11. 협업 톤

- 한국어로 대화. 간결하게. 대표님 존칭.
- 비판은 직설적으로, 근거와 함께. 빈말·과한 칭찬 금지.
- 모르면 추측하지 말고 코드를 직접 열어 확인한 뒤 답한다.
- "이거 고쳤어"는 grep으로 증명한 뒤에만 말한다.
- 결정이 필요하면 옵션·트레이드오프 제시하고 물어본다 — 멋대로 결정 금지.
- **되돌릴 수 없는 작업 앞에서 대표 답이 짧으면("허가"·"OK"·"고") 어느 옵션인지 반드시 재확인한다.** 짧은 답 = 확인 트리거. 재확인 없이 진행 금지.
- 긴 편집 중에도 단계마다 짧게 진행 신호 흘린다 (툴콜만 굴리면 화면에 아무것도 안 뜬 것처럼 보임).
