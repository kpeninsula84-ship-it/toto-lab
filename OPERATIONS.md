# TotoLab 주간 운영 매뉴얼

매주 토요일(경기 전)에 부상 데이터를 수동 업데이트한다.

---

## 타임라인

```
토요일 16:00~17:00 KST   부상 데이터 수동 업데이트 (이 매뉴얼)
토요일 18:00 KST         자동: analyzeDaily 실행 (부상 데이터 반영)
토요일 저녁 이후         사이트에 값 픽 표시
일요일 09:00 KST         자동: collectResults 실행 (결과 수집 + 통계 갱신)
```

---

## 주간 부상 데이터 업데이트

### 1. Claude Code 세션에서 부상 검색 요청

Claude에게 이렇게 요청한다:

> "EPL 20팀 부상/출전정지 정보 업데이트해줘. OPERATIONS.md 매뉴얼 따라."

Claude가 20팀 웹 검색 → `injuries-payload.json` 파일 생성 → `main` 브랜치에 커밋/푸시.

### 2. 로컬에 최신 코드 가져오기

```powershell
git pull origin main
```

### 3. Firestore에 업로드

```powershell
curl.exe -X POST -H "Content-Type: application/json" --data "@injuries-payload.json" https://asia-northeast3-toto-lab.cloudfunctions.net/updateInjuriesBulk
```

**기대 응답**:
```json
{"ok":true,"updated":20,"results":[...]}
```

모든 팀이 `updated` 카운트에 포함되어야 한다. 20 미만이면 팀 이름 매칭 실패 가능 (football-data.org 공식 이름과 다름).

### 4. 확인

- Firebase 콘솔 → Firestore → `injuries` 컬렉션에 20개 문서 있는지 확인
- `updatedAt` 타임스탬프가 방금 시간인지 확인

### 5. 자동 분석 대기

18:00 KST에 `analyzeDaily` 자동 실행 → 사이트에 값 픽 갱신됨.

---

## 수동 재분석 (선택)

부상 데이터 업데이트 후 즉시 재분석하고 싶을 때:

```powershell
curl.exe https://asia-northeast3-toto-lab.cloudfunctions.net/reanalyzeUpcomingManual
```

- 대상: 36시간 이내 `SCHEDULED`/`TIMED` 경기 전부 (이미 분석된 것도 덮어씀)
- 비용: 경기당 약 $0.12 (주말 10경기 = ~$1.2)

---

## 비용 예산

| 항목 | 빈도 | 회당 | 월간 |
|---|---|---|---|
| analyzeDaily | 경기 있는 날 | $0.10/경기 | ~$3~5 |
| 부상 업데이트 (수동) | 주 1회 | $0 (chat 웹검색 무료) | $0 |
| 총 | | | **~$5~8** |

$100 한도 → **12~20개월** 지속 가능.

---

## 트러블슈팅

### `updateInjuriesBulk` 401/403 에러
- football-data.org 토큰 만료 → Anthropic 콘솔에서 재발급 후 GitHub Secrets 업데이트 → 빈 커밋으로 재배포

### `updated: N` 이 20보다 적음
- 팀 이름 매칭 실패. Firestore `injuries` 컬렉션에서 `teamName` 필드 확인.
- football-data.org 공식 이름 예: "Arsenal FC", "Manchester United FC", "AFC Bournemouth" (앞에 붙는 경우도 있음)

### 18:00 분석이 안 돌아감
- Firebase 콘솔 → Functions → `analyzeDaily` 로그 확인
- 스케줄러 상태: Cloud Scheduler 콘솔

### 배포 실패 (CI)
- GitHub Actions 로그 확인
- `FIREBASE_TOKEN` / `ANTHROPIC_API_KEY` / `FOOTBALL_DATA_TOKEN` / `ODDS_API_KEY` 시크릿 확인

---

## 주요 엔드포인트

| URL | 용도 |
|---|---|
| `/updateInjuriesBulk` (POST) | 부상 JSON 수동 업로드 |
| `/reanalyzeUpcomingManual` | 36시간 내 경기 강제 재분석 |
| `/analyzeManual?fixtureId=X` | 특정 경기 수동 분석 |
| `/collectResultsManual` | 종료된 경기 결과 수집 + 통계 갱신 |

베이스 URL: `https://asia-northeast3-toto-lab.cloudfunctions.net`

---

## 시즌 종료 시

시즌 마지막 라운드 이후:
- `matches` 컬렉션 그대로 유지 (과거 데이터 아카이브)
- 새 시즌 시작 전에 `collectFixtures`가 새 일정 가져옴
- `injuries` 컬렉션은 덮어쓰기 되므로 별도 초기화 불필요
