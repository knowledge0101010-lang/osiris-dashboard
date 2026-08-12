# Anthropic Academy 통합 학습 노트

> **한 줄 요약** — 모델은 판단하고, 하네스(harness)는 행동·상태·한계를 준다.
> Anthropic Academy가 "무엇을 쓸 수 있는가"를 가르친다면, 이 노트는 그 밑에 깔린
> "왜 그렇게 설계되었는가"를 24개 레이어로 나눠 붙인다.

이 디렉터리는 [Anthropic Academy](https://anthropic.skilljar.com/) 커리큘럼을
**에이전트 하네스 아키텍처**라는 하나의 뼈대 위에 재배치한 한국어 학습 노트다.
강의를 그대로 옮긴 요약본이 아니라, 강의에서 배우는 기능(플랜 모드, CLAUDE.md, 스킬,
서브에이전트, MCP, 훅…)이 각각 **어떤 공학적 문제를 푸는 부품인지** 설명한다.

---

## 왜 이 구조인가

Academy 커리큘럼은 제품 단위로 나뉘어 있다 — Claude Code 코스, API 코스, MCP 코스.
제품 단위로 배우면 기능은 외워지지만 **왜 그 기능이 존재하는지**가 남지 않는다.

하네스 관점으로 재배치하면 다음이 보인다.

| 강의에서 배우는 것 | 실제로 푸는 문제 | 이 노트의 위치 |
| --- | --- | --- |
| 플랜 모드 (Plan Mode) | 파일을 건드리기 전에 계획을 승인 상태로 만든다 | [Layer 2 · 05](02-layer2-complex-work.md) |
| CLAUDE.md | 압축(compaction)에도 살아남는 규칙을 시스템 프롬프트에 고정한다 | [Layer 3 · 10](03-layer3-knowledge-resilience.md) |
| 스킬 (SKILL.md) | 전체 카탈로그를 컨텍스트에 올리지 않고 필요할 때만 로드한다 | [Layer 2 · 07](02-layer2-complex-work.md) |
| 서브에이전트 | 하위 문제를 **새 `messages[]`** 로 격리해 오염을 막는다 | [Layer 2 · 06](02-layer2-complex-work.md) |
| 권한 모드 / 훅 | 부작용이 세상에 닿기 전에 코드로 게이팅한다 | [Layer 1 · 03·04](01-layer0-1-foundations.md) |
| 루틴 / 스케줄 | 사람이 없어도 트리거가 실행을 시작한다 | [Layer 4 · 14](04-layer4-5-long-running-multi-agent.md) |
| 관리형 코드 리뷰 | "다 됐다"를 모델의 주장이 아닌 검증된 사실로 만든다 | [Layer 7 · 21](06-layer7-loop-graph-engineering.md) |
| MCP 서버 | 하네스가 하나의 표준 프로토콜로 외부 세계에 닿는다 | [Layer 6 · 19](05-layer6-integration-observability.md) |

---

## 목차

| 문서 | 내용 |
| --- | --- |
| [00 · 커리큘럼 지도](00-curriculum-map.md) | Academy 코스/트랙 카탈로그, 24개 하네스 섹션과의 매핑표, 4주 학습 플랜 |
| [01 · Layer 0–1 · 기초와 코어 루프](01-layer0-1-foundations.md) | 하네스 명제, 에이전트 루프, 툴 런타임, 권한·샌드박스, 훅 |
| [02 · Layer 2 · 복잡한 작업](02-layer2-complex-work.md) | 플래닝·투두, 서브에이전트, 스킬, 컨텍스트 관리 |
| [03 · Layer 3 · 지식과 회복력](03-layer3-knowledge-resilience.md) | 메모리, 시스템 프롬프트 조립, 에러 복구 |
| [04 · Layer 4–5 · 장기 실행과 멀티 에이전트](04-layer4-5-long-running-multi-agent.md) | 태스크 시스템, 백그라운드, 스케줄링, 워크트리, 코디네이션, 프로토콜, 자율성 |
| [05 · Layer 6 · 통합과 관측](05-layer6-integration-observability.md) | MCP·플러그인·채널, 관측성, 평가 환경 |
| [06 · Layer 7 · 루프와 그래프 엔지니어링](06-layer7-loop-graph-engineering.md) | 검증 루프, 성숙도 레벨, 그래프로의 전환 |
| [07 · 하네스 지형도](07-harness-landscape.md) | Deep Agents, LangGraph, Codex, 그 외 레퍼런스 하네스 비교 |
| [08 · OSIRIS 적용 실습](08-osiris-practice.md) | 이 레포의 AI 엔진을 하네스로 승격시키는 단계별 과제 |
| [09 · 체크리스트와 템플릿](09-checklists-templates.md) | 한국어 하네스 리뷰 체크리스트, AGENTS.md·PLAN.md 템플릿 |
| [SOURCES](SOURCES.md) | 출처, 검증 상태, 재현 방법 |

---

## 학습 순서 추천

**개발자 트랙 (권장)**

```text
Claude 101 ──▶ Claude Code 101 ──▶ Claude Code in Action ──▶ Agent Skills ──▶ Subagents
     │              │                       │                     │              │
     ▼              ▼                       ▼                     ▼              ▼
  [01 §0]       [01 §1–4]              [02 §5,8]             [02 §7]       [02 §6]
```

**플랫폼/API 트랙**

```text
Claude Platform 101 ──▶ Building with the Claude API ──▶ MCP 코스
        │                          │                        │
        ▼                          ▼                        ▼
    [01 §0–2]                 [01 §1–2, 03 §10–11]      [05 §19]
```

**자동화·운영 트랙 (강의 이후)**

```text
[04 §12–15] 장기 실행 ──▶ [05 §20,23] 관측·평가 ──▶ [06 §21–22] 루프·그래프
```

각 문서는 독립적으로 읽을 수 있지만, **순서대로 읽으면 앞 레이어가 뒤 레이어의 전제가 된다**.
01의 루프를 이해하지 못한 채 08의 컨텍스트 관리를 읽으면 "왜 루프 안에서 돌려야 하는지"가 안 보인다.

---

## 이 노트를 쓸 때 지킨 원칙

1. **메커니즘 우선.** "이런 기능이 있다"가 아니라 "이 제어 흐름이 이 문제를 이렇게 막는다".
2. **실패 모드 필수.** 각 레이어마다 무엇이 깨지는지와 완화책을 함께 적는다.
3. **출처 표기.** 검증된 1차 출처와 재구성/추정을 구분한다. [SOURCES.md](SOURCES.md) 참조.
4. **하네스는 많을수록 좋은 게 아니다.** 모든 레이어는 "지금 모델이 못 하는 것"을 메운다.
   모델이 좋아지면 그 레이어는 **부채가 된다**. 각 문서 끝에 *제거 조건*을 적는다.

---

## 접근 제한에 대한 고지

이 세션의 네트워크 정책상 `anthropic.skilljar.com` 직접 접근이 차단되어 있다.
따라서 **코스 카탈로그(제목·개수·트랙 구성)는 웹 검색 결과 기반의 재구성**이며,
2026-08 기준으로 카탈로그가 계속 확장 중이라 실제 목록과 차이가 있을 수 있다.
[00-curriculum-map.md](00-curriculum-map.md)에 검증 상태를 항목별로 표시했다.

반면 **하네스 메커니즘 내용은 클론해서 직접 읽은 6개 레포지토리**를 근거로 한다
(커밋 SHA는 [SOURCES.md](SOURCES.md) §5에 고정해 뒀다).
공부하면서 카탈로그가 다르면 00번 문서만 고치면 되고, 01–09번 본문은 그대로 유효하다.
