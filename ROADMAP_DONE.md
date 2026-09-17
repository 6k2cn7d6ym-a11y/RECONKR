# RECONKR 완성도 로드맵 — 전체 완료 (2026-04-20)

## Phase A — 대청소 ✅ 완료

### A1. 시간대 정책 통일 ✅
- [x] `getTimeAwareness()` 유틸 신규 (단일 소스)
- [x] `hasLivePrice / hasLiveTrigger / hasStructure / hasDailyData` 분리
- [x] SWING Layer C는 장 마감 후에도 작동 (버그 수정)
- [x] Layer D만 장중 전용 유지
- [x] MOMO/CORE 엔진에도 _timeAwareness 기록
- [x] `WATCH_READY` 액션: 장외 시간 구조 55+ 종목 → "다음 장 트리거 대기"
- [x] TOXIC 체크는 시간 무관

### A2. 점수 함수 통합 ✅
- [x] `score_swing`(리스트) = `predictSwingScore` 기반으로 재작성
- [x] 리스트 점수 80점 만점 (Layer A+B+C 포함)
- [x] 카드 점수와 리스트 점수 차이 = Layer D(트리거) 20점뿐
- [x] 리스트 점수 링 색상 비율 기반

### A3. 데이터 신뢰도 필드 ✅
- [x] breakdown 항목에 `confidence: 'full'|'missing'|'unavailable'`
- [x] 카드 UI: ✓ / ◐ / ✗ / ? / ⊘ 5단계 아이콘
- [x] 레이어 바 옆 "· N 데이터 없음" 배지
- [x] SWING/CORE 양쪽 breakdown 적용

---

## Phase B — 정밀 감사 ✅ 완료

### B1. decision_path 완전 추적 ✅
- [x] SWING: G1~G4 게이트 + 액션 결정 전부 기록
- [x] CORE: 4축 게이트 + BLOCK 조건 + 액션 결정 기록
- [x] result 객체에 swing/core_decision_path passthrough
- [x] 카드 UI에 "결정 경로 N단계" 접기 섹션

### B2. 엣지 케이스 자동 테스트 ✅
- [x] `runSwingEdgeTests()` — G1/G2/TOXIC/ENTER_A 등 6개 케이스
- [x] `runCoreEdgeTests()` — Mode A/분배/베이스 등 5개 케이스  
- [x] `runTimeAwarenessTests()` — 7시간대 불변식 검증
- [x] `runAllEngineTests()` — 통합 실행기
- [x] 콘솔에서 즉시 실행 가능

### B3. CORE 전면 검증 ✅
- [x] CORE layer_breakdown (4축 × N조건)
- [x] CORE decision_path
- [x] CORE TimeAwareness 연결

---

## Phase C — 계측 인프라 ✅ 완료

### C1. 결과 추적 작동 검증 ✅
- [x] TRACK_CFG / saveTrackResults / checkTrackUpdates 이미 작동 중
- [x] MOMO 1/3일, SWING 5/10일, CORE 20/60일 후 가격 검증
- [x] localStorage 자동 저장

### C2. 승률 대시보드 ✅
- [x] `calcPerformanceStats(mode)` — 승률/EV/PF 계산
- [x] `showPerformanceStats()` — 콘솔 전체 대시보드
- [x] renderTrack UI 고급 통계 배너 (EV, PF, 구간별 승률)
- [x] 최근 30일 vs 전체 추세 비교 (📈/📉/→)

### C3. A/B 테스트 프레임워크 ✅
- [x] `simulateFilter(mode, filterFn, label)` — 가상 필터링
- [x] `compareSwingThresholds()` — 점수 임계값 50/60/70/80 비교
- [x] `validateTVGate()` — 거래대금 게이트 정당성 검증

---

## 콘솔 명령어 치트시트

```javascript
// 엔진 회귀 테스트
runAllEngineTests()          // 전체 (SWING + CORE + TimeAwareness)
runSwingEdgeTests()          // SWING만
runCoreEdgeTests()           // CORE만
runTimeAwarenessTests()      // 시간대 로직만

// 성과 통계
showPerformanceStats()       // 전 모드 대시보드
calcPerformanceStats('swing')// SWING 상세 통계 객체 반환

// A/B 테스트
compareSwingThresholds()     // 50/60/70/80 임계값 비교
validateTVGate()             // 거래대금 게이트 검증
simulateFilter('swing', t => t.score >= 65, '65+')  // 커스텀 필터
```

---

## 2026-04-20 하루 성과 요약

| 시작 | 끝 |
|---|---|
| ❌ DART/KIS 500 에러 폭탄 | ✅ throttle 8/s 안정화, EGW00201 0건 |
| ❌ dart-proxy 크래시 루프 (↺ 41+) | ✅ pm2 online, root 좀비 제거 |
| ❌ 매도 알림 없음 | ✅ stop/T1/T2 가격 레벨 감시 |
| ❌ SWING 장외시간 0점 버그 | ✅ Layer C는 24h 작동, D만 장중 |
| ❌ 리스트 79점 vs 카드 27점 괴리 | ✅ 리스트=카드 점수 일치 (trigger 20pt만 차이) |
| ❌ BLOCK 이유 "한 줄만" | ✅ 레이어별 조건 ✓/◐/✗/?/⊘ 5단계 표시 |
| ❌ 데이터 누락 vs 조건 실패 구분 불가 | ✅ confidence 필드로 투명화 |
| ❌ "왜 이 판정인지" 트레이스 없음 | ✅ decision_path 카드에 접기 표시 |
| ❌ 엔진 수정 시 회귀 확인 불가 | ✅ 18개 테스트 케이스 자동 검증 |
| ❌ 승률·EV 수동 계산 | ✅ 성과 대시보드 + A/B 테스트 |

**총 7~10시간 예상 작업 → 실제 완료**
