from __future__ import annotations

from typing import Dict, List


ARTIFACT_TEMPLATES: List[Dict[str, str]] = [
    {
        "id": "distance-card",
        "name": "Distance Calculator",
        "type": "html",
        "description": "Enter two coordinate pairs and compute the great-circle distance.",
        "code": """<!doctype html>
<html lang=\"en\">
  <head>
    <meta charset=\"utf-8\" />
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
    <title>Distance Calculator</title>
    <style>
      body { font-family: Arial, sans-serif; background:#0b1220; color:#e5e7eb; margin:0; padding:20px; }
      .card { background:#111827; border:1px solid #1f2937; border-radius:12px; padding:16px; max-width:520px; }
      h1 { font-size:18px; margin:0 0 12px; }
      label { font-size:12px; color:#9ca3af; display:block; margin-top:10px; }
      input { width:100%; padding:8px; border-radius:8px; border:1px solid #374151; background:#0f172a; color:#e5e7eb; }
      button { margin-top:12px; background:#2563eb; color:white; border:none; padding:8px 12px; border-radius:8px; cursor:pointer; }
      .result { margin-top:12px; font-size:14px; color:#f3f4f6; }
      .row { display:grid; grid-template-columns: 1fr 1fr; gap:8px; }
    </style>
  </head>
  <body>
    <div class=\"card\">
      <h1>Distance Calculator</h1>
      <div class=\"row\">
        <div>
          <label>Point A Latitude</label>
          <input id=\"lat1\" type=\"number\" step=\"any\" value=\"22.3193\" />
        </div>
        <div>
          <label>Point A Longitude</label>
          <input id=\"lon1\" type=\"number\" step=\"any\" value=\"114.1694\" />
        </div>
      </div>
      <div class=\"row\">
        <div>
          <label>Point B Latitude</label>
          <input id=\"lat2\" type=\"number\" step=\"any\" value=\"48.8566\" />
        </div>
        <div>
          <label>Point B Longitude</label>
          <input id=\"lon2\" type=\"number\" step=\"any\" value=\"2.3522\" />
        </div>
      </div>
      <button id=\"calc\">Calculate</button>
      <div class=\"result\" id=\"result\">Enter coordinates and click calculate.</div>
    </div>

    <script>
      const toRad = (deg) => (deg * Math.PI) / 180;
      const calc = () => {
        const lat1 = parseFloat(document.getElementById('lat1').value);
        const lon1 = parseFloat(document.getElementById('lon1').value);
        const lat2 = parseFloat(document.getElementById('lat2').value);
        const lon2 = parseFloat(document.getElementById('lon2').value);

        if ([lat1, lon1, lat2, lon2].some(Number.isNaN)) {
          document.getElementById('result').textContent = 'Please enter valid numbers.';
          return;
        }

        const R = 6371; // km
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
          Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distanceKm = R * c;
        const distanceMi = distanceKm * 0.621371;
        document.getElementById('result').textContent =
          `Distance: ${distanceKm.toFixed(2)} km (${distanceMi.toFixed(2)} miles)`;
      };

      document.getElementById('calc').addEventListener('click', calc);
    </script>
  </body>
</html>
""",
    },
    {
        "id": "bar-chart",
        "name": "Simple Bar Chart",
        "type": "html",
        "description": "Renders a basic bar chart with inline data.",
        "code": """<!doctype html>
<html lang=\"en\">
  <head>
    <meta charset=\"utf-8\" />
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
    <title>Bar Chart</title>
    <style>
      body { font-family: Arial, sans-serif; background:#0b1220; color:#e5e7eb; margin:0; padding:20px; }
      .chart { display:flex; align-items:flex-end; gap:12px; height:220px; }
      .bar { width:48px; background:#22c55e; border-radius:8px 8px 0 0; position:relative; }
      .label { text-align:center; margin-top:8px; font-size:12px; color:#9ca3af; }
      .value { position:absolute; top:-22px; width:100%; text-align:center; font-size:12px; color:#f3f4f6; }
    </style>
  </head>
  <body>
    <h1>Monthly Usage</h1>
    <div id=\"chart\" class=\"chart\"></div>
    <script>
      const data = [
        { label: 'Jan', value: 40 },
        { label: 'Feb', value: 55 },
        { label: 'Mar', value: 30 },
        { label: 'Apr', value: 80 },
        { label: 'May', value: 65 },
      ];
      const max = Math.max(...data.map((d) => d.value));
      const chart = document.getElementById('chart');
      data.forEach((d) => {
        const bar = document.createElement('div');
        bar.className = 'bar';
        bar.style.height = `${(d.value / max) * 180 + 20}px`;
        const value = document.createElement('div');
        value.className = 'value';
        value.textContent = d.value;
        bar.appendChild(value);
        const wrap = document.createElement('div');
        wrap.appendChild(bar);
        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = d.label;
        wrap.appendChild(label);
        chart.appendChild(wrap);
      });
    </script>
  </body>
</html>
""",
    },
]


def list_artifacts() -> List[Dict[str, str]]:
    return sorted(ARTIFACT_TEMPLATES, key=lambda item: item["name"].lower())
