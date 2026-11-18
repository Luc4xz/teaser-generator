# Teaser Studio

A focused workspace for turning research papers and user requests into illustrations.

## Current project workflow

1. **Sign in first.** The workspace, upload control, and generation controls are unavailable until the backend validates the session. An expired or rejected session returns to sign-in. Existing username/password registration is retained.
2. **Left column — paper and constraints.** Upload a PDF or paste paper text, choose image direction, audience and constraints, then click **Generate concept** at the bottom.
3. **Middle column — concept and snapshot review.** Expand **Scientific concept** to edit the six fields, then click **Generate image** at the bottom. A changed source paper requires concept regeneration. **Selected snapshot** shows the selected image’s saved concept, visual mapping, and refinement controls. Both sections can be folded.
4. **Right column — image canvas.** Each generation adds a version to the canvas. Select a card or click **Inspect & iterate** to open it in the review column. A refinement uses the currently selected text and image models. A retry preserves the failed run's selections and reuses its drawing prompt when available.

Projects and drafts autosave locally in IndexedDB. Shared boards sync published image snapshots. Switching accounts does not erase device-local projects. Workspace provides project naming, creation and reopening. Desktop uses three independently scrolling columns with generation actions pinned below the first two; mobile stacks them in workflow order.

Use the left icon rail to reopen folded panels. Drag a panel's grip onto the top or bottom half of the other panel to share a column, or click the grip for placement options. Fold both panels to use the full canvas. The Control Center icon and avatar stack both open the page for contributions and modification history. AI Chat opens its own page for previewing the interface.

In **Selected snapshot**, open **Edit figure** to add or move labels, arrows, and connectors. Choose **Draw** to add freehand strokes with an adjustable color and width. Save the edits as a new version. For new images, choose **Editable labels** in the image direction settings to get suggested text as editable layers when you open the editor.

To request approval, invite a coauthor to the shared board. Once they open it, select them in **Request review** and confirm the caption and alt text. The assigned reviewer can comment, approve, or request changes in **Control Center → Figure reviews**. Each edited version needs its own approval. **Export approved figure** downloads a ZIP with the PNG, caption, and alt text.

The backend validates the six concept fields and the visual plan, then compiles scientific concept, evidence and limits, visual mapping, composition, style, and exclusions into the drawing prompt. Concept extraction does not generate an image. Scientific claims and generated pixels still need human review. Failed runs preserve prior versions and expose the actual stage and retry controls.

### Text and image model selection

Open **Settings** in the top bar to select the text and image models independently:

| Purpose | Providers | Server API |
| --- | --- | --- |
| Text: long-paper summarization, concept extraction, visual planning | OpenAI, Azure OpenAI, Anthropic, Gemini | OpenAI/Azure chat completions, Anthropic Messages with a required structured tool, Google Gen AI `generate_content` |
| Images | OpenAI GPT Image, Azure GPT Image deployments, Gemini native image models | OpenAI Images, Azure Images SDK, Google Gen AI image output |

Every text provider's structured response is validated with the same Pydantic schemas. The Gemini image adapter uses native `generate_content` models (for example `gemini-2.5-flash-image`), not Imagen. OpenAI/Azure image entries must use GPT Image models, not DALL-E models with different parameters. Configure model IDs/deployment names available to your provider account.

Install dependencies and restart the API after updating configuration:

```bash
pip install -r backend/requirements.txt
uvicorn backend.app.main:app --reload --port 8000
```

With no explicit model registry, the existing `TEASER_TEXT_MODEL` (or `OPENAI_MODEL`) and `OPENAI_IMAGE_MODEL` create the default OpenAI menu entries. Add other providers using:

```dotenv
OPENAI_API_KEY=...
TEASER_TEXT_MODEL=gpt-5-nano
OPENAI_IMAGE_MODEL=gpt-image-1-mini
OPENAI_IMAGE_SIZE=1024x1024
OPENAI_IMAGE_QUALITY=low
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_VERSION=2025-04-01-preview
AZURE_OPENAI_TEXT_MODEL=your-text-deployment
AZURE_OPENAI_IMAGE_MODEL=your-gpt-image-deployment
ANTHROPIC_API_KEY=...
ANTHROPIC_TEXT_MODEL=your-enabled-claude-model
GEMINI_API_KEY=...
GEMINI_TEXT_MODEL=your-enabled-text-model
GEMINI_IMAGE_MODEL=gemini-2.5-flash-image
```

To offer several models from one provider, or assign a separate API key to each model, set `TEASER_MODELS_JSON` to a JSON array. It **replaces** the defaults. For example:

```dotenv
TEASER_MODELS_JSON='[{"id":"fast-text","label":"GPT-5 nano","kind":"text","provider":"openai","model":"gpt-5-nano","key_env":"OPENAI_TEXT_KEY"},{"id":"general-text","label":"GPT-4o","kind":"text","provider":"openai","model":"gpt-4o","key_env":"OPENAI_TEXT_KEY"},{"id":"image-mini","label":"GPT Image mini","kind":"image","provider":"openai","model":"gpt-image-1-mini","key_env":"OPENAI_IMAGE_KEY"},{"id":"image-standard","label":"GPT Image 1","kind":"image","provider":"openai","model":"gpt-image-1","key_env":"OPENAI_IMAGE_KEY"}]'
OPENAI_TEXT_KEY=...
OPENAI_IMAGE_KEY=...
```

Registry fields: unique `id`, display `label`, `kind` (`text`/`image`), `provider` (`openai`/`azure`/`anthropic`/`gemini`), provider `model`, and `key_env`. Azure entries may also specify `endpoint_env` and `api_version_env` to target different resources. Anthropic entries are text-only. Entries with missing keys or Azure endpoints are omitted from menus. A configured key does not guarantee the account has access to every listed model; provider failures are reported without substituting another model.

The browser obtains only IDs, labels, and providers from authenticated `GET /api/teaser/models`. Generation sends `text_model` and `image_model` IDs, never keys, endpoints, or SDK settings. The backend rejects unknown IDs and modality mismatches before starting work. All `/api/teaser/*` routes require a valid bearer session, including polling. `GET /api/auth/session` verifies saved sessions.

The current UI always submits explicit model selections. `TEASER_PROVIDER` remains available for older clients that omit `image_model` (legacy FLUX/OpenAI workflow and legacy Horde/Pollinations generation). It does not override an explicit image selection. Active runs are in backend memory; a server restart requires starting them again, while local saved versions remain available.

Provider references: [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=chat), [Anthropic Messages](https://platform.claude.com/docs/en/api/python/messages/create), [Google Gen AI SDK](https://github.com/googleapis/python-genai), [Gemini image generation](https://ai.google.dev/gemini-api/docs/image-generation), [Azure image generation](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/dall-e).

Validation:

```bash
python -m unittest discover -s backend/tests
node --test frontend/src/teaser/*.test.js
npm run build --prefix frontend
```

## Original backend prototype

The original FastAPI backend supports chat and live multimodal canvas artifacts. The following setup and endpoint notes apply to that backend, alongside the teaser image-generation endpoint.

## Structure

- `backend/` FastAPI server + Azure OpenAI orchestrator
- `frontend/` React + Vite UI
- `azure.py` Standalone Azure OpenAI smoke test (reads env vars)

## Setup

1. Create a `.env` file in the repo root based on `.env.example`.
2. Install backend deps and run the API.
3. Install frontend deps and run the UI.

## Run Backend

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.app.main:app --reload --port 8000
```

## Run Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`.

## Notes

- The backend exposes `GET /api/artifacts` for the component library and `POST /api/chat` for LLM-driven responses.
- Login endpoint:
  - `POST /api/auth/login` (local username/password auth; email is optional. Creates user on first login, validates password on later logins)
  - Session lifetime is controlled by `LOGIN_SESSION_HOURS` and clamped to 4-6 hours (default: 6).
  - Optional password salt config: `AUTH_PASSWORD_SALT`.
- Chat history persistence is enabled by default (SQLite). Configure with:
  - `CHAT_HISTORY_DB_PATH` (default: `backend/data/chat_history.db`)
  - Stored schema includes: `users`, `conversations`, `messages`, `artifacts`, `artifact_versions`, `tool_runs`
  - This captures first-generation artifacts and later refinement/version iterations in the same conversation.
  - Tool execution provenance is stored per turn (`tool_name`, `args_hash`, `status`, `latency_ms`, `output_summary`).
  - Artifact linkage supports explicit parent mapping (`parent_artifact_id` / `parent_version_id`) for clearer multi-step lineage.
- History inspection endpoints:
  - `GET /api/history/conversations?user_id=<id>&limit=50`
  - `GET /api/history/conversations/{conversation_id}`
- The chat backend now supports tool-driven online lookup (for example, weekly weather forecasts) before generating responses.
- Image generation is supported via Azure image deployment tool calls. Configure these env vars:
  - `AZURE_IMAGE_ENDPOINT` (e.g., `https://<resource>.cognitiveservices.azure.com`)
  - `AZURE_IMAGE_DEPLOYMENT` (default: `dall-e-3`)
  - `AZURE_IMAGE_API_VERSION` (default: `2024-02-01`)
  - Auth: either `AZURE_IMAGE_BEARER_TOKEN` or `AZURE_IMAGE_API_KEY`
- Region-based image refinement (mask + instruction) uses:
  - `POST /api/image/refine`
  - Optional edit overrides: `AZURE_IMAGE_EDIT_ENDPOINT`, `AZURE_IMAGE_EDIT_DEPLOYMENT`, `AZURE_IMAGE_EDIT_API_VERSION`
  - If edit-specific vars are omitted, it falls back to `AZURE_IMAGE_*`.
  - Important: `dall-e-3` deployments often support generations only. For region edits, use an edit-capable deployment (for example `gpt-image-1`) and set `AZURE_IMAGE_EDIT_API_VERSION` accordingly (commonly `2025-04-01-preview`).
- The canvas uses React Flow; each artifact is rendered as a draggable node.

### Collaborative concept canvas

The research studio uses three columns: source inputs, scientific concept review, and a React Flow snapshot board. Sign in in the left column (existing credentials are supported; a new username creates an account). Each new image captures the generating user's display name, timestamp, reviewed concept values, and parent snapshot. Select **Inspect & iterate** to refine a snapshot or revisit its saved concept and brief.

Open **Collaboration**, choose **Create shared board**, then **Copy invite link**. After a collaborator opens the link and signs in, the Collaboration menu displays the prefilled board ID. Choose **Join**. You can also paste the full invite link or the board ID into the menu. All participants must connect to the same backend. Board snapshots and card positions persist in SQLite alongside chat history; clients poll every three seconds and retry after connection failures. This supports near-live and asynchronous collaboration; it does not provide live cursors or simultaneous editing of a concept draft. Drafts remain personal, and iteration produces a new snapshot instead of modifying a previous result. Concurrent moves of the same card use the last server write.

Board access is link-based: any authenticated user holding the board ID can read snapshots (including their saved paper/brief) and move cards. Only snapshots attributed to the currently signed-in user are uploaded automatically; legacy snapshots remain local with an unknown creator. Sessions expire after the existing login duration; sign in again to resume synchronization. Local unsynced results remain available in the workspace.

### Shared production deployment (existing Render + GitHub Pages)

- Backend: `https://teaser-generator-3qny.onrender.com`
- Frontend: `https://luc4xz.github.io/teaser-generator/`
- GitHub repository variable `VITE_API_BASE_URL` must point to that backend before running **Deploy Frontend To GitHub Pages**. The value is compiled into the build; changing it requires a new build.
- Render build command: `pip install -r backend/requirements.txt`; start command: `sh backend/scripts/start.sh` (repository root). Use one service instance and one worker because active jobs are in memory.
- Keep the OpenAI key in Render environment variables. Set `CORS_ORIGINS=https://luc4xz.github.io` (additional origins may be comma-separated; do not include URL paths).
- For durable collaboration, attach a Render persistent disk at `/var/data`, then set `CHAT_HISTORY_DB_PATH=/var/data/chat_history.db`. If migrating an existing database, back it up and copy it to the disk before changing the path. A repository push does not create a disk or change the service environment. Without the disk, Render's ephemeral filesystem loses shared boards and accounts on restart/redeploy, although local browser snapshots remain.
- `GET /api/health` reports the deployed commit, supported features, and whether the SQLite path lies under a detected mounted filesystem. Verify disk provisioning in Render as well; mount detection is diagnostic, not a backup guarantee.
- A deployment interrupts running generation jobs; completed snapshots survive only when the database is on persistent storage.
