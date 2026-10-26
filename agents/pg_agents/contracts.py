"""PrintGuard A2A 계약. ax-company-hq `ax_contracts`의 형식(AgentCard·AgentRequest·AgentResult)을 PrintGuard용으로 옮겼다.

- 정의하지 않은 필드는 거부한다(extra="forbid").
- 시간은 UTC.
- 상태 값은 A2A 표기(`input-required`)를 따른다.
"""
from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, AwareDatetime, BaseModel, ConfigDict, Field, model_validator

UtcDatetime = Annotated[AwareDatetime, AfterValidator(lambda v: v.astimezone(UTC))]
SNAKE = r"^[a-z][a-z0-9_]*$"
Grade = Literal["read", "A", "B", "C"]


class PgModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Skill(PgModel):
    """다른 에이전트가 요청할 수 있는 일 하나. read 외 등급은 실행 전에 safety(execute)를 거친다."""
    id: str = Field(pattern=SNAKE)
    description: str
    input_schema: dict[str, Any] = Field(default_factory=dict)
    output_schema: dict[str, Any] = Field(default_factory=dict)
    grade: Grade
    allowed_requesters: list[str]
    verifier: str | None = None

    @model_validator(mode="after")
    def _b_needs_verifier(self) -> Skill:
        if self.grade == "B" and not self.verifier:
            raise ValueError(f"skill {self.id}: B 등급에는 verifier가 필요하다")
        return self


class AgentCard(PgModel):
    name: str = Field(pattern=SNAKE)
    description: str
    url: str
    version: str = "0.1.0"
    skills: list[Skill]

    @model_validator(mode="after")
    def _no_self_verification(self) -> AgentCard:
        for s in self.skills:
            if s.verifier == self.name:
                raise ValueError(f"skill {s.id}: 자기 자신을 검증자로 둘 수 없다")
        ids = [s.id for s in self.skills]
        if len(ids) != len(set(ids)):
            raise ValueError("skill id 중복")
        return self


class TaskStatus(StrEnum):
    SUBMITTED = "submitted"
    WORKING = "working"
    INPUT_REQUIRED = "input-required"
    COMPLETED = "completed"
    REJECTED = "rejected"
    CANCELED = "canceled"
    FAILED = "failed"


class InputReason(StrEnum):
    DEPT_INPUT = "dept_input"
    CUSTOMER_INPUT = "customer_input"
    HUMAN_INPUT = "human_input"


class ErrorCode(StrEnum):
    LOOP_DETECTED = "LOOP_DETECTED"
    HOP_LIMIT = "HOP_LIMIT"
    TIMEOUT = "TIMEOUT"
    UNAUTHORIZED = "UNAUTHORIZED"
    FORBIDDEN_SKILL = "FORBIDDEN_SKILL"
    INVALID_OUTPUT = "INVALID_OUTPUT"
    MISSING_CONTEXT = "MISSING_CONTEXT"
    INVALID_INPUT = "INVALID_INPUT"
    UNKNOWN_SKILL = "UNKNOWN_SKILL"


class RequestMeta(PgModel):
    """context_id: 검수 의뢰 단위 ID(ctx_job_…). path: 거쳐 온 에이전트. requester는 토큰에서 채운다(본문 값은 무시)."""
    context_id: str
    token: str
    path: list[str] = Field(default_factory=list)
    deadline: UtcDatetime
    idempotency_key: str | None = None
    requester: str | None = None


class Evidence(PgModel):
    queries: list[str] = Field(default_factory=list)
    data_summary: str = ""
    ref_ids: list[str] = Field(default_factory=list)


class AgentRequest(PgModel):
    """untrusted: PDF 본문처럼 외부에서 온 텍스트. 프롬프트에는 데이터 블록으로만 넣고 지시로 해석하지 않는다."""
    meta: RequestMeta
    skill: str
    input: dict[str, Any] = Field(default_factory=dict)
    untrusted: dict[str, Any] = Field(default_factory=dict)


class AgentResult(PgModel):
    meta: RequestMeta
    status: TaskStatus
    outcome: str | None = None
    output: dict[str, Any] = Field(default_factory=dict)
    evidence: Evidence = Field(default_factory=Evidence)
    reason_code: InputReason | None = None
    question: dict[str, Any] | None = None  # input-required일 때 사용자에게 물을 내용
    fallback: bool = False

    @model_validator(mode="after")
    def _status_fields(self) -> AgentResult:
        if self.status == TaskStatus.INPUT_REQUIRED and (self.reason_code is None or self.question is None):
            raise ValueError("input-required에는 reason_code와 question이 필요하다")
        if self.status != TaskStatus.INPUT_REQUIRED and self.reason_code is not None:
            raise ValueError("reason_code는 input-required일 때만 쓴다")
        if self.status == TaskStatus.REJECTED and self.outcome not in {c.value for c in ErrorCode}:
            raise ValueError("rejected의 outcome은 ErrorCode 값이어야 한다")
        return self


# ---------- 실행 관문(safety) ----------
class ExecuteRequest(PgModel):
    action: str
    requester: str
    context_id: str
    idempotency_key: str
    params: dict[str, Any] = Field(default_factory=dict)
    evidence: Evidence = Field(default_factory=Evidence)


Decision = Literal["executed", "pending_review", "rejected"]


class ExecuteDecision(PgModel):
    decision: Decision
    grade: Grade
    reason: str
    execution_id: str
    review_id: str | None = None
    computed: dict[str, Any] = Field(default_factory=dict)


def now_utc() -> datetime:
    return datetime.now(UTC)
