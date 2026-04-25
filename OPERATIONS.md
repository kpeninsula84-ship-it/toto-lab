# TotoLab 주간 운영 매뉴얼

매 경기일 전날, 분석 실행(12:00 KST) 전에 부상 데이터를 수동 업데이트한다.

---

## 자동 실행 스케줄

```
매일 06:00 KST       자동: collectFixtures (다음 7일 경기 수집)
월~금 12:00 KST      자동: analyzeWeekday (다음 24시간 경기 분석)
토요일 12:00 KST     자동: analyzeSaturday (다음 48시간 경기 분석 — 토요일 저녁 + 일요일 전체)
매일 09:00 KST       자동: collectResults (종료 경기 결과 수집 + 통계 갱신)
```

---

## 타임라인 (경기 있는 날 기준)

```
전날 또는 당일 11:00 이전   부상 데이터 수동 업데이트 (이 매뉴얼)
당일 12:00 KST              자동: analyzeWeekday 또는 analyzeSaturday (부상 데이터 반영)
당일 오후 이후              사이트에 값 픽 표시
다음날 09:00 KST            자동: collectResults (결과 수집 + 통계 갱신)
```

⚠️ 11:00 이후에 부상 데이터를 올리면 당일 자동 분석에 반영되지 않는다.
그 경우 수동 재분석(`reanalyzeUpcomingManual`)을 따로 실행해야 한다.

---

## 주간 부상 데이터 업데이트

### 1. Claude Code 세션에서 부상 검색 요청

Claude에게 이렇게 요청한다:

> "EPL 20팀 부상/출전정지 정보 업데이트해줘. OPERATIONS.md 매뉴얼 따라."

Claude가 20팀 웹 검색 → `injuries-payload.json` 파일 생성 → `main` 브랜치에 커밋/푸시.

### 2. 푸시 후 자동 업로드 확인

`injuries-payload.json`이 변경되어 main에 푸시되면 CI/CD가 자동으로 Firestore에 업로드한다.
**별도 curl 명령 불필요.**

GitHub → Actions 탭에서 최신 워크플로우 실행 결과 확인:
- `Upload injuries to Firestore` step이 성공이면 완료
- 로그에 `"ok":true,"updated":20` 확인

### 3. 확인 (선택)

- Firebase 콘솔 → Firestore → `injuries` 컬렉션에 20개 문서 있는지 확인
- `updatedAt` 타임스탬프가 방금 시간인지 확인

### 4. 자동 분석 대기

12:00 KST에 `analyzeWeekday` 또는 `analyzeSaturday` 자동 실행 → 사이트에 값 픽 갱신됨.

---

## 수동 재분석 (선택)

부상 데이터를 12:00 이후에 올렸거나 즉시 재분석하고 싶을 때:

```powershell
curl.exe https://asia-northeast3-toto-lab.cloudfunctions.net/reanalyzeUpcomingManual
```

- 대상: 36시간 이내 `SCHEDULED`/`TIMED` 경기 전부 (이미 분석된 것도 덮어씀)
- 비용: 경기당 약 $0.12 (주말 10경기 = ~$1.2)

---

## 비용 예산

| 항목 | 빈도 | 회당 | 월간 |
|---|---|---|---|
| analyzeWeekday / analyzeSaturday | 경기 있는 날 | $0.10/경기 | ~$3~5 |
| 부상 업데이트 (수동) | 주 1회 | $0 (chat 웹검색 무료) | $0 |
| 총 | | | **~$5~8** |

$100 한도 → **12~20개월** 지속 가능.

---

## 트러블슈팅

### CI/CD injuries 업로드 실패
- GitHub Actions → 해당 워크플로우 → `Upload injuries to Firestore` step 로그 확인
- `updated: N` 이 20보다 적으면 팀 이름 매칭 실패 → Firestore `injuries` 컬렉션에서 `teamName` 확인
- 수동으로 업로드하려면:
  ```powershell
  curl.exe -X POST -H "Content-Type: application/json" --data "@injuries-payload.json" https://asia-northeast3-toto-lab.cloudfunctions.net/updateInjuriesBulk
  ```

### `updateInjuriesBulk` 401/403 에러
- football-data.org 토큰 만료 → Anthropic 콘솔에서 재발급 후 GitHub Secrets 업데이트 → 빈 커밋으로 재배포

### `updated: N` 이 20보다 적음
- 팀 이름 매칭 실패. Firestore `injuries` 컬렉션에서 `teamName` 필드 확인.
- football-data.org 공식 이름 예: "Arsenal FC", "Manchester United FC", "AFC Bournemouth" (앞에 붙는 경우도 있음)

### 12:00 분석이 안 돌아감
- Firebase 콘솔 → Functions → `analyzeWeekday` 또는 `analyzeSaturday` 로그 확인
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
