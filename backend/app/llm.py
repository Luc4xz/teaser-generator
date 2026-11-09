from __future__ import annotations

import base64
import html
import json
import os
import re
import ssl
import time
import uuid
from datetime import datetime
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Tuple

from openai import AzureOpenAI, OpenAI

from .utils import parse_json_maybe


SYSTEM_PROMPT = """
You are an assistant that proposes polished, production-quality multimodal artifacts for a live canvas.
Use available tools whenever real-time or location-dependent data is requested (weather, "latest", "today", etc.).

Return ONLY valid JSON with the schema:
{
  "reply": "string",
  "artifacts": [
    {
      "id": "short-id",
      "name": "Human Name",
      "type": "html" | "image" | "text" | "code",
      "description": "short description",
      "code": "<html>...</html>",
      "image": "https://... or data:image/...",
      "text": "plain text",
      "language": "python|javascript|sql|...",
      "prompt": "optional prompt for generated images",
      "meta": {"optional": "extra metadata"}
    }
  ]
}
Rules:
- If type is html, include code with a complete HTML document.
- If type is image, include image (URL or data URI). Optionally include prompt/meta.
- For image artifacts, include `meta.base_prompt` and `meta.prompt_controls` for post-generation control widgets.
- `meta.prompt_controls` format:
  [
    {
      "id": "style",
      "label": "Style",
      "current": "editorial",
      "options": ["editorial", "cinematic", "minimalist", "illustrative"]
    }
  ]
- Controls must be linguistic prompt factors only (style, lighting, mood, composition, color palette, etc.). Do not use non-linguistic signals.
- If type is text, include text and keep it concise but informative.
- For text artifacts, prefer markdown-like structure (headings, bullets, numbered steps, short callouts).
- For text artifacts, use mixed emphasis intentionally:
  - Use inline tags for semantic emphasis when useful: [[metric:...]], [[risk:...]], [[trend:...]], [[date:...]], [[source:...]], [[action:...]], [[note:...]], [[key:...]].
  - Use markdown inline emphasis where useful: **bold**, _italic_, __underline__.
  - Do not tag every value; emphasize only high-signal items (typically 4-10 per text artifact).
- Prefer varied emphasis styles across different variable types instead of one repeated style.
- If type is code, include code and language.
- If the user requests runnable JavaScript/Python code, return a `code` artifact in that language (plain source only, not an HTML page).
- If no artifacts are needed, return artifacts as an empty array.
- Do not include markdown fences.

Quality bar:
- Output should be visually rich and modern: clean typography, spacing, subtle shadows, and a cohesive color palette.
- Visual direction should feel premium and intentional: layered backgrounds, soft gradients, elevated cards, and clear hierarchy.
- Prefer interactive UI: tooltips, hover states, sliders, toggles, or inline controls when relevant.
- Use only inline CSS and vanilla JS (no external dependencies).
- Keep layout responsive and fit within ~440x300 viewport without clipping.
- For html artifacts, provide a complete HTML document (doctype, head, body).
- For html artifacts, do not reference external assets or URLs (no http/https). For images inside HTML, use inline SVG or data URIs.
- Default to executive-level storytelling visuals, not minimal demos.
- For chart requests, include chart title, subtitle, axis labels, legend, and one interactive control.
- For chart requests, visuals must feel polished and presentation-ready:
  - Use a premium card layout with layered background, rounded corners, and subtle shadows.
  - Include readable axes/grid, a clear legend, and value labels or tooltips for data inspection.
  - Prefer smooth lines/curves, thoughtful color contrast, and non-overlapping labels.
  - Include one compact control (toggle, slider, or segmented selector) that changes the chart state.
  - Minimum interaction requirement: clicking a data mark (bar/point/segment) must trigger a visible state change (highlight + detail text/tooltip/panel update).
  - Keep chart cards focused on the visualization itself; avoid long narrative summaries inside the chart artifact.
- For concept-map requests (especially learning-coach style tasks), optimize for clarity over density:
  - Use one central topic node and 3-6 supporting concept nodes maximum.
  - Group nodes by category (for example: fundamentals, methods, pitfalls) with distinct colors.
  - Use directional connectors with short relationship labels (for example: "depends on", "causes", "used by").
  - Avoid crossing lines when possible; keep spacing generous and labels readable.
  - Include a compact side panel with "How to read this map" and 3 key takeaways.
  - Add simple node interaction (hover highlight + click to pin a short explanation panel).
  - If user provides weak concepts, prioritize only those concepts and their direct dependencies.
- Prefer multimodal packages when useful: a text summary + a visual chart + a code snippet.
- For weather/time-series queries, default to at least 3 artifacts: one html chart, one text summary, and one code snippet.
- For explicit image-generation requests, call the generate_image tool and return an image artifact from its result.
- For image-generation requests, identify 3-5 high-impact prompt factors and expose them via `meta.prompt_controls` with dropdown-ready options.
- Prefer SVG-based visuals for crisp rendering.
- Avoid placeholder UIs and generic lorem-style content.
- Default background should be neutral white/light gray unless the user explicitly asks for a themed background.

Structure guidance:
- Annotate major sections with data-part attributes for user editing (e.g., data-part="title", "subtitle", "x-axis", "y-axis", "legend", "controls", "footer").
- For charts, include clear title/subtitle blocks and axis labels with data-part attributes.
- For concept maps, include data-part markers at least for: "title", "legend", "nodes", "edges", and "details-panel".
""".strip()

IMG_SRC_RE = re.compile(
    r'(<img[^>]*\ssrc=["\\\'])(https?://[^"\\\']+)(["\\\'][^>]*>)',
    re.IGNORECASE,
)
HTTP_URL_RE = re.compile(r"https?://", re.IGNORECASE)
DATA_PART_RE = re.compile(r'data-part="[^"]+"', re.IGNORECASE)
HTML_TAG_RE = re.compile(r"<[^>]+>")
SLUG_RE = re.compile(r"[^a-z0-9-]+")
SCRIPT_TAG_RE = re.compile(r"<script\b[^>]*>(.*?)</script>", re.IGNORECASE | re.DOTALL)

WEATHER_CODE_LABELS = {
    0: "Clear",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Rime fog",
    51: "Light drizzle",
    53: "Drizzle",
    55: "Dense drizzle",
    56: "Freezing drizzle",
    57: "Dense freezing drizzle",
    61: "Slight rain",
    63: "Rain",
    65: "Heavy rain",
    66: "Freezing rain",
    67: "Heavy freezing rain",
    71: "Slight snow",
    73: "Snow",
    75: "Heavy snow",
    77: "Snow grains",
    80: "Rain showers",
    81: "Rain showers",
    82: "Violent rain showers",
    85: "Snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with hail",
    99: "Thunderstorm with heavy hail",
}

TOOLS: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "get_weather_forecast",
            "description": (
                "Get daily weather forecast for a location (including highs, lows, precipitation chance, and condition)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {
                        "type": "string",
                        "description": "City or place name, e.g. 'San Francisco' or 'Austin, TX'.",
                    },
                    "days": {
                        "type": "integer",
                        "description": "Number of forecast days from 1 to 14.",
                        "default": 7,
                    },
                    "unit": {
                        "type": "string",
                        "enum": ["fahrenheit", "celsius"],
                        "default": "fahrenheit",
                    },
                },
                "required": ["location"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_wikipedia",
            "description": "Search Wikipedia and return short snippets for quick factual grounding.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "How many results to return (1-5).",
                        "default": 3,
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "generate_image",
            "description": (
                "Generate an image from a prompt using Azure image generation deployment."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "Image generation prompt.",
                    },
                    "size": {
                        "type": "string",
                        "enum": ["1024x1024", "1024x1792", "1792x1024"],
                        "default": "1024x1024",
                    },
                    "style": {
                        "type": "string",
                        "enum": ["vivid", "natural"],
                        "default": "vivid",
                    },
                    "quality": {
                        "type": "string",
                        "enum": ["standard", "hd"],
                        "default": "standard",
                    },
                    "n": {
                        "type": "integer",
                        "description": "Number of images to generate. DALL-E 3 typically supports 1.",
                        "default": 1,
                    },
                },
                "required": ["prompt"],
            },
        },
    },
]


def _inline_placeholder_image(label: str) -> str:
    safe_label = label.replace("&", "and")
    svg = (
        "<svg xmlns='http://www.w3.org/2000/svg' width='440' height='300'>"
        "<defs><linearGradient id='bg' x1='0' y1='0' x2='1' y2='1'>"
        "<stop offset='0%' stop-color='#e2e8f0'/>"
        "<stop offset='100%' stop-color='#f8fafc'/>"
        "</linearGradient></defs>"
        "<rect width='100%' height='100%' rx='16' fill='url(#bg)'/>"
        "<rect x='16' y='16' width='408' height='268' rx='12' fill='white' stroke='#cbd5f5'/>"
        "<path d='M40 200 C90 140, 180 160, 240 120 C300 80, 360 100, 400 70' "
        "stroke='#2563eb' stroke-width='3' fill='none'/>"
        "<circle cx='110' cy='170' r='6' fill='#22c55e'/>"
        "<circle cx='340' cy='110' r='6' fill='#ef4444'/>"
        f"<text x='32' y='270' fill='#64748b' font-size='14' "
        f"font-family='Arial'>{safe_label}</text>"
        "</svg>"
    )
    encoded = svg.replace("#", "%23").replace("\n", "").replace(" ", "%20")
    return f"data:image/svg+xml;utf8,{encoded}"


def _inline_external_images(html: str) -> str:
    if not html:
        return html

    def _replace(match: re.Match) -> str:
        prefix, _url, suffix = match.groups()
        placeholder = _inline_placeholder_image("Generated Map")
        return f"{prefix}{placeholder}{suffix}"

    return IMG_SRC_RE.sub(_replace, html)


def _looks_like_chart_html(code: str) -> bool:
    lowered = str(code or "").lower()
    if not lowered:
        return False
    # Skip concept-map style visuals; they have their own dedicated template/UX.
    if "concept map" in lowered or (
        'data-part="nodes"' in lowered and 'data-part="details-panel"' in lowered
    ):
        return False

    has_plot_surface = "<svg" in lowered or "<canvas" in lowered
    hints = [
        'data-part="chart"',
        'data-part="legend"',
        'data-part="x-axis"',
        'data-part="y-axis"',
        "tooltip",
        "line chart",
        "bar chart",
        "scatter",
    ]
    score = sum(1 for hint in hints if hint in lowered)
    return (has_plot_surface and score >= 1) or score >= 2


def _inject_chart_theme(code: str) -> str:
    source = str(code or "")
    if not source:
        return source
    if not _looks_like_chart_html(source):
        return source
    if "chat-canvas-chart-theme" in source:
        return source

    theme_css = """
<style id="chat-canvas-chart-theme">
  :root {
    --cc-bg-a: #ffffff;
    --cc-bg-b: #f4f9ff;
    --cc-ink: #0f172a;
    --cc-muted: #64748b;
    --cc-soft: #e2ecff;
    --cc-accent: #1d4ed8;
    --cc-accent-2: #0891b2;
    --cc-shadow: 0 16px 30px rgba(15, 23, 42, 0.11);
  }
  body {
    margin: 0;
    padding: 8px;
    min-height: 100%;
    overflow: auto;
    background: radial-gradient(circle at 0% 0%, rgba(191, 219, 254, 0.32), rgba(255, 255, 255, 0) 46%),
      linear-gradient(150deg, var(--cc-bg-a), var(--cc-bg-b));
    color: var(--cc-ink);
    font-family: "Avenir Next", "Segoe UI", "Trebuchet MS", sans-serif;
  }
  .cc-chart-shell {
    position: relative;
    border: 1px solid #dbe7ff;
    border-radius: 14px;
    box-shadow: var(--cc-shadow);
    background: linear-gradient(165deg, #ffffff, #f8fbff);
    overflow: hidden;
  }
  .cc-chart-shell::before {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
      radial-gradient(circle at 0% 0%, rgba(186, 230, 253, 0.22), rgba(255, 255, 255, 0) 38%),
      radial-gradient(circle at 100% 100%, rgba(219, 234, 254, 0.18), rgba(255, 255, 255, 0) 40%);
  }
  .cc-chart-head {
    position: relative;
    z-index: 1;
    padding: 12px 12px 8px;
    border-bottom: 1px solid #e2e8f0;
    background: rgba(248, 251, 255, 0.86);
  }
  .cc-chart-title {
    margin: 0;
    font-size: 16px;
    line-height: 1.25;
    letter-spacing: 0.01em;
    font-weight: 800;
    color: #0b1220;
  }
  .cc-chart-subtitle {
    margin: 4px 0 0;
    font-size: 12px;
    line-height: 1.35;
    color: var(--cc-muted);
  }
  .cc-chart-meta {
    margin-top: 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .cc-chart-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 1px solid #dbeafe;
    border-radius: 999px;
    padding: 3px 8px;
    background: #f8fbff;
    color: #1e3a8a;
    font-size: 10px;
    font-weight: 700;
  }
  .cc-chart-content {
    position: relative;
    z-index: 1;
    padding: 10px;
    display: grid;
    gap: 8px;
  }
  [data-part="chart"] {
    width: 100%;
    min-height: 190px;
    border-radius: 12px;
    padding: 8px;
    border: 1px solid rgba(191, 219, 254, 0.72);
    box-shadow: 0 10px 22px rgba(15, 23, 42, 0.08);
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(248, 251, 255, 0.95)),
      linear-gradient(90deg, rgba(219, 234, 254, 0.35) 1px, transparent 1px);
    background-size: 100% 100%, 30px 100%;
    overflow: hidden;
  }
  [data-part="title"],
  [data-part="subtitle"],
  [data-part="chart"],
  [data-part="legend"],
  [data-part="controls"],
  [data-part="x-axis"],
  [data-part="y-axis"] {
    position: relative;
    z-index: 1;
  }
  [data-part="chart"] svg,
  [data-part="chart"] canvas,
  svg[data-part="chart"],
  canvas[data-part="chart"] {
    width: 100% !important;
    max-width: 100% !important;
    display: block;
    margin: 0 auto;
  }
  [data-part="chart"] svg,
  svg[data-part="chart"] {
    height: auto !important;
  }
  [data-part="chart"] canvas,
  canvas[data-part="chart"] {
    height: auto !important;
  }
  svg, canvas {
    box-sizing: border-box;
  }
  [data-part="legend"] {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 4px;
    margin-bottom: 6px;
  }
  [data-part="controls"] {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-top: 6px;
  }
  [data-part="controls"] input,
  [data-part="controls"] select,
  [data-part="controls"] button {
    max-width: 100%;
  }
  [data-part="x-axis"],
  [data-part="y-axis"] {
    display: inline-block;
    margin-top: 4px;
  }
  [data-part="chart"] * {
    max-width: 100%;
  }
  * {
    word-break: break-word;
  }
  [data-part="chart"] svg path,
  [data-part="chart"] svg line,
  [data-part="chart"] svg rect,
  [data-part="chart"] svg circle {
    transition: opacity 140ms ease, stroke-width 140ms ease, transform 140ms ease, filter 140ms ease;
  }
  [data-part="chart"] svg path:hover,
  [data-part="chart"] svg line:hover,
  [data-part="chart"] svg rect:hover,
  [data-part="chart"] svg circle:hover {
    opacity: 0.95;
    filter: saturate(1.08);
  }
  [data-part="chart"] svg [data-series]:hover {
    opacity: 1;
  }
  svg, canvas {
    border-radius: 12px;
    overflow: visible;
  }
  [data-part="title"] h1, [data-part="title"] h2, [data-part="title"] h3 {
    letter-spacing: 0.01em;
    margin: 0;
  }
  [data-part="subtitle"], [data-part="legend"], [data-part="x-axis"], [data-part="y-axis"] {
    color: var(--cc-muted);
  }
  [data-part="legend"] > * {
    background: #f8fbff;
    border: 1px solid #dbeafe;
    border-radius: 999px;
    padding: 3px 8px;
    font-size: 10px;
    font-weight: 700;
    color: #1e3a8a;
  }
  [data-part="controls"] > * {
    border-radius: 8px;
  }
  [data-part="controls"] input[type="range"] {
    accent-color: var(--cc-accent);
  }
  .cc-chart-live {
    border-color: #bfdbfe;
    background: #eff6ff;
    color: #1d4ed8;
  }
  .cc-axis-line {
    stroke: #94a3b8;
    stroke-width: 1.4;
    shape-rendering: geometricPrecision;
  }
  .cc-grid-line {
    stroke: #dbeafe;
    stroke-width: 1;
    stroke-dasharray: 2 3;
    shape-rendering: geometricPrecision;
  }
  .cc-axis-label {
    fill: #64748b;
    font-size: 9px;
    font-weight: 700;
    pointer-events: none;
  }
  .cc-bar-interactive {
    cursor: pointer;
  }
  .cc-mark-interactive {
    cursor: pointer;
  }
  .cc-bar-selected {
    stroke: #0f172a !important;
    stroke-width: 2.4 !important;
    opacity: 1 !important;
    filter: saturate(1.12);
  }
  .cc-mark-selected {
    opacity: 1 !important;
    filter: saturate(1.15) drop-shadow(0 0 4px rgba(37, 99, 235, 0.35));
  }
  .cc-control-btn {
    border: 1px solid #bfdbfe;
    background: #eff6ff;
    color: #1d4ed8;
    border-radius: 8px;
    padding: 4px 8px;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
  }
  .cc-control-btn:hover {
    border-color: #93c5fd;
    background: #dbeafe;
  }
  [role="tooltip"], .tooltip {
    border-radius: 8px !important;
    border: 1px solid #dbe7ff !important;
    background: rgba(255, 255, 255, 0.98) !important;
    color: #0f172a !important;
    box-shadow: 0 10px 22px rgba(15, 23, 42, 0.12) !important;
    padding: 6px 8px !important;
    font-size: 11px !important;
  }
</style>
""".strip()

    theme_script = """
<script id="chat-canvas-chart-theme-script">
  (function () {
    try {
      var body = document.body;
      var liveChip = null;

      var num = function (value, fallback) {
        var parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
      };

      var setLive = function (message) {
        if (!liveChip) return;
        liveChip.textContent = String(message || 'Interaction: click a mark for details');
      };

      if (body && !document.querySelector('.cc-chart-shell')) {
        var titleEl =
          document.querySelector('[data-part="title"] h1, [data-part="title"] h2, [data-part="title"] h3, h1, h2, h3');
        var subtitleEl = document.querySelector('[data-part="subtitle"]');
        var xAxisEl = document.querySelector('[data-part="x-axis"]');
        var yAxisEl = document.querySelector('[data-part="y-axis"]');
        var legendEl = document.querySelector('[data-part="legend"]');

        var titleText = (titleEl && titleEl.textContent ? titleEl.textContent : 'Interactive Chart').trim();
        var subtitleText = (subtitleEl && subtitleEl.textContent ? subtitleEl.textContent : 'Explore values directly on the chart area.').trim();
        var xText = (xAxisEl && xAxisEl.textContent ? xAxisEl.textContent : '').trim();
        var yText = (yAxisEl && yAxisEl.textContent ? yAxisEl.textContent : '').trim();
        var legendCount = legendEl ? legendEl.children.length : 0;

        var shell = document.createElement('section');
        shell.className = 'cc-chart-shell';
        var head = document.createElement('header');
        head.className = 'cc-chart-head';
        var meta = document.createElement('div');
        meta.className = 'cc-chart-meta';

        head.innerHTML =
          '<h3 class="cc-chart-title"></h3>' +
          '<p class="cc-chart-subtitle"></p>';
        head.querySelector('.cc-chart-title').textContent = titleText;
        head.querySelector('.cc-chart-subtitle').textContent = subtitleText || 'Interactive chart view';

        var chips = [];
        if (xText) chips.push('X: ' + xText);
        if (yText) chips.push('Y: ' + yText);
        if (legendCount > 0) chips.push('Legend: ' + legendCount + ' series');
        chips.push('Interaction ready');
        chips.slice(0, 3).forEach(function (label) {
          var chip = document.createElement('span');
          chip.className = 'cc-chart-chip';
          chip.textContent = label;
          meta.appendChild(chip);
        });
        liveChip = document.createElement('span');
        liveChip.className = 'cc-chart-chip cc-chart-live';
        liveChip.textContent = 'Interaction: click a mark for details';
        meta.appendChild(liveChip);
        head.appendChild(meta);

        var content = document.createElement('div');
        content.className = 'cc-chart-content';

        var nodesToMove = Array.prototype.slice
          .call(body.children)
          .filter(function (node) {
            return node !== shell && node.tagName !== 'SCRIPT' && node.id !== 'chat-canvas-chart-theme-script';
          });
        nodesToMove.forEach(function (node) {
          content.appendChild(node);
        });

        shell.appendChild(head);
        shell.appendChild(content);
        body.appendChild(shell);
      } else if (!liveChip) {
        liveChip = document.querySelector('.cc-chart-live');
      }

      var enhanceSvg = function (svg) {
        if (!svg || svg.getAttribute('data-cc-enhanced') === '1') return;

        if (!svg.getAttribute('viewBox')) {
          var w = num(svg.getAttribute('width'), Math.round(svg.getBoundingClientRect().width) || 420);
          var h = num(svg.getAttribute('height'), Math.round(svg.getBoundingClientRect().height) || 240);
          svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
        }
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        svg.style.width = '100%';
        svg.style.height = 'auto';

        var vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : null;
        var vbW = vb && vb.width ? vb.width : 420;
        var vbH = vb && vb.height ? vb.height : 240;

        var ensureAxes = function (bounds) {
          var left = num(bounds.left, Math.max(26, vbW * 0.1));
          var right = num(bounds.right, vbW - 10);
          var top = num(bounds.top, 10);
          var bottom = num(bounds.bottom, vbH - 20);

          var layer = svg.querySelector('[data-cc-layer="axes"]');
          if (!layer) {
            layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            layer.setAttribute('data-cc-layer', 'axes');
            svg.insertBefore(layer, svg.firstChild);
          }

          if (!svg.querySelector('[data-cc-axis="x"]')) {
            var xAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            xAxis.setAttribute('x1', String(left));
            xAxis.setAttribute('x2', String(right));
            xAxis.setAttribute('y1', String(bottom));
            xAxis.setAttribute('y2', String(bottom));
            xAxis.setAttribute('class', 'cc-axis-line');
            xAxis.setAttribute('data-cc-axis', 'x');
            layer.appendChild(xAxis);
          }

          if (!svg.querySelector('[data-cc-axis="y"]')) {
            var yAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            yAxis.setAttribute('x1', String(left));
            yAxis.setAttribute('x2', String(left));
            yAxis.setAttribute('y1', String(top));
            yAxis.setAttribute('y2', String(bottom));
            yAxis.setAttribute('class', 'cc-axis-line');
            yAxis.setAttribute('data-cc-axis', 'y');
            layer.appendChild(yAxis);
          }

          if (!svg.querySelector('[data-cc-grid="1"]')) {
            var ticks = 4;
            for (var i = 0; i <= ticks; i += 1) {
              var yTick = top + ((bottom - top) * i) / ticks;
              var grid = document.createElementNS('http://www.w3.org/2000/svg', 'line');
              grid.setAttribute('x1', String(left));
              grid.setAttribute('x2', String(right));
              grid.setAttribute('y1', String(yTick));
              grid.setAttribute('y2', String(yTick));
              grid.setAttribute('class', 'cc-grid-line');
              grid.setAttribute('data-cc-grid', '1');
              layer.appendChild(grid);

              var label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
              label.setAttribute('x', String(left - 6));
              label.setAttribute('y', String(yTick + 3));
              label.setAttribute('text-anchor', 'end');
              label.setAttribute('class', 'cc-axis-label');
              label.setAttribute('data-cc-grid', '1');
              label.textContent = String(Math.round((ticks - i) * (100 / ticks)));
              layer.appendChild(label);
            }
          }
        };

        var bars = Array.prototype.slice.call(svg.querySelectorAll('rect')).filter(function (rect) {
          var w = num(rect.getAttribute('width'), 0);
          var h = num(rect.getAttribute('height'), 0);
          var x = num(rect.getAttribute('x'), 0);
          var y = num(rect.getAttribute('y'), 0);
          var fill = String(rect.getAttribute('fill') || '').toLowerCase();
          if (fill === 'none') return false;
          if (w < 6 || h < 8) return false;
          if (w >= vbW * 0.6 && h >= vbH * 0.6) return false;
          if (x <= 1 && y <= 1 && w >= vbW * 0.8 && h >= vbH * 0.8) return false;
          return w < vbW * 0.35 && h < vbH * 0.95;
        });

        if (bars.length >= 2) {
          var minX = Infinity;
          var maxX = -Infinity;
          var minY = Infinity;
          var maxY = -Infinity;
          bars.forEach(function (bar) {
            var x = num(bar.getAttribute('x'), 0);
            var y = num(bar.getAttribute('y'), 0);
            var w = num(bar.getAttribute('width'), 0);
            var h = num(bar.getAttribute('height'), 0);
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x + w);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y + h);
          });
          ensureAxes({
            left: minX - 4,
            right: maxX + 4,
            top: minY - 2,
            bottom: maxY,
          });

          var existingBottomLabels = Array.prototype.slice.call(svg.querySelectorAll('text')).filter(function (t) {
            return num(t.getAttribute('y'), 0) >= maxY + 10;
          });
          if (existingBottomLabels.length < Math.max(2, Math.floor(bars.length / 2))) {
            var labelLayer = svg.querySelector('[data-cc-layer="axes"]');
            bars.forEach(function (bar, index) {
              if (svg.querySelector('[data-cc-xlbl="' + index + '"]')) return;
              var x = num(bar.getAttribute('x'), 0);
              var w = num(bar.getAttribute('width'), 0);
              var txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
              txt.setAttribute('x', String(x + w / 2));
              txt.setAttribute('y', String(Math.min(vbH - 4, maxY + 12)));
              txt.setAttribute('text-anchor', 'middle');
              txt.setAttribute('class', 'cc-axis-label');
              txt.setAttribute('data-cc-xlbl', String(index));
              txt.textContent = 'B' + String(index + 1);
              labelLayer.appendChild(txt);
            });
          }

          bars.forEach(function (bar, index) {
            bar.classList.add('cc-bar-interactive');
            if (bar.getAttribute('data-cc-bound') === '1') return;
            bar.setAttribute('data-cc-bound', '1');

            var barH = num(bar.getAttribute('height'), 0);
            var maxH = Math.max(1, maxY - minY);
            var value = Math.round((barH / maxH) * 100);

            bar.addEventListener('mouseenter', function () {
              setLive('Hover: bar ' + String(index + 1) + ' \u2022 value ' + String(value));
            });
            bar.addEventListener('click', function () {
              bars.forEach(function (b) { b.classList.remove('cc-bar-selected'); });
              bar.classList.add('cc-bar-selected');
              setLive('Selected bar ' + String(index + 1) + ' \u2022 value ' + String(value));
            });
          });
        } else {
          ensureAxes({
            left: Math.max(26, vbW * 0.1),
            right: vbW - 10,
            top: 10,
            bottom: vbH - 20,
          });

          var marks = Array.prototype.slice.call(svg.querySelectorAll('circle, path, rect')).filter(function (el) {
            if (el.closest('[data-cc-layer="axes"]')) return false;
            var tag = String(el.tagName || '').toLowerCase();
            if (tag === 'rect') {
              var rw = num(el.getAttribute('width'), 0);
              var rh = num(el.getAttribute('height'), 0);
              return rw < vbW * 0.5 && rh < vbH * 0.95;
            }
            return true;
          });
          marks.slice(0, 40).forEach(function (mark, index) {
            mark.classList.add('cc-mark-interactive');
            if (mark.getAttribute('data-cc-bound') === '1') return;
            mark.setAttribute('data-cc-bound', '1');
            mark.addEventListener('mouseenter', function () {
              setLive('Hover: mark ' + String(index + 1));
            });
            mark.addEventListener('click', function () {
              marks.forEach(function (m) { m.classList.remove('cc-mark-selected'); });
              mark.classList.add('cc-mark-selected');
              setLive('Selected mark ' + String(index + 1));
            });
          });
        }

        svg.setAttribute('data-cc-enhanced', '1');
      };

      var svgs = Array.prototype.slice.call(document.querySelectorAll('[data-part="chart"] svg, svg[data-part="chart"], svg'));
      svgs.forEach(enhanceSvg);

      var charts = Array.prototype.slice.call(document.querySelectorAll('[data-part="chart"]'));
      charts.forEach(function (chart) {
        chart.style.minHeight = Math.max(chart.clientHeight || 0, 190) + 'px';
      });

      var controlsHost = document.querySelector('[data-part="controls"]');
      if (!controlsHost) {
        var contentHost = document.querySelector('.cc-chart-content');
        if (contentHost) {
          controlsHost = document.createElement('div');
          controlsHost.setAttribute('data-part', 'controls');
          contentHost.appendChild(controlsHost);
        }
      }
      if (controlsHost && !controlsHost.querySelector('[data-cc-control="grid-toggle"]')) {
        var gridBtn = document.createElement('button');
        gridBtn.type = 'button';
        gridBtn.className = 'cc-control-btn';
        gridBtn.setAttribute('data-cc-control', 'grid-toggle');
        gridBtn.textContent = 'Toggle Grid';
        var gridOn = true;
        gridBtn.addEventListener('click', function () {
          gridOn = !gridOn;
          Array.prototype.slice.call(document.querySelectorAll('[data-cc-grid="1"]')).forEach(function (el) {
            el.style.display = gridOn ? '' : 'none';
          });
          setLive(gridOn ? 'Grid: on' : 'Grid: off');
        });
        controlsHost.appendChild(gridBtn);
      }
    } catch (_err) {}
  })();
</script>
""".strip()

    injection = f"{theme_css}\n{theme_script}"
    if "</head>" in source:
        return source.replace("</head>", f"{injection}</head>")
    return f"{injection}\n{source}"


def _is_weak_html(code: str) -> bool:
    if not code:
        return True
    if HTTP_URL_RE.search(code):
        return True
    if "via.placeholder" in code.lower():
        return True

    score = 0
    if "<style" in code:
        score += 1
    if "<script" in code:
        score += 1
    if "<svg" in code or "<canvas" in code:
        score += 1
    if len(DATA_PART_RE.findall(code)) >= 4:
        score += 1
    if len(code) >= 1200:
        score += 1

    return score < 4


def _latest_user_message(messages: List[Dict[str, str]]) -> str:
    for message in reversed(messages):
        if message.get("role") == "user":
            return str(message.get("content", "")).strip()
    return ""


def _slugify(value: str) -> str:
    lowered = value.strip().lower()
    normalized = SLUG_RE.sub("-", lowered).strip("-")
    return normalized or "artifact"


def _reply_indicates_failure(reply: str) -> bool:
    text = str(reply or "").strip().lower()
    if not text:
        return False

    patterns = [
        r"\bi am unable\b",
        r"\bi'm unable\b",
        r"\bunable to\b",
        r"\bcannot\b",
        r"\bcan't\b",
        r"\bfailed to\b",
        r"\btechnical issue\b",
        r"\bencountered an issue\b",
        r"\btry again later\b",
        r"\bunavailable\b",
    ]
    return any(re.search(pattern, text) for pattern in patterns)


def _reply_looks_like_raw_json_blob(reply: str) -> bool:
    text = str(reply or "").strip()
    if not text:
        return False
    lowered = text.lower()
    if lowered.startswith("```json") or lowered.startswith("```"):
        return True
    if lowered.startswith("{") and '"artifacts"' in lowered:
        return True
    if '"reply"' in lowered and '"artifacts"' in lowered and "{" in lowered:
        return True
    return False


def _find_tool_error(tool_outputs: List[Dict[str, Any]], tool_name: str) -> Optional[str]:
    for output in tool_outputs:
        if output.get("tool_name") != tool_name:
            continue
        result = output.get("result")
        if not isinstance(result, dict):
            continue
        message = str(result.get("error") or "").strip()
        if message:
            return message
    return None


def _build_image_failure_reply(tool_outputs: List[Dict[str, Any]]) -> Optional[str]:
    detail = _find_tool_error(tool_outputs, "generate_image")
    if not detail:
        return None
    return (
        f"Image generation failed: {detail}. "
        "Set AZURE_IMAGE_ENDPOINT, AZURE_IMAGE_DEPLOYMENT, and "
        "AZURE_IMAGE_BEARER_TOKEN (or AZURE_IMAGE_API_KEY), then retry."
    )


def _default_reply_from_artifacts(
    artifacts: List[Dict[str, Any]],
    user_text: str = "",
) -> str:
    safe_artifacts = artifacts if isinstance(artifacts, list) else []
    if not safe_artifacts:
        return "I could not generate artifacts for that request."

    normalized_types = [
        str(item.get("type") or "").strip().lower()
        for item in safe_artifacts
        if isinstance(item, dict)
    ]
    normalized_types = [item for item in normalized_types if item]
    lowered_user = str(user_text or "").lower()

    if len(safe_artifacts) == 1:
        first_type = normalized_types[0] if normalized_types else ""
        if first_type == "code":
            return "Generated one runnable code artifact."
        if first_type == "text":
            return "Generated one structured text artifact."
        if first_type == "image":
            return "Generated one image artifact."
        if first_type == "html":
            if re.search(r"\b(weather|forecast|temperature|rain|precipitation)\b", lowered_user):
                return "Generated one weather artifact."
            return "Generated one interactive chart artifact."
        return "Generated one artifact."

    if normalized_types:
        order = []
        seen = set()
        for item in normalized_types:
            if item in seen:
                continue
            seen.add(item)
            order.append(item)
        summary = ", ".join(order[:4])
        return f"Generated {len(safe_artifacts)} artifacts ({summary})."

    return f"Generated {len(safe_artifacts)} artifacts."


def _strip_html(text: str) -> str:
    return HTML_TAG_RE.sub("", text).strip()


def _parse_tool_arguments(raw_args: str) -> Dict[str, Any]:
    if not raw_args:
        return {}
    try:
        parsed = json.loads(raw_args)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        maybe = parse_json_maybe(raw_args)
        return maybe if isinstance(maybe, dict) else {}


def _http_json_get(url: str) -> Dict[str, Any]:
    request = urllib.request.Request(url=url, headers={"User-Agent": "chat-canvas/1.0"})
    contexts: List[Any] = [None]

    try:
        import certifi  # type: ignore

        contexts.append(ssl.create_default_context(cafile=certifi.where()))
    except Exception:
        pass

    contexts.append(ssl._create_unverified_context())

    last_error: Exception | None = None
    for index, context in enumerate(contexts):
        try:
            open_kwargs = {"timeout": 12}
            if context is not None:
                open_kwargs["context"] = context
            with urllib.request.urlopen(request, **open_kwargs) as response:
                payload = response.read().decode("utf-8")
            loaded = json.loads(payload)
            return loaded if isinstance(loaded, dict) else {}
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ssl.SSLError) as exc:
            last_error = exc
            if not _is_certificate_error(exc):
                break
            if index >= len(contexts) - 1:
                break
            continue

    if isinstance(last_error, urllib.error.URLError):
        raise last_error
    if isinstance(last_error, TimeoutError):
        raise last_error
    if isinstance(last_error, json.JSONDecodeError):
        raise last_error
    if isinstance(last_error, ssl.SSLError):
        raise urllib.error.URLError(last_error) from last_error
    raise urllib.error.URLError("Unknown HTTP fetch error")


def _http_json_post(url: str, payload: Dict[str, Any], headers: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    request_headers = {
        "User-Agent": "chat-canvas/1.0",
        "Content-Type": "application/json",
    }
    if headers:
        for key, value in headers.items():
            if value:
                request_headers[str(key)] = str(value)

    request = urllib.request.Request(url=url, data=body, headers=request_headers, method="POST")
    contexts: List[Any] = [None]

    try:
        import certifi  # type: ignore

        contexts.append(ssl.create_default_context(cafile=certifi.where()))
    except Exception:
        pass

    contexts.append(ssl._create_unverified_context())

    last_error: Exception | None = None
    for index, context in enumerate(contexts):
        try:
            open_kwargs = {"timeout": 30}
            if context is not None:
                open_kwargs["context"] = context
            with urllib.request.urlopen(request, **open_kwargs) as response:
                payload_text = response.read().decode("utf-8")
            loaded = json.loads(payload_text)
            return loaded if isinstance(loaded, dict) else {}
        except urllib.error.HTTPError as exc:
            detail = _extract_http_error_detail(exc)
            raise urllib.error.URLError(f"HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ssl.SSLError) as exc:
            last_error = exc
            if not _is_certificate_error(exc):
                break
            if index >= len(contexts) - 1:
                break
            continue

    if isinstance(last_error, urllib.error.URLError):
        raise last_error
    if isinstance(last_error, TimeoutError):
        raise last_error
    if isinstance(last_error, json.JSONDecodeError):
        raise last_error
    if isinstance(last_error, ssl.SSLError):
        raise urllib.error.URLError(last_error) from last_error
    raise urllib.error.URLError("Unknown HTTP post error")


def _http_bytes_get(url: str) -> bytes:
    request = urllib.request.Request(url=url, headers={"User-Agent": "chat-canvas/1.0"})
    contexts: List[Any] = [None]

    try:
        import certifi  # type: ignore

        contexts.append(ssl.create_default_context(cafile=certifi.where()))
    except Exception:
        pass

    contexts.append(ssl._create_unverified_context())

    last_error: Exception | None = None
    for index, context in enumerate(contexts):
        try:
            open_kwargs = {"timeout": 20}
            if context is not None:
                open_kwargs["context"] = context
            with urllib.request.urlopen(request, **open_kwargs) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            detail = _extract_http_error_detail(exc)
            raise urllib.error.URLError(f"HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError, ssl.SSLError) as exc:
            last_error = exc
            if not _is_certificate_error(exc):
                break
            if index >= len(contexts) - 1:
                break
            continue

    if isinstance(last_error, urllib.error.URLError):
        raise last_error
    if isinstance(last_error, TimeoutError):
        raise last_error
    if isinstance(last_error, ssl.SSLError):
        raise urllib.error.URLError(last_error) from last_error
    raise urllib.error.URLError("Unknown HTTP bytes fetch error")


def _decode_data_url_image(value: str) -> Tuple[str, bytes]:
    text = str(value or "").strip()
    match = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$", text, flags=re.IGNORECASE | re.DOTALL)
    if not match:
        raise ValueError("Invalid image data URL.")
    mime = str(match.group(1)).lower()
    payload = str(match.group(2) or "").strip()
    try:
        raw = base64.b64decode(payload, validate=True)
    except Exception as exc:
        raise ValueError("Invalid base64 image payload.") from exc
    return mime, raw


def _normalize_image_ref_to_bytes(image_ref: str, default_name: str) -> Tuple[str, str, bytes]:
    ref = str(image_ref or "").strip()
    if not ref:
        raise ValueError("Image input is required.")

    if ref.startswith("data:image/"):
        mime, content = _decode_data_url_image(ref)
        ext = mime.split("/", 1)[1] if "/" in mime else "png"
        filename = f"{default_name}.{ext}"
        return filename, mime, content

    if ref.startswith("http://") or ref.startswith("https://"):
        content = _http_bytes_get(ref)
        filename = f"{default_name}.png"
        return filename, "image/png", content

    raise ValueError("Image input must be an http(s) URL or data:image/... URL.")


def _encode_multipart_form_data(
    fields: Dict[str, str],
    files: List[Tuple[str, str, str, bytes]],
) -> Tuple[str, bytes]:
    boundary = f"----chatcanvas-{uuid.uuid4().hex}"
    body = bytearray()

    for key, value in fields.items():
        body.extend(f"--{boundary}\r\n".encode("utf-8"))
        body.extend(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode("utf-8"))
        body.extend(str(value).encode("utf-8"))
        body.extend(b"\r\n")

    for field_name, file_name, content_type, content in files:
        body.extend(f"--{boundary}\r\n".encode("utf-8"))
        body.extend(
            f'Content-Disposition: form-data; name="{field_name}"; filename="{file_name}"\r\n'.encode("utf-8")
        )
        body.extend(f"Content-Type: {content_type}\r\n\r\n".encode("utf-8"))
        body.extend(content)
        body.extend(b"\r\n")

    body.extend(f"--{boundary}--\r\n".encode("utf-8"))
    return boundary, bytes(body)


def _http_multipart_post(
    url: str,
    fields: Dict[str, str],
    files: List[Tuple[str, str, str, bytes]],
    headers: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    boundary, body = _encode_multipart_form_data(fields, files)

    request_headers = {
        "User-Agent": "chat-canvas/1.0",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    }
    if headers:
        for key, value in headers.items():
            if value:
                request_headers[str(key)] = str(value)

    request = urllib.request.Request(url=url, data=body, headers=request_headers, method="POST")
    contexts: List[Any] = [None]

    try:
        import certifi  # type: ignore

        contexts.append(ssl.create_default_context(cafile=certifi.where()))
    except Exception:
        pass

    contexts.append(ssl._create_unverified_context())

    last_error: Exception | None = None
    for index, context in enumerate(contexts):
        try:
            open_kwargs = {"timeout": 45}
            if context is not None:
                open_kwargs["context"] = context
            with urllib.request.urlopen(request, **open_kwargs) as response:
                payload_text = response.read().decode("utf-8")
            loaded = json.loads(payload_text)
            return loaded if isinstance(loaded, dict) else {}
        except urllib.error.HTTPError as exc:
            detail = _extract_http_error_detail(exc)
            raise urllib.error.URLError(f"HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ssl.SSLError) as exc:
            last_error = exc
            if not _is_certificate_error(exc):
                break
            if index >= len(contexts) - 1:
                break
            continue

    if isinstance(last_error, urllib.error.URLError):
        raise last_error
    if isinstance(last_error, TimeoutError):
        raise last_error
    if isinstance(last_error, json.JSONDecodeError):
        raise last_error
    if isinstance(last_error, ssl.SSLError):
        raise urllib.error.URLError(last_error) from last_error
    raise urllib.error.URLError("Unknown HTTP multipart post error")


def _extract_http_error_detail(exc: urllib.error.HTTPError) -> str:
    detail = str(exc.reason or "Request failed")
    try:
        body = exc.read().decode("utf-8")
        parsed = json.loads(body)
        if isinstance(parsed, dict):
            err_obj = parsed.get("error")
            if isinstance(err_obj, dict):
                message = str(err_obj.get("message") or "").strip()
                code = str(err_obj.get("code") or "").strip()
                if code and message:
                    return f"{code}: {message}"
                if message:
                    return message
            message = str(parsed.get("message") or "").strip()
            if message:
                return message
    except Exception:
        pass
    return detail


def _is_content_filter_error(message: str) -> bool:
    lowered = str(message or "").lower()
    markers = [
        "content filter",
        "content policy",
        "responsibleai",
        "safety system",
        "blocked by",
    ]
    return any(marker in lowered for marker in markers)


def _build_safety_adjusted_prompt(prompt: str) -> str:
    text = str(prompt or "").strip()
    if not text:
        return text

    replacements = [
        (r"\byoung woman\b", "adult woman"),
        (r"\byoung man\b", "adult man"),
        (r"\byoung girl\b", "adult woman"),
        (r"\byoung boy\b", "adult man"),
        (r"\bgirl\b", "woman"),
        (r"\bboy\b", "man"),
    ]
    adjusted = text
    for pattern, replacement in replacements:
        adjusted = re.sub(pattern, replacement, adjusted, flags=re.IGNORECASE)

    safety_clause = (
        "Non-explicit, non-sexual, fully clothed, and suitable for a general audience."
    )
    if safety_clause.lower() not in adjusted.lower():
        adjusted = f"{adjusted}. {safety_clause}"
    return re.sub(r"\s+", " ", adjusted).strip()


def _is_certificate_error(exc: BaseException) -> bool:
    if isinstance(exc, ssl.SSLCertVerificationError):
        return True

    reason = getattr(exc, "reason", None)
    if isinstance(reason, ssl.SSLCertVerificationError):
        return True

    message = str(exc).upper()
    return "CERTIFICATE_VERIFY_FAILED" in message or "SSL: CERTIFICATE" in message


def _clamp_int(value: Any, default: int, min_value: int, max_value: int) -> int:
    try:
        numeric = int(value)
    except (TypeError, ValueError):
        numeric = default
    return max(min_value, min(numeric, max_value))


def _unit_symbol(unit: str) -> str:
    return "F" if unit == "fahrenheit" else "C"


def _tool_get_weather_forecast(arguments: Dict[str, Any]) -> Dict[str, Any]:
    raw_location = str(arguments.get("location", "")).strip()
    location = _normalize_location(raw_location)
    if not location:
        return {"error": "location is required"}

    days = _clamp_int(arguments.get("days", 7), default=7, min_value=1, max_value=14)
    unit = str(arguments.get("unit", "fahrenheit")).strip().lower()
    if unit not in {"fahrenheit", "celsius"}:
        unit = "fahrenheit"

    errors: List[str] = []
    for candidate in _location_candidates(location):
        open_meteo = _fetch_open_meteo_weather(candidate, days, unit)
        if not open_meteo.get("error"):
            open_meteo["query"] = {"raw": raw_location, "resolved": candidate}
            return open_meteo
        errors.append(str(open_meteo.get("error")))

    for candidate in _location_candidates(location):
        wttr = _fetch_wttr_weather(candidate, days, unit)
        if not wttr.get("error"):
            wttr["query"] = {"raw": raw_location, "resolved": candidate}
            return wttr
        errors.append(str(wttr.get("error")))

    unique_errors: List[str] = []
    for message in errors:
        text = message.strip()
        if text and text not in unique_errors:
            unique_errors.append(text)
    detail = " | ".join(unique_errors[:3]) if unique_errors else "No provider returned forecast data."
    return {"error": f"Weather lookup failed for '{location}'. {detail}"}


def _normalize_location(raw: str) -> str:
    value = re.sub(r"\s+", " ", raw).strip(" \t\r\n,.;:-")
    if not value:
        return ""
    return value


def _location_candidates(location: str) -> List[str]:
    base = _normalize_location(location)
    if not base:
        return []

    candidates: List[str] = [base]
    lowered = base.lower()
    stop_fragments = [
        " with ",
        " summary",
        " and ",
        " chart",
        " text",
        " code",
        " snippet",
        " in json",
    ]
    for fragment in stop_fragments:
        idx = lowered.find(fragment)
        if idx > 1:
            candidates.append(base[:idx].strip(" ,.;:-"))

    match = re.search(
        r"(?:for|in)\s+([a-zA-Z][a-zA-Z\s,.'-]{1,80})",
        base,
        flags=re.IGNORECASE,
    )
    if match:
        candidates.append(match.group(1).strip(" ,.;:-"))

    for separator in [",", " - ", " / ", "|"]:
        if separator in base:
            left = base.split(separator, 1)[0].strip(" ,.;:-")
            if left:
                candidates.append(left)

    for keyword in [" for ", " in "]:
        if keyword in lowered:
            right = base.split(keyword, 1)[1].strip(" ,.;:-")
            if right:
                candidates.append(right)

    cleaned: List[str] = []
    for candidate in candidates:
        item = re.sub(r"\s+", " ", candidate).strip(" ,.;:-")
        item = re.sub(r"^(?:show|give|fetch|display|provide)\s+", "", item, flags=re.IGNORECASE)
        item = re.sub(r"^\d{1,2}\s*-\s*day\s+", "", item, flags=re.IGNORECASE)
        item = re.sub(r"^weekly\s+", "", item, flags=re.IGNORECASE)
        item = re.sub(r"^weather\s+(?:for|in)\s+", "", item, flags=re.IGNORECASE)
        item = re.sub(r"^forecast\s+(?:for|in)\s+", "", item, flags=re.IGNORECASE)
        item = re.sub(r"\b(summary|chart|text|code|snippet)\b.*$", "", item, flags=re.IGNORECASE)
        item = item.strip(" ,.;:-")
        if len(item) < 2:
            continue
        if item not in cleaned:
            cleaned.append(item)
    return cleaned[:5]


def _fetch_open_meteo_weather(location: str, days: int, unit: str) -> Dict[str, Any]:
    try:
        geocode_url = (
            "https://geocoding-api.open-meteo.com/v1/search?"
            f"name={urllib.parse.quote(location)}&count=1&language=en&format=json"
        )
        geocode = _http_json_get(geocode_url)
        matches = geocode.get("results") or []
        if not matches:
            return {"error": f"No match found for '{location}'."}

        top = matches[0]
        latitude = top.get("latitude")
        longitude = top.get("longitude")
        if latitude is None or longitude is None:
            return {"error": f"Incomplete geocoding data for '{location}'."}

        daily_fields = (
            "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_mean"
        )
        forecast_url = (
            "https://api.open-meteo.com/v1/forecast?"
            f"latitude={latitude}&longitude={longitude}"
            f"&daily={daily_fields}"
            f"&temperature_unit={unit}"
            f"&timezone=auto"
            f"&forecast_days={days}"
        )
        forecast = _http_json_get(forecast_url)
        daily = forecast.get("daily") or {}

        dates = list(daily.get("time") or [])
        highs = list(daily.get("temperature_2m_max") or [])
        lows = list(daily.get("temperature_2m_min") or [])
        precip = list(daily.get("precipitation_probability_mean") or [])
        codes = list(daily.get("weather_code") or [])

        rows: List[Dict[str, Any]] = []
        for index, date in enumerate(dates):
            weather_code = codes[index] if index < len(codes) else None
            condition = WEATHER_CODE_LABELS.get(int(weather_code), "Unknown") if weather_code is not None else "Unknown"
            rows.append(
                {
                    "date": date,
                    "condition": condition,
                    "high": highs[index] if index < len(highs) else None,
                    "low": lows[index] if index < len(lows) else None,
                    "precipitation_probability": precip[index] if index < len(precip) else None,
                }
            )

        return {
            "source": "open-meteo.com",
            "location": {
                "name": top.get("name"),
                "admin1": top.get("admin1"),
                "country": top.get("country"),
                "latitude": latitude,
                "longitude": longitude,
            },
            "unit": unit,
            "unit_symbol": _unit_symbol(unit),
            "forecast": rows,
        }
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        return {"error": f"Open-Meteo lookup failed: {exc}"}


def _fetch_wttr_weather(location: str, days: int, unit: str) -> Dict[str, Any]:
    try:
        wttr_url = (
            f"https://wttr.in/{urllib.parse.quote(location)}"
            f"?format=j1&num_of_days={days}"
        )
        payload = _http_json_get(wttr_url)
        weather_rows = payload.get("weather") or []
        if not weather_rows:
            return {"error": f"No wttr forecast rows for '{location}'."}

        rows: List[Dict[str, Any]] = []
        for item in weather_rows[:days]:
            hourly = item.get("hourly") or []
            midpoint = hourly[len(hourly) // 2] if hourly else {}
            descriptions = midpoint.get("weatherDesc") or []
            description = descriptions[0].get("value") if descriptions and isinstance(descriptions[0], dict) else "Unknown"

            precip_samples: List[int] = []
            for block in hourly:
                value = block.get("chanceofrain")
                try:
                    precip_samples.append(int(value))
                except (TypeError, ValueError):
                    continue
            precip_mean = round(sum(precip_samples) / len(precip_samples), 1) if precip_samples else None

            high_key = "maxtempF" if unit == "fahrenheit" else "maxtempC"
            low_key = "mintempF" if unit == "fahrenheit" else "mintempC"

            rows.append(
                {
                    "date": item.get("date"),
                    "condition": description,
                    "high": _coerce_float(item.get(high_key)),
                    "low": _coerce_float(item.get(low_key)),
                    "precipitation_probability": precip_mean,
                }
            )

        unit_symbol = _unit_symbol(unit)
        return {
            "source": "wttr.in",
            "location": {
                "name": location,
                "admin1": None,
                "country": None,
                "latitude": None,
                "longitude": None,
            },
            "unit": unit,
            "unit_symbol": unit_symbol,
            "forecast": rows,
        }
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        return {"error": f"wttr lookup failed: {exc}"}


def _coerce_float(value: Any) -> Any:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _tool_search_wikipedia(arguments: Dict[str, Any]) -> Dict[str, Any]:
    query = str(arguments.get("query", "")).strip()
    if not query:
        return {"error": "query is required"}

    limit = _clamp_int(arguments.get("limit", 3), default=3, min_value=1, max_value=5)
    try:
        url = (
            "https://en.wikipedia.org/w/api.php?"
            "action=query&list=search&format=json&utf8=1&srprop=snippet&srlimit="
            f"{limit}&srsearch={urllib.parse.quote(query)}"
        )
        payload = _http_json_get(url)
        results = payload.get("query", {}).get("search", [])

        items: List[Dict[str, str]] = []
        for result in results:
            title = str(result.get("title", "")).strip()
            snippet = _strip_html(str(result.get("snippet", "")))
            page_id = result.get("pageid")
            link = f"https://en.wikipedia.org/?curid={page_id}" if page_id else ""
            if title and snippet:
                items.append({"title": title, "snippet": snippet, "url": link})

        return {
            "source": "wikipedia.org",
            "query": query,
            "results": items[:limit],
        }
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        return {"error": f"Wikipedia lookup failed: {exc}"}


def _tool_generate_image(arguments: Dict[str, Any]) -> Dict[str, Any]:
    prompt = str(arguments.get("prompt", "")).strip()
    if not prompt:
        return {"error": "prompt is required"}

    size = str(arguments.get("size", "1024x1024")).strip().lower()
    if size not in {"1024x1024", "1024x1792", "1792x1024"}:
        size = "1024x1024"

    style = str(arguments.get("style", "vivid")).strip().lower()
    if style not in {"vivid", "natural"}:
        style = "vivid"

    quality = str(arguments.get("quality", "standard")).strip().lower()
    if quality not in {"standard", "hd"}:
        quality = "standard"

    n = _clamp_int(arguments.get("n", 1), default=1, min_value=1, max_value=1)

    endpoint = str(
        os.getenv("AZURE_IMAGE_ENDPOINT")
        or os.getenv("AZURE_OPENAI_ENDPOINT")
        or ""
    ).strip()
    deployment = str(os.getenv("AZURE_IMAGE_DEPLOYMENT", "dall-e-3")).strip() or "dall-e-3"
    api_version = str(os.getenv("AZURE_IMAGE_API_VERSION", "2024-02-01")).strip() or "2024-02-01"

    bearer_token = str(
        os.getenv("AZURE_IMAGE_BEARER_TOKEN")
        or os.getenv("AZURE_OPENAI_BEARER_TOKEN")
        or ""
    ).strip()
    api_key = str(
        os.getenv("AZURE_IMAGE_API_KEY")
        or os.getenv("AZURE_OPENAI_API_KEY")
        or ""
    ).strip()

    if not endpoint:
        return {"error": "Image generation endpoint is not configured (AZURE_IMAGE_ENDPOINT)."}
    if not bearer_token and not api_key:
        return {
            "error": (
                "Image generation credentials are missing. "
                "Set AZURE_IMAGE_BEARER_TOKEN or AZURE_IMAGE_API_KEY "
                "(AZURE_OPENAI_API_KEY is also accepted as a fallback)."
            )
        }

    url = (
        f"{endpoint.rstrip('/')}/openai/deployments/{urllib.parse.quote(deployment)}/images/generations"
        f"?api-version={urllib.parse.quote(api_version)}"
    )

    headers: Dict[str, str] = {}
    if bearer_token:
        headers["Authorization"] = f"Bearer {bearer_token}"
    else:
        headers["api-key"] = api_key

    def _request_image(prompt_text: str) -> Dict[str, Any]:
        body = {
            "model": deployment,
            "prompt": prompt_text,
            "size": size,
            "style": style,
            "quality": quality,
            "n": n,
        }
        payload = _http_json_post(url, body, headers=headers)
        items = payload.get("data") or []
        if not isinstance(items, list) or not items:
            return {"error": "Image generation returned no data."}

        first = items[0] if isinstance(items[0], dict) else {}
        image_url = str(first.get("url") or "").strip()
        b64_json = str(first.get("b64_json") or "").strip()
        revised_prompt = str(first.get("revised_prompt") or "").strip() or None

        image = image_url
        if b64_json:
            try:
                base64.b64decode(b64_json, validate=True)
                image = f"data:image/png;base64,{b64_json}"
            except Exception:
                image = ""

        if not image:
            return {"error": "Image generation returned neither URL nor valid base64 image."}

        return {
            "source": "azure-image",
            "deployment": deployment,
            "prompt": prompt_text,
            "revised_prompt": revised_prompt,
            "size": size,
            "style": style,
            "quality": quality,
            "image": image,
        }

    try:
        return _request_image(prompt)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        if _is_content_filter_error(str(exc)):
            safe_prompt = _build_safety_adjusted_prompt(prompt)
            if safe_prompt and safe_prompt != prompt:
                try:
                    retried = _request_image(safe_prompt)
                    retried["safety_adjusted"] = True
                    retried["original_prompt"] = prompt
                    retried["prompt"] = safe_prompt
                    return retried
                except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as retry_exc:
                    return {
                        "error": (
                            "Image generation was blocked by content filters after safety adjustment. "
                            "Try safer wording (for example, use 'adult woman' instead of 'young woman') "
                            f"and avoid sensitive cues. Details: {retry_exc} "
                            f"(endpoint={endpoint.rstrip('/')}, deployment={deployment}, api_version={api_version})"
                        )
                    }
        return {
            "error": (
                f"Image generation failed: {exc} "
                f"(endpoint={endpoint.rstrip('/')}, deployment={deployment}, api_version={api_version})"
            )
        }


def _normalize_prompt_controls_payload(
    controls: Any,
    selections: Optional[Dict[str, str]] = None,
) -> List[Dict[str, Any]]:
    if not isinstance(controls, list):
        return []
    selected = selections if isinstance(selections, dict) else {}
    normalized: List[Dict[str, Any]] = []

    for index, item in enumerate(controls):
        if not isinstance(item, dict):
            continue
        control_id = str(item.get("id") or f"control-{index + 1}").strip()
        if not control_id:
            continue
        label = str(item.get("label") or control_id).strip() or control_id
        raw_options = item.get("options")
        options: List[str] = []
        if isinstance(raw_options, list):
            for option in raw_options:
                if isinstance(option, str):
                    value = option.strip()
                    if value:
                        options.append(value)
                elif isinstance(option, dict):
                    value = str(option.get("value") or option.get("label") or "").strip()
                    if value:
                        options.append(value)
        options = _dedupe_text(options)
        current = str(selected.get(control_id) or item.get("current") or "").strip()
        if current and current not in options:
            options = [current] + options
        if not current:
            current = options[0] if options else ""
        if not options and current:
            options = [current]
        normalized.append(
            {
                "id": control_id,
                "label": label,
                "current": current,
                "options": options,
            }
        )
    return normalized


def _tool_edit_image_region(arguments: Dict[str, Any]) -> Dict[str, Any]:
    image_ref = str(arguments.get("image", "")).strip()
    mask_ref = str(arguments.get("mask", "")).strip()
    instruction = str(arguments.get("instruction", "")).strip()
    base_prompt = str(arguments.get("base_prompt", "")).strip()
    size = str(arguments.get("size", "1024x1024")).strip().lower()
    selections = arguments.get("selections") if isinstance(arguments.get("selections"), dict) else {}
    controls = _normalize_prompt_controls_payload(arguments.get("controls"), selections)

    if not image_ref:
        return {"error": "image is required"}
    if not mask_ref:
        return {"error": "mask is required"}
    if not instruction:
        return {"error": "instruction is required"}
    if size not in {"1024x1024", "1024x1792", "1792x1024"}:
        size = "1024x1024"

    edit_endpoint_env = str(os.getenv("AZURE_IMAGE_EDIT_ENDPOINT") or "").strip()
    image_endpoint_env = str(os.getenv("AZURE_IMAGE_ENDPOINT") or "").strip()
    openai_endpoint_env = str(os.getenv("AZURE_OPENAI_ENDPOINT") or "").strip()
    endpoint = edit_endpoint_env or image_endpoint_env or openai_endpoint_env

    edit_deployment_env = str(os.getenv("AZURE_IMAGE_EDIT_DEPLOYMENT") or "").strip()
    image_deployment_env = str(os.getenv("AZURE_IMAGE_DEPLOYMENT") or "").strip()
    deployment = edit_deployment_env or image_deployment_env or "dall-e-3"

    edit_api_version_env = str(os.getenv("AZURE_IMAGE_EDIT_API_VERSION") or "").strip()
    image_api_version_env = str(os.getenv("AZURE_IMAGE_API_VERSION") or "").strip()
    primary_api_version = edit_api_version_env or image_api_version_env or "2024-02-01"
    if edit_api_version_env:
        api_versions = [primary_api_version]
    else:
        api_versions = _dedupe_text(
            [
                primary_api_version,
                "2025-04-01-preview",
                "2024-02-01",
            ]
        )

    bearer_token = str(
        os.getenv("AZURE_IMAGE_BEARER_TOKEN")
        or os.getenv("AZURE_OPENAI_BEARER_TOKEN")
        or ""
    ).strip()
    api_key = str(
        os.getenv("AZURE_IMAGE_API_KEY")
        or os.getenv("AZURE_OPENAI_API_KEY")
        or ""
    ).strip()

    if not endpoint:
        return {"error": "Image edit endpoint is not configured (AZURE_IMAGE_EDIT_ENDPOINT)."}
    if not bearer_token and not api_key:
        return {
            "error": (
                "Image edit credentials are missing. "
                "Set AZURE_IMAGE_BEARER_TOKEN or AZURE_IMAGE_API_KEY "
                "(AZURE_OPENAI_API_KEY is also accepted as a fallback)."
            )
        }
    if deployment.lower() == "dall-e-3":
        return {
            "error": (
                "Image edit is not supported by deployment 'dall-e-3'. "
                "Set AZURE_IMAGE_EDIT_DEPLOYMENT to an edit-capable deployment "
                "(for example 'gpt-image-1') and set "
                "AZURE_IMAGE_EDIT_API_VERSION=2025-04-01-preview."
            )
        }

    try:
        image_file = _normalize_image_ref_to_bytes(image_ref, "source")
        mask_file = _normalize_image_ref_to_bytes(mask_ref, "mask")
    except (ValueError, urllib.error.URLError) as exc:
        return {"error": f"Invalid image or mask input: {exc}"}

    control_lines = [
        f"- {item.get('label', item.get('id', 'Option'))}: {item.get('current', '')}"
        for item in controls
        if str(item.get("current") or "").strip()
    ]
    prompt_parts = [
        base_prompt or "Preserve the original image composition and subject.",
        f"Edit instruction: {instruction}",
        "Only edit the masked area and keep everything else unchanged.",
        "Do not alter identity, pose, camera angle, background, or style outside the masked region.",
    ]
    if control_lines:
        prompt_parts.append("Prompt controls:")
        prompt_parts.extend(control_lines)
    edit_prompt = "\n".join(prompt_parts)

    headers: Dict[str, str] = {}
    if bearer_token:
        headers["Authorization"] = f"Bearer {bearer_token}"
    else:
        headers["api-key"] = api_key

    fields = {
        "prompt": edit_prompt,
        "n": "1",
        "size": size,
        "model": deployment,
    }
    files = [
        ("image", image_file[0], image_file[1], image_file[2]),
        ("mask", mask_file[0], mask_file[1], mask_file[2]),
    ]
    endpoint_root = endpoint.rstrip("/")
    quoted_deployment = urllib.parse.quote(deployment)
    attempt_targets: List[Tuple[str, str]] = []
    for api_version in api_versions:
        quoted_version = urllib.parse.quote(api_version)
        attempt_targets.append(
            (
                api_version,
                f"{endpoint_root}/openai/deployments/{quoted_deployment}/images/edits"
                f"?api-version={quoted_version}",
            )
        )
        attempt_targets.append(
            (
                api_version,
                f"{endpoint_root}/openai/images/edits?api-version={quoted_version}",
            )
        )

    seen_urls: set[str] = set()
    deduped_attempts: List[Tuple[str, str]] = []
    for api_version, url in attempt_targets:
        if url in seen_urls:
            continue
        seen_urls.add(url)
        deduped_attempts.append((api_version, url))

    failures: List[str] = []
    for api_version, url in deduped_attempts:
        try:
            payload = _http_multipart_post(url, fields, files, headers=headers)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            route = "deployment" if "/deployments/" in url else "global"
            failures.append(f"{exc} (api_version={api_version}, route={route})")
            continue

        items = payload.get("data") or []
        if not isinstance(items, list) or not items:
            err_obj = payload.get("error")
            err_message = ""
            if isinstance(err_obj, dict):
                err_message = str(err_obj.get("message") or err_obj.get("code") or "").strip()
            if not err_message:
                err_message = str(payload.get("message") or "").strip()
            if not err_message:
                err_message = "Image edit returned no data."
            route = "deployment" if "/deployments/" in url else "global"
            failures.append(f"{err_message} (api_version={api_version}, route={route})")
            continue

        first = items[0] if isinstance(items[0], dict) else {}
        image_url = str(first.get("url") or "").strip()
        b64_json = str(first.get("b64_json") or "").strip()
        revised_prompt = str(first.get("revised_prompt") or "").strip() or None

        image = image_url
        if b64_json:
            try:
                base64.b64decode(b64_json, validate=True)
                image = f"data:image/png;base64,{b64_json}"
            except Exception:
                image = ""

        if not image:
            failures.append(
                f"Image edit returned neither URL nor valid base64 image. "
                f"(api_version={api_version}, route={'deployment' if '/deployments/' in url else 'global'})"
            )
            continue

        return {
            "source": "azure-image-edit",
            "deployment": deployment,
            "prompt": edit_prompt,
            "original_prompt": base_prompt or None,
            "revised_prompt": revised_prompt,
            "size": size,
            "image": image,
            "edit_instruction": instruction,
            "prompt_controls": controls,
        }

    detail = " | ".join(failures[:2]) if failures else "No edit response payload returned."
    hint = ""
    lowered_failures = detail.lower()
    if deployment.lower() == "dall-e-3" and ("404" in lowered_failures or "resource not found" in lowered_failures):
        hint = (
            " The configured edit deployment appears to be dall-e-3, which commonly supports generation only. "
            "Set AZURE_IMAGE_EDIT_DEPLOYMENT to an edit-capable deployment (for example gpt-image-1) and "
            "AZURE_IMAGE_EDIT_API_VERSION to 2025-04-01-preview."
        )

    return {
        "error": (
            f"Image edit failed: {detail} "
            f"(endpoint={endpoint_root}, deployment={deployment}){hint}"
        )
    }


TOOL_REGISTRY: Dict[str, Callable[[Dict[str, Any]], Dict[str, Any]]] = {
    "get_weather_forecast": _tool_get_weather_forecast,
    "search_wikipedia": _tool_search_wikipedia,
    "generate_image": _tool_generate_image,
}


def _run_tool_calls(tool_calls: Any) -> List[Dict[str, Any]]:
    outputs: List[Dict[str, Any]] = []
    for call in tool_calls or []:
        fn = getattr(call, "function", None)
        call_id = str(getattr(call, "id", "") or "")
        name = getattr(fn, "name", "") if fn else ""
        args_raw = getattr(fn, "arguments", "") if fn else ""
        args = _parse_tool_arguments(args_raw)
        handler = TOOL_REGISTRY.get(name)

        if not handler:
            outputs.append(
                {
                    "tool_call_id": call_id,
                    "tool_name": name or "unknown",
                    "arguments": args,
                    "result": {"error": f"Unknown tool: {name}"},
                    "status": "error",
                    "latency_ms": 0,
                }
            )
            continue

        started_at = time.perf_counter()
        result = handler(args)
        latency_ms = int((time.perf_counter() - started_at) * 1000)
        status = "error" if isinstance(result, dict) and result.get("error") else "ok"
        outputs.append(
            {
                "tool_call_id": call_id,
                "tool_name": name,
                "arguments": args,
                "result": result,
                "status": status,
                "latency_ms": latency_ms,
            }
        )

    return outputs


def _build_weather_display_name(result: Dict[str, Any]) -> str:
    location = result.get("location") or {}
    parts = [
        str(location.get("name") or "").strip(),
        str(location.get("admin1") or "").strip(),
        str(location.get("country") or "").strip(),
    ]
    filtered = [part for part in parts if part]
    return ", ".join(filtered) or "Selected Location"


def _build_weather_summary_text(result: Dict[str, Any]) -> str:
    rows = [row for row in result.get("forecast", []) if isinstance(row, dict)]
    if not rows:
        return "Forecast data is currently unavailable."

    unit_symbol = str(result.get("unit_symbol", "F")).upper()
    location_name = _build_weather_display_name(result)
    highs = [row.get("high") for row in rows if isinstance(row.get("high"), (int, float))]
    lows = [row.get("low") for row in rows if isinstance(row.get("low"), (int, float))]
    precip_values = [
        row.get("precipitation_probability")
        for row in rows
        if isinstance(row.get("precipitation_probability"), (int, float))
    ]

    mean_high = round(sum(highs) / len(highs), 1) if highs else None
    mean_low = round(sum(lows) / len(lows), 1) if lows else None
    wettest = max(
        rows,
        key=lambda item: item.get("precipitation_probability")
        if isinstance(item.get("precipitation_probability"), (int, float))
        else -1,
    )

    lines = [
        f"7-day outlook for {location_name}",
        f"Source: {result.get('source', 'weather service')}",
    ]
    if mean_high is not None and mean_low is not None:
        lines.append(f"Average range: {mean_low}{unit_symbol} to {mean_high}{unit_symbol}")
    if precip_values:
        lines.append(f"Average precipitation chance: {round(sum(precip_values) / len(precip_values), 1)}%")

    wettest_day = wettest.get("date")
    wettest_chance = wettest.get("precipitation_probability")
    if wettest_day and isinstance(wettest_chance, (int, float)):
        lines.append(f"Highest rain probability: {wettest_chance}% on {wettest_day}")

    return "\n".join(lines)


def _build_weather_code_snippet(result: Dict[str, Any], days: int) -> str:
    location = result.get("location") or {}
    latitude = location.get("latitude")
    longitude = location.get("longitude")
    unit = str(result.get("unit", "fahrenheit"))

    if isinstance(latitude, (int, float)) and isinstance(longitude, (int, float)):
        return (
            "import requests\n\n"
            f"LAT = {latitude}\n"
            f"LON = {longitude}\n"
            f"DAYS = {days}\n"
            f"TEMP_UNIT = \"{unit}\"\n\n"
            "url = (\n"
            "    \"https://api.open-meteo.com/v1/forecast\"\n"
            "    f\"?latitude={LAT}&longitude={LON}\"\n"
            "    \"&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_mean\"\n"
            "    f\"&temperature_unit={TEMP_UNIT}&timezone=auto&forecast_days={DAYS}\"\n"
            ")\n"
            "payload = requests.get(url, timeout=15).json()\n"
            "for i, date in enumerate(payload.get(\"daily\", {}).get(\"time\", [])):\n"
            "    high = payload[\"daily\"][\"temperature_2m_max\"][i]\n"
            "    low = payload[\"daily\"][\"temperature_2m_min\"][i]\n"
            "    rain = payload[\"daily\"][\"precipitation_probability_mean\"][i]\n"
            "    print(date, high, low, rain)\n"
        )

    safe_location = _build_weather_display_name(result).replace("\\", "\\\\").replace('"', '\\"')
    return (
        "import requests\n\n"
        f"LOCATION = \"{safe_location}\"\n"
        f"DAYS = {days}\n\n"
        "url = f\"https://wttr.in/{LOCATION}?format=j1&num_of_days={DAYS}\"\n"
        "payload = requests.get(url, timeout=15).json()\n"
        "for day in payload.get(\"weather\", []):\n"
        "    print(day.get(\"date\"), day.get(\"maxtempF\"), day.get(\"mintempF\"))\n"
    )


def _wants_weather_text_artifact(user_text: str) -> bool:
    lowered = str(user_text or "").lower()
    if not lowered:
        return False
    return bool(
        re.search(
            r"\b(summary|text|bullet|bullets|analysis|explain|explanation|overview|narrative)\b",
            lowered,
        )
    )


def _wants_weather_code_artifact(user_text: str) -> bool:
    lowered = str(user_text or "").lower()
    if not lowered:
        return False
    return bool(
        re.search(
            r"\b(code|python|javascript|js|snippet|script|function|program)\b",
            lowered,
        )
    )


def _weekday_label(date_text: str) -> str:
    value = str(date_text).strip()
    try:
        return datetime.strptime(value, "%Y-%m-%d").strftime("%a")
    except ValueError:
        return value[5:] if len(value) >= 5 else value


def _condition_icon(condition: str) -> str:
    lowered = condition.lower()
    if "thunder" in lowered:
        return "storm"
    if "snow" in lowered or "sleet" in lowered:
        return "snow"
    if "rain" in lowered or "drizzle" in lowered or "shower" in lowered:
        return "rain"
    if "fog" in lowered or "mist" in lowered:
        return "fog"
    if "cloud" in lowered or "overcast" in lowered:
        return "cloud"
    return "sun"


def _build_weather_html_artifact(result: Dict[str, Any]) -> Dict[str, Any]:
    rows = [row for row in result.get("forecast", []) if isinstance(row, dict)]
    location_name = _build_weather_display_name(result)
    source = str(result.get("source", "weather service"))
    unit_symbol = str(result.get("unit_symbol", "F")).upper()
    safe_data: List[Dict[str, Any]] = []
    for row in rows:
        safe_data.append(
            {
                "date": str(row.get("date", "")),
                "day": _weekday_label(str(row.get("date", ""))),
                "condition": str(row.get("condition", "Unknown")),
                "icon": _condition_icon(str(row.get("condition", "Unknown"))),
                "high": row.get("high"),
                "low": row.get("low"),
                "precip": row.get("precipitation_probability"),
            }
        )
    data_json = json.dumps(safe_data)

    template = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Weekly Forecast</title>
  <style>
    :root { --ink:#10243f; --muted:#5f6f88; --line:#2f80ed; --line-2:#16a34a; --rain:#f59e0b; --surface:#ffffff; --edge:#dbe7ff; --card:#f8fbff; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:'Avenir Next','Segoe UI',sans-serif; color:var(--ink); background:radial-gradient(circle at 15% 0%,#eaf2ff 0%,#f8fbff 38%,#ffffff 75%); }
    .card { width:100%; max-width:440px; min-height:300px; margin:0 auto; padding:12px; display:grid; gap:10px; }
    .head { background:linear-gradient(145deg,#ffffff,#f3f8ff); border:1px solid var(--edge); border-radius:16px; padding:10px 12px; box-shadow:0 14px 30px rgba(47,128,237,.16); display:grid; gap:8px; }
    .title-row { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; }
    .title { margin:0; font-size:17px; font-weight:800; letter-spacing:.01em; }
    .sub { margin:4px 0 0; font-size:12px; color:var(--muted); }
    .now { min-width:110px; text-align:right; }
    .now .temp { font-size:28px; font-weight:800; line-height:1; color:#1d4ed8; }
    .now .range { margin-top:2px; font-size:11px; color:var(--muted); }
    .meta { display:flex; gap:8px; flex-wrap:wrap; font-size:11px; color:#1d4ed8; }
    .chip { border:1px solid #bfdbfe; border-radius:999px; padding:2px 8px; background:#eff6ff; }
    .chart { position:relative; border:1px solid var(--edge); border-radius:14px; background:var(--surface); height:164px; overflow:hidden; }
    .chart svg { width:100%; height:100%; display:block; }
    .legend { display:flex; gap:12px; align-items:center; font-size:11px; color:var(--muted); padding:0 4px; justify-content:space-between; }
    .dot { width:10px; height:10px; border-radius:999px; display:inline-block; margin-right:4px; }
    .detail { border:1px solid #dbeafe; background:#f8fbff; border-radius:11px; padding:8px 10px; font-size:11px; color:#1e3a8a; display:flex; justify-content:space-between; gap:8px; }
    .detail strong { color:#0f172a; font-size:12px; }
    .forecast { display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:6px; }
    .day-card { border:1px solid #e2e8f0; border-radius:11px; background:linear-gradient(165deg,#ffffff,#f8fbff); padding:6px 4px; text-align:center; cursor:pointer; transition:border-color .16s ease, box-shadow .16s ease, transform .16s ease; }
    .day-card:hover { border-color:#93c5fd; box-shadow:0 8px 16px rgba(37,99,235,.14); transform:translateY(-1px); }
    .day-card.active { border-color:#1d4ed8; box-shadow:0 10px 18px rgba(37,99,235,.2); }
    .day-name { font-size:10px; color:#475569; }
    .day-icon { width:24px; height:24px; display:block; margin:4px auto; }
    .day-hi { font-size:12px; font-weight:700; color:#0f172a; }
    .day-lo { font-size:10px; color:#64748b; }
    .day-rain { margin-top:3px; font-size:10px; color:#b45309; }
    .controls { display:flex; align-items:center; gap:8px; font-size:11px; color:#475569; }
    .controls input[type='range'] { width:100%; accent-color:#f59e0b; }
    .footer { display:flex; justify-content:space-between; font-size:11px; color:var(--muted); padding:0 4px; }
    .rain-bar, .hi-point, .low-point, .x-hit { cursor:pointer; }
    .rain-bar.active { stroke:#b45309; stroke-width:1.8; opacity:.9 !important; }
    .hi-point.active, .low-point.active { stroke:#0f172a; stroke-width:1.8; r:3.8; }
    .axis-label { fill:#64748b; font-size:9px; font-weight:700; }
    .grid-line { stroke:#e2ecff; stroke-width:1; stroke-dasharray:2 2; }
  </style>
</head>
<body>
  <main class="card">
    <header class="head" data-part="title">
      <div class="title-row">
        <div>
          <h1 class="title">7-Day Forecast</h1>
          <p class="sub" data-part="subtitle">__LOCATION__</p>
        </div>
        <div class="now">
          <div class="temp" id="nowTemp">--°__UNIT__</div>
          <div class="range" id="nowRange">H -- / L --</div>
        </div>
      </div>
      <div class="meta" data-part="controls">
        <span class="chip">Unit: __UNIT__</span>
        <span class="chip">Source: __SOURCE__</span>
      </div>
    </header>
    <section class="chart" data-part="chart">
      <svg id="plot" viewBox="0 0 420 164" role="img" aria-label="Temperature trend chart"></svg>
    </section>
    <section class="legend" data-part="legend">
      <span><span class="dot" style="background:#2f80ed"></span>High</span>
      <span><span class="dot" style="background:#16a34a"></span>Low</span>
      <span><span class="dot" style="background:#f59e0b"></span>Rain chance</span>
    </section>
    <section class="detail" id="dayDetail" data-part="details-panel"></section>
    <section class="forecast" id="forecastCards" data-part="forecast-cards"></section>
    <section class="controls" data-part="controls">
      <span>Rain emphasis</span>
      <input id="rainWeight" type="range" min="10" max="100" value="45" />
    </section>
    <footer class="footer" data-part="footer">
      <span data-part="x-axis">X: Day</span>
      <span data-part="y-axis">Y: Temperature / Rain Chance</span>
    </footer>
  </main>
  <script>
    const rows = __DATA__;
    const svg = document.getElementById('plot');
    const cards = document.getElementById('forecastCards');
    const rainWeight = document.getElementById('rainWeight');
    const nowTemp = document.getElementById('nowTemp');
    const nowRange = document.getElementById('nowRange');
    const detail = document.getElementById('dayDetail');
    const W = 420;
    const H = 164;
    const pad = { left: 32, right: 12, top: 12, bottom: 24 };
    const num = (value, fallback = 0) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const iconSvg = (key) => {
      if (key === 'rain') return `<svg class="day-icon" viewBox="0 0 24 24" fill="none"><path d="M7 10a5 5 0 0 1 9.7-1.5A4 4 0 1 1 17 16H7a3 3 0 1 1 0-6z" fill="#93c5fd"/><path d="M8 18l-1.4 2M12 18l-1.4 2M16 18l-1.4 2" stroke="#2563eb" stroke-width="1.6" stroke-linecap="round"/></svg>`;
      if (key === 'snow') return `<svg class="day-icon" viewBox="0 0 24 24" fill="none"><path d="M7 10a5 5 0 0 1 9.7-1.5A4 4 0 1 1 17 16H7a3 3 0 1 1 0-6z" fill="#cbd5e1"/><path d="M12 18v4M10 20h4M10.6 18.6l2.8 2.8M13.4 18.6l-2.8 2.8" stroke="#0ea5e9" stroke-width="1.2" stroke-linecap="round"/></svg>`;
      if (key === 'storm') return `<svg class="day-icon" viewBox="0 0 24 24" fill="none"><path d="M7 10a5 5 0 0 1 9.7-1.5A4 4 0 1 1 17 16H7a3 3 0 1 1 0-6z" fill="#94a3b8"/><path d="M12 16l-2 4h2l-1 3 3-5h-2l1-2z" fill="#facc15"/></svg>`;
      if (key === 'fog') return `<svg class="day-icon" viewBox="0 0 24 24" fill="none"><path d="M7 10a5 5 0 0 1 9.7-1.5A4 4 0 1 1 17 16H7a3 3 0 1 1 0-6z" fill="#e2e8f0"/><path d="M5 18h14M7 21h10" stroke="#94a3b8" stroke-width="1.4" stroke-linecap="round"/></svg>`;
      if (key === 'cloud') return `<svg class="day-icon" viewBox="0 0 24 24" fill="none"><path d="M7 10a5 5 0 0 1 9.7-1.5A4 4 0 1 1 17 16H7a3 3 0 1 1 0-6z" fill="#cbd5e1"/></svg>`;
      return `<svg class="day-icon" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="5" fill="#f59e0b"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.2 2.2M16.9 16.9l2.2 2.2M4.9 19.1l2.2-2.2M16.9 7.1l2.2-2.2" stroke="#f59e0b" stroke-width="1.4" stroke-linecap="round"/></svg>`;
    };

    const highs = rows.map((d) => num(d.high, 0));
    const lows = rows.map((d) => num(d.low, 0));
    const maxTemp = Math.max(...highs, ...lows, 1);
    const minTemp = Math.min(...highs, ...lows, 0);
    const upper = Math.ceil((maxTemp + 2) / 5) * 5;
    const lower = Math.floor((minTemp - 2) / 5) * 5;
    const span = Math.max(upper - lower, 1);
    const xStep = rows.length > 1 ? (W - pad.left - pad.right) / (rows.length - 1) : 0;
    const toY = (value) => pad.top + ((upper - value) / span) * (H - pad.top - pad.bottom);
    const makePath = (values) => values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${pad.left + xStep * i} ${toY(v)}`).join(' ');
    let activeDay = 0;

    const first = rows[0] || {};
    const firstHigh = num(first.high, 0);
    const firstLow = num(first.low, 0);
    nowTemp.textContent = `${Math.round((firstHigh + firstLow) / 2)}°__UNIT__`;
    nowRange.textContent = `H ${Math.round(firstHigh)}° / L ${Math.round(firstLow)}°`;

    const renderDetail = () => {
      const day = rows[activeDay] || {};
      const hi = Math.round(num(day.high, 0));
      const lo = Math.round(num(day.low, 0));
      const rain = Math.round(num(day.precip, 0));
      const label = day.day || (day.date || '').slice(5);
      detail.innerHTML = `<strong>${label}</strong><span>${day.condition || 'Condition unavailable'}</span><span>H ${hi}° / L ${lo}°</span><span>Rain ${rain}%</span>`;
    };

    const renderCards = () => {
      cards.innerHTML = rows.map((d, i) => `
        <article class="day-card ${i === activeDay ? 'active' : ''}" data-day-index="${i}">
          <div class="day-name">${d.day || (d.date || '').slice(5)}</div>
          ${iconSvg(d.icon)}
          <div class="day-hi">${Math.round(num(d.high, 0))}°</div>
          <div class="day-lo">${Math.round(num(d.low, 0))}°</div>
          <div class="day-rain">${Math.round(num(d.precip, 0))}%</div>
        </article>
      `).join('');
      cards.querySelectorAll('[data-day-index]').forEach((node) => {
        node.addEventListener('click', () => {
          activeDay = Number(node.getAttribute('data-day-index')) || 0;
          renderCards();
          renderDetail();
          renderChart();
        });
      });
    };

    const renderChart = () => {
      const rainAlpha = Math.max(0.12, Number(rainWeight.value) / 180);
      const yTicks = [0, 0.25, 0.5, 0.75, 1];
      const grid = yTicks.map((t) => {
        const y = pad.top + (H - pad.top - pad.bottom) * t;
        const value = Math.round(upper - span * t);
        return `<line class="grid-line" x1="${pad.left}" y1="${y}" x2="${W - pad.right}" y2="${y}"></line><text class="axis-label" x="${pad.left - 6}" y="${y + 3}" text-anchor="end">${value}</text>`;
      }).join('');
      const rainBars = rows.map((d, i) => {
        const x = pad.left + xStep * i - 8;
        const h = Math.max(2, (num(d.precip, 0) / 100) * 34);
        const y = H - pad.bottom - h;
        const selected = i === activeDay;
        return `<rect class="rain-bar ${selected ? 'active' : ''}" data-i="${i}" x="${x}" y="${y}" width="16" height="${h}" rx="3" fill="#f59e0b" opacity="${selected ? Math.min(0.95, rainAlpha + 0.35) : rainAlpha}"><title>${d.day || ''}: ${Math.round(num(d.precip, 0))}% rain chance</title></rect>`;
      }).join('');
      const highDots = rows.map((d, i) => {
        const x = pad.left + xStep * i;
        const y = toY(num(d.high, 0));
        return `<circle class="hi-point ${i === activeDay ? 'active' : ''}" data-i="${i}" cx="${x}" cy="${y}" r="3.2" fill="#2f80ed"><title>${d.day || ''}: high ${Math.round(num(d.high, 0))}°</title></circle>`;
      }).join('');
      const lowDots = rows.map((d, i) => {
        const x = pad.left + xStep * i;
        const y = toY(num(d.low, 0));
        return `<circle class="low-point ${i === activeDay ? 'active' : ''}" data-i="${i}" cx="${x}" cy="${y}" r="3.2" fill="#16a34a"><title>${d.day || ''}: low ${Math.round(num(d.low, 0))}°</title></circle>`;
      }).join('');
      const hitTargets = rows.map((d, i) => {
        const x = pad.left + xStep * i - 10;
        return `<rect class="x-hit" data-i="${i}" x="${x}" y="${pad.top}" width="20" height="${H - pad.top - pad.bottom}" fill="transparent"></rect>`;
      }).join('');
      const labels = rows.map((d, i) => {
        const x = pad.left + xStep * i;
        const active = i === activeDay;
        return `<text x="${x}" y="${H - 7}" font-size="${active ? 10 : 9}" font-weight="${active ? 800 : 700}" text-anchor="middle" fill="${active ? '#1d4ed8' : '#64748b'}">${d.day || ''}</text>`;
      }).join('');

      svg.innerHTML = `
        <rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"></rect>
        ${grid}
        <line x1="${pad.left}" y1="${H - pad.bottom}" x2="${W - pad.right}" y2="${H - pad.bottom}" stroke="#9db8e8"></line>
        <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${H - pad.bottom}" stroke="#9db8e8"></line>
        ${hitTargets}
        ${rainBars}
        <path d="${makePath(highs)}" fill="none" stroke="#2f80ed" stroke-width="2.8" stroke-linecap="round"></path>
        <path d="${makePath(lows)}" fill="none" stroke="#16a34a" stroke-width="2.8" stroke-linecap="round"></path>
        ${highDots}
        ${lowDots}
        ${labels}
      `;

      svg.querySelectorAll('[data-i]').forEach((node) => {
        node.addEventListener('click', () => {
          activeDay = Number(node.getAttribute('data-i')) || 0;
          renderCards();
          renderDetail();
          renderChart();
        });
      });
    };

    rainWeight.addEventListener('input', renderChart);
    renderCards();
    renderDetail();
    renderChart();
  </script>
</body>
</html>"""

    return {
        "id": f"weekly-weather-{_slugify(location_name)}",
        "name": f"Weekly Weather - {location_name}",
        "type": "html",
        "description": f"Interactive weekly weather chart sourced from {source}.",
        "code": (
            template.replace("__LOCATION__", html.escape(location_name))
            .replace("__UNIT__", html.escape(unit_symbol))
            .replace("__SOURCE__", html.escape(source))
            .replace("__DATA__", data_json)
        ),
    }


def _inject_weather_artifacts(
    artifacts: List[Dict[str, Any]],
    tool_outputs: List[Dict[str, Any]],
    user_text: str = "",
) -> List[Dict[str, Any]]:
    weather_result: Dict[str, Any] | None = None
    for output in tool_outputs:
        if output.get("tool_name") != "get_weather_forecast":
            continue
        result = output.get("result")
        if isinstance(result, dict) and not result.get("error"):
            weather_result = result
            break

    if not weather_result:
        return artifacts

    weather_html = _build_weather_html_artifact(weather_result)
    include_text = _wants_weather_text_artifact(user_text)
    include_code = _wants_weather_code_artifact(user_text)
    augmented = [weather_html]
    for item in artifacts:
        if item.get("id") == weather_html.get("id"):
            continue
        item_type = str(item.get("type") or "").strip().lower()
        if item_type == "text" and not include_text:
            continue
        if item_type == "code" and not include_code:
            continue
        augmented.append(item)

    has_text = any(item.get("type") == "text" for item in augmented)
    has_code = any(item.get("type") == "code" for item in augmented)

    if include_text and not has_text:
        augmented.append(
            {
                "id": f"weekly-weather-summary-{_slugify(_build_weather_display_name(weather_result))}",
                "name": "Weather Summary",
                "type": "text",
                "description": "Concise narrative weather highlights.",
                "text": _build_weather_summary_text(weather_result),
            }
        )

    if include_code and not has_code:
        days = len([row for row in weather_result.get("forecast", []) if isinstance(row, dict)]) or 7
        augmented.append(
            {
                "id": f"weekly-weather-code-{_slugify(_build_weather_display_name(weather_result))}",
                "name": "Weather Fetch Snippet",
                "type": "code",
                "description": "Python snippet to fetch and print daily weather values.",
                "language": "python",
                "code": _build_weather_code_snippet(weather_result, days),
            }
        )

    return augmented


def _build_generated_image_artifact(result: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    image = str(result.get("image") or "").strip()
    if not image:
        return None

    original_prompt = str(result.get("original_prompt") or result.get("prompt") or "").strip()
    prompt = str(result.get("revised_prompt") or result.get("prompt") or "").strip()
    title_seed = prompt or original_prompt or "generated-image"
    deployment = str(result.get("deployment") or "image-model").strip()
    size = str(result.get("size") or "").strip()
    style = str(result.get("style") or "").strip()
    quality = str(result.get("quality") or "").strip()
    safety_adjusted = bool(result.get("safety_adjusted"))

    base_prompt = original_prompt or prompt
    lead_terms = _extract_image_lead_terms(base_prompt)
    prompt_controls = _normalize_prompt_controls_payload(result.get("prompt_controls")) or _suggest_image_prompt_controls(base_prompt)
    edit_instruction = str(result.get("edit_instruction") or "").strip() or None

    meta = {
        "source": str(result.get("source") or "azure-image"),
        "deployment": deployment,
        "size": size,
        "style": style,
        "quality": quality,
        "base_prompt": base_prompt or None,
        "lead_terms": lead_terms,
        "prompt_controls": prompt_controls,
        "safety_adjusted": safety_adjusted,
        "edit_instruction": edit_instruction,
    }

    summary_parts = [f"Generated via {deployment}"]
    if size:
        summary_parts.append(size)
    if style:
        summary_parts.append(style)
    if quality:
        summary_parts.append(quality)

    return {
        "id": f"generated-image-{_slugify(title_seed[:80])}",
        "name": "Generated Image",
        "type": "image",
        "description": " | ".join(summary_parts),
        "image": image,
        "prompt": prompt or None,
        "meta": meta,
    }


def _extract_image_lead_terms(prompt: str) -> List[str]:
    source = str(prompt or "").strip()
    if not source:
        return []

    chunks = [part.strip() for part in re.split(r"[,;\n]+", source) if part.strip()]
    compact: List[str] = []
    seen: set[str] = set()

    for chunk in chunks:
        normalized = re.sub(r"\s+", " ", chunk).strip()
        lowered = normalized.lower()
        if not normalized or lowered in seen:
            continue
        seen.add(lowered)
        compact.append(normalized)
        if len(compact) >= 5:
            break
    return compact


def _dedupe_text(values: List[str]) -> List[str]:
    seen: set[str] = set()
    out: List[str] = []
    for value in values:
        item = str(value).strip()
        if not item:
            continue
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


def _classify_prompt_phrase(phrase: str) -> str:
    lowered = str(phrase or "").lower()
    if re.search(r"\b(light|lighting|shadow|backlit|rim light|golden hour|neon|studio)\b", lowered):
        return "lighting"
    if re.search(r"\b(color|colour|tone|tones|palette|background|black-and-white|monochrome|pastel|metallic)\b", lowered):
        return "palette"
    if re.search(r"\b(close-up|portrait|headshot|half-body|full-body|wide|angle|framing|rule of thirds|centered)\b", lowered):
        return "composition"
    if re.search(r"\b(mood|vibe|atmosphere|dreamy|mysterious|bold|elegant|moody)\b", lowered):
        return "mood"
    if re.search(r"\b(style|stylized|fashion|editorial|magazine|cinematic|vintage|cyberpunk|film|illustration|anime)\b", lowered):
        return "style"
    return "art-direction"


def _prompt_phrase_options(phrase: str, category: str) -> List[str]:
    current = str(phrase or "").strip()

    pools: Dict[str, List[str]] = {
        "lighting": [
            "golden hour lighting",
            "soft diffused studio lighting",
            "dramatic chiaroscuro lighting",
            "neon rim lighting",
            "soft vintage film lighting",
            "glossy metallic highlights",
        ],
        "palette": [
            "pastel tones",
            "bold red background",
            "minimal black-and-white style",
            "neon cyberpunk colors",
            "earthy muted palette",
            "glossy metallic tones",
        ],
        "style": [
            "magazine cover editorial style",
            "high-fashion runway aesthetic",
            "cinematic film still style",
            "minimal black-and-white style",
            "soft vintage film look",
            "neon cyberpunk art direction",
        ],
        "composition": [
            "tight close-up portrait framing",
            "half-body portrait framing",
            "centered editorial composition",
            "rule-of-thirds composition",
            "wide environmental portrait framing",
        ],
        "mood": [
            "elegant and poised mood",
            "bold and dramatic mood",
            "dreamy cinematic mood",
            "mysterious noir mood",
            "energetic fashion-campaign mood",
        ],
        "art-direction": [
            "pastel tones",
            "bold red background",
            "minimal black-and-white style",
            "golden hour lighting",
            "neon cyberpunk colors",
            "soft vintage film look",
            "glossy metallic tones",
        ],
    }

    options = [current] + pools.get(category, pools["art-direction"])
    return _dedupe_text(options)[:8]


def _extract_modifiable_prompt_phrases(prompt: str) -> List[str]:
    source = str(prompt or "").strip()
    if not source:
        return []

    chunks = [part.strip() for part in re.split(r"[,;\n]+", source) if part.strip()]
    if not chunks:
        return []

    # Keep the first chunk as the core subject and treat later chunks as modifiable directions.
    candidates = chunks[1:] if len(chunks) > 1 else []

    # If prompt is one chunk, try extracting "with/under/in + phrase" tails.
    if not candidates:
        for match in re.finditer(
            r"\b(?:with|under|in|against|featuring)\s+([a-zA-Z][a-zA-Z0-9\s\-&]+)",
            source,
            flags=re.IGNORECASE,
        ):
            phrase = str(match.group(1) or "").strip(" .")
            if len(phrase) >= 4:
                candidates.append(phrase)

    cleaned: List[str] = []
    for candidate in candidates:
        normalized = re.sub(r"\s+", " ", str(candidate)).strip(" .")
        if len(normalized) < 3:
            continue
        cleaned.append(normalized)

    return _dedupe_text(cleaned)[:5]


def _suggest_image_prompt_controls(prompt: str) -> List[Dict[str, Any]]:
    phrases = _extract_modifiable_prompt_phrases(prompt)
    if not phrases:
        phrases = ["overall visual direction"]

    controls: List[Dict[str, Any]] = []
    used_categories: Dict[str, int] = {}

    label_by_category = {
        "lighting": "Lighting",
        "palette": "Palette / Background",
        "style": "Style Direction",
        "composition": "Composition",
        "mood": "Mood",
        "art-direction": "Art Direction",
    }

    for index, phrase in enumerate(phrases[:4], start=1):
        category = _classify_prompt_phrase(phrase)
        used_categories[category] = used_categories.get(category, 0) + 1
        suffix = used_categories[category]
        control_id = f"{category}-{suffix}"
        label = label_by_category.get(category, "Art Direction")
        if used_categories[category] > 1:
            label = f"{label} {suffix}"

        options = _prompt_phrase_options(phrase, category)
        current = options[0] if options else phrase

        controls.append(
            {
                "id": control_id,
                "label": label,
                "current": current,
                "options": options,
            }
        )

    return controls


def _inject_generated_image_artifacts(
    artifacts: List[Dict[str, Any]],
    tool_outputs: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    has_image = any(item.get("type") == "image" and str(item.get("image", "")).strip() for item in artifacts)
    if has_image:
        return artifacts

    for output in tool_outputs:
        if output.get("tool_name") != "generate_image":
            continue
        result = output.get("result")
        if not isinstance(result, dict) or result.get("error"):
            continue
        artifact = _build_generated_image_artifact(result)
        if artifact:
            return [artifact] + artifacts

    return artifacts


def _wants_multiple_cards(user_text: str) -> bool:
    lowered = (user_text or "").lower()
    explicit_terms = [
        "multiple cards",
        "separate cards",
        "split into cards",
        "different cards",
        "multiple outputs",
        "separate outputs",
        "several outputs",
        "separate artifacts",
        "multiple artifacts",
        "each in a card",
        "one card each",
    ]
    if any(term in lowered for term in explicit_terms):
        return True
    return bool(re.search(r"\b\d+\s+(cards|outputs|artifacts)\b", lowered))


def _merge_text_artifacts_if_needed(
    artifacts: List[Dict[str, Any]],
    user_text: str,
) -> List[Dict[str, Any]]:
    if _wants_multiple_cards(user_text):
        return artifacts

    text_artifacts = [
        item
        for item in artifacts
        if item.get("type") == "text" and str(item.get("text", "")).strip()
    ]
    if len(text_artifacts) <= 1:
        return artifacts

    sections: List[str] = []
    for index, item in enumerate(text_artifacts, start=1):
        title = str(item.get("name") or f"Section {index}").strip() or f"Section {index}"
        desc = str(item.get("description") or "").strip()
        body = str(item.get("text") or "").strip()
        section = f"### {title}"
        if desc:
            section += f"\n{desc}"
        section += f"\n{body}"
        sections.append(section.strip())

    merged_text = "\n\n".join(sections).strip()
    first_id = str(text_artifacts[0].get("id") or "combined-text")
    merged_artifact = {
        "id": f"{first_id}-combined",
        "name": "Combined Text Response",
        "type": "text",
        "description": "Merged text sections from the current response.",
        "text": merged_text,
    }

    merged: List[Dict[str, Any]] = []
    inserted = False
    for item in artifacts:
        if item.get("type") == "text" and str(item.get("text", "")).strip():
            if not inserted:
                merged.append(merged_artifact)
                inserted = True
            continue
        merged.append(item)

    return merged


def _is_runnable_javascript_request(user_text: str) -> bool:
    lowered = str(user_text or "").lower()
    if not lowered:
        return False
    has_js = bool(re.search(r"\b(javascript|js)\b", lowered))
    has_code = bool(re.search(r"\b(code|snippet|function|script|runnable)\b", lowered))
    return has_js and has_code


def _looks_like_html_document(code: str) -> bool:
    lowered = str(code or "").lower()
    return "<html" in lowered or "<!doctype html" in lowered or ("<head" in lowered and "<body" in lowered)


def _extract_script_from_html(code: str) -> str:
    chunks: List[str] = []
    for match in SCRIPT_TAG_RE.finditer(str(code or "")):
        block = str(match.group(1) or "").strip()
        if block:
            chunks.append(block)
    return "\n\n".join(chunks).strip()


def _looks_like_javascript_code(code: str) -> bool:
    lowered = str(code or "").lower()
    if not lowered:
        return False
    hints = [
        "console.log(",
        "function ",
        "=>",
        "const ",
        "let ",
        "for (",
        "while (",
        "return ",
    ]
    score = sum(1 for hint in hints if hint in lowered)
    return score >= 2 and "<html" not in lowered


def _extract_requested_point_count(user_text: str, default_count: int = 6) -> int:
    lowered = str(user_text or "").lower()
    match = re.search(
        r"\b(\d{1,2})\s*(?:bars?|points?|periods?|days?|weeks?|months?|quarters?)\b",
        lowered,
    )
    if not match:
        return default_count
    count = int(match.group(1))
    return max(3, min(12, count))


def _extract_time_labels(user_text: str) -> List[str]:
    lowered = str(user_text or "").lower()

    quarter_range = re.search(r"\bq([1-4])\s*[-–]\s*q([1-4])\b", lowered)
    if quarter_range:
        start = int(quarter_range.group(1))
        end = int(quarter_range.group(2))
        step = 1 if end >= start else -1
        return [f"Q{i}" for i in range(start, end + step, step)]

    quarters: List[str] = []
    seen_quarters: set[str] = set()
    for match in re.finditer(r"\bq([1-4])\b", lowered):
        token = f"Q{int(match.group(1))}"
        if token in seen_quarters:
            continue
        seen_quarters.add(token)
        quarters.append(token)
    if len(quarters) >= 3:
        return quarters

    month_map = {
        "jan": "Jan",
        "january": "Jan",
        "feb": "Feb",
        "february": "Feb",
        "mar": "Mar",
        "march": "Mar",
        "apr": "Apr",
        "april": "Apr",
        "may": "May",
        "jun": "Jun",
        "june": "Jun",
        "jul": "Jul",
        "july": "Jul",
        "aug": "Aug",
        "august": "Aug",
        "sep": "Sep",
        "sept": "Sep",
        "september": "Sep",
        "oct": "Oct",
        "october": "Oct",
        "nov": "Nov",
        "november": "Nov",
        "dec": "Dec",
        "december": "Dec",
    }
    month_pattern = (
        r"\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|"
        r"aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b"
    )
    months: List[str] = []
    seen_months: set[str] = set()
    for match in re.finditer(month_pattern, lowered):
        label = month_map.get(match.group(1), "")
        if not label or label in seen_months:
            continue
        seen_months.add(label)
        months.append(label)
    if len(months) >= 3:
        return months

    if re.search(r"\bquarterly|quarters?\b", lowered):
        count = _extract_requested_point_count(lowered, default_count=4)
        return [f"Q{i}" for i in range(1, count + 1)]
    if re.search(r"\bweekly|weeks?\b", lowered):
        count = _extract_requested_point_count(lowered, default_count=6)
        return [f"W{i}" for i in range(1, count + 1)]
    if re.search(r"\bdaily|days?\b", lowered):
        count = _extract_requested_point_count(lowered, default_count=7)
        return [f"D{i}" for i in range(1, count + 1)]

    return ["Jan", "Feb", "Mar", "Apr", "May", "Jun"]


def _infer_metric_axis(user_text: str) -> Tuple[str, str]:
    lowered = str(user_text or "").lower()
    if "revenue" in lowered:
        return ("Revenue", "USD (k)")
    if "sales" in lowered:
        return ("Sales", "Units")
    if "conversion" in lowered or "ctr" in lowered:
        return ("Conversion", "%")
    if "traffic" in lowered or "visitors" in lowered:
        return ("Traffic", "Sessions")
    if "users" in lowered or "active users" in lowered:
        return ("Users", "Count")
    if "cost" in lowered or "expense" in lowered:
        return ("Cost", "USD (k)")
    return ("Value", "Units")


def _infer_trend_mode(user_text: str) -> str:
    lowered = str(user_text or "").lower()
    if re.search(r"\b(decrease|decline|down|drop|falling)\b", lowered):
        return "down"
    if re.search(r"\b(flat|stable|constant)\b", lowered):
        return "flat"
    if re.search(r"\b(volatile|fluctuat|spike|swing)\b", lowered):
        return "volatile"
    return "up"


def _infer_time_axis_label(labels: List[str]) -> str:
    if not labels:
        return "Period"
    first = str(labels[0])
    if first.startswith("Q"):
        return "Quarter"
    if first.startswith("W"):
        return "Week"
    if first.startswith("D"):
        return "Day"
    if first in {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"}:
        return "Month"
    return "Period"


def _build_prompt_series(user_text: str) -> Dict[str, Any]:
    labels = _extract_time_labels(user_text)
    metric_name, y_axis_label = _infer_metric_axis(user_text)
    trend_mode = _infer_trend_mode(user_text)
    subject = _extract_chart_subject(user_text)
    seed = sum((index + 1) * ord(ch) for index, ch in enumerate(str(user_text or "chart"))) % 97

    if y_axis_label == "%":
        base = 42 + (seed % 14)
        step = 2 + (seed % 3)
    else:
        base = 88 + (seed % 45)
        step = 6 + (seed % 5)

    rows: List[Dict[str, Any]] = []
    total = len(labels)
    for index, label in enumerate(labels):
        jitter = ((seed + index * 11) % 9) - 4
        if trend_mode == "down":
            value = base + (total - index - 1) * step + jitter
        elif trend_mode == "flat":
            value = base + jitter
        elif trend_mode == "volatile":
            swing = (8 + (seed % 7)) * (1 if index % 2 == 0 else -1)
            value = base + swing + jitter
        else:
            value = base + index * step + jitter

        if y_axis_label == "%":
            value = max(5, min(95, value))
        else:
            value = max(10, value)

        target_offset = 5 + ((seed + index * 3) % 8)
        target = value - target_offset + (2 if trend_mode == "down" else 0)
        if y_axis_label == "%":
            target = max(3, min(95, target))
        else:
            target = max(8, target)

        rows.append(
            {
                "label": label,
                "value": int(round(value)),
                "target": int(round(target)),
            }
        )

    return {
        "subject": subject,
        "metric_name": metric_name,
        "y_axis_label": y_axis_label,
        "x_axis_label": _infer_time_axis_label(labels),
        "rows": rows,
    }


def _build_fallback_javascript_code_artifact(user_text: str) -> Dict[str, Any]:
    series = _build_prompt_series(user_text)
    labels = [row["label"] for row in series["rows"]]
    values = [row["value"] for row in series["rows"]]
    labels_json = json.dumps(labels)
    values_json = json.dumps(values)
    metric_name = str(series["metric_name"])

    code = f"""function summarizeSeries(labels, values) {{
  const paired = labels.map((label, i) => {{ return {{ label, value: values[i] }}; }});
  const total = values.reduce((sum, value) => sum + value, 0);
  const average = total / Math.max(values.length, 1);
  const best = paired.reduce((a, b) => (a.value > b.value ? a : b));
  const worst = paired.reduce((a, b) => (a.value < b.value ? a : b));
  const trend = values[values.length - 1] - values[0];
  return {{ paired, total, average, best, worst, trend }};
}}

const labels = {labels_json};
const values = {values_json};
const summary = summarizeSeries(labels, values);

console.log("{metric_name} by period:");
summary.paired.forEach((row) => console.log(`- ${{row.label}}: ${{row.value}}`));
console.log("Total:", summary.total);
console.log("Average:", summary.average.toFixed(2));
console.log("Best:", `${{summary.best.label}} (${{summary.best.value}})`);
console.log("Lowest:", `${{summary.worst.label}} (${{summary.worst.value}})`);
console.log("Trend delta:", summary.trend >= 0 ? `+${{summary.trend}}` : `${{summary.trend}}`);
"""
    return {
        "id": "runnable-javascript-demo",
        "name": "Runnable JavaScript Demo",
        "type": "code",
        "description": f"Dependency-free JavaScript using prompt-adapted {metric_name.lower()} data.",
        "language": "javascript",
        "code": code,
    }


def _enforce_runnable_javascript_artifacts(
    artifacts: List[Dict[str, Any]],
    user_text: str,
) -> List[Dict[str, Any]]:
    if not _is_runnable_javascript_request(user_text):
        return artifacts

    preserved: List[Dict[str, Any]] = []
    extracted_from_html: List[Dict[str, Any]] = []
    has_js_code = False

    for item in artifacts:
        item_type = str(item.get("type") or "").strip().lower()
        if item_type == "code":
            raw_code = str(item.get("code") or "").strip()
            if not raw_code:
                continue
            language = str(item.get("language") or "").strip().lower()
            code = raw_code

            if _looks_like_html_document(code):
                script_only = _extract_script_from_html(code)
                if script_only:
                    code = script_only
                    language = "javascript"

            if language in {"js", "node"}:
                language = "javascript"

            if language != "javascript":
                if _looks_like_javascript_code(code):
                    language = "javascript"
                else:
                    preserved.append(item)
                    continue

            updated = dict(item)
            updated["type"] = "code"
            updated["language"] = "javascript"
            updated["code"] = code
            preserved.append(updated)
            has_js_code = True
            continue

        if item_type == "html":
            script_only = _extract_script_from_html(str(item.get("code") or ""))
            preserved.append(item)
            if script_only and _looks_like_javascript_code(script_only):
                extracted_from_html.append(
                    {
                        "id": f"{_slugify(str(item.get('id') or item.get('name') or 'html'))}-script",
                        "name": str(item.get("name") or "Runnable JavaScript").strip() or "Runnable JavaScript",
                        "type": "code",
                        "description": "Script extracted from generated HTML for direct simulation.",
                        "language": "javascript",
                        "code": script_only,
                    }
                )
            continue

        preserved.append(item)

    if not has_js_code:
        if extracted_from_html:
            preserved.append(extracted_from_html[0])
        else:
            preserved.append(_build_fallback_javascript_code_artifact(user_text))

    return preserved


def _is_chart_request(user_text: str) -> bool:
    lowered = str(user_text or "").lower()
    if not lowered:
        return False
    patterns = [
        r"\b(bar|line|area|scatter|pie|donut|histogram)\s+chart\b",
        r"\bchart\b",
        r"\bgraph\b",
        r"\bplot\b",
        r"\bdashboard\b",
        r"\btrend\b",
        r"\btooltip\b",
    ]
    return any(re.search(pattern, lowered) for pattern in patterns)


def _is_weather_request(user_text: str) -> bool:
    lowered = str(user_text or "").lower()
    return bool(re.search(r"\b(weather|forecast|temperature|rain|precipitation)\b", lowered))


def _has_chart_artifact(artifacts: List[Dict[str, Any]]) -> bool:
    for item in artifacts:
        if item.get("type") != "html":
            continue
        code = str(item.get("code") or "")
        if _looks_like_chart_html(code):
            return True
    return False


def _extract_chart_subject(user_text: str) -> str:
    text = str(user_text or "").strip()
    lowered = text.lower()
    match = re.search(
        r"(?i)\b(?:create|build|generate|show|make)\s+(?:a|an)?\s*([^.:\n]{2,70}?)\s+(?:bar|line|area|scatter|pie|chart|graph)\b",
        text,
    )
    if match:
        phrase = re.sub(r"\s+", " ", str(match.group(1) or "")).strip(" -:,.")
        if phrase:
            return phrase
    if "sales" in lowered:
        return "sales performance"
    if "revenue" in lowered:
        return "revenue trend"
    if "kpi" in lowered:
        return "kpi performance"
    return "performance trend"


def _build_fallback_chart_html_artifact(
    user_text: str,
    series: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    if not isinstance(series, dict):
        series = _build_prompt_series(user_text)
    subject = str(series["subject"])
    title = f"Interactive {subject.title()}"
    data = list(series["rows"])
    data_json = json.dumps(data)
    metric_name = str(series["metric_name"])
    x_axis_label = str(series["x_axis_label"])
    y_axis_label = str(series["y_axis_label"])
    points_count = len(data)
    subtitle = f"Prompt-adapted {metric_name.lower()} trend view. Click bars to inspect each period."

    template = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Interactive Chart</title>
  <style>
    :root {
      --bg0: #f9fbff;
      --bg1: #eef5ff;
      --ink: #0f172a;
      --muted: #64748b;
      --line: #dbeafe;
      --accent: #2563eb;
      --accent-2: #0ea5e9;
      --target: #f59e0b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Avenir Next", "Segoe UI", "Trebuchet MS", sans-serif;
      color: var(--ink);
      background: radial-gradient(circle at 0% 0%, rgba(191, 219, 254, 0.34), transparent 42%), linear-gradient(150deg, var(--bg0), var(--bg1));
    }
    .card {
      width: 100%;
      max-width: 440px;
      min-height: 300px;
      margin: 0 auto;
      padding: 12px;
      display: grid;
      gap: 8px;
    }
    .head {
      border: 1px solid #dbeafe;
      border-radius: 14px;
      padding: 10px 11px;
      background: linear-gradient(165deg, #ffffff, #f7fbff);
      box-shadow: 0 12px 24px rgba(15, 23, 42, 0.1);
      display: grid;
      gap: 5px;
    }
    .title { margin: 0; font-size: 16px; font-weight: 800; letter-spacing: 0.01em; }
    .sub { margin: 0; font-size: 11px; color: var(--muted); }
    .meta { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip {
      border: 1px solid #bfdbfe;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 10px;
      color: #1e40af;
      background: #eff6ff;
      font-weight: 700;
    }
    .controls {
      display: inline-flex;
      gap: 6px;
      padding: 2px;
      border: 1px solid #dbeafe;
      border-radius: 9px;
      background: #f8fbff;
    }
    .seg-btn {
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: #1e3a8a;
      font-size: 11px;
      font-weight: 700;
      padding: 5px 8px;
      cursor: pointer;
    }
    .seg-btn.active {
      background: #dbeafe;
      color: #1d4ed8;
    }
    .chart-wrap {
      position: relative;
      border: 1px solid #dbeafe;
      border-radius: 12px;
      background: #ffffff;
      overflow: hidden;
      box-shadow: inset 0 0 0 1px rgba(191, 219, 254, 0.24);
    }
    .chart-wrap svg { width: 100%; height: 190px; display: block; }
    .grid { stroke: var(--line); stroke-width: 1; stroke-dasharray: 2 2; }
    .axis { stroke: #9fb6df; stroke-width: 1.25; }
    .axis-label { fill: #64748b; font-size: 9px; font-weight: 700; }
    .bar { fill: url(#barGrad); cursor: pointer; transition: filter .14s ease, opacity .14s ease; }
    .bar:hover { filter: saturate(1.15); }
    .bar.active { stroke: #0f172a; stroke-width: 2; filter: saturate(1.2); }
    .target-line { stroke: var(--target); stroke-width: 2.2; stroke-linecap: round; }
    .x-hit { fill: transparent; cursor: pointer; }
    .legend { display: flex; gap: 10px; align-items: center; font-size: 11px; color: var(--muted); padding: 0 4px; }
    .dot { width: 9px; height: 9px; border-radius: 999px; display: inline-block; margin-right: 4px; }
    .detail {
      border: 1px solid #dbeafe;
      border-radius: 10px;
      background: #f8fbff;
      padding: 7px 9px;
      display: flex;
      gap: 8px;
      justify-content: space-between;
      font-size: 11px;
      color: #1e3a8a;
    }
    .detail strong { color: #0f172a; font-size: 12px; }
    .tip {
      position: absolute;
      pointer-events: none;
      transform: translate(-50%, -110%);
      border: 1px solid #bfdbfe;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.97);
      color: #0f172a;
      box-shadow: 0 10px 22px rgba(15, 23, 42, 0.16);
      padding: 5px 8px;
      font-size: 10px;
      line-height: 1.25;
      opacity: 0;
      transition: opacity .08s ease;
      white-space: nowrap;
    }
    .tip.show { opacity: 1; }
    .footer {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: var(--muted);
      padding: 0 4px;
    }
  </style>
</head>
<body>
  <main class="card">
    <header class="head">
      <h1 class="title" data-part="title">__TITLE__</h1>
      <p class="sub" data-part="subtitle">__SUBTITLE__</p>
      <div class="meta" data-part="legend">
        <span class="chip">__POINTS__ periods</span>
        <span class="chip">Interactive selection</span>
      </div>
      <div class="controls" data-part="controls">
        <button id="modeValue" type="button" class="seg-btn active">Actual</button>
        <button id="modeTarget" type="button" class="seg-btn">Target</button>
      </div>
    </header>
    <section class="chart-wrap" data-part="chart">
      <svg id="svg" viewBox="0 0 420 190" role="img" aria-label="Interactive bar chart"></svg>
      <div class="tip" id="tip"></div>
    </section>
    <section class="legend" data-part="legend">
      <span><span class="dot" style="background:#2563eb"></span>__LEGEND_VALUE__</span>
      <span><span class="dot" style="background:#f59e0b"></span>__LEGEND_TARGET__</span>
    </section>
    <section class="detail" id="detail" data-part="details-panel"></section>
    <footer class="footer" data-part="footer">
      <span data-part="x-axis">__X_AXIS__</span>
      <span data-part="y-axis">__Y_AXIS__</span>
    </footer>
  </main>
  <script>
    const rows = __DATA__;
    const svg = document.getElementById('svg');
    const tip = document.getElementById('tip');
    const detail = document.getElementById('detail');
    const btnValue = document.getElementById('modeValue');
    const btnTarget = document.getElementById('modeTarget');
    const W = 420;
    const H = 190;
    const pad = { left: 34, right: 12, top: 14, bottom: 26 };

    let mode = 'value';
    let active = 0;

    const num = (value, fallback = 0) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    const valueFor = (row) => mode === 'value' ? num(row.value, 0) : num(row.target, 0);

    const renderDetail = () => {
      const row = rows[active] || {};
      const actual = Math.round(num(row.value, 0));
      const target = Math.round(num(row.target, 0));
      const delta = actual - target;
      const modeValue = Math.round(valueFor(row));
      detail.innerHTML = `<strong>${row.label || ''}</strong><span>Selected ${mode === 'value' ? 'Actual' : 'Target'}: ${modeValue}</span><span>Actual ${actual} vs Target ${target} (${delta >= 0 ? '+' : ''}${delta})</span>`;
    };

    const showTip = (event, text) => {
      const bounds = svg.getBoundingClientRect();
      tip.textContent = text;
      tip.style.left = `${event.clientX - bounds.left}px`;
      tip.style.top = `${event.clientY - bounds.top}px`;
      tip.classList.add('show');
    };

    const hideTip = () => tip.classList.remove('show');

    const render = () => {
      btnValue.classList.toggle('active', mode === 'value');
      btnTarget.classList.toggle('active', mode === 'target');

      const values = rows.map((row) => valueFor(row));
      const maxVal = Math.max(...values, ...rows.map((row) => num(row.target, 0)), 10);
      const xStep = rows.length > 1 ? (W - pad.left - pad.right) / rows.length : 0;
      const barW = Math.max(20, Math.min(28, xStep - 8));
      const toY = (v) => pad.top + ((maxVal - v) / maxVal) * (H - pad.top - pad.bottom);

      const ticks = [0, 0.25, 0.5, 0.75, 1];
      const grid = ticks.map((t) => {
        const y = pad.top + (H - pad.top - pad.bottom) * t;
        const label = Math.round(maxVal * (1 - t));
        return `<line class="grid" x1="${pad.left}" y1="${y}" x2="${W - pad.right}" y2="${y}"></line><text class="axis-label" x="${pad.left - 7}" y="${y + 3}" text-anchor="end">${label}</text>`;
      }).join('');

      const bars = rows.map((row, i) => {
        const x = pad.left + i * xStep + (xStep - barW) / 2;
        const v = valueFor(row);
        const y = toY(v);
        const h = Math.max(2, (H - pad.bottom) - y);
        const selected = i === active ? 'active' : '';
        return `<rect class="bar ${selected}" data-i="${i}" x="${x}" y="${y}" width="${barW}" height="${h}" rx="5"></rect>`;
      }).join('');

      const targetPath = rows.map((row, i) => {
        const x = pad.left + i * xStep + xStep / 2;
        const y = toY(num(row.target, 0));
        return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
      }).join(' ');

      const labels = rows.map((row, i) => {
        const x = pad.left + i * xStep + xStep / 2;
        const isActive = i === active;
        return `<text x="${x}" y="${H - 8}" font-size="${isActive ? 10 : 9}" font-weight="${isActive ? 800 : 700}" text-anchor="middle" fill="${isActive ? '#1d4ed8' : '#64748b'}">${row.label}</text>`;
      }).join('');

      const hits = rows.map((row, i) => {
        const x = pad.left + i * xStep + (xStep - barW) / 2 - 4;
        return `<rect class="x-hit" data-i="${i}" x="${x}" y="${pad.top}" width="${barW + 8}" height="${H - pad.top - pad.bottom}"></rect>`;
      }).join('');

      svg.innerHTML = `
        <defs>
          <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#3b82f6"></stop>
            <stop offset="100%" stop-color="#1d4ed8"></stop>
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="${W}" height="${H}" fill="#fff"></rect>
        ${grid}
        <line class="axis" x1="${pad.left}" y1="${H - pad.bottom}" x2="${W - pad.right}" y2="${H - pad.bottom}"></line>
        <line class="axis" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${H - pad.bottom}"></line>
        <path class="target-line" d="${targetPath}" fill="none"></path>
        ${bars}
        ${hits}
        ${labels}
      `;

      const interactives = svg.querySelectorAll('[data-i]');
      interactives.forEach((node) => {
        const i = Number(node.getAttribute('data-i')) || 0;
        node.addEventListener('mouseenter', (event) => {
          const row = rows[i] || {};
          showTip(event, `${row.label}: actual ${Math.round(num(row.value, 0))}, target ${Math.round(num(row.target, 0))}`);
        });
        node.addEventListener('mousemove', (event) => {
          showTip(event, tip.textContent || '');
        });
        node.addEventListener('mouseleave', hideTip);
        node.addEventListener('click', () => {
          active = i;
          render();
          renderDetail();
        });
      });
    };

    btnValue.addEventListener('click', () => {
      mode = 'value';
      render();
      renderDetail();
    });
    btnTarget.addEventListener('click', () => {
      mode = 'target';
      render();
      renderDetail();
    });

    render();
    renderDetail();
  </script>
</body>
</html>"""

    return {
        "id": f"chart-fallback-{_slugify(subject)}",
        "name": title,
        "type": "html",
        "description": "Auto-generated interactive chart fallback.",
        "code": (
            template.replace("__TITLE__", html.escape(title))
            .replace("__SUBTITLE__", html.escape(subtitle))
            .replace("__POINTS__", str(points_count))
            .replace("__LEGEND_VALUE__", html.escape(f"Selected {metric_name.lower()} value"))
            .replace("__LEGEND_TARGET__", html.escape(f"Reference {metric_name.lower()} target"))
            .replace("__X_AXIS__", html.escape(f"X: {x_axis_label}"))
            .replace("__Y_AXIS__", html.escape(f"Y: {y_axis_label}"))
            .replace("__DATA__", data_json)
        ),
    }


def _wants_text_summary_for_chart(user_text: str) -> bool:
    lowered = str(user_text or "").lower()
    if not lowered:
        return False
    return bool(
        re.search(
            r"\b(summary|text|bullet|bullets|insight|insights|analysis|action items?)\b",
            lowered,
        )
    )


def _is_chart_context_reference(user_text: str) -> bool:
    lowered = str(user_text or "").lower()
    if not lowered:
        return False
    if re.search(
        r"\b(summary|text|bullets?|analysis|insights?)\b[\s\S]{0,30}\b(of|about|for|from)\b[\s\S]{0,30}\b(chart|graph|plot|trend|trends)\b",
        lowered,
    ):
        return True
    if re.search(r"\b(chart|graph|plot)\s+trends?\b", lowered) and re.search(
        r"\b(summary|text|bullets?|analysis|insights?)\b",
        lowered,
    ):
        return True
    return False


def _requested_artifact_types(user_text: str) -> List[str]:
    lowered = str(user_text or "").lower()
    if not lowered:
        return []

    requested: List[str] = []

    def add(value: str) -> None:
        if value not in requested:
            requested.append(value)

    if re.search(r"\b(text|summary|bullet|bullets|analysis|writeup|paragraph)\b", lowered):
        add("text")
    if re.search(r"\b(code|javascript|python|function|snippet|script)\b", lowered):
        add("code")
    if re.search(r"\b(image|photo|portrait|illustration|picture)\b", lowered):
        add("image")

    if _explicit_chart_output_requested(lowered):
        add("html")

    weather_output_patterns = [
        r"\b(weather|forecast)\b[\s\S]{0,30}\b(chart|card|artifact|output)\b",
        r"\bshow\b[\s\S]{0,80}\b(weather|forecast)\b",
    ]
    if any(re.search(pattern, lowered) for pattern in weather_output_patterns):
        add("html")

    return requested


def _filter_artifacts_by_requested_types(
    artifacts: List[Dict[str, Any]],
    user_text: str,
) -> List[Dict[str, Any]]:
    if not isinstance(artifacts, list):
        return []
    requested = _requested_artifact_types(user_text)
    if not requested:
        return artifacts

    requested_set = set(requested)
    filtered: List[Dict[str, Any]] = []
    for item in artifacts:
        if not isinstance(item, dict):
            continue
        item_type = str(item.get("type") or "").strip().lower()
        if item_type in requested_set:
            filtered.append(item)
    return filtered


def _explicit_chart_output_requested(user_text: str) -> bool:
    lowered = str(user_text or "").lower()
    if not lowered:
        return False
    if _is_chart_context_reference(lowered):
        # "text summary of chart trends" references chart as context,
        # not as requested output artifact.
        return False
    patterns = [
        r"\b(create|build|generate|show|make|return|provide)\b[\s\S]{0,80}\b(an?\s+|one\s+)?(interactive\s+)?(chart|graph|plot|dashboard)\b",
        r"\b(with|plus|along with|and)\b[\s\S]{0,30}\b(an?\s+|one\s+)?(interactive\s+)?(chart|graph|plot|dashboard)\b",
        r"\bwith\s+(?:an?\s+)?(interactive\s+)?(chart|graph|plot|dashboard)\b",
        r"\b(chart|graph|plot|dashboard)\s+(artifact|card|output)\b",
    ]
    return any(re.search(pattern, lowered) for pattern in patterns)


def _prefers_text_only_chart_context(user_text: str) -> bool:
    lowered = str(user_text or "").lower()
    if not lowered:
        return False
    if not _wants_text_summary_for_chart(lowered):
        return False
    if _explicit_chart_output_requested(lowered):
        return False

    if re.search(r"\b(only|just)\s+(text|summary|bullets?)\b", lowered):
        return True
    if re.search(r"\b(text|summary|bullets?|analysis)\b[\s\S]{0,24}\bof\b[\s\S]{0,24}\b(chart|graph|plot|trend)\b", lowered):
        return True
    return True


def _build_chart_aligned_text_artifact(
    user_text: str,
    series: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    if not isinstance(series, dict):
        series = _build_prompt_series(user_text)

    subject = str(series.get("subject") or "performance trend")
    metric_name = str(series.get("metric_name") or "Value")
    x_axis_label = str(series.get("x_axis_label") or "Period")
    y_axis_label = str(series.get("y_axis_label") or "Units")
    rows_raw = series.get("rows") or []
    rows = [row for row in rows_raw if isinstance(row, dict)]

    if not rows:
        text = (
            f"### {metric_name} Summary\n"
            f"- No chart data points were available.\n"
            f"- Requested context: {subject.title()}."
        )
        return {
            "id": f"chart-summary-{_slugify(subject)}",
            "name": f"{metric_name} Summary",
            "type": "text",
            "description": "Summary aligned with chart data.",
            "text": text,
        }

    values: List[float] = [float(row.get("value", 0)) for row in rows]
    labels: List[str] = [str(row.get("label", "")) for row in rows]
    total = sum(values)
    average = total / max(len(values), 1)
    best_idx = max(range(len(values)), key=lambda idx: values[idx])
    worst_idx = min(range(len(values)), key=lambda idx: values[idx])
    delta = values[-1] - values[0]
    trend_word = "increased" if delta > 0 else "decreased" if delta < 0 else "stayed flat"

    best_label = labels[best_idx] if best_idx < len(labels) else f"{x_axis_label} {best_idx + 1}"
    worst_label = labels[worst_idx] if worst_idx < len(labels) else f"{x_axis_label} {worst_idx + 1}"

    text = (
        f"### {metric_name} Summary ({subject.title()})\n"
        f"- Range: {x_axis_label} {labels[0]} to {labels[-1]} ({len(rows)} periods)\n"
        f"- Trend: {metric_name} {trend_word} by {delta:+.0f} from first to last period ({y_axis_label})\n"
        f"- Peak: {best_label} at {values[best_idx]:.0f}; Low: {worst_label} at {values[worst_idx]:.0f}\n"
        f"- Average: {average:.1f} {y_axis_label} per period; Total: {total:.0f}\n"
        f"- Action item: validate outliers around {best_label} and tune targets for the next {x_axis_label.lower()} cycle."
    )

    return {
        "id": f"chart-summary-{_slugify(subject)}",
        "name": f"{metric_name} Summary",
        "type": "text",
        "description": "Summary aligned with chart data.",
        "text": text,
    }


def _inject_chart_fallback_artifact(
    artifacts: List[Dict[str, Any]],
    user_text: str,
) -> List[Dict[str, Any]]:
    if not _is_chart_request(user_text):
        return artifacts
    if _prefers_text_only_chart_context(user_text):
        return artifacts
    if _is_weather_request(user_text):
        return artifacts
    if _is_learning_coach_request(user_text):
        return artifacts
    if _has_chart_artifact(artifacts):
        return artifacts

    series = _build_prompt_series(user_text)
    chart_artifact = _build_fallback_chart_html_artifact(user_text, series)
    has_text_artifact = any(
        item.get("type") == "text" and str(item.get("text") or "").strip()
        for item in artifacts
    )

    if has_text_artifact or _wants_text_summary_for_chart(user_text):
        summary_artifact = _build_chart_aligned_text_artifact(user_text, series)
        retained_non_text = [item for item in artifacts if item.get("type") != "text"]
        return [chart_artifact, summary_artifact] + retained_non_text

    return [chart_artifact] + artifacts


def _is_learning_coach_request(user_text: str) -> bool:
    lowered = str(user_text or "").lower()
    return bool(
        re.search(
            r"\b(personal learning coach|learning coach|weak concepts?|concept map|practice questions?|quiz-generator)\b",
            lowered,
        )
    )


def _extract_learning_topic(user_text: str) -> str:
    text = str(user_text or "")
    patterns = [
        r"(?im)^\s*-\s*topic\s*:\s*(.+?)\s*$",
        r"(?im)^\s*topic\s*:\s*(.+?)\s*$",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            value = str(match.group(1) or "").strip()
            if value:
                return value
    return "Learning Topic"


def _extract_weak_concepts(user_text: str) -> List[str]:
    text = str(user_text or "")
    patterns = [
        r"(?im)^\s*-\s*weak concepts(?: selected by user)?\s*:\s*(.+?)\s*$",
        r"(?im)^\s*weak concepts(?: selected by user)?\s*:\s*(.+?)\s*$",
    ]
    raw = ""
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            raw = str(match.group(1) or "").strip()
            if raw:
                break

    if not raw:
        return []

    pieces = re.split(r",|;|\n|\band\b", raw, flags=re.IGNORECASE)
    concepts: List[str] = []
    seen: set[str] = set()
    for piece in pieces:
        cleaned = re.sub(r"^[\-\d.\)\s]+", "", str(piece)).strip(" .")
        if not cleaned:
            continue
        key = cleaned.lower()
        if key in seen:
            continue
        seen.add(key)
        concepts.append(cleaned)
    return concepts[:6]


def _build_learning_concept_map_html_artifact(user_text: str) -> Dict[str, Any]:
    topic = _extract_learning_topic(user_text)
    concepts = _extract_weak_concepts(user_text)
    if not concepts:
        concepts = ["Core idea", "How it works", "Common mistakes"]

    concepts_json = json.dumps(concepts, ensure_ascii=False)
    topic_json = json.dumps(topic, ensure_ascii=False)

    template = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Learning Concept Map</title>
  <style>
    :root {
      --bg0: #f8fbff;
      --bg1: #eef6ff;
      --ink: #0f172a;
      --muted: #64748b;
      --line: #bfdbfe;
      --core: #2563eb;
      --c1: #0ea5e9;
      --c2: #10b981;
      --c3: #f59e0b;
      --card: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Avenir Next", "Segoe UI", "Trebuchet MS", sans-serif;
      color: var(--ink);
      background: radial-gradient(circle at 0% 0%, rgba(147, 197, 253, 0.35), transparent 45%), linear-gradient(145deg, var(--bg0), var(--bg1));
      min-height: 100vh;
    }
    .wrap {
      width: 100%;
      min-height: 100vh;
      display: grid;
      grid-template-columns: 1fr 150px;
      gap: 10px;
      padding: 12px;
    }
    .map-card {
      background: linear-gradient(170deg, #ffffff, #f8fbff);
      border: 1px solid #dbeafe;
      border-radius: 14px;
      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.1);
      padding: 10px;
      display: flex;
      flex-direction: column;
      min-height: 270px;
    }
    .title {
      margin: 0;
      font-size: 16px;
      font-weight: 800;
      letter-spacing: 0.01em;
    }
    .sub {
      margin: 4px 0 8px;
      font-size: 11px;
      color: var(--muted);
    }
    svg {
      width: 100%;
      height: 236px;
      border-radius: 10px;
      background: linear-gradient(180deg, #ffffff, #f8fbff);
      border: 1px solid #e2e8f0;
    }
    .edge {
      stroke: var(--line);
      stroke-width: 1.8;
      fill: none;
      opacity: 0.95;
    }
    .node circle {
      stroke: #ffffff;
      stroke-width: 2;
      filter: drop-shadow(0 2px 4px rgba(15, 23, 42, 0.18));
    }
    .node text {
      font-size: 10px;
      font-weight: 700;
      text-anchor: middle;
      dominant-baseline: middle;
      fill: #0f172a;
      pointer-events: none;
    }
    .node.is-core text {
      fill: #ffffff;
      font-size: 10px;
    }
    .node.active circle {
      stroke: #0f172a;
      stroke-width: 2.4;
    }
    .legend {
      display: flex;
      gap: 8px;
      margin-top: 8px;
      flex-wrap: wrap;
      font-size: 10px;
      color: #475569;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      border: 1px solid #dbeafe;
      border-radius: 999px;
      padding: 3px 7px;
      background: #f8fbff;
    }
    .dot { width: 8px; height: 8px; border-radius: 999px; }
    .side {
      background: var(--card);
      border: 1px solid #dbeafe;
      border-radius: 12px;
      box-shadow: 0 8px 20px rgba(15, 23, 42, 0.09);
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .side h4 {
      margin: 0;
      font-size: 12px;
    }
    .detail-title {
      font-size: 11px;
      font-weight: 800;
      margin: 0;
    }
    .detail {
      font-size: 10px;
      color: #334155;
      line-height: 1.4;
      margin: 0;
    }
    .tips {
      margin: 0;
      padding-left: 16px;
      font-size: 10px;
      color: #334155;
      line-height: 1.35;
    }
    .relations {
      margin: 0;
      padding-left: 16px;
      font-size: 10px;
      color: #334155;
      line-height: 1.35;
      border-top: 1px dashed #dbeafe;
      padding-top: 8px;
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="map-card">
      <h1 class="title" data-part="title">Concept Map: __TOPIC_LABEL__</h1>
      <p class="sub">Click any concept node to inspect it and get a practice-question prompt.</p>
      <svg viewBox="0 0 420 244" data-part="nodes">
        <defs data-part="edges">
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="#bfdbfe"></path>
          </marker>
        </defs>
        <g id="edgeLayer"></g>
        <g id="nodeLayer"></g>
      </svg>
      <div class="legend" data-part="legend">
        <span class="chip"><span class="dot" style="background:var(--core)"></span>Core topic</span>
        <span class="chip"><span class="dot" style="background:var(--c1)"></span>Concept group A</span>
        <span class="chip"><span class="dot" style="background:var(--c2)"></span>Concept group B</span>
        <span class="chip"><span class="dot" style="background:var(--c3)"></span>Concept group C</span>
      </div>
    </section>

    <aside class="side" data-part="details-panel">
      <div>
        <p class="detail-title" id="detailTitle">Select a node</p>
        <p class="detail" id="detailBody">Click a concept to see a focused note.</p>
      </div>
      <ul class="tips">
        <li>Start with high-connection nodes first.</li>
        <li>Review one common mistake per node.</li>
        <li>Then ask for 3 practice questions.</li>
      </ul>
      <ul class="relations" id="relationList"></ul>
    </aside>
  </main>

  <script>
    const topic = __TOPIC_JSON__;
    const concepts = __CONCEPTS_JSON__;

    const cx = 210;
    const cy = 122;
    const palette = ['var(--c1)', 'var(--c2)', 'var(--c3)'];

    const nodeLayer = document.getElementById('nodeLayer');
    const edgeLayer = document.getElementById('edgeLayer');
    const detailTitle = document.getElementById('detailTitle');
    const detailBody = document.getElementById('detailBody');
    const relationList = document.getElementById('relationList');
    const svgNS = 'http://www.w3.org/2000/svg';

    const nodes = [
      { id: 'core', label: topic, x: cx, y: cy, r: 30, color: 'var(--core)', core: true }
    ];

    const count = Math.max(concepts.length, 1);
    const radius = Math.min(98, 78 + count * 3);
    concepts.forEach((label, index) => {
      const angle = (-Math.PI / 2) + ((Math.PI * 2) * index) / count;
      nodes.push({
        id: `c-${index}`,
        label,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
        r: 18,
        color: palette[index % palette.length],
        core: false
      });
    });

    const mk = (tag, attrs = {}) => {
      const el = document.createElementNS(svgNS, tag);
      Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
      return el;
    };

    const relationForEdge = (index) => {
      const options = ['depends on', 'builds to', 'often confused with', 'supports'];
      return options[index % options.length];
    };

    const relations = [];
    nodes.slice(1).forEach((node, idx) => {
      const dx = node.x - cx;
      const dy = node.y - cy;
      const bend = idx % 2 === 0 ? 12 : -12;
      const c1x = cx + dx * 0.42 - (dy * bend) / 120;
      const c1y = cy + dy * 0.42 + (dx * bend) / 120;
      const c2x = cx + dx * 0.78 - (dy * bend) / 120;
      const c2y = cy + dy * 0.78 + (dx * bend) / 120;

      const path = mk('path', {
        d: `M ${cx} ${cy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${node.x} ${node.y}`,
        class: 'edge',
        'marker-end': 'url(#arrow)'
      });
      edgeLayer.appendChild(path);
      relations.push(`${topic} → ${node.label}: ${relationForEdge(idx)}`);
    });

    relationList.innerHTML = relations
      .map((line) => `<li>${line.length > 84 ? `${line.slice(0, 82)}…` : line}</li>`)
      .join('');

    const groups = [];
    nodes.forEach((node) => {
      const g = mk('g', { class: `node${node.core ? ' is-core' : ''}`, 'data-id': node.id });
      const c = mk('circle', { cx: node.x, cy: node.y, r: node.r, fill: node.color });
      const t = mk('text', { x: node.x, y: node.y });
      t.textContent = node.label.length > 18 ? `${node.label.slice(0, 16)}…` : node.label;
      g.appendChild(c);
      g.appendChild(t);
      nodeLayer.appendChild(g);
      groups.push(g);
    });

    const activate = (id) => {
      groups.forEach((g) => {
        if (g.getAttribute('data-id') === id) g.classList.add('active');
        else g.classList.remove('active');
      });
      const node = nodes.find((item) => item.id === id);
      if (!node) return;
      if (node.core) {
        detailTitle.textContent = topic;
        detailBody.textContent = 'Core topic selected. Start with one outer node, then practice retrieval with 3 questions.';
        return;
      }
      detailTitle.textContent = node.label;
      detailBody.textContent = `Why it matters: this concept directly affects understanding of ${topic}. Common mistake: memorizing definitions without linking to application. Ask next: "Give 3 practice questions for ${node.label}."`;
    };

    groups.forEach((g) => {
      g.style.cursor = 'pointer';
      g.addEventListener('click', () => activate(g.getAttribute('data-id')));
    });
    activate('core');
  </script>
</body>
</html>"""

    topic_label = html.escape(topic)
    return {
        "id": f"concept-map-{_slugify(topic)}",
        "name": f"Concept Map - {topic}",
        "type": "html",
        "description": "Interactive concept map focused on selected weak concepts.",
        "code": (
            template.replace("__TOPIC_LABEL__", topic_label)
            .replace("__TOPIC_JSON__", topic_json)
            .replace("__CONCEPTS_JSON__", concepts_json)
        ),
    }


def _inject_learning_concept_map_artifact(
    artifacts: List[Dict[str, Any]],
    user_text: str,
) -> List[Dict[str, Any]]:
    if not _is_learning_coach_request(user_text):
        return artifacts

    map_artifact = _build_learning_concept_map_html_artifact(user_text)
    retained: List[Dict[str, Any]] = []

    for item in artifacts:
        if item.get("type") != "html":
            retained.append(item)
            continue
        descriptor = " ".join(
            [
                str(item.get("id", "")),
                str(item.get("name", "")),
                str(item.get("description", "")),
            ]
        ).lower()
        if "concept" in descriptor or "map" in descriptor:
            continue
        retained.append(item)

    return [map_artifact] + retained


def _finalize_artifacts(
    payload: Any,
    user_text: str,
) -> List[Dict[str, Any]]:
    if not isinstance(payload, list):
        return []

    finalized: List[Dict[str, Any]] = []
    for item in payload:
        if not isinstance(item, dict):
            continue

        artifact_type = str(item.get("type", "")).strip().lower()
        artifact_id = _slugify(str(item.get("id") or item.get("name") or artifact_type or "artifact"))
        name = str(item.get("name") or artifact_id.replace("-", " ").title()).strip()
        description = str(item.get("description") or "").strip() or None
        meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}

        if artifact_type == "html":
            code = _inline_external_images(str(item.get("code", "")))
            code = _inject_chart_theme(code)
            if _is_weak_html(code):
                continue
            finalized.append(
                {
                    "id": artifact_id,
                    "name": name,
                    "type": "html",
                    "description": description,
                    "code": code,
                }
            )
            continue

        if artifact_type == "image":
            image = str(item.get("image") or item.get("url") or "").strip()
            if not image:
                continue
            prompt = str(item.get("prompt") or "").strip() or None
            meta = meta or {}
            if prompt and not str(meta.get("base_prompt") or "").strip():
                meta["base_prompt"] = prompt
            controls = meta.get("prompt_controls")
            if not isinstance(controls, list) or not controls:
                meta["prompt_controls"] = _suggest_image_prompt_controls(str(meta.get("base_prompt") or prompt or ""))
            finalized.append(
                {
                    "id": artifact_id,
                    "name": name,
                    "type": "image",
                    "description": description,
                    "image": image,
                    "prompt": prompt,
                    "meta": meta or None,
                }
            )
            continue

        if artifact_type == "text":
            text = str(item.get("text", "")).strip()
            if text:
                finalized.append(
                    {
                        "id": artifact_id,
                        "name": name,
                        "type": "text",
                        "description": description,
                        "text": text,
                    }
                )
            continue

        if artifact_type == "code":
            code = str(item.get("code", "")).strip()
            if code:
                language = str(item.get("language", "text")).strip().lower() or "text"
                finalized.append(
                    {
                        "id": artifact_id,
                        "name": name,
                        "type": "code",
                        "description": description,
                        "code": code,
                        "language": language,
                    }
                )

    return finalized


class LLMClient:
    def __init__(self) -> None:
        endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
        api_key = os.getenv("AZURE_OPENAI_API_KEY")
        api_version = os.getenv("AZURE_OPENAI_API_VERSION", "2024-12-01-preview")
        self.deployment = os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4o")
        self.temperature = float(os.getenv("AZURE_OPENAI_TEMPERATURE", "0.2"))
        self.max_tokens = int(os.getenv("AZURE_OPENAI_MAX_TOKENS", "2048"))

        openai_api_key = os.getenv("OPENAI_API_KEY", "").strip()
        if openai_api_key:
            self.deployment = os.getenv("OPENAI_MODEL", "gpt-4o")
            self.temperature = float(os.getenv("OPENAI_TEMPERATURE", "0.2"))
            self.max_tokens = int(os.getenv("OPENAI_MAX_TOKENS", "2048"))
            self.client = OpenAI(api_key=openai_api_key)
            return

        if not endpoint or not api_key:
            raise RuntimeError("OpenAI or Azure OpenAI configuration is missing.")

        self.client = AzureOpenAI(
            api_version=api_version,
            azure_endpoint=endpoint,
            api_key=api_key,
        )

    def chat(self, messages: List[Dict[str, str]]) -> Dict[str, Any]:
        payload = [{"role": "system", "content": SYSTEM_PROMPT}] + messages
        user_text = _latest_user_message(messages)

        first_pass = self.client.chat.completions.create(
            model=self.deployment,
            messages=payload,
            tools=TOOLS,
            tool_choice="auto",
            temperature=self.temperature,
            max_tokens=self.max_tokens,
        )

        first_message = first_pass.choices[0].message
        content = first_message.content or ""

        tool_outputs = _run_tool_calls(getattr(first_message, "tool_calls", None))
        if tool_outputs:
            tool_context = json.dumps(tool_outputs, ensure_ascii=False)
            tool_payload = payload + [
                {
                    "role": "system",
                    "content": (
                        "Tool results are available below as trusted context.\n"
                        f"{tool_context}\n"
                        "Now return the final JSON response only."
                    ),
                }
            ]

            second_pass = self.client.chat.completions.create(
                model=self.deployment,
                messages=tool_payload,
                temperature=self.temperature,
                max_tokens=self.max_tokens,
            )
            content = second_pass.choices[0].message.content or content

        parsed = parse_json_maybe(content)
        if parsed:
            parsed["artifacts"] = _finalize_artifacts(
                parsed.get("artifacts"),
                user_text,
            )
            parsed["artifacts"] = _inject_weather_artifacts(parsed["artifacts"], tool_outputs, user_text)
            parsed["artifacts"] = _inject_generated_image_artifacts(parsed["artifacts"], tool_outputs)
            parsed["artifacts"] = _inject_learning_concept_map_artifact(parsed["artifacts"], user_text)
            parsed["artifacts"] = _merge_text_artifacts_if_needed(parsed["artifacts"], user_text)
            parsed["artifacts"] = _inject_chart_fallback_artifact(parsed["artifacts"], user_text)
            parsed["artifacts"] = _enforce_runnable_javascript_artifacts(parsed["artifacts"], user_text)
            parsed["artifacts"] = _filter_artifacts_by_requested_types(parsed["artifacts"], user_text)
            if not parsed.get("reply"):
                parsed["reply"] = _default_reply_from_artifacts(
                    parsed.get("artifacts") if isinstance(parsed.get("artifacts"), list) else [],
                    user_text,
                )
            if _reply_indicates_failure(str(parsed.get("reply", ""))):
                parsed["artifacts"] = []
                image_failure_reply = _build_image_failure_reply(tool_outputs)
                if image_failure_reply:
                    parsed["reply"] = image_failure_reply
            parsed["tool_runs"] = tool_outputs
            return parsed

        if content:
            repair_payload = payload + [
                {
                    "role": "assistant",
                    "content": content,
                },
                {
                    "role": "system",
                    "content": (
                        "Reformat the assistant output into the required JSON schema exactly. "
                        "Do not add markdown."
                    ),
                },
            ]
            repair_pass = self.client.chat.completions.create(
                model=self.deployment,
                messages=repair_payload,
                temperature=0,
                max_tokens=self.max_tokens,
            )
            repaired_content = repair_pass.choices[0].message.content or ""
            repaired = parse_json_maybe(repaired_content)
            if repaired:
                repaired["artifacts"] = _finalize_artifacts(
                    repaired.get("artifacts"),
                    user_text,
                )
                repaired["artifacts"] = _inject_weather_artifacts(repaired["artifacts"], tool_outputs, user_text)
                repaired["artifacts"] = _inject_generated_image_artifacts(repaired["artifacts"], tool_outputs)
                repaired["artifacts"] = _inject_learning_concept_map_artifact(repaired["artifacts"], user_text)
                repaired["artifacts"] = _merge_text_artifacts_if_needed(repaired["artifacts"], user_text)
                repaired["artifacts"] = _inject_chart_fallback_artifact(repaired["artifacts"], user_text)
                repaired["artifacts"] = _enforce_runnable_javascript_artifacts(repaired["artifacts"], user_text)
                repaired["artifacts"] = _filter_artifacts_by_requested_types(repaired["artifacts"], user_text)
                if not repaired.get("reply"):
                    repaired["reply"] = _default_reply_from_artifacts(
                        repaired.get("artifacts") if isinstance(repaired.get("artifacts"), list) else [],
                        user_text,
                    )
                if _reply_indicates_failure(str(repaired.get("reply", ""))):
                    repaired["artifacts"] = []
                    image_failure_reply = _build_image_failure_reply(tool_outputs)
                    if image_failure_reply:
                        repaired["reply"] = image_failure_reply
                repaired["tool_runs"] = tool_outputs
                return repaired

        fallback_artifacts: List[Dict[str, Any]] = []
        fallback_artifacts = _inject_weather_artifacts(fallback_artifacts, tool_outputs, user_text)
        fallback_artifacts = _inject_generated_image_artifacts(fallback_artifacts, tool_outputs)
        fallback_artifacts = _inject_learning_concept_map_artifact(fallback_artifacts, user_text)
        fallback_artifacts = _merge_text_artifacts_if_needed(fallback_artifacts, user_text)
        fallback_artifacts = _inject_chart_fallback_artifact(fallback_artifacts, user_text)
        fallback_artifacts = _enforce_runnable_javascript_artifacts(fallback_artifacts, user_text)
        fallback_artifacts = _filter_artifacts_by_requested_types(fallback_artifacts, user_text)
        fallback_reply = content or _default_reply_from_artifacts(fallback_artifacts, user_text)
        if _reply_looks_like_raw_json_blob(fallback_reply):
            fallback_reply = _default_reply_from_artifacts(fallback_artifacts, user_text)
        image_failure_reply = _build_image_failure_reply(tool_outputs)
        if image_failure_reply:
            fallback_reply = image_failure_reply
            fallback_artifacts = []
        return {
            "reply": fallback_reply,
            "artifacts": fallback_artifacts,
            "tool_runs": tool_outputs,
        }

    def refine_image(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        safe_payload = payload if isinstance(payload, dict) else {}
        started_at = time.perf_counter()
        result = _tool_edit_image_region(safe_payload)
        latency_ms = int((time.perf_counter() - started_at) * 1000)
        tool_run = {
            "tool_name": "edit_image_region",
            "arguments": {
                "instruction": str(safe_payload.get("instruction") or "").strip(),
                "size": str(safe_payload.get("size") or "").strip(),
                "has_image": bool(safe_payload.get("image")),
                "has_mask": bool(safe_payload.get("mask")),
            },
            "result": result,
            "status": "error" if result.get("error") else "ok",
            "latency_ms": latency_ms,
        }
        if result.get("error"):
            return {
                "reply": f"Image refinement failed: {result.get('error')}",
                "artifact": None,
                "tool_runs": [tool_run],
            }

        artifact = _build_generated_image_artifact(result)
        if not artifact:
            return {
                "reply": "Image refinement failed: no edited image returned.",
                "artifact": None,
                "tool_runs": [tool_run],
            }

        return {
            "reply": "Updated the selected region while preserving the rest of the image.",
            "artifact": artifact,
            "tool_runs": [tool_run],
        }
