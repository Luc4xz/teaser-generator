"""Validated intermediate representations and deterministic drawing instructions."""
from typing import List, Literal
from pydantic import BaseModel, ConfigDict, Field, constr

class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)

class ScientificConcept(StrictModel):
    core_concept: str = Field(min_length=1, max_length=1200)
    entities: str = Field(min_length=1, max_length=1600)
    mechanism: str = Field(min_length=1, max_length=2000)
    finding: str = Field(min_length=1, max_length=1600)
    evidence: str = Field(min_length=1, max_length=2400)
    limitations: str = Field(min_length=1, max_length=1600)

class VisualMapping(StrictModel):
    concept_field: Literal['core_concept', 'entities', 'mechanism', 'finding', 'limitations']
    depiction: str = Field(min_length=1, max_length=500)
    rationale: str = Field(min_length=1, max_length=400)

class VisualPlan(StrictModel):
    mappings: List[VisualMapping] = Field(min_length=1, max_length=6)
    composition: str = Field(min_length=1, max_length=1000)
    style: str = Field(min_length=1, max_length=700)
    labels: List[constr(strip_whitespace=True, min_length=1, max_length=120)] = Field(max_length=4)
    exclusions: str = Field(min_length=1, max_length=1000)


def prompt_sections(concept, plan):
    return [
        {'title': '1. Scientific concept', 'content': '\n'.join(f'{key.replace("_", " ").title()}: {getattr(concept, key)}' for key in ['core_concept', 'entities', 'mechanism', 'finding'])},
        {'title': '2. Evidence and limits', 'content': f'Evidence (context, not text to print): {concept.evidence}\nLimitations: {concept.limitations}'},
        {'title': '3. Visual mapping', 'content': '\n'.join(f'{m.concept_field}: {m.depiction}\nScientific connection: {m.rationale}' for m in plan.mappings)},
        {'title': '4. Composition', 'content': plan.composition},
        {'title': '5. Style and image text', 'content': plan.style + '\nAllowed image text: ' + ('; '.join(plan.labels) or 'No text or labels.')},
        {'title': '6. Exclusions', 'content': plan.exclusions},
    ]
