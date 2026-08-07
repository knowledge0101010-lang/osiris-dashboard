# 출처와 검증 상태

이 노트가 무엇을 근거로 썼는지, 무엇이 확인되었고 무엇이 추정인지.

---

## 1. 직접 읽은 것 — 신뢰도 높음

이 세션에서 클론해서 파일을 직접 읽은 레포지토리.

| 레포 | 라이선스 | 이 노트에서의 역할 |
| --- | --- | --- |
| [hardness1020/awesome-agent-architecture](https://github.com/hardness1020/awesome-agent-architecture) | MIT | **뼈대.** 24개 섹션 구조, 메커니즘 서술, 실패 모드, Claude Code / Hermes / mini-swe-agent 비교 |
| [ai-boost/awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering) | CC0 | 1차 출처 링크 모음, 하네스 리뷰 체크리스트와 AGENTS/PLAN/IMPLEMENT 템플릿 원본 |
| [Picrew/awesome-agent-harness](https://github.com/Picrew/awesome-agent-harness) | — | 338개 프로젝트 카탈로그. [07 지형도](07-harness-landscape.md)의 카테고리 분포 |
| [langchain-ai/deepagents](https://github.com/langchain-ai/deepagents) | MIT | "배터리 포함 하네스"의 대표 사례. 원칙, 기능, 보안 모델 |
| [anthropics/claude-code](https://github.com/anthropics/claude-code) | — | 플러그인/커맨드/서브에이전트/스킬 파일 포맷. `.claude/` 배선의 근거 |
| [openai/codex](https://github.com/openai/codex) | Apache-2.0 | `codex exec` CLI 계약. 플래그는 `codex-rs/exec/src/cli.rs`와 `codex-rs/utils/cli/src/shared_options.rs`에서 직접 확인 |

### `codex exec` 플래그 — 소스에서 확인함

`orchestra/dispatch.mjs`가 쓰는 플래그는 전부 소스에서 확인했다.

| 플래그 | 정의 위치 |
| --- | --- |
| `--json` (alias `--experimental-json`) | `exec/src/cli.rs` |
| `-o, --output-last-message <FILE>` | `exec/src/cli.rs` |
| `--color <auto\|always\|never>` | `exec/src/cli.rs` |
| `--output-schema <FILE>` | `exec/src/cli.rs` |
| `--ephemeral`, `--skip-git-repo-check` | `exec/src/cli.rs` |
| `-m, --model` | `utils/cli/src/shared_options.rs` |
| `-s, --sandbox` | `utils/cli/src/shared_options.rs` |
| `-C, --cd <DIR>` | `utils/cli/src/shared_options.rs` |
| `--add-dir <DIR>` | `utils/cli/src/shared_options.rs` |
| 서브커맨드 `resume` / `fork` / `review` | `exec/src/cli.rs` |

`--dangerously-bypass-approvals-and-sandbox`도 존재하지만 **의도적으로 쓰지 않는다.**
이유는 [`orchestra/README.md`](../../orchestra/README.md#왜-샌드박스-우회-플래그가-없는가) 참조.

---

## 2. 재구성 — 신뢰도 중간 ⚠️

### Anthropic Academy 카탈로그

이 세션의 네트워크 정책이 `anthropic.skilljar.com`과 `www.anthropic.com`을
차단하므로 **강의 목록을 직접 확인하지 못했다.** 웹 검색 결과를 교차 확인해
재구성했고, 자료마다 코스 수가 다르다.

| 자료 시점 | 보고된 코스 수 |
| --- | --- |
| 2026-03 (런칭) | — |
| 2026-04 | 17코스 / 5트랙 |
| 2026-06~07 | 20코스 |
| 일부 자료 | 21코스 |

**차이는 집계 시점 때문이다.** 카탈로그가 제품 로드맵과 함께 확장 중이다.

확인된 정보:

- 플랫폼: Skilljar, 2026-03-02 공개, 무료, 이메일 가입만 필요
- 수료증: Skilljar 발급, LinkedIn 등재 가능
- 파트너 전용 카탈로그 별도: `anthropic-partners.skilljar.com`
- "Claude Code in Action": **4모듈, 약 2시간**, 대상은 단발 프롬프트에서
  길고 감독 적은 팀 전체 워크플로로 넘어가려는 개발자

**차단된 도메인:** `anthropic.skilljar.com`, `www.anthropic.com`,
`pasqualepillitteri.it`, `aitoolsclub.com`, `ainativecamp-production.up.railway.app`

> **실제 수강 시 [00-curriculum-map.md](00-curriculum-map.md)의 카탈로그 절만
> 갱신하면 된다.** 01–09번 본문의 메커니즘 내용은 카탈로그와 무관하게 유효하다.

---

## 3. 1차 출처 — 인용된 원문

`awesome-harness-engineering`이 정리한 것 중 이 노트가 실제로 인용한 것들.
**직접 읽지는 않았고, 큐레이션 요약을 근거로 했다.**

### Anthropic

- Building Effective Agents — 워크플로 vs 에이전트, 5가지 워크플로 형태
- Writing Effective Tools for Agents — 툴 인터페이스 설계
- Beyond Permission Prompts — 구조화된 권한 시스템
- Effective Context Engineering for AI Agents — 컨텍스트를 유한 자원으로
- Harness Design for Long-Running Application Development — "모든 하네스 부품은
  모델이 못 하는 것을 가정한다. 그 가정은 만료된다"
- Effective Harnesses for Long-Running Agents — initializer + coding 에이전트 핸드오프
- Demystifying Evals for AI Agents — 에이전트 평가 프레임워크
- Agent Harness Design: 3 Patterns — 3가지 설계 패턴
- April 23 Postmortem — 하네스 레벨 변경 3개가 만든 품질 저하
- 2026 Agentic Coding Trends Report — 인프라 설정이 벤치마크를 5%p+ 움직임
- Getting started with loops — 턴/목표/시간/선제 루프 분류
- Introducing dynamic workflows in Claude Code — 실행 가능 코드로서의 계획
- Scaling Managed Agents / Claude Code auto mode
- Agent Skills best practices — 점진적 공개 레벨
- Prompt caching / Compaction / Extended thinking — API 문서

### OpenAI

- Harness Engineering — 하네스 엔지니어링을 분야로 정의
- Unrolling the Codex Agent Loop — 루프 1회 반복의 정본 분해
- Unlocking the Codex Harness — Item/Turn/Thread 프로토콜, MCP로 부족했던 이유
- Run Long-Horizon Tasks with Codex — Plan.md / Implement.md
- Hooks – Codex — `SessionStart` / `PreToolUse` / `PostToolUse`
- A Practical Guide to Building AI Agents

### LangChain

- The Anatomy of an Agent Harness — 5대 프리미티브
- Improving Deep Agents with Harness Engineering — 30위 → 톱5
- Tuning the harness, not the model (Nemotron 3 Ultra) — $4.48 vs $43.48
- How Middleware Lets You Customize Your Agent Harness — 6개 훅
- Choosing the Right Multi-Agent Architecture — 서브에이전트가 스킬 대비 토큰 67% 절감
- Autonomous Context Compression
- The art of loop engineering — 4개 중첩 루프
- Evaluating Deep Agents: Our Learnings
- 3 years of graph engineering with LangGraph

### Microsoft / Google / Meta / 기타

- Context Engineering Lessons from Azure SRE Agent — 파일시스템 전환으로 45% → 75%
- How We Build Azure SRE Agent — 35,000+ 인시던트, MTTM 40.5시간 → 3분
- Google ADK 2.0 — 코드로 라우팅, 노드 간 컨텍스트 격리
- Meta REA — hibernate-and-wake 체크포인팅
- VS Code / GitHub Copilot 코딩 하네스 — "모델은 엔진, 하네스는 자동차"
- Martin Fowler (Birgitta Böckeler) — feedforward + feedback, 계산적 vs 추론적 제어
- Red Hat — 4기둥 모델 (vibes, specs, skills, agents)
- GitHub — 멀티 에이전트는 분산 시스템

### 논문

- ReAct (arXiv:2210.03629) — Thought/Action/Observation 루프
- LATS (arXiv:2310.04406) — MCTS 기반 계획
- Plan-and-Act (arXiv:2503.09572)
- The Design Space of Today's and Future AI Agent Systems (arXiv:2604.14228) —
  Claude Code 5단계 점진적 압축, 27종 훅 이벤트
- What makes a harness a harness (arXiv:2606.10106) — 하네스의 필요충분 4요소
- Architectural Design Decisions in AI Agent Harnesses (arXiv:2604.18071) — 70개 시스템
- A Scheduler-Theoretic Framework for LLM Agent Execution (arXiv:2604.11378) —
  70개 프로젝트 중 60%가 Agent Loop
- Code as Agent Harness (arXiv:2605.18747)
- Natural-Language Agent Harnesses (arXiv:2603.25723)
- SkillTester (arXiv:2603.28815) — 스킬 능력/견고성/보안 평가

### 도구·프로젝트

- statewright — 툴 공간 축소로 로컬 모델 2/10 → 10/10
- Mirage — 여러 백엔드를 하나의 가상 파일시스템으로
- Trellis — 점진적 스펙 시스템
- context-mode, Token Savior, headroom, semble — 컨텍스트 압력 완화
- mini-swe-agent, hermes-agent — 이 노트의 비교 대상 시스템
- ai-agent-book (李博杰, Apache-2.0) — 스캐폴딩과 모델 강도의 관계

> 위 항목의 URL은 [`ai-boost/awesome-harness-engineering`](https://github.com/ai-boost/awesome-harness-engineering)의
> README에 전부 있다. 여기서 중복하지 않는다.

---

## 4. 이 노트의 자체 판단 — 검증 안 됨

다음은 원문에 없고 이 노트가 정리·확장한 것이다. **비판적으로 읽어라.**

- 24개 섹션을 Academy 코스에 매핑한 표 ([00번](00-curriculum-map.md) §4)
- 각 문서 말미의 **"제거 가능 시점"** 표 — `§0`의 원칙을 각 레이어에 적용한 것
- **"권한·예산·관측·평가는 제거 불가"** 라는 구분 — 이 노트의 주장이다.
  근거: 이 넷은 모델 능력이 아니라 신뢰 경계와 비용에 대한 결정이다
- 4주 학습 플랜과 확인 질문 ([00번](00-curriculum-map.md) §5)
- OSIRIS 현재 상태 진단과 7개 실습 과제 ([08번](08-osiris-practice.md))
- `orchestra/`와 `android/`의 설계 결정 전부

---

## 5. 재현 방법

이 노트의 근거를 직접 확인하려면:

```bash
mkdir -p refs && cd refs
git clone --depth 1 https://github.com/hardness1020/awesome-agent-architecture.git
git clone --depth 1 https://github.com/ai-boost/awesome-harness-engineering.git
git clone --depth 1 https://github.com/Picrew/awesome-agent-harness.git
git clone --depth 1 https://github.com/langchain-ai/deepagents.git
git clone --depth 1 https://github.com/anthropics/claude-code.git
git clone --depth 1 https://github.com/openai/codex.git
```

핵심 파일:

```
awesome-agent-architecture/README.md              24개 섹션 지도
awesome-agent-architecture/sections/NN-*/README.md  각 섹션 (메커니즘·비교·실패 모드)
awesome-agent-architecture/sections/NN-*/src/     실행 가능한 데모 (섹션마다 누적)
awesome-harness-engineering/README.md             1차 출처 링크 전체
awesome-harness-engineering/templates/            체크리스트·템플릿 원본
awesome-agent-harness/data/projects.yaml          338개 프로젝트 원본 데이터
codex/codex-rs/exec/src/cli.rs                    codex exec 플래그
codex/codex-rs/utils/cli/src/shared_options.rs    공용 플래그
claude-code/plugins/                              커맨드/에이전트/스킬 포맷 예시
```

`awesome-agent-architecture`의 학습법 — **섹션의 `src/`를 앞 섹션과 diff 하라.**
그 diff가 해당 섹션이 추가하는 단 하나의 메커니즘이다.

---

*작성: 2026-08-07 · 갱신 시 이 절의 검증 상태를 함께 고쳐야 한다.*
