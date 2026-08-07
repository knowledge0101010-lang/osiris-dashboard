# 00 · 커리큘럼 지도

Anthropic Academy 카탈로그와 24개 하네스 섹션을 맞물리는 지도.

---

## 1. Anthropic Academy는 무엇인가

| 항목 | 내용 |
| --- | --- |
| URL | https://anthropic.skilljar.com/ (별칭: https://www.anthropic.com/learn) |
| 플랫폼 | Skilljar (LMS) |
| 공개 | 2026-03-02 |
| 비용 | 전액 무료. 이메일 가입만 필요하며 Anthropic 계정은 필요 없다 |
| 수료증 | Skilljar 발급 공식 수료증. LinkedIn 자격증란에 등재 가능 |
| 규모 | 2026-04 기준 17코스 / 5트랙 → 2026-07 기준 20+ 코스, 21코스로 집계한 자료도 있음 |
| 파트너 전용 | https://anthropic-partners.skilljar.com/ (별도 카탈로그) |

> ⚠️ **검증 상태** — 이 세션에서는 skilljar 도메인이 네트워크 정책에 막혀 있어
> 아래 카탈로그는 웹 검색 결과를 교차 확인한 **재구성**이다.
> 코스 수가 자료마다 13 / 17 / 20 / 21로 다른 것은 집계 시점 차이 때문이다.
> 실제 수강 시 목록을 확인하고 이 표를 갱신하면 된다.

---

## 2. 트랙 구성

2026-04 시점 기준으로 5개 트랙이 보고된다.

| 트랙 | 대상 | 성격 |
| --- | --- | --- |
| **AI Fluency** | 전 직군 | AI를 쓰는 사고 프레임워크. 교육자·학생용 변형 존재 |
| **Product Training** | 일반 사용자 | Claude 앱, Claude in Excel/Chrome 등 제품 사용법 |
| **Developer Deep-Dives** | 개발자 | Claude Code, API, MCP, Agent Skills, Subagents |
| **Cloud & Enterprise** | 플랫폼 엔지니어 | Bedrock/Vertex 등 클라우드 배포, 엔터프라이즈 운영 |
| **Foundational Knowledge** | 전 직군 | LLM 기초, 프롬프트, 안전성 |

---

## 3. 코스 카탈로그 (재구성)

### 3.1 확인 신뢰도 높음 — 검색 결과에서 URL 또는 설명까지 확인됨

| 코스 | 한 줄 요약 | 대응 하네스 섹션 |
| --- | --- | --- |
| **Claude 101** | 일상 업무에서 Claude 쓰기, 핵심 기능과 다음 학습 경로 | §0 |
| **Claude Code 101** | 일상 개발 워크플로에 Claude Code를 끼워 넣기 | §1–4 |
| **Claude Code in Action** | 길고 감독 없는 세션을 신뢰 가능하게: 조종·설정·자동화·검증 (4모듈 / 약 2시간) | §5, 8, 10, 14, 20, 21 |
| **Claude Platform 101** | Claude 플랫폼 전반 개요 | §0–2 |
| **Building with the Claude API** | Claude API로 모델을 다루는 전 범위 | §1–2, 10–11 |
| **Introduction to Model Context Protocol** | Python으로 MCP 서버/클라이언트를 처음부터: tools, resources, prompts | §19 |
| **Introduction to Agent Skills** | 스킬로 반복 절차를 패키징 | §7 |
| **Introduction to Subagents** | 컨텍스트 관리·위임·전문화 워크플로 | §6 |
| **AI Fluency: Framework and Foundations** | AI 활용 사고 프레임워크 (워크숍/프로그램용) | — |

### 3.2 카탈로그에 존재하는 것으로 보이나 세부 확인 필요

- MCP 심화 (두 번째 MCP 코스) — §19
- Claude in Excel / Claude in Chrome 등 제품별 코스 — §19 (채널 관점)
- AI Fluency for Educators / for Students — 트랙 변형
- 클라우드 배포 (Bedrock / Vertex AI) 코스 — §3, 19
- 프롬프트 엔지니어링 / 안전성 기초 — §10

> 이 절은 **의도적으로 미확정 상태로 남긴다.** 실제 수강 시 채워 넣을 것.

---

## 4. 하네스 24개 섹션 ↔ 코스 매핑

`awesome-agent-architecture`의 24개 섹션이 이 노트의 뼈대다.
Academy 코스가 없는 섹션이 절반 이상인데, **그게 이 노트의 존재 이유**다 —
강의는 "Claude Code를 잘 쓰는 법"까지 가르치고, 나머지는 직접 만들 때 필요한 지식이다.

| # | 섹션 | 질문 | 대응 코스 | 노트 |
| --- | --- | --- | --- | --- |
| | **Layer 0 · 기초** | | | |
| 0 | 하네스 명제 | 에이전시는 어디서 오는가 | Claude 101, Platform 101 | [01](01-layer0-1-foundations.md) |
| | **Layer 1 · 코어 루프** | | | |
| 1 | 에이전트 루프 | 에이전트는 어떻게 계속 도는가 | Building with the Claude API | [01](01-layer0-1-foundations.md) |
| 2 | 툴 런타임 | 툴은 어떻게 호출·라우팅되는가 | Building with the Claude API | [01](01-layer0-1-foundations.md) |
| 3 | 권한 & 샌드박스 | 부작용은 어떻게 게이팅되는가 | Claude Code in Action | [01](01-layer0-1-foundations.md) |
| 4 | 훅 | 확장은 루프에 어떻게 붙는가 | Claude Code in Action | [01](01-layer0-1-foundations.md) |
| | **Layer 2 · 복잡한 작업** | | | |
| 5 | 플래닝 & 투두 | 큰 작업을 어떻게 쪼개는가 | Claude Code in Action | [02](02-layer2-complex-work.md) |
| 6 | 서브에이전트 | 하위 문제를 어떻게 격리하는가 | Introduction to Subagents | [02](02-layer2-complex-work.md) |
| 7 | 스킬 | 능력을 어떻게 온디맨드로 로드하는가 | Introduction to Agent Skills | [02](02-layer2-complex-work.md) |
| 8 | 컨텍스트 관리 | 긴 세션이 어떻게 윈도우에 맞는가 | Claude Code in Action | [02](02-layer2-complex-work.md) |
| | **Layer 3 · 지식과 회복력** | | | |
| 9 | 메모리 | 실행 간에 어떻게 기억하는가 | — | [03](03-layer3-knowledge-resilience.md) |
| 10 | 시스템 프롬프트 조립 | 프롬프트는 매 턴 어떻게 만들어지는가 | Claude Code in Action (CLAUDE.md) | [03](03-layer3-knowledge-resilience.md) |
| 11 | 에러 복구 | 긴 작업이 실패를 어떻게 견디는가 | — | [03](03-layer3-knowledge-resilience.md) |
| | **Layer 4 · 장기 실행 & 비동기** | | | |
| 12 | 태스크 시스템 | 작업이 턴을 넘어 어떻게 지속되는가 | — | [04](04-layer4-5-long-running-multi-agent.md) |
| 13 | 백그라운드 실행 | 작업이 메인 루프 밖에서 어떻게 도는가 | — | [04](04-layer4-5-long-running-multi-agent.md) |
| 14 | 스케줄링 | 에이전트가 나중에 어떻게 실행되는가 | Claude Code in Action (Routines) | [04](04-layer4-5-long-running-multi-agent.md) |
| 15 | 워크트리 격리 | 병렬 작업이 어떻게 충돌을 피하는가 | — | [04](04-layer4-5-long-running-multi-agent.md) |
| | **Layer 5 · 멀티 에이전트** | | | |
| 16 | 코디네이션 | 여러 에이전트가 어떻게 대화하는가 | — | [04](04-layer4-5-long-running-multi-agent.md) |
| 17 | 프로토콜 | 합의하고 깔끔히 멈추는 법 | — | [04](04-layer4-5-long-running-multi-agent.md) |
| 18 | 자율성 | 스스로 어떻게 조직화하는가 | — | [04](04-layer4-5-long-running-multi-agent.md) |
| | **Layer 6 · 확장 & 통합** | | | |
| 19 | MCP / 플러그인 / 채널 | 하네스는 세상에 어떻게 닿는가 | MCP 코스 | [05](05-layer6-integration-observability.md) |
| 20 | 관측성 | 잘 돌아가는지 어떻게 아는가 | Claude Code in Action | [05](05-layer6-integration-observability.md) |
| 23 | 평가 | 변경이 개선인지 어떻게 아는가 | — | [05](05-layer6-integration-observability.md) |
| | **Layer 7 · 조합** | | | |
| 21 | 루프 엔지니어링 | 루프가 어떻게 스스로 도는 시스템이 되는가 | Claude Code in Action | [06](06-layer7-loop-graph-engineering.md) |
| 22 | 그래프 엔지니어링 | 제어 흐름이 언제 모델에서 코드로 옮겨가는가 | — | [06](06-layer7-loop-graph-engineering.md) |

**빈칸이 곧 커리큘럼의 경계선이다.** §9, 11–13, 15–18, 22–23은 Academy 강의로는 안 배운다.
이건 결함이 아니다 — Academy는 *Claude Code 사용자*를 대상으로 하고,
그 섹션들은 *하네스를 직접 만드는 사람*의 영역이다.

---

## 5. 4주 학습 플랜

각 주는 "강의 → 노트 → 실습" 3단으로 구성한다.

### 1주차 — 기초와 루프

| | 내용 |
| --- | --- |
| 강의 | Claude 101 → Claude Platform 101 → Claude Code 101 |
| 노트 | [01 · Layer 0–1](01-layer0-1-foundations.md) 전체 |
| 실습 | `messages[]` 루프를 30줄로 직접 구현. `stop_reason`으로 `tool_use` / `end_turn` 분기. 툴 하나(파일 읽기)만 등록 |
| 확인 질문 | 모델 호출 한 번과 에이전트의 차이를 4가지로 말할 수 있는가 (실행 장소 / 관측 / 게이팅 / 상태 지속) |

### 2주차 — 복잡한 작업

| | 내용 |
| --- | --- |
| 강의 | Claude Code in Action (4모듈) |
| 노트 | [02 · Layer 2](02-layer2-complex-work.md), [03 · Layer 3](03-layer3-knowledge-resilience.md) |
| 실습 | 1주차 루프에 (a) 권한 게이트 (b) 툴 결과 스텁 처리 (c) `SKILL.md` 하나 추가 |
| 확인 질문 | CLAUDE.md에 규칙을 두는 것과 대화에 규칙을 말하는 것의 차이를 압축(compaction) 관점에서 설명할 수 있는가 |

### 3주차 — 확장과 통합

| | 내용 |
| --- | --- |
| 강의 | Introduction to Agent Skills → Introduction to Subagents → MCP 코스 |
| 노트 | [05 · Layer 6](05-layer6-integration-observability.md), [07 · 지형도](07-harness-landscape.md) |
| 실습 | MCP 서버 하나를 직접 작성(tools + resources + prompts)하고 루프에 물리기 |
| 확인 질문 | 서브에이전트가 스킬보다 토큰을 덜 쓰는 시나리오와 그 반대 시나리오를 각각 들 수 있는가 |

### 4주차 — 자율성과 검증

| | 내용 |
| --- | --- |
| 강의 | (강의 없음 — 문서와 실습) |
| 노트 | [04 · Layer 4–5](04-layer4-5-long-running-multi-agent.md), [06 · Layer 7](06-layer7-loop-graph-engineering.md) |
| 실습 | [08 · OSIRIS 적용](08-osiris-practice.md)의 과제 1–3 수행 |
| 확인 질문 | "다 됐다"를 모델의 주장이 아닌 검증된 사실로 만드는 최소 구성요소 3가지는? (별도 채점자 / 고정 루브릭 / 하네스가 강제하는 예산) |

---

## 6. 수료 후 남겨야 할 것

수료증보다 중요한 산출물:

1. **직접 만든 30–150줄 루프.** 남의 프레임워크 없이 도는 것.
2. **`AGENTS.md` 한 장.** 자기 레포에 대해 실제로 작동하는 것. → [09번 템플릿](09-checklists-templates.md)
3. **검증 루프 한 개.** 통과/실패를 코드가 판정하는 것.
4. **제거 목록.** 지금 만든 하네스 레이어 중, 모델이 좋아지면 지울 것들의 목록.
