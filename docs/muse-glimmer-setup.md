# Muse Glimmer 30B — 설치 파일 선택 가이드

Meta의 Muse Code CLI 및 Muse Glimmer 30B 모델을 로컬에 설치할 때 참고하는 문서.

> **확인 범위에 대한 고지**
> 이 문서를 작성한 세션에서는 `dev.meta.ai`와 `huggingface.co`가 모두 이그레스 정책으로
> 차단되어 있었다. 따라서 저장소의 **파일 목록을 직접 확인하지 못했고**, 아래 파일명과
> 용량은 웹 검색 결과에 기반한다. 실제 다운로드 전에 저장소 페이지에서 최종 확인할 것.

---

## 1. Muse Code CLI

터미널 코딩 에이전트. 2026-08-05 베타 공개. Muse Spark 1.2 모델 기반.

```bash
curl -fsSL https://dev.meta.ai/install.sh -o install.sh
less install.sh      # 파이프로 바로 bash에 넘기지 말고 먼저 검토
bash install.sh
muse login           # 디바이스 코드 방식 대화형 인증
```

- macOS / Linux 그대로 지원. Windows는 WSL2 안에서 설치.
- 의존성은 `curl`과 `bash`뿐 — Node.js나 Python 불필요.
- 설치 위치: 자기 갱신 런처 `~/.local/bin/muse`, 실제 바이너리는
  `~/.local/bin/muse-bin-<version>`로 함께 내려받는다.

주의: 여러 가이드가 `dev.ai/install.sh`로 잘못 표기한다. 올바른 호스트는
`dev.meta.ai`이며, `dev.ai`는 무관한 사이트로 설치 스크립트를 제공하지 않는다.

---

## 2. Muse Glimmer 30B 모델

Apache 2.0 라이선스, 30B 파라미터, 에이전트용 멀티모달 모델. 2026-08-10 공개.
전용 perception encoder를 갖춘 causal language model.

### 저장소가 4개 — 목적이 다르다

| 저장소 | 용도 | 대상 |
|---|---|---|
| `meta-models/Muse-Glimmer-30B` | 원본 full-precision 가중치 | 파인튜닝·직접 양자화용. 일반 사용자는 불필요 |
| `meta-models/Muse-Glimmer-30B-GGUF` | llama.cpp / Ollama / LM Studio | **대부분의 경우 여기서 받는다** |
| `meta-models/Muse-Glimmer-30B-ExecuTorch-PTE` | 사전 내보내기된 PTE | 최고 성능, 단 하드웨어 타깃 고정 |
| `meta-models/Muse-Glimmer-30B-assistant` | assistant 변형 | 용도 별도 확인 필요 |

`meta-models`는 `meta-llama`(Llama·Llama Guard·Prompt Guard 전용)와 별개의 조직이다.

### GGUF 양자화 선택

| 파일 | 용량 | 비고 |
|---|---|---|
| `Q4_K_M` | 17.31 GB | 크기·성능 균형의 표준 선택 |
| `Q6_K` | 28.3 GB | **고를 이유가 거의 없다** — 아래 참조 |
| `Q8_0` | 29.6 GB | Q6_K보다 1.3GB 클 뿐인데 31% 더 정확 |

**`Q6_K`는 건너뛴다.** 그 용량을 감당할 수 있으면 Q8_0으로 간다.

같은 저장소의 추가 파일:

- **perception encoder** — 이미지 입력을 쓸 경우 **필수**
- **DFlash drafter** — speculative decoding 가속용, 선택

### ExecuTorch PTE 선택

PTE는 ExecuTorch가 특정 백엔드에 맞춰 lowering·최적화해 직렬화한 산출물이다.
CUDA(sm80+ptx)와 Apple Silicon(metal)용으로, text-only / text+image,
DFlash 유무 조합이 미리 준비되어 있다. 백엔드별 lowering은 CUDA에서 Triton,
Apple Silicon에서 MLX-native 및 커스텀 Metal을 쓴다.

| 변형 | 요구 메모리 | 대상 |
|---|---|---|
| `k-quant-17G` | 24 GB VRAM / 통합메모리 | RTX 3090, RTX 4090 |
| `k-quant-dynamic` | 32 GB | RTX 5090 |

> **반드시 `--include`로 정확히 한 변형만 지정할 것.**
> 지정하지 않으면 모든 변형(각 17.9–31.5 GB)을 전부 내려받는다.
> 공유 루트 파일은 함께 받아야 한다.

---

## 3. 하드웨어별 권장 조합

이미지 입력(멀티모달)을 함께 쓰는 것을 전제로 한 표. 텍스트만 쓸 경우
perception encoder를 생략하면 된다.

| 하드웨어 | 받을 것 |
|---|---|
| NVIDIA 24GB (3090 / 4090) | GGUF **Q4_K_M** (17.31GB) + perception encoder |
| NVIDIA 32GB (5090) | PTE **k-quant-dynamic / text+image**, 또는 GGUF **Q8_0** + encoder |
| Apple Silicon, 통합메모리 32GB | GGUF **Q4_K_M** + encoder |
| Apple Silicon, 통합메모리 64GB+ | GGUF **Q8_0** + encoder, 또는 metal PTE의 text+image 변형 |
| GPU 없음 / VRAM 16GB 이하 | 30B는 무리. 더 작은 모델을 쓸 것 |

Meta는 통합메모리 64GB MacBook Pro에서의 구동을 시연했다. Apple Silicon은
CPU·GPU가 메모리 풀을 공유하므로, 64GB면 4-bit 30B 모델과 캐시에 여유가 있다.

### 로컬 장비 사양 확인

**Windows (PowerShell)**
```powershell
Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM
Get-CimInstance Win32_ComputerSystem | Select-Object TotalPhysicalMemory
nvidia-smi
```

**macOS**
```bash
sysctl -n machdep.cpu.brand_string
system_profiler SPHardwareDataType | grep -E "Chip|Memory"
```

**Linux**
```bash
nvidia-smi --query-gpu=name,memory.total --format=csv
free -h
```

---

## 4. Claude Code 원격 세션에서는 설치할 수 없다

이 저장소를 다루는 Claude Code 클라우드 세션에서 설치를 시도하면 실패한다.
같은 문제를 다시 진단하지 않도록 근거를 남긴다.

### 네트워크

이그레스 정책이 해당 호스트들을 차단한다. 프록시 CONNECT 단계에서 403이 반환된다.

```
$ curl -fsSL https://dev.meta.ai/install.sh | bash
curl: (22) The requested URL returned error: 403
```

프록시 상태 엔드포인트(`$HTTPS_PROXY/__agentproxy/status`) 기록:

```
connect_rejected  dev.meta.ai:443
connect_rejected  huggingface.co:443
```

- 차단: `dev.meta.ai`, `ai.meta.com`, `huggingface.co`
- 정상: `registry.npmjs.org`, `raw.githubusercontent.com`, `github.com`

즉 인터넷 자체는 되고 특정 도메인만 정책적으로 막혀 있다. DNS는 정상 해석된다
(`dev.meta.ai` → `star.c10r.facebook.com`). 도메인 문제가 아니다.

**우회하지 말 것.** `/root/.ccr/README.md`가 명시한다:

> **403 / 407 from the proxy** — The destination host is not allowed by your
> organization's egress policy for this session. Do not retry or route around
> it — report the blocked host.

우회해도 완주가 불가능하다. 설치 스크립트는 런처를 배치한 뒤 실제 바이너리를
같은 차단 도메인에서 내려받으므로 다음 단계에서 동일한 403을 맞는다.

해제하려면 환경 소유자가 이그레스 허용 목록에 `dev.meta.ai`(가급적 `*.meta.ai`)와
`huggingface.co`를 추가해야 한다.
참고: https://code.claude.com/docs/en/claude-code-on-the-web

### 하드웨어

허용 목록이 열리더라도 세션 컨테이너 자체가 30B 모델을 감당하지 못한다.
측정된 사양:

```
CPU      : Intel Xeon @ 2.10GHz, 4 vCPU (Hypervisor: KVM, virt: docker)
RAM      : 15 GiB (스왑 0)
디스크    : 30 GB 여유 / 252 GB
GPU      : 없음 (nvidia-smi 없음, /dev/dri 없음, GPU 패스스루 없음)
OS       : Ubuntu 24.04.4 LTS, 커널 6.18.5-fc-v20
```

여기에 더해 컨테이너는 세션 종료 시 회수되고, `muse login`은 대화형 디바이스 코드
인증을 요구한다. 설치는 로컬 장비에서 수행할 것.
