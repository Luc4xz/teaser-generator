from __future__ import annotations

import hashlib
import html
import math
import re
from typing import Dict, Tuple


def _slugify(text: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "-", text.lower()).strip("-")
    return cleaned or "generated-artifact"


def _infer_intent(text: str) -> str:
    lowered = text.lower()
    if (
        any(token in lowered for token in ["distance", "route", "between", "map"])
        or re.search(r"from\\s+[a-z\\s]+\\s+to\\s+[a-z\\s]+", lowered)
    ):
        return "distance"
    if any(token in lowered for token in ["line chart", "trend", "timeline", "timeseries", "time series"]):
        return "line"
    if any(token in lowered for token in ["dashboard", "kpi", "metric", "summary"]):
        return "dashboard"
    if any(token in lowered for token in ["bar chart", "histogram", "compare", "category"]):
        return "bar"
    return "bar"


def _extract_two_places(text: str) -> Tuple[str, str]:
    between = re.search(r"between\s+([A-Za-z\s]+?)\s+and\s+([A-Za-z\s]+)", text, flags=re.IGNORECASE)
    if between:
        return between.group(1).strip().title(), between.group(2).strip().title()

    from_to = re.search(r"from\s+([A-Za-z\s]+?)\s+to\s+([A-Za-z\s]+)", text, flags=re.IGNORECASE)
    if from_to:
        return from_to.group(1).strip().title(), from_to.group(2).strip().title()

    return "Hong Kong", "Paris"


def _pseudo_coords(name: str) -> Tuple[float, float]:
    digest = hashlib.sha256(name.encode("utf-8")).hexdigest()
    lat_seed = int(digest[:8], 16)
    lon_seed = int(digest[8:16], 16)
    lat = (lat_seed / 0xFFFFFFFF) * 120 - 60
    lon = (lon_seed / 0xFFFFFFFF) * 320 - 160
    return lat, lon


def _haversine_km(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    radius = 6371.0
    d_lat = math.radians(b_lat - a_lat)
    d_lon = math.radians(b_lon - a_lon)
    x = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(a_lat)) * math.cos(math.radians(b_lat)) * math.sin(d_lon / 2) ** 2
    )
    return radius * 2 * math.atan2(math.sqrt(x), math.sqrt(1 - x))


def _distance_artifact(user_text: str) -> Dict[str, str]:
    city_a, city_b = _extract_two_places(user_text)
    lat1, lon1 = _pseudo_coords(city_a)
    lat2, lon2 = _pseudo_coords(city_b)
    km = int(round(_haversine_km(lat1, lon1, lat2, lon2)))
    safe_a = html.escape(city_a)
    safe_b = html.escape(city_b)

    code = f"""<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
  <title>Distance Explorer</title>
  <style>
    :root {{
      --bg-a:#f8fbff;
      --bg-b:#eef4ff;
      --ink:#0f172a;
      --muted:#475569;
      --accent:#2563eb;
      --accent-2:#14b8a6;
      --card:#ffffff;
    }}
    * {{ box-sizing: border-box; }}
    body {{ margin:0; font-family:'Avenir Next', 'Segoe UI', sans-serif; background:#ffffff; color:var(--ink); }}
    .frame {{ width:100%; max-width:440px; min-height:300px; margin:0 auto; padding:14px; display:grid; gap:10px; }}
    .hero {{ background:var(--card); border:1px solid #dbe4ff; border-radius:14px; padding:10px 12px; box-shadow:0 12px 30px rgba(37,99,235,.10); }}
    .title {{ font-size:16px; font-weight:700; margin:0; }}
    .sub {{ margin:4px 0 0; font-size:12px; color:var(--muted); }}
    .map {{ position:relative; height:150px; border-radius:12px; background:#f8fafc; border:1px solid #e2e8f0; overflow:hidden; }}
    .grid {{ position:absolute; inset:0; background:repeating-linear-gradient(90deg,rgba(37,99,235,.08) 0,rgba(37,99,235,.08) 1px,transparent 1px,transparent 32px),repeating-linear-gradient(0deg,rgba(37,99,235,.08) 0,rgba(37,99,235,.08) 1px,transparent 1px,transparent 32px); }}
    .pin {{ position:absolute; width:12px; height:12px; border-radius:50%; border:2px solid #fff; box-shadow:0 4px 8px rgba(0,0,0,.2); }}
    .a {{ left:76px; top:92px; background:#14b8a6; }}
    .b {{ right:74px; top:48px; background:#2563eb; }}
    .route {{ position:absolute; left:88px; top:58px; width:260px; height:72px; pointer-events:none; }}
    .metrics {{ display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; }}
    .metric {{ background:#f8fbff; border:1px solid #dbeafe; border-radius:10px; padding:8px; }}
    .metric .label {{ font-size:11px; color:var(--muted); }}
    .metric .value {{ margin-top:3px; font-size:14px; font-weight:700; }}
    .controls {{ display:flex; gap:10px; align-items:center; font-size:12px; color:var(--muted); }}
    select {{ border:1px solid #cbd5e1; border-radius:8px; padding:4px 8px; background:#fff; }}
  </style>
</head>
<body>
  <div class=\"frame\">
    <section class=\"hero\" data-part=\"title\">
      <h1 class=\"title\">Route Distance Overview</h1>
      <p class=\"sub\" data-part=\"subtitle\">{safe_a} to {safe_b} with dynamic ETA and route profile</p>
    </section>
    <section class=\"map\" data-part=\"map\">
      <div class=\"grid\"></div>
      <svg class=\"route\" viewBox=\"0 0 260 72\" fill=\"none\" aria-hidden=\"true\">
        <path d=\"M4 54 C80 0, 160 94, 256 20\" stroke=\"#2563eb\" stroke-width=\"3\" stroke-dasharray=\"6 6\"/>
      </svg>
      <div class=\"pin a\" title=\"{safe_a}\"></div>
      <div class=\"pin b\" title=\"{safe_b}\"></div>
    </section>
    <section class=\"metrics\" data-part=\"metrics\">
      <article class=\"metric\"><div class=\"label\">Distance</div><div class=\"value\" id=\"distance\">{km} km</div></article>
      <article class=\"metric\"><div class=\"label\">Flight ETA</div><div class=\"value\" id=\"eta\">12.1 h</div></article>
      <article class=\"metric\"><div class=\"label\">Confidence</div><div class=\"value\">92%</div></article>
    </section>
    <section class=\"controls\" data-part=\"controls\">
      <label for=\"mode\">Travel mode</label>
      <select id=\"mode\">
        <option value=\"900\">Air</option>
        <option value=\"120\">Rail</option>
        <option value=\"70\">Road</option>
      </select>
      <span id=\"mode-note\">ETA updates instantly</span>
    </section>
  </div>
  <script>
    const distanceKm = {km};
    const mode = document.getElementById('mode');
    const eta = document.getElementById('eta');
    mode.addEventListener('change', () => {{
      const speed = Number(mode.value);
      const hours = distanceKm / speed;
      eta.textContent = `${{hours.toFixed(1)}} h`;
    }});
  </script>
</body>
</html>"""

    return {
        "id": f"distance-{_slugify(city_a)}-{_slugify(city_b)}",
        "name": f"Distance Explorer: {city_a} -> {city_b}",
        "type": "html",
        "description": "Interactive route visualization with distance and ETA controls.",
        "code": code,
    }


def _bar_artifact(user_text: str) -> Dict[str, str]:
    safe_query = html.escape(user_text[:90]) if user_text else "Category Performance"
    code = f"""<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
  <title>Executive Bar Chart</title>
  <style>
    :root {{ --paper:#ffffff; --ink:#10253f; --muted:#5b6b84; --accent:#0ea5e9; --accent-2:#f59e0b; --grid:#dbe7ff; }}
    * {{ box-sizing:border-box; }}
    body {{ margin:0; font-family:'Manrope','Segoe UI',sans-serif; background:#ffffff; color:var(--ink); }}
    .card {{ max-width:440px; min-height:300px; margin:0 auto; background:var(--paper); border:1px solid #dce7fb; border-radius:16px; padding:12px; box-shadow:0 14px 36px rgba(2,132,199,.15); display:grid; gap:10px; }}
    .title {{ margin:0; font-size:16px; font-weight:800; letter-spacing:.01em; }}
    .subtitle {{ margin:3px 0 0; font-size:12px; color:var(--muted); }}
    .toolbar {{ display:flex; justify-content:space-between; align-items:center; font-size:11px; color:var(--muted); }}
    .slider {{ width:132px; }}
    .chart {{ position:relative; height:155px; border:1px solid var(--grid); border-radius:12px; background:#ffffff; overflow:hidden; padding:8px 10px 24px; }}
    .y-label {{ position:absolute; left:8px; top:8px; font-size:10px; color:var(--muted); }}
    .bars {{ position:absolute; left:26px; right:8px; top:8px; bottom:28px; display:flex; align-items:flex-end; gap:10px; }}
    .bar-wrap {{ width:100%; display:grid; gap:4px; justify-items:center; }}
    .bar {{ width:100%; border-radius:8px 8px 4px 4px; background:linear-gradient(180deg,var(--accent),#1d4ed8); position:relative; transition:height .25s ease; }}
    .bar:hover {{ filter:brightness(1.08); }}
    .val {{ position:absolute; top:-18px; left:50%; transform:translateX(-50%); font-size:10px; color:#0f172a; background:#f8fafc; border:1px solid #e2e8f0; padding:1px 5px; border-radius:999px; }}
    .x {{ font-size:10px; color:var(--muted); }}
    .x-axis {{ position:absolute; left:24px; right:8px; bottom:8px; border-top:1px solid #cbd5e1; }}
    .legend {{ display:flex; align-items:center; gap:8px; font-size:11px; color:var(--muted); }}
    .swatch {{ width:12px; height:12px; border-radius:3px; background:linear-gradient(180deg,var(--accent),#1d4ed8); }}
  </style>
</head>
<body>
  <article class=\"card\">
    <header data-part=\"title\">
      <h1 class=\"title\">Category Performance Bar Chart</h1>
      <p class=\"subtitle\" data-part=\"subtitle\">{safe_query}</p>
    </header>
    <section class=\"toolbar\" data-part=\"controls\">
      <span>Scale sensitivity</span>
      <input id=\"scale\" class=\"slider\" type=\"range\" min=\"70\" max=\"140\" value=\"100\" />
    </section>
    <section class=\"chart\" data-part=\"bars\">
      <span class=\"y-label\" data-part=\"y-axis\">Y: Value</span>
      <div class=\"bars\" id=\"bars\"></div>
      <div class=\"x-axis\" data-part=\"x-axis\"></div>
    </section>
    <footer class=\"legend\" data-part=\"legend\"><span class=\"swatch\"></span><span>Current quarter</span></footer>
  </article>
  <script>
    const source = [
      {{ label: 'A', value: 68 }},
      {{ label: 'B', value: 94 }},
      {{ label: 'C', value: 77 }},
      {{ label: 'D', value: 122 }},
      {{ label: 'E', value: 88 }}
    ];
    const bars = document.getElementById('bars');
    const scale = document.getElementById('scale');

    function render(multiplier = 1) {{
      bars.innerHTML = '';
      const max = Math.max(...source.map(item => item.value * multiplier));
      for (const item of source) {{
        const adjusted = item.value * multiplier;
        const h = Math.max(16, (adjusted / max) * 118);
        const wrap = document.createElement('div');
        wrap.className = 'bar-wrap';
        const bar = document.createElement('div');
        bar.className = 'bar';
        bar.style.height = `${{h}}px`;
        const value = document.createElement('span');
        value.className = 'val';
        value.textContent = Math.round(adjusted);
        bar.appendChild(value);
        const label = document.createElement('span');
        label.className = 'x';
        label.textContent = item.label;
        wrap.appendChild(bar);
        wrap.appendChild(label);
        bars.appendChild(wrap);
      }}
    }}

    scale.addEventListener('input', () => render(Number(scale.value) / 100));
    render();
  </script>
</body>
</html>"""

    return {
        "id": "executive-bar-chart",
        "name": "Executive Bar Chart",
        "type": "html",
        "description": "Interactive bar chart with axis controls and editable sections.",
        "code": code,
    }


def _line_artifact(user_text: str) -> Dict[str, str]:
    safe_query = html.escape(user_text[:90]) if user_text else "Trend overview"
    code = f"""<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
  <title>Trend Line</title>
  <style>
    body {{ margin:0; font-family:'Manrope','Segoe UI',sans-serif; background:#ffffff; color:#0f172a; }}
    .panel {{ max-width:440px; min-height:300px; margin:0 auto; border-radius:16px; border:1px solid #dbeafe; background:#fff; box-shadow:0 12px 30px rgba(14,116,144,.12); padding:12px; display:grid; gap:10px; }}
    h1 {{ margin:0; font-size:16px; font-weight:800; }}
    .sub {{ margin:4px 0 0; font-size:12px; color:#64748b; }}
    .chart {{ border:1px solid #dbeafe; border-radius:12px; background:#ffffff; padding:8px; }}
    .meta {{ display:flex; justify-content:space-between; font-size:11px; color:#64748b; }}
  </style>
</head>
<body>
  <section class=\"panel\">
    <header data-part=\"title\">
      <h1>Trend Signal Timeline</h1>
      <p class=\"sub\" data-part=\"subtitle\">{safe_query}</p>
    </header>
    <div class=\"chart\" data-part=\"line-series\">
      <svg viewBox=\"0 0 400 170\" width=\"100%\" height=\"170\" aria-label=\"Line chart\">
        <defs>
          <linearGradient id=\"area\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">
            <stop offset=\"0%\" stop-color=\"#0284c7\" stop-opacity=\"0.35\"/>
            <stop offset=\"100%\" stop-color=\"#0284c7\" stop-opacity=\"0\"/>
          </linearGradient>
        </defs>
        <g stroke=\"#dbeafe\" stroke-width=\"1\" data-part=\"y-axis\">
          <line x1=\"34\" y1=\"20\" x2=\"34\" y2=\"145\" />
          <line x1=\"34\" y1=\"145\" x2=\"380\" y2=\"145\" data-part=\"x-axis\" />
        </g>
        <path d=\"M34 140 L80 130 L130 102 L182 114 L232 86 L286 73 L336 48 L380 54 L380 145 L34 145 Z\" fill=\"url(#area)\"/>
        <path d=\"M34 140 L80 130 L130 102 L182 114 L232 86 L286 73 L336 48 L380 54\" fill=\"none\" stroke=\"#0284c7\" stroke-width=\"3\" stroke-linecap=\"round\"/>
        <g fill=\"#0284c7\" data-part=\"markers\">
          <circle cx=\"80\" cy=\"130\" r=\"4\"/><circle cx=\"130\" cy=\"102\" r=\"4\"/><circle cx=\"182\" cy=\"114\" r=\"4\"/><circle cx=\"232\" cy=\"86\" r=\"4\"/><circle cx=\"286\" cy=\"73\" r=\"4\"/><circle cx=\"336\" cy=\"48\" r=\"4\"/>
        </g>
      </svg>
    </div>
    <footer class=\"meta\" data-part=\"footer\"><span>Growth +24.8%</span><span>Updated now</span></footer>
  </section>
</body>
</html>"""

    return {
        "id": "trend-line-visualization",
        "name": "Trend Line Visualization",
        "type": "html",
        "description": "Executive trend view with area fill and structured chart regions.",
        "code": code,
    }


def _dashboard_artifact(_user_text: str) -> Dict[str, str]:
    code = """<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
  <title>KPI Board</title>
  <style>
    body { margin:0; font-family:'Manrope','Segoe UI',sans-serif; background:#ffffff; color:#0f172a; }
    .grid { max-width:440px; min-height:300px; margin:0 auto; display:grid; grid-template-columns:1fr 1fr; gap:8px; padding:12px; }
    .head { grid-column:1 / -1; border:1px solid #c7d2fe; border-radius:14px; background:#fff; padding:10px 12px; }
    h1 { margin:0; font-size:16px; font-weight:800; }
    .sub { margin-top:4px; font-size:12px; color:#64748b; }
    .card { border:1px solid #dbeafe; border-radius:12px; background:#fff; padding:10px; box-shadow:0 8px 20px rgba(2,132,199,.12); }
    .k { font-size:11px; color:#64748b; }
    .v { margin-top:6px; font-size:18px; font-weight:800; }
    .delta { margin-top:4px; font-size:11px; color:#0f766e; }
  </style>
</head>
<body>
  <section class=\"grid\">
    <header class=\"head\" data-part=\"title\">
      <h1>Executive KPI Overview</h1>
      <div class=\"sub\" data-part=\"subtitle\">Live summary with modular metric cards</div>
    </header>
    <article class=\"card\" data-part=\"kpi-1\"><div class=\"k\">Revenue</div><div class=\"v\">$1.28M</div><div class=\"delta\">+12.4%</div></article>
    <article class=\"card\" data-part=\"kpi-2\"><div class=\"k\">Active Users</div><div class=\"v\">84,221</div><div class=\"delta\">+7.1%</div></article>
    <article class=\"card\" data-part=\"kpi-3\"><div class=\"k\">NPS</div><div class=\"v\">67</div><div class=\"delta\">+3 pts</div></article>
    <article class=\"card\" data-part=\"kpi-4\"><div class=\"k\">Churn</div><div class=\"v\">2.8%</div><div class=\"delta\">-0.5 pts</div></article>
  </section>
</body>
</html>"""

    return {
        "id": "kpi-dashboard",
        "name": "KPI Dashboard",
        "type": "html",
        "description": "High-density executive dashboard with modular cards.",
        "code": code,
    }


def build_fallback_artifact(user_text: str) -> Dict[str, str]:
    intent = _infer_intent(user_text)
    if intent == "distance":
        return _distance_artifact(user_text)
    if intent == "line":
        return _line_artifact(user_text)
    if intent == "dashboard":
        return _dashboard_artifact(user_text)
    return _bar_artifact(user_text)
