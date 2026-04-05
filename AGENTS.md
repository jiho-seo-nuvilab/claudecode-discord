# Global Operating Rules — Integrated Workflow Mode

이 저장소의 에이전트 작업은 다음 원칙을 기본으로 한다.

- 모든 요청에서 먼저 사용자 의도를 파악한다.
- 기본 워크플로우는 `bd + gsd + Serena` 조합이다.
- 코드 이해가 필요하면 `Serena`를 먼저 사용한다.
- 다단계 작업, 리팩터, 마이그레이션, 검증 중심 작업에는 `gsd`를 기본 적용한다.
- 의미 있는 작업 진행과 완료 시 `bd` 상태 업데이트, 진행 저장, `bd sync`를 기본 적용한다.
- 모든 응답은 기본적으로 한국어로 작성한다.
- 모든 응답 마지막에는 반드시 `[Reflection]`, `[Improvement]`, `[Next Step Suggestion]`을 포함한다.

프로젝트 상세 규칙과 아키텍처 설명은 `CLAUDE.md`를 따른다.
