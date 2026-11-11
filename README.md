# Teaser Studio

A focused workspace for turning research papers and user requests into illustrations.

## Current project workflow

The OpenAI workflow now separates **paper → scientific concept → visual mapping → drawing prompt → image**:

1. Upload or paste the paper. The scientific concept is the source of the image subject; there is no separate free-text subject prompt.
2. After a paper is uploaded or pasted, the **Generate concept** button on the left becomes enabled. The resulting concept appears as a compact artifact on the right; expand **Review & edit** to edit six required fields: core concept, entities, relationships/mechanism, main finding, evidence, and limitations. Missing evidence must be stated explicitly; extraction does not verify claims.
3. Drag the reviewed concept card into the destination beside the paper upload card, or click **Confirm & move left**. This confirms the concept, locks all six fields, and enables image generation. The compact confirmed card has a **Return to canvas to edit** action, which restores the previous individual field locks. Confirmation and locks persist across reloads. Set image direction and constraints, then generate. Changing the source paper makes the concept stale and requires re-extraction; changing style does not.
4. The backend validates a structured visual plan that maps named concept fields to depictions and explains each connection. It compiles six fixed drawing-prompt sections: scientific concept; evidence and limits; visual mapping; composition; style and image text; exclusions. Required fields, field lengths, mapping references, refusal, and incomplete model outputs are checked before image generation.
5. Each version saves its concept, visual mapping, prompt sections, and exact rendering prompt. Inspect these on the right or use **Revisit paper & brief** to restore and edit the version’s concept in the right-hand artifact panel. Rendering-only revisions use saved or manually edited instructions; their mappings are not rebuilt or claimed to be revalidated.

Each source, brief, visual setting, and concept field has a **Keep / Change** lock toggle. Keep prevents edits and preserves the value when restoring or refining a version. Concept regeneration replaces only unlocked fields; locked fields are preserved by the backend even if the model returns different values. With all six concept fields locked, extraction returns them without another model call. Lock states autosave and are included in version snapshots. Image prompts explicitly give locked settings priority over conflicting revision feedback; generated pixels still require review.

Concept extraction uses `POST /api/teaser/concept` and makes no image request. New analysis uses OpenAI strict structured outputs plus backend Pydantic validation. Older versions without concepts remain viewable. Projects and their saved versions are local to this browser/device and remain available in **Workspace** when you create another project.


The desktop workspace has a 40% input panel and a 60% display canvas, with a compact header and no stage indicator. Upload a PDF (or paste text), describe the desired image, set optional research and visual requirements, and generate one image. Chat history and the previous research sidebar are not part
of this interface; generated image versions have a visual version stack at the far-right edge beside the selected image. The stack shows newest versions first, thumbnail previews, revision notes, timestamps, and parent versions. Select a card to view, download, or refine that version. Versions and the selected card are saved on this device across reloads, with saving/error status displayed above the stack. Smaller screens show a horizontal version strip and stack the input panel above the canvas.

Use **Workspace** in the header to name and save the current project, create a new project, or search and reopen saved projects. Each project preserves its paper, concept, parameter locks, settings, and image versions. Changes autosave, and switching saves the outgoing project first. Existing single-project storage migrates automatically. Projects are stored in this browser on this device, not synced to a cloud account. The button is unavailable while loading, uploading, or generating.

Each request generates one image, which can be expanded and downloaded. Each includes a
“Why this image?” card linking paper claims to planned visual elements, supporting quotes,
and the actual drawing prompt. These explain the plan, not a verified assessment of the
rendered image. If source-backed planning fails, generation still attempts a clearly
labelled creative interpretation. The previous image remains available if a new request fails.

Additional controls are collapsed by default: **Image direction** selects abstract,
illustrated, or realistic representation and an explanatory, thought-provoking, or balanced
purpose; **Audience & constraints** holds audience, facts to preserve, and exclusions.
The reviewed scientific concept owns the subject and mechanism. Retired free-text subject prompts are not sent by the concept or version workflow.
Publication front matter and common metadata are filtered before planning. Grounded drawing
instructions contain visual mappings and claims; fallback prompts use at most three short
research excerpts instead of the opening paper page. This extractive fallback remains unverified.
The explanation card shows cited quotes or short fallback context, not the full source dump.

### Image generation

To use OpenAI for the current version workflow, set these values in the root `.env` and restart the backend:

```dotenv
TEASER_PROVIDER=openai
OPENAI_API_KEY=your-api-key
TEASER_TEXT_MODEL=gpt-5-nano
OPENAI_IMAGE_MODEL=gpt-image-1-mini
OPENAI_IMAGE_SIZE=1024x1024
OPENAI_IMAGE_QUALITY=low
```

OpenAI mode uses OpenAI for both paper analysis and image generation, with no public-demo fallback. The key stays on the backend. Progress, saved versions, refinement, and retries work with either OpenAI or FLUX. Rendering retries reuse the saved drawing prompt without repeating analysis. API billing, access, and rate-limit errors appear in the workspace; no image version is saved on failure.

The default `TEASER_PROVIDER=flux-demo` calls the official Black Forest Labs
[FLUX.1-schnell public Space](https://huggingface.co/spaces/black-forest-labs/FLUX.1-schnell)
through its Gradio `/gradio_api/call/infer` API. The demo needs no key in the tested setup,
but availability, quotas, and authentication requirements can change. It renders 768×512
images in four steps. It is an illustration model, not a scientific verification system.

The image API receives a compact subject-first drawing prompt, not the raw paper or the
long planning essay. Portraits, people, author photographs and institutional logos are excluded
in the instructions. The rationale card exposes the exact instructions submitted. Common
metadata is filtered out before paper planning, and fallback context is limited to short excerpts.
The paper planner still uses Pollinations text with a local fallback if that service fails.
No other image provider is silently substituted on failure.

The workspace uses `POST /api/teaser/runs` to start background generation and polls
`GET /api/teaser/runs/{id}` for actual stages: source processing, visual planning, prompt
composition, provider rendering, and image-file validation. Completed plans and prompts
are inspectable while the provider is working. No fabricated percentages are shown.
The legacy `POST /api/teaser/generate` still returns the finished image. The backend reads the Gradio event
stream with bounded waits and rejects quota errors, unexpected download URLs, and invalid
image bytes. Use public demo papers and review scientific details in the output.

Optional providers remain explicitly configurable:

- `aihorde`: queued community rendering with `AI_HORDE_MODEL=stable_diffusion` or another
  available model, optional `AI_HORDE_API_KEY`. Anonymous Horde generations are shared by
  the provider; registered requests use `shared=false`. The UI polls `/api/teaser/jobs/{id}`.
- `pollinations`: legacy image route, not the default.
- `openai`: requires an API key and API credits, never an automatic fallback.

The desktop layout fits the viewport with a 56px header containing both panel titles and independently scrollable
40/60 panels. Image-direction settings are expanded by default; audience constraints and evidence links
remain collapsible. The Generate button stays pinned below the scrolling input area. Inputs, images, input snapshots, and version lineage autosave in IndexedDB. Each generation
adds a version instead of replacing the previous image. Selecting an earlier version lets
users rebuild its visual plan with feedback, edit its saved drawing prompt and rerender,
or restore its paper and brief for broader changes. FLUX renders new pixels from instructions;
this is not image-to-image editing. Prompt-only rerenders are explicitly not revalidated
against the paper. Failed rendering preserves the composed prompt for retry.
Active run IDs are saved so a page refresh reconnects. Runs live in backend memory; after
a server restart, saved versions remain but active runs must be started again.

Project article: [latest overview](docs/project-overview.md) · [plain text](docs/project-overview.txt).

Implementation: `frontend/src/teaser/`, `backend/app/teaser.py`, `backend/app/free_images.py`, and `backend/app/grounding.py`.

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

Choose **Create shared board**, then **Copy invite link**. A collaborator opens the link, signs in, and chooses **Join** with the prefilled board ID. All participants must connect to the same backend. Board snapshots and card positions persist in SQLite alongside chat history; clients poll every three seconds and retry after connection failures. This supports near-live and asynchronous collaboration; it does not provide live cursors or simultaneous editing of a concept draft. Drafts remain personal, and iteration produces a new snapshot instead of modifying a previous result. Concurrent moves of the same card use the last server write.

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
