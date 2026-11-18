"""Server-owned model allowlist and provider-specific SDK adapters.

The browser sends only an ID. Keys, endpoints and SDK options come from server config.
"""
import base64
import json
import os
from typing import Literal

from fastapi import HTTPException
from openai import OpenAI, AzureOpenAI, OpenAIError
from pydantic import BaseModel, Field, ValidationError


class ModelConfig(BaseModel):
    id: str = Field(min_length=1, max_length=160)
    label: str = Field(min_length=1, max_length=200)
    kind: Literal['text', 'image']
    provider: Literal['openai', 'azure', 'anthropic', 'gemini']
    model: str = Field(min_length=1)
    key_env: str = Field(min_length=1)
    endpoint_env: str = 'AZURE_OPENAI_ENDPOINT'
    api_version_env: str = 'AZURE_OPENAI_API_VERSION'


def configured_models():
    raw = os.getenv('TEASER_MODELS_JSON', '').strip()
    try:
        if raw:
            entries = [ModelConfig.model_validate(item) for item in json.loads(raw)]
        else:
            text = os.getenv('TEASER_TEXT_MODEL') or os.getenv('OPENAI_MODEL', 'gpt-5-nano')
            image = os.getenv('OPENAI_IMAGE_MODEL', 'gpt-image-1-mini')
            entries = [ModelConfig(id='openai-text', label=f'OpenAI · {text}', kind='text', provider='openai', model=text, key_env='OPENAI_API_KEY'),
                       ModelConfig(id='openai-image', label=f'OpenAI · {image}', kind='image', provider='openai', model=image, key_env='OPENAI_API_KEY')]
            for provider, prefix, key in [('azure','AZURE_OPENAI','AZURE_OPENAI_API_KEY'), ('anthropic','ANTHROPIC','ANTHROPIC_API_KEY'), ('gemini','GEMINI','GEMINI_API_KEY')]:
                for kind, suffix in [('text','TEXT_MODEL'), ('image','IMAGE_MODEL')]:
                    model = os.getenv(f'{prefix}_{suffix}', '').strip()
                    if model:
                        entries.append(ModelConfig(id=f'{provider}-{kind}', label=f'{provider.title()} · {model}', kind=kind, provider=provider, model=model, key_env=key))
        if len({entry.id for entry in entries}) != len(entries):
            raise ValueError('Duplicate IDs')
        if any(entry.kind == 'image' and entry.provider == 'anthropic' for entry in entries):
            raise ValueError('Anthropic is text-only')
        return entries
    except (ValidationError, ValueError, TypeError):
        raise HTTPException(503, 'Invalid backend model configuration. Check TEASER_MODELS_JSON and provider settings.') from None


def available(entry):
    return bool(os.getenv(entry.key_env, '').strip()) and (entry.provider != 'azure' or bool(os.getenv(entry.endpoint_env, '').strip()))


def model_catalog():
    entries = [entry for entry in configured_models() if available(entry)]
    groups = {kind:[{'id':entry.id, 'label':entry.label, 'provider':entry.provider} for entry in entries if entry.kind == kind] for kind in ('text','image')}
    return {'models':groups, 'defaults':{kind:items[0]['id'] if items else '' for kind, items in groups.items()}}


def resolve_model(selection='', kind='text'):
    entries = configured_models()
    if selection:
        entry = next((entry for entry in entries if entry.id == selection and entry.kind == kind), None)
        if entry is None:
            raise HTTPException(422, f'Unknown {kind} model. Reload the model list and choose again.')
    else:
        entry = next((entry for entry in entries if entry.kind == kind and available(entry)), None)
        if entry is None:
            raise HTTPException(503, f'No {kind} model is configured on the backend.')
    if not available(entry):
        raise HTTPException(503, f'{entry.label} is not configured on the backend. Choose another model.')
    return entry


def text_generation_options(model, token_limit):
    if model == 'gpt-5-nano' or model.startswith('gpt-5-nano-'):
        return {'max_completion_tokens':token_limit, 'extra_body':{'reasoning_effort':'minimal'}}
    if model.startswith(('gpt-5', 'o1', 'o3', 'o4')):
        return {'max_completion_tokens':token_limit}
    return {'max_tokens':token_limit}


def openai_client(entry):
    options = dict(api_key=os.environ[entry.key_env], timeout=120, max_retries=0)
    if entry.provider == 'azure':
        return AzureOpenAI(**options, azure_endpoint=os.environ[entry.endpoint_env],
                           api_version=os.getenv(entry.api_version_env, '2025-04-01-preview'))
    return OpenAI(**options)


def complete_text(entry, messages, token_limit=4000, schema=None):
    """Return complete text only; validate structured content at the caller."""
    try:
        if entry.provider in ('openai','azure'):
            with openai_client(entry) as client:
                options = text_generation_options(entry.model, token_limit)
                if schema:
                    options['response_format'] = {'type':'json_schema', 'json_schema':{'name':schema.__name__, 'strict':True, 'schema':schema.model_json_schema()}}
                response = client.chat.completions.create(model=entry.model, messages=messages, **options)
            choice = response.choices[0]
            if getattr(choice.message, 'refusal', None):
                raise HTTPException(422, 'The model declined this analysis. Revise the brief and retry.')
            if choice.finish_reason != 'stop':
                raise HTTPException(502, 'The analysis was incomplete. Shorten the brief and retry.')
            content = choice.message.content
        elif entry.provider == 'anthropic':
            from anthropic import Anthropic
            options = {}
            if schema:
                options = {'tools':[{'name':'submit_analysis','description':'Return the complete scientific analysis.', 'input_schema':schema.model_json_schema()}],
                           'tool_choice':{'type':'tool','name':'submit_analysis'}}
            with Anthropic(api_key=os.environ[entry.key_env], timeout=120, max_retries=0) as client:
                response = client.messages.create(model=entry.model, max_tokens=token_limit,
                    system='\n'.join(message['content'] for message in messages if message['role']=='system'),
                    messages=[message for message in messages if message['role']!='system'], **options)
            if response.stop_reason not in ('end_turn','tool_use'):
                raise HTTPException(502, 'The analysis was incomplete. Shorten the brief and retry.')
            if schema:
                block = next((block for block in response.content if block.type=='tool_use' and block.name=='submit_analysis'), None)
                content = json.dumps(block.input) if block else ''
            else:
                content = ''.join(block.text for block in response.content if block.type=='text')
        else:
            from google import genai
            options = {'system_instruction':'\n'.join(message['content'] for message in messages if message['role']=='system'), 'max_output_tokens':token_limit}
            if schema:
                options.update(response_mime_type='application/json', response_schema=schema)
            with genai.Client(api_key=os.environ[entry.key_env], http_options={'timeout':120000}) as client:
                response = client.models.generate_content(model=entry.model,
                    contents='\n'.join(message['content'] for message in messages if message['role']!='system'), config=options)
            if not response.candidates or response.candidates[0].finish_reason != 'STOP':
                raise HTTPException(502, 'The analysis was incomplete or declined. Revise the brief and retry.')
            content = response.text
        if not content or not content.strip():
            raise HTTPException(502, 'The model returned no analysis. Please retry.')
        return content
    except HTTPException:
        raise
    except OpenAIError as error:
        from .teaser import openai_error_detail
        raise HTTPException(502, openai_error_detail(error)) from None
    except ImportError:
        raise HTTPException(503, 'The selected provider SDK is missing. Install backend/requirements.txt.') from None
    except Exception:
        # Provider errors can contain keys, request bodies or endpoint URLs.
        raise HTTPException(502, f'{entry.label} analysis failed. Check provider access, quota and connectivity.') from None


def render_image(prompt, plan, selection, progress=lambda stage, message: None):
    entry = resolve_model(selection, 'image')
    if entry.provider == 'openai':
        from .teaser import render_openai_prompt
        return render_openai_prompt(prompt, plan, progress, config=entry)
    try:
        if entry.provider == 'azure':
            with openai_client(entry) as client:
                response = client.images.generate(model=entry.model, prompt=prompt, n=1,
                    size=os.getenv('OPENAI_IMAGE_SIZE', '1024x1024'), quality=os.getenv('OPENAI_IMAGE_QUALITY', 'low'),
                    extra_body={'output_format':'jpeg','output_compression':85})
            data = base64.b64decode(response.data[0].b64_json, validate=True)
        else:
            from google import genai
            with genai.Client(api_key=os.environ[entry.key_env], http_options={'timeout':240000}) as client:
                response = client.models.generate_content(model=entry.model, contents=prompt, config={'response_modalities':['TEXT','IMAGE']})
            parts = response.candidates[0].content.parts if response.candidates else []
            blob = next((part.inline_data for part in parts if part.inline_data and part.inline_data.mime_type.startswith('image/')), None)
            if not blob:
                raise ValueError('Missing image')
            data = blob.data
        mime = 'image/jpeg' if data.startswith(b'\xff\xd8\xff') else 'image/png' if data.startswith(b'\x89PNG\r\n\x1a\n') else None
        if not mime or len(data) < 1000:
            raise ValueError('Invalid image')
        progress('check', f'Checking the image returned by {entry.label}.')
        return {**plan, 'image':f'data:{mime};base64,{base64.b64encode(data).decode()}', 'model':entry.model,
                'imageModel':entry.id, 'source':f'{entry.provider}-image', 'drawingBrief':prompt,
                'providerNote':f'{entry.label}. Review scientific details.'}
    except HTTPException:
        raise
    except ImportError:
        raise HTTPException(503, 'The selected provider SDK is missing. Install backend/requirements.txt.') from None
    except Exception:
        raise HTTPException(502, f'{entry.label} image generation failed. Check model access, quota and connectivity, then retry.') from None
