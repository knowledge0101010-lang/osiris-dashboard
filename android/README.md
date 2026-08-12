# Claude Code on Android

안드로이드 기기(Termux)에서 Claude Code를 돌리고, 워크스테이션에서 그 기기에
접속할 수 있게 하는 CLI 묶음.

| 파일 | 어디서 실행 | 역할 |
| --- | --- | --- |
| `termux-setup.sh` | **기기 안 (Termux)** | 런타임 부트스트랩, Claude Code 설치, sshd 옵션 |
| `claude-android` | **기기 안 (Termux)** | tmux + wake lock으로 감싼 Claude Code 런처 |
| `bridge.sh` | **워크스테이션** | adb/ssh로 기기에 접속·포워딩·파일 동기화 |

---

## 왜 래퍼가 필요한가

노트북에서는 필요 없는데 폰에서는 필요한 것들이 있다.

| 안드로이드 제약 | 대응 |
| --- | --- |
| 화면이 꺼지면 OS가 백그라운드 프로세스를 죽인다 | `termux-wake-lock` |
| 앱을 스와이프해서 닫으면 세션이 사라진다 | tmux 세션에 넣고 detach/attach |
| 터미널 폭이 좁아 diff·표가 깨진다 | 60컬럼 미만이면 경고하고 대처법 안내 |
| Termux 홈은 앱 전용 디렉터리라 다른 파일이 안 보인다 | `termux-setup-storage`로 공유 저장소 링크 |
| 물리 키보드가 없다 | Vol-Down = Ctrl 등 키 매핑 안내 |

`claude-android`는 이걸 한 번에 처리하는 얇은 래퍼일 뿐이다. 내부적으로는 그냥
`claude`를 부른다.

---

## 1. 기기 쪽 설치

Termux를 **F-Droid**에서 설치한다. Play 스토어 빌드는 유지보수가 중단되어
패키지 설치가 깨진다.

> https://f-droid.org/packages/com.termux/

Termux를 열고:

```bash
pkg install -y git
git clone <이 레포 URL> ~/osiris
cd ~/osiris
bash android/termux-setup.sh
```

스크립트가 하는 일:

**묻지 않고 바로 진행** — 설치만 하고 기기 밖으로 아무것도 열지 않는다.

1. `nodejs-lts git tmux openssh termux-api ripgrep` 설치
2. `npm install -g @anthropic-ai/claude-code`
3. `claude-android` 래퍼를 `$PREFIX/bin`에 설치

**물어본 뒤에만 진행** — 기기에 닿는 범위를 넓히는 것들.

4. 공유 저장소 접근 권한 (안드로이드 시스템 다이얼로그가 따로 뜬다)
5. wake lock 획득
6. sshd 활성화 (아래 "기기 접속" 참조 — 공개키가 없으면 시작하지 않는다)

설치 후:

```bash
claude          # 최초 1회 로그인
claude-android  # 세션 시작
```

---

## 2. 기기에서 쓰기

```bash
claude-android            # 시작하거나 기존 세션에 attach
claude-android attach     # 실행 중인 세션에 attach
claude-android new        # 기존 세션 죽이고 새로 시작
claude-android stop       # 세션 종료 + wake lock 해제
claude-android status     # 세션 / wake lock / sshd 상태
claude-android doctor     # 설치 진단
claude-android -- --model opus   # claude에 인자 그대로 전달
```

**Ctrl-B 다음 D** 를 누르면 세션을 죽이지 않고 빠져나온다. Termux를 닫아도
세션은 살아 있고, 다시 열어서 `claude-android attach` 하면 이어진다.

### 작은 화면 요령

| | |
| --- | --- |
| Ctrl 키 | Vol-Down + 문자 (Vol-Down + C = Ctrl-C) |
| 붙여넣기 | 터미널 롱프레스 → Paste |
| 글꼴 축소 | Vol-Up + `-` (컬럼 수가 늘어난다) |
| 가로 모드 | diff 볼 때는 사실상 필수 |
| tmux 접두 | Ctrl-B |

---

## 3. 기기 접속 — 워크스테이션에서

폰 화면 키보드로 오래 작업하는 건 고통스럽다. `bridge.sh`는 워크스테이션에서
기기의 Termux 셸에 붙게 해준다.

### 동의 모델 — 우회할 수 없고, 우회하지 않는다

접속은 **매번 기기에서 사람이 직접 허용해야** 성립한다.

1. **개발자 옵션 활성화** — 설정 > 휴대전화 정보 > 빌드 번호 7회 탭
2. **USB 디버깅** 또는 **무선 디버깅** 켜기 — 설정 > 시스템 > 개발자 옵션
3. USB 연결 시 **"USB 디버깅을 허용하시겠습니까?"** 다이얼로그 수락
4. 무선 연결 시 기기 화면에 뜨는 **6자리 페어링 코드**를 읽어서 입력

`bridge.sh`는 이 중 어느 것도 자동화하지 않는다. 자동화할 수 없고, 그게 맞다.
스크립트는 자격증명을 저장하지 않으며, `.local/`에 마지막 접속 주소만 남긴다
(gitignore 됨).

### USB 연결

```bash
# 케이블 연결 후
./android/bridge.sh devices     # 인식 확인
./android/bridge.sh ssh         # 포워딩 + 셸 접속
```

### 무선 연결 (Android 11+)

기기: 설정 > 개발자 옵션 > 무선 디버깅 > **"페어링 코드로 기기 페어링"**

```bash
./android/bridge.sh pair 192.168.1.5:41234   # 페어링 화면의 IP:PORT
# → 기기 화면의 6자리 코드 입력

./android/bridge.sh connect 192.168.1.5:5555 # 무선 디버깅 화면의 IP:PORT (다른 포트!)
./android/bridge.sh ssh
```

> 페어링 포트와 디버깅 포트는 **다르다.** 가장 흔한 실수다.

### 파일 동기화

```bash
./android/bridge.sh push . /sdcard/osiris    # 워크스테이션 → 기기
./android/bridge.sh pull /sdcard/osiris/out .   # 기기 → 워크스테이션
```

`push`는 덮어쓰기 전에 확인을 받는다. Termux 홈(`/data/data/com.termux/...`)은
adb가 직접 쓸 수 없는 경우가 많으니, `/sdcard/`로 밀어 넣고 기기에서
`mv`로 옮기는 게 확실하다.

### 정리

```bash
./android/bridge.sh status      # 기기 / 포워딩 / 기기측 설치 상태
./android/bridge.sh disconnect  # 포워딩 제거 + 무선 연결 해제
```

---

## 4. 보안 메모

이건 **본인 기기**를 본인이 쓰는 도구다. 그 전제가 깨지면 안 된다.

- **sshd는 기본 비활성.** `termux-setup.sh`가 명시적으로 물어본 뒤에만 켠다.
- **공개키가 없으면 sshd를 시작하지 않는다.** 비밀번호 인증이 꺼져 있으므로
  키가 유일한 진입 수단이고, 키가 없으면 켜 봐야 아무도 못 들어간다.
- **강제되는 설정.** Termux sshd의 기본값은 모든 인터페이스에 바인딩하고
  비밀번호 인증을 허용한다. 이 문서가 말하는 접근 모델과 어긋나므로,
  스크립트가 `$PREFIX/etc/ssh/sshd_config.d/claude-android.conf`에 명시적으로 고정한다:

  ```text
  ListenAddress 127.0.0.1        # 루프백만 — Wi-Fi에서 안 보인다
  ListenAddress ::1
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  PermitEmptyPasswords no
  PubkeyAuthentication yes
  ```

  설치 직후 `sshd -T`로 실제 적용값을 출력하므로 눈으로 확인할 수 있다.
- **8022는 루프백 전용이다.** `adb forward tcp:8022 tcp:8022` 없이는 외부에서 못 닿는다.
  그래도 공용 Wi-Fi에서 무선 디버깅을 켜 두지 마라 — sshd와 별개로 adb 자체가
  같은 네트워크에 노출된다.
- **작업이 끝나면 끄기:**
  ```bash
  ./android/bridge.sh disconnect   # 워크스테이션
  pkill sshd; termux-wake-unlock   # 기기
  ```
  그리고 개발자 옵션에서 무선 디버깅을 다시 끈다.
- **`android/.local/`은 gitignore 되어 있다.** 기기 주소가 커밋되지 않는다.

---

## 5. 문제 해결

| 증상 | 원인 / 대응 |
| --- | --- |
| `claude: command not found` | `bash android/termux-setup.sh` 재실행. `claude-android doctor`로 진단 |
| `pkg install` 실패 | Play 스토어 Termux를 쓰고 있을 가능성. F-Droid 빌드로 재설치 |
| 화면 끄면 세션이 죽음 | wake lock 미획득. `termux-wake-lock` 또는 `claude-android` 재시작 |
| `no authorised device` | USB 디버깅 미활성 또는 기기 다이얼로그 미수락 |
| `adb connect` 실패 | 페어링 포트로 connect 시도한 경우. 무선 디버깅 화면의 포트를 쓸 것 |
| ssh 접속 거부 | 기기에서 `sshd` 미실행. Termux에서 `sshd` 입력 |
| diff가 다 깨져 보임 | 터미널이 좁음. 가로 모드 + 글꼴 축소 |
| 긴 작업 중 앱이 죽음 | 안드로이드 배터리 최적화. 설정에서 Termux를 최적화 예외로 |

---

## 관련 문서

- [`docs/anthropic-academy/`](../docs/anthropic-academy/) — 하네스 아키텍처 학습 노트
- [`orchestra/`](../orchestra/) — Claude Code가 Codex를 병렬 지휘하는 오케스트레이션
