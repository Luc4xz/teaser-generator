import React, { useEffect, useMemo, useState } from 'react';
import ChatPanel from './components/ChatPanel.jsx';
import ArtifactList from './components/ArtifactList.jsx';
import CanvasPanel from './components/CanvasPanel.jsx';
import { loginUser, refineImage, sendChat } from './api.js';

const DEFAULT_LOADING_PHASES = [
  'Analyzing your request',
  'Planning artifacts',
  'Generating components',
  'Polishing output',
];

const LOADING_PHASES_BY_MODE = {
  weather: [
    'Resolving location and timeframe',
    'Fetching forecast data',
    'Generating weather visuals',
    'Finalizing forecast cards',
  ],
  search: [
    'Planning online lookup',
    'Collecting source data',
    'Cross-checking key facts',
    'Formatting sourced response',
  ],
  image: [
    'Parsing image direction',
    'Applying visual controls',
    'Generating image artifact',
    'Finalizing image output',
  ],
  code: [
    'Interpreting coding task',
    'Designing runnable solution',
    'Generating code artifact',
    'Adding execution-ready details',
  ],
  chart: [
    'Interpreting chart goal',
    'Preparing chart structure',
    'Rendering interactive visuals',
    'Finalizing chart card',
  ],
  concept: [
    'Analyzing learning concepts',
    'Organizing concept relationships',
    'Generating explanation artifacts',
    'Finalizing learning package',
  ],
  text: DEFAULT_LOADING_PHASES,
  general: DEFAULT_LOADING_PHASES,
};

const DEFAULT_TEXT_TRY_PROMPT = [
  'Act as a Draft Coach.',
  '',
  'Analyze this draft and return one structured text artifact with:',
  '1) Key points',
  '2) Risks or weaknesses',
  '3) Action items with priority (High/Medium/Low)',
  '',
  'Draft:',
  'We propose a campus tutoring platform that matches students with peer mentors using schedule and topic preferences. The first pilot will include math and programming courses and target first-year students. We expect improved course completion and confidence, but we have limited mentor training resources and no clear plan yet for measuring long-term outcomes.',
].join('\n');

function inferLoadingMode(text, fallback = 'general') {
  const lowered = String(text || '').toLowerCase();
  if (!lowered) return fallback;
  if (/\b(image|photo|portrait|illustration|regenerate|refine)\b/.test(lowered)) return 'image';
  if (/\b(weather|forecast|temperature|precipitation|rain)\b/.test(lowered)) return 'weather';
  if (/\b(online search|search|latest|source|sources|freshness|timestamp)\b/.test(lowered)) return 'search';
  if (/\b(code|javascript|python|function|snippet|algorithm|simulate)\b/.test(lowered)) return 'code';
  if (/\b(chart|graph|plot|dashboard|kpi|bar|line|scatter|trend)\b/.test(lowered)) return 'chart';
  if (/\b(concept map|learning coach|weak concepts|quiz|practice questions)\b/.test(lowered)) return 'concept';
  if (/\b(summary|analyze|analysis|text|bullet|explain)\b/.test(lowered)) return 'text';
  return fallback;
}

function phasesForMode(mode) {
  return LOADING_PHASES_BY_MODE[mode] || DEFAULT_LOADING_PHASES;
}

function looksLikeUnproductiveReply(reply) {
  const lowered = String(reply || '').toLowerCase();
  if (!lowered) return true;
  return [
    'unable to',
    'cannot',
    "can't",
    'failed to',
    'issue',
    'try again',
    'did not return',
    'formatting failed',
    'no artifacts',
  ].some((token) => lowered.includes(token));
}

function detectIssueCase(rawText) {
  const lowered = String(rawText || '').toLowerCase();
  if (!lowered.trim()) return 'empty';
  if (/\b(content filter|blocked by content|policy)\b/.test(lowered)) return 'content_filter';
  if (/\b(missing credentials|api key|authorization|unauthorized|401|forbidden|403)\b/.test(lowered)) return 'auth';
  if (/\b(certificate verification|ssl|tls)\b/.test(lowered)) return 'certificate';
  if (/\b(timeout|timed out|network|connection|failed to fetch)\b/.test(lowered)) return 'network';
  if (/\b(deploymentnotfound|operationnotsupported|not supported|resource not found|404)\b/.test(lowered)) return 'model_or_endpoint';
  if (/\b(unable to retrieve|failed to retrieve|no data|empty data)\b/.test(lowered)) return 'data_unavailable';
  if (/\b(no artifacts|did not return|formatting failed|json|parse)\b/.test(lowered)) return 'artifact_format';
  if (/\b(unable to|cannot|can't|failed to|issue|try again)\b/.test(lowered)) return 'generic_failure';
  return 'no_artifacts';
}

function issueLabelForCase(issueCase) {
  if (issueCase === 'content_filter') return 'Content Filter';
  if (issueCase === 'auth') return 'Credentials';
  if (issueCase === 'certificate') return 'Certificate';
  if (issueCase === 'network') return 'Network';
  if (issueCase === 'model_or_endpoint') return 'Model/Endpoint';
  if (issueCase === 'data_unavailable') return 'Data Unavailable';
  if (issueCase === 'artifact_format') return 'Output Format';
  if (issueCase === 'generic_failure') return 'Execution Failure';
  if (issueCase === 'empty') return 'Empty Response';
  return 'No Output';
}

function issueMessageForCase(issueCase) {
  if (issueCase === 'content_filter') {
    return 'Request was blocked by content filters. Rephrase with safer wording while keeping the same main intent.';
  }
  if (issueCase === 'auth') {
    return 'The request failed due to missing/invalid credentials. Try again after credentials are available.';
  }
  if (issueCase === 'certificate') {
    return 'The request failed due to SSL/certificate verification. Retry or use a source/tool that avoids this path.';
  }
  if (issueCase === 'network') {
    return 'The request failed due to a network/timeout issue. Retry with a narrower request.';
  }
  if (issueCase === 'model_or_endpoint') {
    return 'The selected model or endpoint does not support this operation. Try a compatible request/output type.';
  }
  if (issueCase === 'data_unavailable') {
    return 'Data could not be retrieved for this request. Try a different location/source or a clearer timeframe.';
  }
  if (issueCase === 'artifact_format') {
    return 'The response format did not produce valid canvas artifacts. Ask for explicit artifact types and counts.';
  }
  if (issueCase === 'generic_failure') {
    return 'The request could not be completed. Try a clearer, more constrained prompt with explicit outputs.';
  }
  if (issueCase === 'empty') {
    return 'No response was returned from the model. Retry with a concise prompt and explicit output types.';
  }
  return 'No canvas output was generated from that prompt. Try a clearer instruction and specify output type(s).';
}

function compactPrompt(prompt, maxLen = 260) {
  const flat = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > maxLen ? `${flat.slice(0, maxLen)}...` : flat;
}

function normalizeClauseText(value, maxLen = 180) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[).]\s+/, '');
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function extractPromptClauses(prompt) {
  const source = String(prompt || '');
  if (!source.trim()) return [];

  const lines = source
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const ignoredHeaders = new Set(['task', 'input', 'return', 'requirements', 'output', 'outputs']);
  const clauses = [];

  lines.forEach((line) => {
    const numbered = line.match(/^\d+[).]\s+(.+)$/);
    if (numbered) {
      const cleaned = normalizeClauseText(numbered[1]);
      if (cleaned) clauses.push(cleaned);
      return;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      const cleaned = normalizeClauseText(bullet[1]);
      if (cleaned) clauses.push(cleaned);
      return;
    }

    const label = line.match(/^([a-zA-Z ]+):\s*$/);
    if (label) {
      const key = String(label[1] || '')
        .trim()
        .toLowerCase();
      if (ignoredHeaders.has(key)) return;
    }

    if (/[.!?]\s*$/.test(line) || line.length >= 22) {
      const cleaned = normalizeClauseText(line);
      if (cleaned) clauses.push(cleaned);
    }
  });

  if (!clauses.length) {
    return source
      .split(/[.!?]\s+/)
      .map((item) => normalizeClauseText(item))
      .filter(Boolean)
      .slice(0, 8);
  }

  const seen = new Set();
  const deduped = [];
  clauses.forEach((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(item);
  });
  return deduped.slice(0, 8);
}

function artifactKeywords(artifact) {
  const type = String(artifact?.type || '').toLowerCase();
  const base = [type];
  if (type === 'chart' || type === 'html') {
    base.push('chart', 'graph', 'plot', 'dashboard', 'kpi', 'bar', 'line', 'visual');
  }
  if (type === 'code') {
    base.push('code', 'function', 'script', 'javascript', 'python', 'snippet', 'simulate');
  }
  if (type === 'text') {
    base.push('text', 'summary', 'analysis', 'explain', 'bullet', 'insight');
  }
  if (type === 'image') {
    base.push('image', 'photo', 'portrait', 'illustration', 'style', 'lighting');
  }
  return base;
}

function choosePromptClauseForArtifact(artifact, clauses) {
  if (!Array.isArray(clauses) || !clauses.length) return '';
  if (clauses.length === 1) return clauses[0];

  const searchable = [
    artifact?.type,
    artifact?.name,
    artifact?.description,
    artifact?.id,
  ]
    .map((item) => String(item || '').toLowerCase())
    .join(' ');

  const keywords = artifactKeywords(artifact);
  let bestClause = clauses[0];
  let bestScore = -1;

  clauses.forEach((clause, index) => {
    const lowered = String(clause || '').toLowerCase();
    let score = 0;
    keywords.forEach((keyword) => {
      if (keyword && lowered.includes(keyword)) {
        score += 3;
      }
    });

    searchable.split(/\W+/).forEach((token) => {
      if (token.length >= 4 && lowered.includes(token)) {
        score += 1;
      }
    });

    if (score > bestScore) {
      bestScore = score;
      bestClause = clauses[index];
    }
  });

  return normalizeClauseText(bestClause);
}

function annotateArtifactsWithPromptClause(items, promptText) {
  const clauses = extractPromptClauses(promptText);
  return items.map((item) => {
    const clause = choosePromptClauseForArtifact(item, clauses);
    const nextMeta = {
      ...((item && item.meta && typeof item.meta === 'object') ? item.meta : {}),
      prompt_clause: clause || '',
      prompt_clauses: clauses,
    };
    return { ...item, meta: nextMeta };
  });
}

function rewritePromptForCase(mode, failedPrompt, issueCase) {
  const intent = compactPrompt(failedPrompt);
  if (mode === 'weather') {
    return 'Use online search and return exactly one weather artifact for Seattle with the latest 7-day forecast.';
  }
  if (mode === 'search') {
    return 'Use online search and return exactly one text artifact with 4 key bullets, source links, and a freshness timestamp.';
  }
  if (mode === 'chart') {
    return 'Create exactly one interactive chart artifact with labeled axes, legend, and tooltips using sample data.';
  }
  if (mode === 'code') {
    return 'Create exactly one runnable JavaScript code artifact (no external imports) with sample output.';
  }
  if (mode === 'image') {
    if (issueCase === 'content_filter') {
      return 'Generate one safe image artifact: a scenic mountain sunrise landscape with soft natural lighting.';
    }
    return 'Generate exactly one image artifact from this prompt direction with safe, non-sensitive wording.';
  }
  if (mode === 'text' || mode === 'concept') {
    return DEFAULT_TEXT_TRY_PROMPT;
  }
  if (intent) {
    return `Rewrite and execute this intent with explicit artifacts only: "${intent}". Return exactly one text artifact and one chart artifact.`;
  }
  return 'Return exactly one text artifact with concise bullet points and one chart artifact with labeled axes.';
}

function uniquePrompts(items) {
  const seen = new Set();
  const out = [];
  items.forEach((item) => {
    const value = String(item || '').trim();
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(value);
  });
  return out;
}

function suggestionsForMode(mode, failedPrompt, issueCase) {
  const rewrite = rewritePromptForCase(mode, failedPrompt, issueCase);
  let defaults = [];
  if (mode === 'weather') {
    defaults = [
      'Show the latest 7-day weather for Seattle.',
      'Show the latest 7-day weather forecast for New York.',
    ];
    return uniquePrompts([rewrite, ...defaults]);
  }
  if (mode === 'chart') {
    defaults = [
      'Create an interactive sales bar chart with axes, legend, and tooltips.',
      'Build a KPI trend chart with a toggle for monthly vs weekly view.',
    ];
    return uniquePrompts([rewrite, ...defaults]);
  }
  if (mode === 'code') {
    defaults = [
      'Create a runnable JavaScript code (no external imports) with sample output.',
      'Write a runnable Python snippet (no external imports) that demonstrates sorting and prints output.',
    ];
    return uniquePrompts([rewrite, ...defaults]);
  }
  if (mode === 'image') {
    defaults = [
      'Generate an image of a red fox in an autumn forest.',
      'Generate a cinematic mountain sunrise landscape, wide composition.',
    ];
    return uniquePrompts([rewrite, ...defaults]);
  }
  if (mode === 'search') {
    defaults = [
      'Use online search and summarize the latest AI news in 4 bullets with sources.',
      'Find current information about inflation in the U.S. with source links and date.',
    ];
    return uniquePrompts([rewrite, ...defaults]);
  }
  if (mode === 'text' || mode === 'concept') {
    return uniquePrompts([rewrite, DEFAULT_TEXT_TRY_PROMPT]);
  }
  defaults = [
    'Create an interactive sales bar chart with axes, legend, and tooltips.',
    DEFAULT_TEXT_TRY_PROMPT,
  ];
  return uniquePrompts([rewrite, ...defaults]);
}

const CHART_COLOR_PALETTES = {
  red: { primary: '#ef4444', dark: '#b91c1c', light: '#fca5a5' },
  orange: { primary: '#f97316', dark: '#c2410c', light: '#fdba74' },
  yellow: { primary: '#eab308', dark: '#a16207', light: '#fde047' },
  green: { primary: '#22c55e', dark: '#15803d', light: '#86efac' },
  teal: { primary: '#14b8a6', dark: '#0f766e', light: '#5eead4' },
  cyan: { primary: '#06b6d4', dark: '#0e7490', light: '#67e8f9' },
  blue: { primary: '#2563eb', dark: '#1d4ed8', light: '#93c5fd' },
  indigo: { primary: '#6366f1', dark: '#4338ca', light: '#a5b4fc' },
  purple: { primary: '#a855f7', dark: '#7e22ce', light: '#d8b4fe' },
  pink: { primary: '#ec4899', dark: '#be185d', light: '#f9a8d4' },
  gray: { primary: '#6b7280', dark: '#374151', light: '#d1d5db' },
  grey: { primary: '#6b7280', dark: '#374151', light: '#d1d5db' },
  black: { primary: '#111827', dark: '#000000', light: '#9ca3af' },
  white: { primary: '#f3f4f6', dark: '#d1d5db', light: '#ffffff' },
};
const CHART_DATA_VARIABLE_CANDIDATES = ['rows', 'data', 'dataset', 'points', 'series', 'days', 'months'];
const MONTH_ALIASES = {
  jan: ['jan', 'january'],
  feb: ['feb', 'february'],
  mar: ['mar', 'march'],
  apr: ['apr', 'april'],
  may: ['may'],
  jun: ['jun', 'june'],
  jul: ['jul', 'july'],
  aug: ['aug', 'august'],
  sep: ['sep', 'sept', 'september'],
  oct: ['oct', 'october'],
  nov: ['nov', 'november'],
  dec: ['dec', 'december'],
};

function looksLikeChartHtmlCode(code) {
  const lowered = String(code || '').toLowerCase();
  if (!lowered) return false;
  return (
    (lowered.includes('<svg') || lowered.includes('<canvas'))
    && (lowered.includes('chart') || lowered.includes('bar') || lowered.includes('tooltip') || lowered.includes('legend'))
  );
}

function looksLikeWeatherHtmlCode(code) {
  const lowered = String(code || '').toLowerCase();
  if (!lowered) return false;
  const hasWeatherTerms = (
    lowered.includes('weather')
    || lowered.includes('forecast')
    || lowered.includes('weekly forecast')
  );
  const hasWeatherFields = (
    lowered.includes('precip')
    || lowered.includes('temperature')
    || lowered.includes('humidity')
    || lowered.includes('wind')
    || lowered.includes('daily')
  );
  return hasWeatherTerms && hasWeatherFields;
}

function detectRequestedChartColor(prompt) {
  const text = String(prompt || '').toLowerCase();
  if (!text.trim()) return '';
  if (!/\b(color|colour|palette|bar|bars)\b/.test(text)) return '';

  const direct = text.match(/\b(?:to|as|into)\s+(red|orange|yellow|green|teal|cyan|blue|indigo|purple|pink|gray|grey|black|white)\b/);
  if (direct && direct[1]) return String(direct[1]).trim();

  const generic = text.match(/\b(red|orange|yellow|green|teal|cyan|blue|indigo|purple|pink|gray|grey|black|white)\b/);
  if (generic && generic[1]) return String(generic[1]).trim();

  return '';
}

function applyChartColorOverride(code, colorToken) {
  const source = String(code || '');
  const key = String(colorToken || '').trim().toLowerCase();
  const palette = CHART_COLOR_PALETTES[key];
  if (!source || !palette || !looksLikeChartHtmlCode(source)) return source;

  const uniqueByRole = (role) => Array.from(new Set(
    Object.values(CHART_COLOR_PALETTES)
      .map((item) => String(item?.[role] || '').trim())
      .filter(Boolean)
  ));
  const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const primaryPool = uniqueByRole('primary');
  const darkPool = uniqueByRole('dark');
  const lightPool = uniqueByRole('light');

  const replacements = [
    { from: /#2563eb/gi, to: palette.primary },
    { from: /#3b82f6/gi, to: palette.light },
    { from: /#1d4ed8/gi, to: palette.dark },
    { from: /#1e40af/gi, to: palette.dark },
    { from: /#1e3a8a/gi, to: palette.dark },
    { from: /#0ea5e9/gi, to: palette.primary },
  ];

  let patched = source;
  replacements.forEach(({ from, to }) => {
    patched = patched.replace(from, to);
  });

  if (primaryPool.length) {
    const rx = new RegExp(primaryPool.map(escapeRegex).join('|'), 'gi');
    patched = patched.replace(rx, palette.primary);
  }
  if (darkPool.length) {
    const rx = new RegExp(darkPool.map(escapeRegex).join('|'), 'gi');
    patched = patched.replace(rx, palette.dark);
  }
  if (lightPool.length) {
    const rx = new RegExp(lightPool.map(escapeRegex).join('|'), 'gi');
    patched = patched.replace(rx, palette.light);
  }

  patched = patched.replace(
    /((?:fill|stroke|stop-color|color|background(?:-color)?|border-color)\s*[:=]\s*['"]?)(red|orange|yellow|green|teal|cyan|blue|indigo|purple|pink|gray|grey|black|white)(['"]?)/gi,
    `$1${palette.primary}$3`
  );
  patched = patched.replace(/(--accent\s*:\s*)[^;]+;/gi, `$1${palette.primary};`);
  patched = patched.replace(/(--accent-2\s*:\s*)[^;]+;/gi, `$1${palette.dark};`);

  return patched;
}

function normalizeToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function extractChartRowsFromCode(code) {
  const source = String(code || '');
  if (!source || !looksLikeChartHtmlCode(source)) return null;
  for (const variable of CHART_DATA_VARIABLE_CANDIDATES) {
    const pattern = new RegExp(`(?:const|let|var)\\s+${variable}\\s*=\\s*(\\[[\\s\\S]*?\\])\\s*;`, 'm');
    const match = source.match(pattern);
    if (!match?.[1]) continue;
    try {
      const parsed = JSON.parse(match[1]);
      if (!Array.isArray(parsed)) continue;
      const objectRows = parsed.filter((row) => row && typeof row === 'object' && !Array.isArray(row));
      if (!objectRows.length) continue;
      return { variable, rows: objectRows };
    } catch (_err) {
      // continue
    }
  }
  return null;
}

function replaceChartRowsInCode(code, rows, variableHint = '') {
  const source = String(code || '');
  if (!source || !Array.isArray(rows) || !rows.length) return source;
  const rowJson = JSON.stringify(rows);
  const preferred = String(variableHint || '').trim();
  const variables = preferred
    ? [preferred, ...CHART_DATA_VARIABLE_CANDIDATES.filter((item) => item !== preferred)]
    : CHART_DATA_VARIABLE_CANDIDATES;

  for (const variable of variables) {
    const pattern = new RegExp(`((?:const|let|var)\\s+${variable}\\s*=\\s*)(\\[[\\s\\S]*?\\])(\\s*;)`, 'm');
    if (!pattern.test(source)) continue;
    return source.replace(pattern, `$1${rowJson}$3`);
  }
  return source;
}

function mergeChartHtmlWithPriorState(previousCode, incomingCode) {
  const prior = String(previousCode || '');
  const incoming = String(incomingCode || '');
  if (!looksLikeChartHtmlCode(prior)) return incoming;
  if (!incoming || !looksLikeChartHtmlCode(incoming)) return prior;

  const extracted = extractChartRowsFromCode(incoming);
  if (!extracted || !Array.isArray(extracted.rows) || !extracted.rows.length) return prior;

  const withRows = replaceChartRowsInCode(prior, extracted.rows, extracted.variable);
  return applyChartPeriodCountOverride(withRows, extracted.rows.length);
}

function detectChartDataRemovalTarget(prompt) {
  const text = String(prompt || '').toLowerCase();
  if (!text.trim()) return '';
  if (!/\b(remove|delete|drop|exclude)\b/.test(text)) return '';
  if (!/\b(data|point|bar|row|entry|value|chart)\b/.test(text)) return '';

  const monthMatch = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/);
  if (monthMatch?.[1]) return String(monthMatch[1]).trim();

  const anchored = text.match(/\b(?:for|of|from)\s+([a-z0-9_-]{2,24})\b/);
  if (anchored?.[1]) {
    const candidate = String(anchored[1]).replace(/[^a-z0-9_-]/g, '').trim();
    if (candidate && !['data', 'chart', 'bar', 'bars', 'row', 'entry', 'value'].includes(candidate)) {
      return candidate;
    }
  }

  const loose = text.match(/\b(?:remove|delete|drop|exclude)\s+([a-z0-9_-]{2,24})\b/);
  if (loose?.[1]) {
    const candidate = String(loose[1]).replace(/[^a-z0-9_-]/g, '').trim();
    if (candidate && !['data', 'chart', 'bar', 'bars', 'row', 'entry', 'value'].includes(candidate)) {
      return candidate;
    }
  }

  return '';
}

function buildRemovalAliasSet(target) {
  const token = normalizeToken(target);
  const set = new Set();
  if (!token) return set;
  set.add(token);
  Object.values(MONTH_ALIASES).forEach((aliases) => {
    const normalizedAliases = aliases.map((value) => normalizeToken(value));
    if (normalizedAliases.includes(token)) {
      normalizedAliases.forEach((value) => set.add(value));
    }
  });
  return set;
}

function applyChartPeriodCountOverride(code, rowCount) {
  const source = String(code || '');
  const count = Number(rowCount);
  if (!source || !Number.isFinite(count) || count <= 0) return source;
  const label = `${count} period${count === 1 ? '' : 's'}`;

  let patched = source;
  patched = patched.replace(/>\s*\d+\s+periods?\s*</gi, `>${label}<`);
  patched = patched.replace(/([=:(]\s*['"`])\s*\d+\s+periods?\s*(['"`])/gi, `$1${label}$2`);
  patched = patched.replace(/\b(\d+)\s+periods?\b(?=\s*(?:[.,;)]|$))/gi, label);
  return patched;
}

function applyChartDataRemovalOverride(code, target) {
  const source = String(code || '');
  if (!source || !looksLikeChartHtmlCode(source)) return source;
  const aliasSet = buildRemovalAliasSet(target);
  if (!aliasSet.size) return source;

  for (const variable of CHART_DATA_VARIABLE_CANDIDATES) {
    const pattern = new RegExp(`((?:const|let|var)\\s+${variable}\\s*=\\s*)(\\[[\\s\\S]*?\\])(\\s*;)`, 'm');
    const match = source.match(pattern);
    if (!match?.[2]) continue;

    try {
      const parsed = JSON.parse(match[2]);
      if (!Array.isArray(parsed)) continue;
      const objectRows = parsed.filter((row) => row && typeof row === 'object' && !Array.isArray(row));
      if (!objectRows.length) continue;

      const filteredRows = objectRows.filter((row) => {
        const values = Object.values(row).filter((value) => typeof value === 'string');
        return !values.some((value) => aliasSet.has(normalizeToken(value)));
      });
      if (!filteredRows.length || filteredRows.length === objectRows.length) continue;

      const withRows = source.replace(pattern, `$1${JSON.stringify(filteredRows)}$3`);
      return applyChartPeriodCountOverride(withRows, filteredRows.length);
    } catch (_err) {
      // continue
    }
  }

  return source;
}

function detectChartDataAdditionTargets(prompt) {
  const text = String(prompt || '').toLowerCase();
  if (!text.trim()) return [];
  if (!/\b(add|include|append|insert|put)\b/.test(text)) return [];
  if (!/\b(data|point|bar|row|entry|value|chart|month|months)\b/.test(text)) return [];

  const matches = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/g);
  if (!matches || !matches.length) return [];
  return Array.from(new Set(matches.map((item) => String(item || '').trim())));
}

function canonicalMonthToken(value) {
  const token = normalizeToken(value);
  if (!token) return '';
  const entries = Object.entries(MONTH_ALIASES);
  for (const [short, aliases] of entries) {
    const normalized = aliases.map((item) => normalizeToken(item));
    if (normalized.includes(token)) return short;
  }
  return '';
}

function monthDisplayLabel(shortToken) {
  const map = {
    jan: 'Jan',
    feb: 'Feb',
    mar: 'Mar',
    apr: 'Apr',
    may: 'May',
    jun: 'Jun',
    jul: 'Jul',
    aug: 'Aug',
    sep: 'Sep',
    oct: 'Oct',
    nov: 'Nov',
    dec: 'Dec',
  };
  return map[String(shortToken || '').toLowerCase()] || '';
}

function monthOrderIndex(label) {
  const short = canonicalMonthToken(label);
  const order = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  return order.indexOf(short);
}

function applyChartDataAdditionOverride(code, monthTargets) {
  const source = String(code || '');
  const targets = Array.isArray(monthTargets) ? monthTargets : [];
  if (!source || !looksLikeChartHtmlCode(source) || !targets.length) return source;

  const requestedShortMonths = Array.from(
    new Set(
      targets
        .map((item) => canonicalMonthToken(item))
        .filter(Boolean)
    )
  );
  if (!requestedShortMonths.length) return source;

  for (const variable of CHART_DATA_VARIABLE_CANDIDATES) {
    const pattern = new RegExp(`((?:const|let|var)\\s+${variable}\\s*=\\s*)(\\[[\\s\\S]*?\\])(\\s*;)`, 'm');
    const match = source.match(pattern);
    if (!match?.[2]) continue;
    try {
      const parsed = JSON.parse(match[2]);
      if (!Array.isArray(parsed)) continue;
      const objectRows = parsed.filter((row) => row && typeof row === 'object' && !Array.isArray(row));
      if (!objectRows.length) continue;

      const sampleRow = objectRows[0] || {};
      const keyNames = Object.keys(sampleRow);
      const labelKey = keyNames.find((key) => typeof sampleRow[key] === 'string') || 'label';
      const numericKeys = keyNames.filter((key) => typeof sampleRow[key] === 'number');
      const valueKey = numericKeys[0] || 'value';
      const lastRow = objectRows[objectRows.length - 1] || {};
      const existingMonthShorts = new Set(
        objectRows
          .map((row) => canonicalMonthToken(row?.[labelKey]))
          .filter(Boolean)
      );
      const missing = requestedShortMonths.filter((month) => !existingMonthShorts.has(month));
      if (!missing.length) continue;

      const numericSeries = objectRows
        .map((row) => Number(row?.[valueKey]))
        .filter((value) => Number.isFinite(value));
      const lastValue = numericSeries.length ? numericSeries[numericSeries.length - 1] : 100;
      const deltas = [];
      for (let idx = 1; idx < numericSeries.length; idx += 1) {
        deltas.push(numericSeries[idx] - numericSeries[idx - 1]);
      }
      const avgDelta = deltas.length
        ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length
        : Math.max(5, Math.round(lastValue * 0.06));

      const additions = missing.map((short, index) => {
        const row = { ...lastRow };
        row[labelKey] = monthDisplayLabel(short) || short.toUpperCase();
        const projected = Number(lastValue + avgDelta * (index + 1));
        row[valueKey] = Number.isFinite(projected) ? Math.round(projected * 10) / 10 : lastValue;
        return row;
      });

      const combined = [...objectRows, ...additions];
      const allMonths = combined.every((row) => monthOrderIndex(row?.[labelKey]) >= 0);
      if (allMonths) {
        combined.sort((left, right) => monthOrderIndex(left?.[labelKey]) - monthOrderIndex(right?.[labelKey]));
      }

      const withRows = source.replace(pattern, `$1${JSON.stringify(combined)}$3`);
      return applyChartPeriodCountOverride(withRows, combined.length);
    } catch (_err) {
      // continue
    }
  }

  return source;
}

function isGenericArtifactReply(reply) {
  const lowered = String(reply || '').toLowerCase().trim();
  if (!lowered) return true;
  return (
    lowered.includes('generated a multimodal response with editable artifacts')
    || lowered.includes('generated artifacts from available tool data')
  );
}

function buildChartRevisionAcknowledgement({ color = '', removed = '', addedMonths = [] } = {}) {
  const actions = [];
  if (color) actions.push(`bar color changed to ${String(color).trim().toLowerCase()}`);
  if (removed) actions.push(`removed ${String(removed).trim()} data`);
  if (Array.isArray(addedMonths) && addedMonths.length) {
    const readable = addedMonths
      .map((value) => monthDisplayLabel(canonicalMonthToken(value)) || String(value || '').trim())
      .filter(Boolean);
    if (readable.length) actions.push(`added ${readable.join(' and ')} data`);
  }
  if (!actions.length) return 'The chart has been revised in place.';
  return `The chart has been updated: ${actions.join(', ')}.`;
}

function detectExplicitNewCardRequest(prompt) {
  const text = String(prompt || '').toLowerCase();
  if (!text.trim()) return false;
  const artifactNouns = '(card|artifact|output|chart|graph|plot|dashboard|code|snippet|text|summary|image|photo|portrait|illustration)';
  return (
    new RegExp(`\\b(new|another|additional|separate)\\s+([a-z]+\\s+){0,2}${artifactNouns}\\b`).test(text)
    || new RegExp(`\\b(give|show|provide|add|create|generate|make)\\s+(me\\s+)?(another|a\\s+new|an\\s+additional|new)\\s+([a-z]+\\s+){0,2}${artifactNouns}\\b`).test(text)
    || /\bin addition to\b/.test(text)
  );
}

function detectRevisionIntent(prompt) {
  const text = String(prompt || '').toLowerCase();
  if (!text.trim()) return false;
  return /\b(revise|revision|rewrite|reword|improve|refine|polish|enhance|expand|shorten|condense|professional tone|more professional|more detail|add details|fix|correct|update|modify|change|adjust|tweak|shorter|longer|concise|brief|briefer|detailed|more detailed|lengthen|elaborate|simplify|advanced|optimize|clean up|cleanup|better)\b/.test(text)
    || /\bmake\b[\s\S]{0,40}\b(more|less)\b/.test(text);
}

function detectFreshGenerationIntent(prompt) {
  const text = String(prompt || '').toLowerCase();
  if (!text.trim()) return false;
  const generationVerb = /\b(create|generate|build|show|return|provide|make)\b/.test(text);
  const artifactTarget = /\b(card|artifact|output|chart|graph|plot|dashboard|code|snippet|text|summary|image|photo|portrait|illustration)\b/.test(text);
  const quantify = /\b(\d+|one|two|three|multiple)\s+(card|cards|artifact|artifacts|output|outputs)\b/.test(text);
  return (generationVerb && artifactTarget) || quantify;
}

function detectContextualFollowup(prompt) {
  const text = String(prompt || '').toLowerCase();
  if (!text.trim()) return false;
  return /\b(it|this|that|same|previous|above|current|existing|the code|the chart|the text|the image|card|output|result)\b/.test(text);
}

function detectTargetTypes(prompt) {
  const text = String(prompt || '').toLowerCase();
  const types = new Set();
  const hasWeather = /\b(weather|forecast|temperature|rain|precipitation|humidity|wind)\b/.test(text);
  const hasSearch = /\b(online search|search|source|sources|freshness|latest|current)\b/.test(text);
  if (/\b(code|javascript|python|function|snippet|script)\b/.test(text)) types.add('code');
  if (/\b(text|summary|tone|bullet|writeup|analysis|paragraph)\b/.test(text)) types.add('text');
  if (/\b(chart|graph|plot|dashboard|kpi|bar|line|scatter|visual)\b/.test(text)) types.add('html');
  if (/\b(image|photo|portrait|illustration|picture)\b/.test(text)) types.add('image');
  if (hasWeather) types.add('html');
  if (hasSearch && !hasWeather) types.add('text');
  if (/\b(all cards|all artifacts|everything|all outputs)\b/.test(text)) types.add('*');
  return Array.from(types);
}

function detectPrimaryRequestedType(prompt) {
  const text = String(prompt || '').toLowerCase();
  if (!text.trim()) return '';
  const asksToCreate = /\b(create|write|provide|give|generate|return|make|build|show)\b/.test(text);
  if (!asksToCreate) return '';

  if (/\b(text|summary|bullet|bullets|analysis|paragraph|writeup)\b/.test(text)) return 'text';
  if (/\b(code|javascript|python|function|snippet|script)\b/.test(text)) return 'code';
  if (/\b(chart|graph|plot|dashboard|kpi|bar|line|scatter|visual)\b/.test(text)) return 'html';
  if (/\b(image|photo|portrait|illustration|picture)\b/.test(text)) return 'image';
  if (/\b(weather|forecast|temperature|rain|precipitation)\b/.test(text)) return 'html';
  return '';
}

function isChartSummaryWithoutChartContext(prompt, existingArtifacts) {
  const text = String(prompt || '').toLowerCase();
  if (!text.trim()) return false;
  const asksSummary = /\b(text|summary|bullet|bullets|analysis|writeup|paragraph)\b/.test(text);
  const referencesChart = /\b(chart|graph|plot|dashboard|trend|trends)\b/.test(text);
  if (!asksSummary || !referencesChart) return false;

  const artifacts = Array.isArray(existingArtifacts) ? existingArtifacts : [];
  const hasChart = artifacts.some((artifact) => {
    if (String(artifact?.type || '').toLowerCase() !== 'html') return false;
    const code = String(artifact?.code || '');
    return looksLikeChartHtmlCode(code) && !looksLikeWeatherHtmlCode(code);
  });
  return !hasChart;
}

function scoreArtifactForPrompt(artifact, prompt) {
  const text = String(prompt || '').toLowerCase();
  const haystack = [
    artifact?.id,
    artifact?.name,
    artifact?.description,
    artifact?.type,
    artifact?.meta?.source,
    artifact?.meta?.prompt_clause,
  ].map((value) => String(value || '').toLowerCase()).join(' ');

  let score = 0;
  if (!text || !haystack) return score;

  if (/\b(weather|forecast|temperature|rain|precipitation|humidity|wind)\b/.test(text) && /\b(weather|forecast|rain|temp)\b/.test(haystack)) score += 8;
  if (/\b(online search|search|source|sources|freshness|latest|current)\b/.test(text) && /\b(source|search|weather|forecast|latest)\b/.test(haystack)) score += 5;
  if (/\b(code|javascript|python|function|snippet|script)\b/.test(text) && /\b(code|javascript|python|snippet|function)\b/.test(haystack)) score += 6;
  if (/\b(chart|graph|plot|dashboard|kpi|bar|line|scatter)\b/.test(text) && /\b(chart|graph|plot|dashboard|bar|line|scatter)\b/.test(haystack)) score += 6;
  if (/\b(text|summary|analysis|bullet|tone)\b/.test(text) && /\b(text|summary|analysis|bullet)\b/.test(haystack)) score += 6;
  if (/\b(image|photo|portrait|illustration)\b/.test(text) && /\b(image|photo|portrait|illustration)\b/.test(haystack)) score += 6;

  const tokens = text.split(/[^a-z0-9]+/).filter((token) => token.length >= 4);
  tokens.forEach((token) => {
    if (haystack.includes(token)) score += 1;
  });
  return score;
}

function buildRevisionPlan(prompt, existingArtifacts, activeArtifact) {
  const existing = Array.isArray(existingArtifacts) ? existingArtifacts : [];
  if (!existing.length) {
    return { enabled: false, explicitNew: false, targets: [] };
  }

  const revisionIntent = detectRevisionIntent(prompt);
  const contextualFollowup = detectContextualFollowup(prompt);
  if (!revisionIntent && !contextualFollowup) {
    return { enabled: false, explicitNew: false, targets: [] };
  }

  const explicitNew = detectExplicitNewCardRequest(prompt);
  if (!revisionIntent && !explicitNew && detectFreshGenerationIntent(prompt) && !contextualFollowup) {
    return { enabled: false, explicitNew: false, targets: [] };
  }
  const freshGenerationIntent = detectFreshGenerationIntent(prompt);
  const targetTypes = detectTargetTypes(prompt);
  const primaryRequestedType = detectPrimaryRequestedType(prompt);
  if (primaryRequestedType && freshGenerationIntent) {
    const hasExistingPrimaryType = existing.some(
      (artifact) => String(artifact?.type || '').toLowerCase() === primaryRequestedType
    );
    if (!hasExistingPrimaryType) {
      return { enabled: false, explicitNew: false, targets: [] };
    }
  }

  const candidateTypes = primaryRequestedType
    ? [primaryRequestedType]
    : targetTypes;

  let targets = [];
  if (candidateTypes.includes('*')) {
    targets = [...existing];
  } else if (candidateTypes.length) {
    const byType = new Map();
    existing.forEach((artifact) => {
      const key = String(artifact?.type || '').toLowerCase();
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key).push(artifact);
    });
    candidateTypes.forEach((type) => {
      const candidates = byType.get(type) || [];
      if (!candidates.length) return;
      const activeId = activeArtifact?.uid || activeArtifact?.id;
      const activeCandidate = candidates.find((artifact) => (artifact?.uid || artifact?.id) === activeId) || null;
      const ranked = [...candidates].sort((left, right) => scoreArtifactForPrompt(right, prompt) - scoreArtifactForPrompt(left, prompt));
      const preferred = activeCandidate || ranked[0] || candidates[0];
      targets.push(preferred);
    });
  } else if (activeArtifact) {
    targets = [activeArtifact];
  } else {
    targets = [existing[0]];
  }

  const deduped = [];
  const seen = new Set();
  targets.forEach((artifact) => {
    const key = String(artifact?.uid || artifact?.id || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    deduped.push(artifact);
  });

  return {
    enabled: !explicitNew && deduped.length > 0,
    explicitNew,
    targets: deduped,
  };
}

function buildRevisionInstruction(targets) {
  const lines = [
    'Revision mode constraints:',
    '- Revise existing artifacts in place.',
    '- Do not create additional cards.',
    '- Return only revised artifacts for the targets below.',
    '- Keep each target artifact id exactly unchanged.',
    '- Keep each target artifact type unchanged.',
    'Targets:',
  ];
  targets.forEach((artifact) => {
    const artifactId = String(artifact?.id || '').trim();
    const artifactType = String(artifact?.type || '').trim().toLowerCase();
    const artifactName = String(artifact?.name || '').trim();
    if (!artifactId || !artifactType) return;
    lines.push(`- id: ${artifactId} | type: ${artifactType} | name: ${artifactName}`);
  });
  return lines.join('\n');
}

const DEFAULT_MESSAGE = {
  role: 'assistant',
  content:
    'Describe what you want to build on the canvas. I can generate text analyses (including grant/learning coaching), charts, code snippets, and image outputs, with online-search grounding when needed.',
};

const AUTH_SESSION_STORAGE_KEY = 'chat-canvas-auth-session-v1';
const SESSION_MIN_HOURS = 4;
const SESSION_MAX_HOURS = 6;

function readCachedAuthSession() {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(AUTH_SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const userId = String(parsed?.userId || '').trim();
    const username = String(parsed?.username || '').trim();
    const email = String(parsed?.email || '').trim().toLowerCase();
    const displayName = String(parsed?.displayName || '').trim();
    const expiresAt = Number(parsed?.expiresAt || 0);
    if (!userId || !username || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      window.localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
      return null;
    }
    return { userId, username, email, displayName: displayName || username, expiresAt };
  } catch (_err) {
    window.localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
    return null;
  }
}

function persistAuthSession(session) {
  if (typeof window === 'undefined') return;
  if (!session || !session.userId) {
    window.localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(
    AUTH_SESSION_STORAGE_KEY,
    JSON.stringify({
      userId: session.userId,
      username: session.username,
      email: session.email,
      displayName: session.displayName,
      expiresAt: session.expiresAt,
    })
  );
}

function clampSessionHours(hours) {
  if (!Number.isFinite(hours)) return SESSION_MAX_HOURS;
  return Math.max(SESSION_MIN_HOURS, Math.min(SESSION_MAX_HOURS, hours));
}

export default function App() {
  const [authSession, setAuthSession] = useState(() => readCachedAuthSession());
  const [loginUsername, setLoginUsername] = useState(() => String(readCachedAuthSession()?.username || ''));
  const [loginEmail, setLoginEmail] = useState(() => String(readCachedAuthSession()?.email || ''));
  const [loginPassword, setLoginPassword] = useState('');
  const [loginDisplayName, setLoginDisplayName] = useState(() => String(readCachedAuthSession()?.displayName || ''));
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState('');

  const [messages, setMessages] = useState([DEFAULT_MESSAGE]);
  const [input, setInput] = useState('');
  const [chatUserId, setChatUserId] = useState(() => String(readCachedAuthSession()?.userId || ''));
  const [conversationId, setConversationId] = useState('');
  const [generated, setGenerated] = useState([]);
  const [activeArtifact, setActiveArtifact] = useState(null);
  const [visibleIds, setVisibleIds] = useState([]);
  const [hiddenParts, setHiddenParts] = useState({});
  const [expandedId, setExpandedId] = useState(null);
  const [collapsedIds, setCollapsedIds] = useState({});
  const [imageUpdatingId, setImageUpdatingId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingStartedAt, setLoadingStartedAt] = useState(null);
  const [loadingMode, setLoadingMode] = useState('general');
  const [loadingPhases, setLoadingPhases] = useState(DEFAULT_LOADING_PHASES);
  const [generationIssue, setGenerationIssue] = useState(null);
  const [error, setError] = useState(null);

  const getArtifactId = (artifact) => artifact.uid ?? artifact.id;

  const createUid = () => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  };

  useEffect(() => {
    persistAuthSession(authSession);
  }, [authSession]);

  useEffect(() => {
    if (!authSession?.expiresAt) return undefined;
    const timer = window.setInterval(() => {
      if (Date.now() >= Number(authSession.expiresAt)) {
        setAuthSession(null);
        setAuthError('Session expired. Please log in again.');
        setMessages([DEFAULT_MESSAGE]);
        setInput('');
        setGenerated([]);
        setActiveArtifact(null);
        setVisibleIds([]);
        setHiddenParts({});
        setExpandedId(null);
        setCollapsedIds({});
        setImageUpdatingId(null);
        setLoading(false);
        setLoadingStartedAt(null);
        setLoadingMode('general');
        setLoadingPhases(DEFAULT_LOADING_PHASES);
        setGenerationIssue(null);
        setError(null);
        setConversationId('');
      }
    }, 30000);
    return () => window.clearInterval(timer);
  }, [authSession?.expiresAt]);

  useEffect(() => {
    if (!authSession?.userId) {
      setChatUserId('');
      setConversationId('');
      return;
    }
    const stableUserId = String(authSession.userId).trim();
    setChatUserId(stableUserId);
    setConversationId('');
  }, [authSession?.userId]);

  const syncConversationContext = (payload) => {
    const nextUserId = String(payload?.user_id || '').trim();
    const nextConversationId = String(payload?.conversation_id || '').trim();
    if (nextUserId) {
      setChatUserId(nextUserId);
      setAuthSession((prev) => {
        if (!prev) return prev;
        return { ...prev, userId: nextUserId };
      });
    }
    if (nextConversationId) {
      setConversationId(nextConversationId);
    }
  };

  const resetWorkspace = () => {
    setMessages([DEFAULT_MESSAGE]);
    setInput('');
    setGenerated([]);
    setActiveArtifact(null);
    setVisibleIds([]);
    setHiddenParts({});
    setExpandedId(null);
    setCollapsedIds({});
    setImageUpdatingId(null);
    setLoading(false);
    setLoadingStartedAt(null);
    setLoadingMode('general');
    setLoadingPhases(DEFAULT_LOADING_PHASES);
    setGenerationIssue(null);
    setError(null);
    setConversationId('');
  };

  const handleLogout = () => {
    setAuthSession(null);
    setAuthError('');
    setLoginPassword('');
    resetWorkspace();
  };

  const handleLoginSubmit = async (event) => {
    event.preventDefault();
    if (authLoading) return;
    const username = String(loginUsername || '').trim().toLowerCase();
    const email = String(loginEmail || '').trim().toLowerCase();
    const password = String(loginPassword || '');
    const displayName = String(loginDisplayName || '').trim();
    if (!username || !password) {
      setAuthError('Please provide username and password.');
      return;
    }
    setAuthLoading(true);
    setAuthError('');
    try {
      const payload = await loginUser({
        username,
        email: email || undefined,
        password,
        display_name: displayName || undefined,
      });
      const expiresInSeconds = Number(payload?.expires_in_seconds || 0);
      const expiresAtFromServer = Date.parse(String(payload?.session_expires_at || ''));
      const fallbackHours = clampSessionHours(expiresInSeconds > 0 ? expiresInSeconds / 3600 : SESSION_MAX_HOURS);
      const expiresAt = Number.isFinite(expiresAtFromServer) && expiresAtFromServer > Date.now()
        ? expiresAtFromServer
        : Date.now() + fallbackHours * 3600 * 1000;

      const nextSession = {
        userId: String(payload?.user_id || '').trim(),
        username: String(payload?.username || username).trim().toLowerCase(),
        email: String(payload?.email || email).trim().toLowerCase(),
        displayName: String(payload?.display_name || displayName || payload?.username || username).trim(),
        expiresAt,
      };
      if (!nextSession.userId || !nextSession.username) {
        throw new Error('Login failed: missing user id.');
      }
      setAuthSession(nextSession);
      setLoginPassword('');
      resetWorkspace();
    } catch (err) {
      setAuthError(err?.message || 'Login failed.');
    } finally {
      setAuthLoading(false);
    }
  };

  const normalizeArtifacts = (items, prefix) =>
    items.map((item) => ({
      ...item,
      uid: item.uid ?? `${prefix}-${item.id}-${createUid()}`,
      _rev: Number.isFinite(item._rev) ? item._rev : 0,
    }));

  const allArtifacts = useMemo(
    () => ({
      generated,
      all: [...generated],
    }),
    [generated]
  );

  const visibleArtifacts = useMemo(
    () => allArtifacts.all.filter((item) => visibleIds.includes(getArtifactId(item))),
    [allArtifacts.all, visibleIds]
  );

  const isVisible = (id) => visibleIds.includes(id);

  const toggleVisibility = (artifact) => {
    const id = getArtifactId(artifact);
    setVisibleIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return Array.from(next);
    });
  };

  const updateArtifact = (updated) => {
    const nextUpdated = {
      ...updated,
      _rev: (updated._rev || 0) + 1,
    };
    const updatedId = getArtifactId(updated);
    setGenerated((prev) =>
      prev.map((item) => (getArtifactId(item) === updatedId ? nextUpdated : item))
    );
    if (getArtifactId(activeArtifact || {}) === updatedId) {
      setActiveArtifact(nextUpdated);
    }
  };

  const mergeArtifactHistoryMeta = (nextArtifact, previousArtifact) => {
    const priorMeta = previousArtifact?.meta && typeof previousArtifact.meta === 'object'
      ? previousArtifact.meta
      : {};
    const nextMeta = nextArtifact?.meta && typeof nextArtifact.meta === 'object'
      ? nextArtifact.meta
      : {};
    const priorHistory = priorMeta?.history && typeof priorMeta.history === 'object'
      ? priorMeta.history
      : {};
    const nextHistory = nextMeta?.history && typeof nextMeta.history === 'object'
      ? nextMeta.history
      : {};
    const mergedHistory = { ...priorHistory, ...nextHistory };
    const hasHistory = Object.keys(mergedHistory).length > 0;
    if (!hasHistory) return nextArtifact;
    return {
      ...nextArtifact,
      meta: {
        ...priorMeta,
        ...nextMeta,
        history: mergedHistory,
      },
    };
  };

  const mergeRevisedArtifacts = (incomingArtifacts, plan) => {
    const targets = Array.isArray(plan?.targets) ? plan.targets : [];
    if (!targets.length) {
      return {
        merged: generated,
        applied: [],
      };
    }

    const byId = new Map();
    const byType = new Map();
    targets.forEach((artifact) => {
      const artifactId = String(artifact?.id || '').trim();
      const logicalKey = String(artifact?.meta?.history?.logical_key || '').trim();
      const type = String(artifact?.type || '').trim().toLowerCase();
      if (artifactId) byId.set(artifactId, artifact);
      if (logicalKey) byId.set(logicalKey, artifact);
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(artifact);
    });

    const used = new Set();
    const next = [...generated];
    const applied = [];

    (incomingArtifacts || []).forEach((incoming) => {
      if (!incoming || typeof incoming !== 'object') return;
      const incomingId = String(incoming.id || '').trim();
      const incomingType = String(incoming.type || '').trim().toLowerCase();

      let target = null;
      if (incomingId && byId.has(incomingId)) {
        target = byId.get(incomingId);
      } else {
        const candidates = (byType.get(incomingType) || []).filter((artifact) => {
          const key = String(artifact?.uid || artifact?.id || '').trim();
          return key && !used.has(key);
        });
        if (candidates.length === 1) {
          target = candidates[0];
        } else if (targets.length === 1) {
          target = targets[0];
        }
      }

      if (!target) return;

      const targetKey = String(target?.uid || target?.id || '').trim();
      if (!targetKey || used.has(targetKey)) return;

      const mergedMeta = mergeArtifactHistoryMeta(incoming, target);
      const updated = {
        ...mergedMeta,
        uid: target.uid ?? target.id,
        _rev: (target._rev || 0) + 1,
      };

      const index = next.findIndex((item) => String(getArtifactId(item)) === targetKey);
      if (index >= 0) {
        next[index] = updated;
      } else {
        next.unshift(updated);
      }

      used.add(targetKey);
      applied.push(updated);
    });

    return {
      merged: next,
      applied,
    };
  };

  const togglePartVisibility = (artifact, part) => {
    const artifactId = getArtifactId(artifact);
    setHiddenParts((prev) => {
      const existing = new Set(prev[artifactId] || []);
      if (existing.has(part)) {
        existing.delete(part);
      } else {
        existing.add(part);
      }
      return { ...prev, [artifactId]: Array.from(existing) };
    });
  };

  const toggleExpand = (artifact) => {
    const artifactId = getArtifactId(artifact);
    setExpandedId((prev) => (prev === artifactId ? null : artifactId));
  };

  const isCollapsed = (id) => collapsedIds[id] !== false;

  const toggleCollapse = (artifact) => {
    const artifactId = getArtifactId(artifact);
    setCollapsedIds((prev) => {
      const current = prev[artifactId] !== false;
      const next = { ...prev, [artifactId]: !current };
      return next;
    });
    if (expandedId === artifactId) {
      setExpandedId(null);
    }
  };

  useEffect(() => {
    if (!activeArtifact) {
      return;
    }

    if (!visibleIds.includes(getArtifactId(activeArtifact))) {
      setActiveArtifact(visibleArtifacts[0] || null);
    }
  }, [activeArtifact, visibleArtifacts, visibleIds]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || loading || !chatUserId) {
      return;
    }
    if (isChartSummaryWithoutChartContext(trimmed, generated)) {
      const uiMessages = [...messages, { role: 'user', content: trimmed }];
      const assistantContent = 'Missing required context: there is no chart in this chat yet. Create a chart first, then request a chart-trend summary.';
      setMessages([...uiMessages, { role: 'assistant', content: assistantContent }]);
      setGenerationIssue({
        mode: 'text',
        caseName: 'missing_context',
        caseLabel: 'Missing Context',
        message: 'A chart-trend summary needs an existing chart in this chat. Generate a chart first.',
        suggestions: [
          'Create an interactive sales bar chart with axes, legend, and tooltips.',
          'Create a concise text summary of chart trends with 3 bullets.',
        ],
      });
      setError(null);
      return;
    }

    const revisionPlan = buildRevisionPlan(trimmed, generated, activeArtifact);
    const requestUserContent = revisionPlan.enabled
      ? `${trimmed}\n\n${buildRevisionInstruction(revisionPlan.targets)}`
      : trimmed;
    const requestMessages = [...messages, { role: 'user', content: requestUserContent }];
    const uiMessages = [...messages, { role: 'user', content: trimmed }];
    const nextMode = inferLoadingMode(trimmed, 'general');
    setMessages(uiMessages);
    setInput('');
    setLoading(true);
    setLoadingStartedAt(Date.now());
    setLoadingMode(nextMode);
    setLoadingPhases(phasesForMode(nextMode));
    setError(null);
    setGenerationIssue(null);

    try {
      const parentLinks = revisionPlan.enabled
        ? revisionPlan.targets.map((artifact) => {
          const artifactId = String(artifact?.id || '').trim();
          const parentArtifactId = String(artifact?.meta?.history?.logical_key || artifactId || '').trim();
          const parentVersionId = String(artifact?.meta?.history?.version_id || '').trim();
          if (!artifactId || !parentArtifactId) return null;
          return {
            artifact_id: artifactId,
            parent_artifact_id: parentArtifactId,
            parent_version_id: parentVersionId || undefined,
          };
        }).filter(Boolean)
        : [];

      const singleParent = revisionPlan.enabled && revisionPlan.targets.length === 1
        ? revisionPlan.targets[0]
        : null;
      const singleParentLogicalKey = String(
        singleParent?.meta?.history?.logical_key || singleParent?.id || ''
      ).trim();
      const singleParentVersion = String(singleParent?.meta?.history?.version_id || '').trim();

      const data = await sendChat(requestMessages, {
        userId: chatUserId,
        conversationId,
        parentArtifactId: singleParentLogicalKey || undefined,
        parentVersionId: singleParentVersion || undefined,
        artifactParentLinks: parentLinks,
      });
      syncConversationContext(data);
      const reply = String(data.reply || '');
      let assistantReply = reply;
      const rawArtifacts = annotateArtifactsWithPromptClause(
        normalizeArtifacts(Array.isArray(data.artifacts) ? data.artifacts : [], 'gen'),
        trimmed
      );
      const requestedChartColor = revisionPlan.enabled ? detectRequestedChartColor(trimmed) : '';
      const requestedChartRowRemoval = revisionPlan.enabled ? detectChartDataRemovalTarget(trimmed) : '';
      const requestedChartRowAdditions = revisionPlan.enabled ? detectChartDataAdditionTargets(trimmed) : [];
      const hasDeterministicChartEdit = Boolean(
        requestedChartColor
        || requestedChartRowRemoval
        || (requestedChartRowAdditions && requestedChartRowAdditions.length)
      );
      const revisionTargets = revisionPlan.enabled ? revisionPlan.targets : [];
      const artifacts = rawArtifacts.map((artifact) => {
        if (String(artifact?.type || '').toLowerCase() !== 'html') return artifact;
        const incomingCode = String(artifact?.code || '');
        let nextCode = incomingCode;
        if (revisionPlan.enabled) {
          const artifactId = String(artifact?.id || '').trim();
          const artifactType = String(artifact?.type || '').toLowerCase();
          const targetCandidates = revisionTargets.filter((target) => String(target?.type || '').toLowerCase() === artifactType);
          const idMatchedTarget = targetCandidates.find((target) => String(target?.id || '').trim() === artifactId) || null;
          const target = idMatchedTarget || (targetCandidates.length === 1 ? targetCandidates[0] : null);
          const targetCode = String(target?.code || '');
          const shouldMergeChartState = Boolean(
            target
            && looksLikeChartHtmlCode(targetCode)
            && looksLikeChartHtmlCode(incomingCode)
            && !looksLikeWeatherHtmlCode(targetCode)
            && !looksLikeWeatherHtmlCode(incomingCode)
          );
          if (shouldMergeChartState) {
            nextCode = mergeChartHtmlWithPriorState(String(target?.code || ''), incomingCode);
          }
        }
        if (requestedChartColor) {
          nextCode = applyChartColorOverride(nextCode, requestedChartColor);
        }
        if (requestedChartRowRemoval) {
          nextCode = applyChartDataRemovalOverride(nextCode, requestedChartRowRemoval);
        }
        if (requestedChartRowAdditions.length) {
          nextCode = applyChartDataAdditionOverride(nextCode, requestedChartRowAdditions);
        }
        return {
          ...artifact,
          code: nextCode,
        };
      });
      const applyDirectChartRevisionToTargets = () => {
        const targets = Array.isArray(revisionPlan.targets) ? revisionPlan.targets : [];
        if (!targets.length || !hasDeterministicChartEdit) {
          return { merged: generated, applied: [] };
        }
        const next = [...generated];
        const applied = [];

        targets.forEach((target) => {
          if (String(target?.type || '').toLowerCase() !== 'html') return;
          const baseCode = String(target?.code || '');
          if (!looksLikeChartHtmlCode(baseCode) || looksLikeWeatherHtmlCode(baseCode)) return;
          let updatedCode = baseCode;
          if (requestedChartColor) {
            updatedCode = applyChartColorOverride(updatedCode, requestedChartColor);
          }
          if (requestedChartRowRemoval) {
            updatedCode = applyChartDataRemovalOverride(updatedCode, requestedChartRowRemoval);
          }
          if (requestedChartRowAdditions.length) {
            updatedCode = applyChartDataAdditionOverride(updatedCode, requestedChartRowAdditions);
          }
          if (updatedCode === baseCode) return;

          const updated = {
            ...target,
            code: updatedCode,
            _rev: (target._rev || 0) + 1,
          };
          const targetKey = String(getArtifactId(target));
          const index = next.findIndex((item) => String(getArtifactId(item)) === targetKey);
          if (index >= 0) next[index] = updated;
          applied.push(updated);
        });

        return { merged: next, applied };
      };

      if (artifacts.length) {
        if (revisionPlan.enabled) {
          const { merged, applied } = mergeRevisedArtifacts(artifacts, revisionPlan);
          if (applied.length) {
            setGenerated(merged);
            setVisibleIds((prev) => {
              const next = new Set(prev);
              applied.forEach((artifact) => next.add(getArtifactId(artifact)));
              return Array.from(next);
            });
            setActiveArtifact(applied[0]);
          } else {
            const local = applyDirectChartRevisionToTargets();
            if (local.applied.length) {
              setGenerated(local.merged);
              setVisibleIds((prev) => {
                const next = new Set(prev);
                local.applied.forEach((artifact) => next.add(getArtifactId(artifact)));
                return Array.from(next);
              });
              setActiveArtifact(local.applied[0]);
              if (isGenericArtifactReply(assistantReply)) {
                assistantReply = buildChartRevisionAcknowledgement({
                  color: requestedChartColor,
                  removed: requestedChartRowRemoval,
                  addedMonths: requestedChartRowAdditions,
                });
              }
            } else {
              setError('Revision output did not match existing card targets. No new card was added.');
            }
          }
        } else {
          setGenerated((prev) => [...artifacts, ...prev]);
          setVisibleIds((prev) => {
            const next = new Set(prev);
            artifacts.forEach((artifact) => next.add(getArtifactId(artifact)));
            return Array.from(next);
          });
          setActiveArtifact(artifacts[0]);
        }
        setGenerationIssue(null);
      } else {
        const local = revisionPlan.enabled ? applyDirectChartRevisionToTargets() : { merged: generated, applied: [] };
        if (local.applied.length) {
          setGenerated(local.merged);
          setVisibleIds((prev) => {
            const next = new Set(prev);
            local.applied.forEach((artifact) => next.add(getArtifactId(artifact)));
            return Array.from(next);
          });
          setActiveArtifact(local.applied[0]);
          setGenerationIssue(null);
          if (isGenericArtifactReply(assistantReply)) {
            assistantReply = buildChartRevisionAcknowledgement({
              color: requestedChartColor,
              removed: requestedChartRowRemoval,
              addedMonths: requestedChartRowAdditions,
            });
          }
        } else {
          const issueCase = looksLikeUnproductiveReply(reply)
            ? detectIssueCase(reply)
            : 'no_artifacts';
          setGenerationIssue({
            mode: nextMode,
            caseName: issueCase,
            caseLabel: issueLabelForCase(issueCase),
            message: issueMessageForCase(issueCase),
            suggestions: suggestionsForMode(nextMode, trimmed, issueCase),
          });
        }
      }
      setMessages([...uiMessages, { role: 'assistant', content: assistantReply }]);
    } catch (err) {
      const errText = err?.message || 'Chat failed';
      const issueCase = detectIssueCase(errText);
      setError(errText);
      setGenerationIssue({
        mode: nextMode,
        caseName: issueCase,
        caseLabel: issueLabelForCase(issueCase),
        message: issueMessageForCase(issueCase),
        suggestions: suggestionsForMode(nextMode, trimmed, issueCase),
      });
    } finally {
      setLoading(false);
      setLoadingStartedAt(null);
    }
  };

  const handleRefineImage = async ({
    artifact,
    controls,
    selections,
    basePrompt,
    mode = 'regenerate',
    instruction = '',
    maskDataUrl = '',
  }) => {
    const artifactId = getArtifactId(artifact || {});
    if (!artifactId || loading) {
      return;
    }
    const nextMode = String(mode || 'regenerate').trim().toLowerCase();
    const editInstruction = String(instruction || '').trim();
    const nextMaskDataUrl = String(maskDataUrl || '').trim();
    const parentLogicalKey = String(artifact?.meta?.history?.logical_key || artifact?.id || '').trim();
    const parentVersionId = String(artifact?.meta?.history?.version_id || '').trim();

    const controlLines = (controls || [])
      .map((control) => {
        const id = String(control?.id || '').trim();
        const label = String(control?.label || id || 'Option').trim();
        const value = String((selections || {})[id] || control?.current || '').trim();
        if (!id || !value) return '';
        return `- ${label}: ${value}`;
      })
      .filter(Boolean);

    const base = String(basePrompt || artifact?.prompt || '').trim();

    if (nextMode === 'inpaint') {
      if (!editInstruction || !nextMaskDataUrl) {
        setError('Please draw a region and provide an edit instruction.');
        return;
      }

      const compactUserText = controlLines.length
        ? `Edit selected region:\n- Instruction: ${editInstruction}\n${controlLines.join('\n')}`
        : `Edit selected region:\n- Instruction: ${editInstruction}`;

      const uiMessages = [...messages, { role: 'user', content: compactUserText }];
      setMessages(uiMessages);
      setLoading(true);
      setLoadingStartedAt(Date.now());
      setLoadingMode('image');
      setLoadingPhases([
        'Preparing region mask',
        'Applying local prompt edits',
        'Generating refined image',
        'Finalizing updated artifact',
      ]);
      setError(null);
      setGenerationIssue(null);
      setImageUpdatingId(artifactId);

      try {
        const data = await refineImage({
          image: String(artifact?.image || ''),
          mask: nextMaskDataUrl,
          instruction: editInstruction,
          base_prompt: base,
          size: String(artifact?.meta?.size || ''),
          controls: controls || [],
          selections: selections || {},
          artifact_id: parentLogicalKey || String(artifact?.id || ''),
          parent_version_id: parentVersionId || undefined,
          user_id: chatUserId,
          conversation_id: conversationId,
        });
        syncConversationContext(data);

        const reply = String(data?.reply || '');
        const imageArtifact = data?.artifact && typeof data.artifact === 'object' ? data.artifact : null;
        setMessages([...uiMessages, { role: 'assistant', content: reply }]);

        if (!imageArtifact || imageArtifact.type !== 'image') {
          setError('Image region edit did not return an image artifact.');
          return;
        }

        const annotated = annotateArtifactsWithPromptClause(
          [imageArtifact],
          compactUserText
        )[0];
        const mergedArtifact = mergeArtifactHistoryMeta(annotated, artifact);

        const updated = {
          ...mergedArtifact,
          uid: artifact.uid ?? artifact.id,
          _rev: (artifact._rev || 0) + 1,
        };

        setGenerated((prev) =>
          prev.map((item) => (getArtifactId(item) === artifactId ? updated : item))
        );
        setActiveArtifact(updated);
      } catch (err) {
        setError(err.message || 'Image region edit failed');
      } finally {
        setImageUpdatingId(null);
        setLoading(false);
        setLoadingStartedAt(null);
      }
      return;
    }

    const promptText = [
      'Regenerate exactly one image artifact from this image direction.',
      base
        ? `Base prompt: ${base}`
        : 'Base prompt: keep the original direction but apply the control selections.',
      'Preserve the same core subject and big-picture intent from the base prompt.',
      'Determine leading visual prompt factors from the base prompt and use them for prompt control suggestions.',
      'Use linguistic factors only; do not use non-linguistic interaction signals.',
      'Control selections:',
      ...(controlLines.length ? controlLines : ['- Keep current settings']),
      'Return only one image artifact.',
      'Do not return html, text, or code artifacts.',
      'For that image artifact, include:',
      '- prompt',
      '- meta.base_prompt',
      '- meta.prompt_controls (same control ids/labels, with updated current values and options)',
    ].join('\n');

    const compactUserText = controlLines.length
      ? `Refine image with selected controls:\n${controlLines.join('\n')}`
      : 'Refine image with current controls.';

    const requestMessages = [...messages, { role: 'user', content: promptText }];
    const uiMessages = [...messages, { role: 'user', content: compactUserText }];
    setMessages(uiMessages);
    setLoading(true);
    setLoadingStartedAt(Date.now());
    setLoadingMode('image');
    setLoadingPhases([
      'Analyzing base prompt',
      'Applying selected controls',
      'Generating updated image',
      'Finalizing image artifact',
    ]);
    setError(null);
    setGenerationIssue(null);
    setImageUpdatingId(artifactId);

    try {
      const data = await sendChat(requestMessages, {
        userId: chatUserId,
        conversationId,
        parentArtifactId: parentLogicalKey || String(artifact?.id || ''),
        parentVersionId: parentVersionId || undefined,
        artifactParentLinks: [
          {
            artifact_id: String(artifact?.id || parentLogicalKey || ''),
            parent_artifact_id: parentLogicalKey || String(artifact?.id || ''),
            parent_version_id: parentVersionId || undefined,
          },
        ],
      });
      syncConversationContext(data);
      const reply = data.reply || '';
      const artifacts = annotateArtifactsWithPromptClause(
        normalizeArtifacts(Array.isArray(data.artifacts) ? data.artifacts : [], 'regen'),
        compactUserText
      );
      const imageArtifact = artifacts.find((item) => item.type === 'image');

      setMessages([...uiMessages, { role: 'assistant', content: reply }]);

      if (!imageArtifact) {
        setError('Image regenerate did not return an image artifact.');
        return;
      }

      const mergedArtifact = mergeArtifactHistoryMeta(imageArtifact, artifact);
      const updated = {
        ...mergedArtifact,
        uid: artifact.uid ?? artifact.id,
        _rev: (artifact._rev || 0) + 1,
      };

      setGenerated((prev) =>
        prev.map((item) => (getArtifactId(item) === artifactId ? updated : item))
      );
      setActiveArtifact(updated);
    } catch (err) {
      setError(err.message || 'Image regenerate failed');
    } finally {
      setImageUpdatingId(null);
      setLoading(false);
      setLoadingStartedAt(null);
    }
  };

  if (!authSession?.userId) {
    return (
      <div className="login-shell">
        <div className="login-bg-orb login-bg-orb-a" />
        <div className="login-bg-orb login-bg-orb-b" />
        <div className="login-panel">
          <div className="login-brand">Chat To Artifacts</div>
          <h1>Sign In</h1>
          <p>Log in to continue. Your chat and artifact history will be tied to your account.</p>
          <form className="login-form" onSubmit={handleLoginSubmit}>
            <label>
              Username
              <input
                type="text"
                value={loginUsername}
                onChange={(event) => setLoginUsername(event.target.value)}
                placeholder="e.g. tonyguo"
                autoComplete="username"
                required
              />
            </label>
            <label>
              Display Name
              <input
                type="text"
                value={loginDisplayName}
                onChange={(event) => setLoginDisplayName(event.target.value)}
                placeholder="Your name"
                autoComplete="name"
              />
            </label>
            <label>
              Email (Optional)
              <input
                type="email"
                value={loginEmail}
                onChange={(event) => setLoginEmail(event.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                placeholder="At least 6 characters"
                autoComplete="current-password"
                minLength={6}
                required
              />
            </label>
            {authError && <div className="login-error">{authError}</div>}
            <button type="submit" className="login-submit" disabled={authLoading}>
              {authLoading ? 'Signing In...' : 'Sign In'}
            </button>
          </form>
          <div className="login-note">Session stays signed in for 4-6 hours.</div>
        </div>
      </div>
    );
  }

  const sessionHoursRemaining = Math.max(
    0,
    (Number(authSession.expiresAt || 0) - Date.now()) / (3600 * 1000)
  );

  return (
    <div className="app-shell">
      <div className="app">
        <div className="left-column">
          <ChatPanel
            messages={messages}
            input={input}
            onInputChange={setInput}
            onSend={handleSend}
            loading={loading}
            loadingStartedAt={loadingStartedAt}
            loadingPhases={loadingPhases}
            generationIssue={generationIssue}
            error={error}
          />

          <ArtifactList
            title="Generated Components"
            items={allArtifacts.generated}
            conversationId={conversationId}
            activeId={activeArtifact ? getArtifactId(activeArtifact) : null}
            onSelect={setActiveArtifact}
            onToggleVisibility={toggleVisibility}
            isVisible={isVisible}
            expandedId={expandedId}
            onToggleExpand={toggleExpand}
            onUpdate={updateArtifact}
            hiddenParts={hiddenParts}
            onTogglePart={togglePartVisibility}
            isCollapsed={isCollapsed}
            onToggleCollapse={toggleCollapse}
          />
        </div>

        <div className="right-column">
          <div className="session-bar session-bar-canvas">
            <div className="session-user">
              Signed in as <strong>{authSession.displayName}</strong> @{authSession.username}
              {authSession.email ? ` (${authSession.email})` : ''}
            </div>
            <div className="session-meta">
              <span>{sessionHoursRemaining.toFixed(1)}h left</span>
              <button type="button" className="session-logout" onClick={handleLogout}>
                Log Out
              </button>
            </div>
          </div>
          <CanvasPanel
            artifacts={visibleArtifacts}
            activeArtifact={activeArtifact}
            onSelect={setActiveArtifact}
            hiddenParts={hiddenParts}
            onRefineImage={handleRefineImage}
            imageUpdatingId={imageUpdatingId}
            loading={loading}
            loadingStartedAt={loadingStartedAt}
            loadingMode={loadingMode}
            loadingPhases={loadingPhases}
            generationIssue={generationIssue}
          />
        </div>
      </div>
    </div>
  );
}
