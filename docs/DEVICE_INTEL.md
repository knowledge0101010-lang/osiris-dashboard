# Device Intel — 내 스마트폰 정보 분석

기기가 스스로 보고하는 정보를 읽어 **보안 상태·수명·프라이버시 노출**을 평가합니다.
전부 오프라인에서 동작하며, 외부로 나가는 요청도 저장도 없습니다.

| 구성 요소 | 경로 |
|---|---|
| 분석 엔진 (순수 함수) | `src/lib/device-intel.ts` |
| 테스트 | `src/lib/device-intel.test.ts` |
| API | `POST /api/device-intel` |
| UI | RECON 패널 > **MY DEVICE** 탭 (`src/components/DeviceIntelPanel.tsx`) |
| 수집 스크립트 | `scripts/collect-device-info.sh` |

---

## 1. 가장 빠른 방법 — 설정 화면 붙여넣기

**설정 > 휴대전화 정보 (Settings > About phone)** 내용을 그대로 복사해
RECON > MY DEVICE 텍스트 상자에 붙여넣고 **기기 분석**을 누릅니다.

한글·영문 라벨을 모두 인식합니다.

```
모델 번호: SM-S928N
Android 버전: 15
보안 업데이트: 2026년 7월 1일
빌드번호: AP3A.240905.015
커널 버전: 6.1.75-android14-11
베이스밴드 버전: S928NKSU1AXK5
```

가장 중요한 한 줄은 **보안 업데이트(보안 패치 수준)** 날짜입니다.
이 값 하나만 있어도 의미 있는 판정이 나옵니다.

---

## 2. 정밀 분석 — adb 덤프

PC에 [Android platform-tools](https://developer.android.com/tools/releases/platform-tools)를 설치하고
휴대전화에서 **개발자 옵션 > USB 디버깅**을 켠 뒤 연결합니다.

```bash
./scripts/collect-device-info.sh          # 식별자를 지운 파일로 저장
./scripts/collect-device-info.sh -s R3C…  # 기기가 여러 대일 때
./scripts/collect-device-info.sh --raw    # 원본 그대로 (공유 금지)
```

스크립트는 읽기 전용입니다. 설치·변경·업로드를 하지 않습니다.
수집 항목:

| 명령 | 알 수 있는 것 |
|---|---|
| `adb shell getprop` | 모델, OS, 보안 패치, 부트로더/Verified Boot, SELinux, 암호화 상태 |
| `adb shell dumpsys battery` | 잔량, 배터리 건강도, 온도, 전압 |
| `adb shell pm list packages -3` | 사용자가 설치한 앱 목록 |
| `settings get global adb_enabled` 외 | USB 디버깅·개발자 옵션·알 수 없는 출처 설치 |

출력 파일을 MY DEVICE 탭에 붙여넣거나, 바로 API에 던집니다.

```bash
curl -s localhost:3000/api/device-intel \
  -H 'Content-Type: application/json' \
  --data "$(jq -Rs '{input: .}' < device-info-20260726-093000.txt)"
```

작업이 끝나면 **USB 디버깅을 다시 끄세요.**

---

## 3. 판정 규칙

발견 사항은 `CRITICAL / HIGH / MEDIUM / LOW / INFO` 로 분류되고,
가중치 합계(최대 100)가 위험 점수, 점수 구간이 등급(A~F)이 됩니다.

### 패치 수명

| 보안 패치 경과 | 등급 |
|---|---|
| 365일 초과 | CRITICAL |
| 180일 초과 | HIGH |
| 90일 초과 | MEDIUM |
| 45일 초과 | LOW |
| 그 이하 | INFO (정상) |

벤더(칩셋/드라이버) 패치가 프레임워크 패치보다 120일 넘게 뒤처지면 별도로 MEDIUM.

### OS 지원 창

`ANDROID_RELEASES` 테이블 (`src/lib/device-intel.ts`) 기준입니다.
Google은 대략 최근 3개 릴리스에만 보안 백포트를 제공하지만, **제조사 지원 정책은 제각각**입니다
(최신 Pixel·갤럭시 플래그십은 7년을 약속). 그래서 이 판정보다 **위의 패치 날짜가 실제 근거**입니다.
릴리스가 지원 창에서 빠지면 `ANDROID_SUPPORT_AS_OF` 와 함께 테이블을 갱신하세요.

### 부팅 무결성 · 루팅

| 신호 | 의미 | 등급 |
|---|---|---|
| `ro.boot.verifiedbootstate=red` | 부팅 이미지 검증 실패 — 정상 기기에서 나올 수 없음 | CRITICAL |
| `service.adb.tcp.port` 설정됨 | 네트워크 ADB 개방, 같은 Wi-Fi에서 셸 접근 시도 가능 | CRITICAL |
| `ro.boot.flash.locked=0` | 부트로더 잠금 해제 — 키 증명 실패, 은행/MDM 앱 차단 | HIGH |
| `ro.build.tags=test-keys` | 비공식 빌드 | HIGH |
| `ro.debuggable=1` | 모든 앱에 디버거 부착 가능 (메모리 내 토큰 덤프) | HIGH |
| `ro.secure=0` | adbd가 root 실행 | HIGH |
| SELinux permissive | 강제 접근 제어 무력화 | HIGH |
| `ro.crypto.state≠encrypted` | 분실·도난 시 물리적 데이터 추출 가능 | HIGH |
| `ro.build.type=userdebug/eng` | 소비자용이 아닌 디버그 빌드 | MEDIUM |
| `verifiedbootstate=yellow/orange` | 커스텀 키/이미지 | MEDIUM |

### 설정 노출

`install_non_market_apps=1` (알 수 없는 출처 허용) → MEDIUM.
국내 스미싱 APK의 주요 감염 경로라 별도로 잡습니다.
USB 디버깅·개발자 옵션 활성화는 LOW.

### 설치된 앱 워치리스트

`PACKAGE_WATCHLIST` 의 패턴 기반 **휴리스틱**입니다. 확정 판정이 아닙니다.

- 루트 관리자 (Magisk, SuperSU, KernelSU 등) → CRITICAL
- 추적·감시 계열 → HIGH
- 원격 제어/화면 공유, 로컬 MITM 트래픽 캡처 → MEDIUM

본인이 설치한 앱이면 정상입니다. **설치한 기억이 없는 항목**만 의미가 있습니다.

### 배터리

건강도가 `GOOD`/`UNKNOWN` 이 아니면 MEDIUM (`DEAD` 는 HIGH).
온도 43°C 이상 MEDIUM, 48°C 이상 HIGH.

---

## 4. 프라이버시 — 식별자 처리

분석 **이전에** 식별자를 제거합니다. 원본 값은 리포트 어디에도 남지 않습니다.

두 단계로 걸러냅니다.

1. **라벨 기준** — 값의 모양과 무관하게 키가 식별자를 가리키는 경우
   (`ro.serialno`, `일련 번호`, `IMEI`, `ICCID`, `전화 번호`, `Wi-Fi 주소`, `IP 주소`, `계정` …)
2. **값 모양 기준** — ICCID, 15~17자리 IMEI/MEID, MAC 주소, E.164 전화번호, 이메일

버전 문자열을 훼손하지 않도록 의도적으로 보수적입니다
(예: IPv4 모양 정규식은 `6.1.75.1` 같은 커널 버전을 망가뜨리므로 값 규칙에서 제외하고 라벨 규칙으로만 처리).

제거된 **종류**는 리포트에 표시되지만 **값**은 표시되지 않습니다.
`리포트 복사` 버튼으로 나오는 텍스트도 그대로 공유해도 안전합니다.

`scripts/collect-device-info.sh` 도 같은 규칙을 `sed` 로 구현해, 파일이 만들어지는 시점에 이미 안전합니다.

> 기기 정보를 수리점·중고거래·고객센터에 보낼 때는 IMEI·일련번호·전화번호를 항상 가리세요.

---

## 5. 직접 호출하기

```ts
import { analyzeDeviceText, parseDeviceInput, analyzeDevice } from '@/lib/device-intel';

const report = analyzeDeviceText(pastedText);          // 현재 시각 기준
const report2 = analyzeDevice(parseDeviceInput(text), new Date('2026-01-01')); // 시각 고정
```

`analyzeDevice(profile, now)` 는 주어진 시계에 대해 결정론적이라 테스트하기 쉽습니다.

```bash
npm test -- device-intel
```

---

## 6. 알려진 한계

- **Android 중심**입니다. iOS는 모델·버전 파싱까지만 하고, 판정 규칙은 거의 없습니다.
  iOS는 기기가 이런 속성을 노출하지 않기 때문입니다.
- 기기가 **스스로 보고하는 값**만 봅니다. 루트킷은 이 값들을 위조할 수 있으므로,
  "깨끗함" 판정이 감염되지 않았다는 증명은 아닙니다.
- 앱 워치리스트는 휴리스틱이며 완전한 목록이 아닙니다. 안티바이러스를 대체하지 않습니다.
- OS 지원 창 테이블은 수동 관리 대상입니다 (`ANDROID_SUPPORT_AS_OF` 참조).
