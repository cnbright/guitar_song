from typing import Literal

from pydantic import BaseModel, Field


class ArrangementConfig(BaseModel):
    capo: int = Field(default=0, ge=0, le=12)
    pattern: Literal['arpeggio', 'strum'] = 'arpeggio'
    rhythm: Literal['steady', 'folk'] = 'folk'
    meter: Literal[3, 4] = 4
    bpm: float | None = Field(default=None, ge=40, le=220)
    offset: float | None = Field(default=None, ge=0, le=30)
    changes: Literal['bar', 'half'] = 'bar'
    overrides: dict[str, str] = Field(default_factory=dict)

