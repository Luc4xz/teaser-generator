import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  NodeResizer,
  applyNodeChanges,
  useEdgesState,
  useNodesState,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { simulateCode } from '../api.js';

const NODE_WIDTH = 520;
const NODE_HEIGHT = 260;
const NODE_MIN_WIDTH = 420;
const NODE_MIN_HEIGHT = 140;
const NODE_GAP_X = 40;
const NODE_GAP_Y = 40;
const NODE_COLUMNS = 2;

function parseImageSizeMeta(artifact) {
  if (!artifact || artifact.type !== 'image') return null;

  const meta = artifact.meta && typeof artifact.meta === 'object' ? artifact.meta : null;
  const raw =
    (meta && typeof meta.size === 'string' ? meta.size : '') ||
    (typeof artifact.size === 'string' ? artifact.size : '');

  const match = String(raw).trim().match(/^(\d{2,5})\s*x\s*(\d{2,5})$/i);
  if (!match) return null;

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
}

function normalizeImagePromptControls(artifact) {
  if (!artifact || artifact.type !== 'image') return [];
  const meta = artifact.meta && typeof artifact.meta === 'object' ? artifact.meta : null;
  const raw = meta && Array.isArray(meta.prompt_controls) ? meta.prompt_controls : [];

  return raw
    .map((control, index) => {
      if (!control || typeof control !== 'object') return null;
      const id = String(control.id || `control-${index + 1}`).trim();
      const label = String(control.label || id || `Control ${index + 1}`).trim();
      const current = String(control.current || '').trim();
      const optionsRaw = Array.isArray(control.options) ? control.options : [];
      const options = optionsRaw
        .map((option) => {
          if (typeof option === 'string') {
            const value = option.trim();
            return value ? { label: value, value } : null;
          }
          if (option && typeof option === 'object') {
            const value = String(option.value || option.label || '').trim();
            const optionLabel = String(option.label || value).trim();
            if (!value) return null;
            return { label: optionLabel || value, value };
          }
          return null;
        })
        .filter(Boolean);

      const optionValues = new Set(options.map((item) => item.value));
      if (current && !optionValues.has(current)) {
        options.unshift({ label: current, value: current });
      }
      if (!id || !options.length) return null;
      return {
        id,
        label: label || id,
        current: current || options[0].value,
        options,
      };
    })
    .filter(Boolean);
}

async function copyText(value) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (_err) {
    return false;
  }
  return false;
}

function renderHighlightedText(line, term) {
  if (!term) return [line];
  const lowered = line.toLowerCase();
  const token = term.toLowerCase();
  const parts = [];
  let cursor = 0;

  while (cursor < line.length) {
    const idx = lowered.indexOf(token, cursor);
    if (idx === -1) {
      parts.push(line.slice(cursor));
      break;
    }
    if (idx > cursor) {
      parts.push(line.slice(cursor, idx));
    }
    parts.push(
      <mark key={`${idx}-${cursor}`} className="artifact-code-mark">
        {line.slice(idx, idx + token.length)}
      </mark>
    );
    cursor = idx + token.length;
  }

  if (!parts.length) return [line];
  return parts;
}

const TEXT_HIGHLIGHT_RE =
  /(https?:\/\/[^\s)]+|\$\d[\d,]*(?:\.\d+)?|\b\d{4}-\d{2}-\d{2}\b|\b\d+(?:\.\d+)?\s?(?:%|°[FC]|mm|cm|km|mph|kph)\b|\b(?:high|low|risk|action item|deadline|source|warning|critical|major|minor|trend|temperature|precipitation|summary|freshness|increase|decrease|up|down|owner|due)\b)/gi;

const EXPLICIT_STYLE_RE = /\[\[([a-zA-Z_-]+)\s*:\s*([^[\]]+?)\]\]/g;
const MARKDOWN_INLINE_RE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g;

function normalizeStyleLabel(label) {
  const lowered = String(label || '').trim().toLowerCase();
  const mapping = {
    metric: 'metric',
    value: 'metric',
    number: 'metric',
    risk: 'risk',
    warning: 'risk',
    alert: 'risk',
    date: 'date',
    time: 'date',
    source: 'source',
    link: 'source',
    trend: 'trend',
    action: 'action',
    owner: 'action',
    note: 'note',
    info: 'note',
  };
  return mapping[lowered] || 'key';
}

function classifyToken(token) {
  const value = String(token || '').trim();
  const lowered = value.toLowerCase();
  if (/^https?:\/\//.test(lowered) || /\bsource\b/.test(lowered)) return 'source';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
  if (/\$|\b\d+(?:\.\d+)?\s?(%|°[fc]|mm|cm|km|mph|kph)\b/i.test(value)) return 'metric';
  if (/\b(risk|warning|critical|major|minor|issue)\b/.test(lowered)) return 'risk';
  if (/\b(trend|increase|decrease|up|down|warming|cooling)\b/.test(lowered)) return 'trend';
  if (/\b(action|owner|due|todo|next)\b/.test(lowered)) return 'action';
  if (/\b(note|summary|info|freshness)\b/.test(lowered)) return 'note';
  return 'key';
}

function renderMarkdownInline(text, keyPrefix, className = '') {
  if (!text) return [''];
  const chunks = [];
  let cursor = 0;
  let idx = 0;

  for (const match of text.matchAll(MARKDOWN_INLINE_RE)) {
    if (typeof match.index !== 'number') continue;
    if (match.index > cursor) {
      chunks.push(text.slice(cursor, match.index));
    }
    const raw = match[0];
    let inner = raw;
    let flavor = '';
    if (raw.startsWith('**') && raw.endsWith('**')) {
      inner = raw.slice(2, -2);
      flavor = 'strong';
    } else if (raw.startsWith('__') && raw.endsWith('__')) {
      inner = raw.slice(2, -2);
      flavor = 'underline';
    } else if (raw.startsWith('*') && raw.endsWith('*')) {
      inner = raw.slice(1, -1);
      flavor = 'italic';
    } else if (raw.startsWith('_') && raw.endsWith('_')) {
      inner = raw.slice(1, -1);
      flavor = 'italic';
    }

    chunks.push(
      <span
        key={`${keyPrefix}-md-${idx}`}
        className={`artifact-text-em artifact-text-em-${flavor}${className ? ` ${className}` : ''}`}
      >
        {inner}
      </span>
    );
    cursor = match.index + raw.length;
    idx += 1;
  }

  if (cursor < text.length) {
    chunks.push(text.slice(cursor));
  }

  return chunks.length ? chunks : [text];
}

function renderAutoStyledSegment(segment, keyPrefix, startIndex = 0) {
  if (!segment) return { nodes: [''], nextIndex: startIndex };
  const nodes = [];
  let cursor = 0;
  let index = startIndex;

  for (const match of segment.matchAll(TEXT_HIGHLIGHT_RE)) {
    if (typeof match.index !== 'number') continue;
    if (match.index > cursor) {
      nodes.push(...renderMarkdownInline(segment.slice(cursor, match.index), `${keyPrefix}-plain-${index}`));
    }
    const token = match[0];
    const tokenType = classifyToken(token);
    nodes.push(
      <span key={`${keyPrefix}-tok-${index}`} className={`artifact-text-token artifact-text-token--${tokenType}`}>
        {token}
      </span>
    );
    cursor = match.index + token.length;
    index += 1;
  }

  if (cursor < segment.length) {
    nodes.push(...renderMarkdownInline(segment.slice(cursor), `${keyPrefix}-tail-${index}`));
  }
  return { nodes: nodes.length ? nodes : [segment], nextIndex: index };
}

function renderTextWithHighlights(line, keyPrefix) {
  if (!line) return [''];

  const parts = [];
  let cursor = 0;
  let tokenIndex = 0;

  for (const match of line.matchAll(EXPLICIT_STYLE_RE)) {
    if (typeof match.index !== 'number') continue;

    if (match.index > cursor) {
      const before = renderAutoStyledSegment(line.slice(cursor, match.index), `${keyPrefix}-pre`, tokenIndex);
      parts.push(...before.nodes);
      tokenIndex = before.nextIndex;
    }

    const styleType = normalizeStyleLabel(match[1]);
    const content = String(match[2] || '').trim();
    parts.push(
      <span key={`${keyPrefix}-explicit-${tokenIndex}`} className={`artifact-text-token artifact-text-token--${styleType}`}>
        {renderMarkdownInline(content, `${keyPrefix}-explicit-inner-${tokenIndex}`)}
      </span>
    );
    cursor = match.index + match[0].length;
    tokenIndex += 1;
  }

  if (cursor < line.length) {
    const tail = renderAutoStyledSegment(line.slice(cursor), `${keyPrefix}-post`, tokenIndex);
    parts.push(...tail.nodes);
  }

  return parts.length ? parts : renderMarkdownInline(line, `${keyPrefix}-all`);
}

function parseStructuredText(text) {
  const source = String(text || '');
  if (!source.trim()) return [];

  const lines = source.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      i += 1;
      const codeLines = [];
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: 'code', text: codeLines.join('\n') });
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      });
      i += 1;
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length) {
        const lineMatch = lines[i].trim().match(/^[-*]\s+(.*)$/);
        if (!lineMatch) break;
        items.push(lineMatch[1].trim());
        i += 1;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length) {
        const lineMatch = lines[i].trim().match(/^\d+\.\s+(.*)$/);
        if (!lineMatch) break;
        items.push(lineMatch[1].trim());
        i += 1;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    if (/^>\s+/.test(trimmed) || /^(note|source|sources|data freshness|warning)\b/i.test(trimmed)) {
      blocks.push({
        type: 'callout',
        text: trimmed.replace(/^>\s*/, ''),
      });
      i += 1;
      continue;
    }

    const paragraphLines = [trimmed];
    i += 1;
    while (i < lines.length) {
      const next = lines[i].trim();
      if (!next) {
        i += 1;
        break;
      }
      if (/^(#{1,3}\s+|[-*]\s+|\d+\.\s+|>\s+|```)/.test(next)) break;
      paragraphLines.push(next);
      i += 1;
    }
    blocks.push({ type: 'p', text: paragraphLines.join(' ') });
  }

  return blocks;
}

function renderTextBlock(block, index) {
  if (block.type === 'heading') {
    return (
      <h4 key={`heading-${index}`} className={`artifact-text-heading level-${block.level || 1}`}>
        {renderTextWithHighlights(block.text || '', `heading-${index}`)}
      </h4>
    );
  }

  if (block.type === 'callout') {
    return (
      <div key={`callout-${index}`} className="artifact-text-callout">
        {renderTextWithHighlights(block.text || '', `callout-${index}`)}
      </div>
    );
  }

  if (block.type === 'ul') {
    return (
      <ul key={`ul-${index}`} className="artifact-text-list artifact-text-list-ul">
        {(block.items || []).map((item, itemIndex) => (
          <li key={`ul-${index}-${itemIndex}`}>
            {renderTextWithHighlights(item, `ul-${index}-${itemIndex}`)}
          </li>
        ))}
      </ul>
    );
  }

  if (block.type === 'ol') {
    return (
      <ol key={`ol-${index}`} className="artifact-text-list artifact-text-list-ol">
        {(block.items || []).map((item, itemIndex) => (
          <li key={`ol-${index}-${itemIndex}`}>
            {renderTextWithHighlights(item, `ol-${index}-${itemIndex}`)}
          </li>
        ))}
      </ol>
    );
  }

  if (block.type === 'code') {
    return (
      <pre key={`code-${index}`} className="artifact-text-code">
        {block.text || ''}
      </pre>
    );
  }

  return (
    <p key={`p-${index}`} className="artifact-text-paragraph">
      {renderTextWithHighlights(block.text || '', `p-${index}`)}
    </p>
  );
}

function ArtifactNode({ data, selected }) {
  const { artifact, hiddenParts, onSimulateCode, simulatingCodeId } = data;
  const artifactId = artifact.uid || artifact.id;
  const traceClause = String(artifact?.meta?.prompt_clause || '').trim();
  const [textExpanded, setTextExpanded] = useState(false);
  const [textFontSize, setTextFontSize] = useState(13);
  const [textCopied, setTextCopied] = useState(false);
  const [codeWrap, setCodeWrap] = useState(false);
  const [codeShowLines, setCodeShowLines] = useState(true);
  const [codeCopied, setCodeCopied] = useState(false);
  const [codeSearch, setCodeSearch] = useState('');

  const injected = useMemo(() => {
    if (artifact.type !== 'html') return null;
    if (!artifact.code) return artifact.code;

    const baseRules = [
      'html, body { margin: 0 !important; padding: 0 !important; width: 100% !important; min-height: 100% !important; overflow: auto !important; background: #ffffff !important; }',
      '* { box-sizing: border-box; }',
      'img, svg, canvas, table { max-width: 100% !important; }',
      '[style*="100vh"] { height: auto !important; min-height: 0 !important; }',
    ];

    const escapeCssAttrValue = (value) => String(value).replace(/["\\]/g, '\\$&');
    const hiddenRules = (hiddenParts || [])
      .map((part) => `[data-part="${escapeCssAttrValue(part)}"]{display:none !important;}`)
      .join('\n');
    const rules = `${baseRules.join('\n')}\n${hiddenRules}`.trim();
    const styleTag = `<style>${rules}</style>`;

    const artifactIdJson = JSON.stringify(artifactId);
    const scriptTag = `<script>(function(){try{var ID=${artifactIdJson};var last=0;var send=function(){var h=Math.max(document.body?document.body.scrollHeight:0,document.documentElement?document.documentElement.scrollHeight:0,0);if(!h||Math.abs(h-last)<2)return;last=h;window.parent&&window.parent.postMessage({__artifactPreview:true,artifactId:ID,height:h},'*');};var schedule=function(){try{requestAnimationFrame(send);}catch(e){send();}};window.addEventListener('load',schedule);if(typeof ResizeObserver!=='undefined'){var ro=new ResizeObserver(schedule);ro.observe(document.documentElement);if(document.body)ro.observe(document.body);}if(typeof MutationObserver!=='undefined'){var mo=new MutationObserver(schedule);mo.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});}schedule();}catch(e){}})();</script>`;

    const injection = `${styleTag}\n${scriptTag}`;
    const html = String(artifact.code);
    if (html.includes('</head>')) {
      return html.replace('</head>', `${injection}</head>`);
    }
    return `${injection}${html}`;
  }, [artifact.code, artifact.type, hiddenParts, artifactId]);
  const hiddenKey = hiddenParts?.length ? hiddenParts.join('|') : 'visible';
  const renderKey = `${artifactId}-${artifact._rev || 0}-${hiddenKey}`;
  const stopWheelPropagation = (event) => {
    event.stopPropagation();
  };
  const textValue = String(artifact.text || artifact.description || '');
  const textPreviewLimit = 380;
  const textDisplay =
    textExpanded || textValue.length <= textPreviewLimit
      ? textValue
      : `${textValue.slice(0, textPreviewLimit)}...`;
  const textBlocks = useMemo(() => parseStructuredText(textDisplay), [textDisplay]);

  const codeValue = String(artifact.code || '');
  const codeLines = codeValue.split('\n');
  const codeLineCount = codeLines.length;
  const normalizedSearch = codeSearch.trim();
  const filteredLines = normalizedSearch
    ? codeLines
        .map((line, index) => ({ line, index }))
        .filter((item) => item.line.toLowerCase().includes(normalizedSearch.toLowerCase()))
    : codeLines.map((line, index) => ({ line, index }));

  const handleTextCopy = async () => {
    if (!textValue) return;
    const ok = await copyText(textValue);
    if (ok) {
      setTextCopied(true);
      window.setTimeout(() => setTextCopied(false), 1100);
    }
  };

  const handleCodeCopy = async () => {
    if (!codeValue) return;
    const ok = await copyText(codeValue);
    if (ok) {
      setCodeCopied(true);
      window.setTimeout(() => setCodeCopied(false), 1100);
    }
  };

  const handleCodeSimulate = () => {
    if (!onSimulateCode) return;
    onSimulateCode(artifact);
  };
  const loadingProgress = Math.max(8, Math.min(98, Number(artifact?.meta?.progress || 38)));

  return (
    <div className={`artifact-node ${selected ? 'active' : ''}`}>
      <NodeResizer
        isVisible={selected}
        minWidth={NODE_MIN_WIDTH}
        minHeight={NODE_MIN_HEIGHT}
        lineStyle={{ borderColor: '#38bdf8', borderWidth: 1 }}
        handleStyle={{
          width: 10,
          height: 10,
          borderRadius: 999,
          border: '1px solid #0ea5e9',
          background: '#e0f2fe',
        }}
      />
      <div className="artifact-drag-area" title={`Drag ${artifact.name}`}>
        <div
          className="artifact-drag-label"
          data-clause={traceClause}
          title={traceClause ? `Prompt clause: ${traceClause}` : artifact.type.toUpperCase()}
        >
          {artifact.type.toUpperCase()}
        </div>
      </div>
      <div className="artifact-node-content nowheel nopan" onWheelCapture={stopWheelPropagation}>
        {artifact.type === 'html' && (
          <section className="artifact-node-html nodrag nowheel nopan">
            <iframe
              key={renderKey}
              title={artifact.name}
              sandbox="allow-scripts allow-forms allow-modals"
              srcDoc={injected}
              className="artifact-node-frame nodrag nowheel nopan"
            />
          </section>
        )}

        {artifact.type === 'loading' && (
          <section className="artifact-node-loading nodrag nowheel nopan">
            <div className="artifact-loading-top">
              <h3>{artifact.name || 'Generating output'}</h3>
              <span>{loadingProgress}%</span>
            </div>
            <p className="artifact-loading-sub">
              {artifact.description || 'Live generation in progress...'}
            </p>
            <div className="artifact-loading-bar">
              <span style={{ width: `${loadingProgress}%` }} />
            </div>
            <div className="artifact-loading-skeleton">
              <span />
              <span />
              <span />
            </div>
          </section>
        )}

        {artifact.type === 'image' && (
          <div className="artifact-node-image nodrag nowheel nopan">
            <img src={artifact.image} alt={artifact.name} />
          </div>
        )}

        {artifact.type === 'text' && (
          <article className="artifact-node-text nodrag nowheel nopan">
            <div className="artifact-node-toolbar">
              <div className="artifact-node-toolbar-group">
                <button
                  type="button"
                  className="artifact-node-btn"
                  onClick={() => setTextFontSize((prev) => Math.max(11, prev - 1))}
                >
                  A-
                </button>
                <button
                  type="button"
                  className="artifact-node-btn"
                  onClick={() => setTextFontSize((prev) => Math.min(20, prev + 1))}
                >
                  A+
                </button>
              </div>
              <div className="artifact-node-toolbar-group">
                <button
                  type="button"
                  className="artifact-node-btn"
                  onClick={() => setTextExpanded((prev) => !prev)}
                >
                  {textExpanded ? 'Less' : 'More'}
                </button>
                <button
                  type="button"
                  className="artifact-node-btn"
                  onClick={handleTextCopy}
                >
                  {textCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
            <h3>{artifact.name}</h3>
            <div className="artifact-text-rich" style={{ fontSize: `${textFontSize}px` }}>
              {textBlocks.map((block, index) => renderTextBlock(block, index))}
            </div>
          </article>
        )}

        {artifact.type === 'code' && (
          <section className="artifact-node-code nodrag nowheel nopan">
            <header>
              <span>{artifact.name}</span>
              <span className="artifact-node-lang">{(artifact.language || 'text').toUpperCase()}</span>
            </header>
            <div className="artifact-node-code-toolbar">
              <input
                type="text"
                className="artifact-code-search"
                placeholder="Search in code"
                value={codeSearch}
                onChange={(event) => setCodeSearch(event.target.value)}
              />
              <button
                type="button"
                className="artifact-node-btn"
                onClick={() => setCodeWrap((prev) => !prev)}
              >
                {codeWrap ? 'No Wrap' : 'Wrap'}
              </button>
              <button
                type="button"
                className="artifact-node-btn"
                onClick={() => setCodeShowLines((prev) => !prev)}
              >
                {codeShowLines ? 'No #' : '#'}
              </button>
              <button
                type="button"
                className="artifact-node-btn"
                onClick={handleCodeCopy}
              >
                {codeCopied ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                className="artifact-node-btn artifact-node-btn-simulate"
                onClick={handleCodeSimulate}
                disabled={simulatingCodeId === artifactId}
              >
                {simulatingCodeId === artifactId ? 'Running…' : 'Simulate'}
              </button>
            </div>
            <div className={`artifact-code-view ${codeWrap ? 'wrap' : ''}`}>
              {filteredLines.map(({ line, index }) => (
                <div key={`${index}-${line}`} className="artifact-code-line">
                  {codeShowLines && <span className="artifact-code-ln">{index + 1}</span>}
                  <span className="artifact-code-txt">
                    {renderHighlightedText(line || ' ', normalizedSearch)}
                  </span>
                </div>
              ))}
              {!filteredLines.length && (
                <div className="artifact-code-empty">
                  No matches in {codeLineCount} lines
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

const nodeTypes = { artifact: ArtifactNode };

export default function CanvasPanel({
  artifacts,
  activeArtifact,
  onSelect,
  hiddenParts,
  onRefineImage,
  imageUpdatingId,
  loading,
  loadingStartedAt,
  loadingMode,
  loadingPhases,
  generationIssue,
}) {
  const [nodes, setNodes] = useNodesState([]);
  const [edges, _setEdges, onEdgesChange] = useEdgesState([]);
  const hasFitRef = useRef(false);
  const instanceRef = useRef(null);
  const canvasFlowRef = useRef(null);
  const codeSimWindowRef = useRef(null);
  const dragCodeSimRef = useRef(null);
  const [autoHeights, setAutoHeights] = useState({});
  const [simulatingCodeId, setSimulatingCodeId] = useState(null);
  const [codeSimResult, setCodeSimResult] = useState(null);
  const [codeSimWindowPos, setCodeSimWindowPos] = useState(null);
  const [isDraggingCodeSim, setIsDraggingCodeSim] = useState(false);
  const [liveNow, setLiveNow] = useState(Date.now());
  const [imageSelectionsById, setImageSelectionsById] = useState({});
  const [imageEditInstruction, setImageEditInstruction] = useState('');
  const [imageBrushSize, setImageBrushSize] = useState(28);
  const [isMaskDrawing, setIsMaskDrawing] = useState(false);
  const [hasMaskById, setHasMaskById] = useState({});
  const maskDrawCanvasRef = useRef(null);
  const isNodeFocused = Boolean(activeArtifact);
  const activeImageArtifact = activeArtifact?.type === 'image' ? activeArtifact : null;
  const activeImageId = activeImageArtifact ? activeImageArtifact.uid || activeImageArtifact.id : null;
  const activeImageSize = useMemo(
    () => parseImageSizeMeta(activeImageArtifact) || { width: 1024, height: 1024 },
    [activeImageArtifact]
  );
  const hasMask = Boolean(activeImageId && hasMaskById[activeImageId]);
  const imageControls = useMemo(
    () => normalizeImagePromptControls(activeImageArtifact),
    [activeImageArtifact]
  );
  const activeImageSelections = activeImageId ? imageSelectionsById[activeImageId] || {} : {};
  const isImageUpdating = Boolean(activeImageId && imageUpdatingId === activeImageId);
  const hasImageControls = Boolean(activeImageArtifact && imageControls.length > 0);
  useEffect(() => {
    if (!loading) return undefined;
    const timer = window.setInterval(() => setLiveNow(Date.now()), 700);
    return () => window.clearInterval(timer);
  }, [loading]);
  const loadingElapsed = useMemo(() => {
    if (!loadingStartedAt) return 0;
    return Math.max(0, liveNow - loadingStartedAt);
  }, [liveNow, loadingStartedAt]);
  const loadingPhase = useMemo(() => {
    const phases = Array.isArray(loadingPhases) && loadingPhases.length
      ? loadingPhases
      : ['Analyzing request', 'Planning artifacts', 'Generating cards', 'Finalizing response'];
    const index = Math.floor(loadingElapsed / 2600) % phases.length;
    return phases[index];
  }, [loadingElapsed, loadingPhases]);
  const loadingProgress = useMemo(
    () => Math.min(96, 14 + Math.floor(loadingElapsed / 240)),
    [loadingElapsed]
  );
  const loadingArtifact = useMemo(() => {
    if (!loading) return null;
    return {
      id: '__live-loading__',
      uid: '__live-loading__',
      type: 'loading',
      name: loadingPhase,
      description:
        loadingMode === 'weather'
          ? 'Building weather-focused outputs on the canvas.'
          : loadingMode === 'search'
            ? 'Composing source-aware results for the canvas.'
            : loadingMode === 'image'
              ? 'Preparing updated image artifacts.'
              : loadingMode === 'code'
                ? 'Preparing executable code output.'
                : loadingMode === 'chart'
                  ? 'Rendering interactive chart artifacts.'
                  : loadingMode === 'concept'
                    ? 'Preparing concept map and learning outputs.'
                    : 'Preparing live artifacts for the canvas.',
      meta: { progress: loadingProgress },
      _rev: Math.floor(loadingElapsed / 700),
    };
  }, [loading, loadingElapsed, loadingMode, loadingPhase, loadingProgress]);
  const renderArtifacts = useMemo(
    () => (loadingArtifact ? [loadingArtifact, ...artifacts] : artifacts),
    [artifacts, loadingArtifact]
  );
  const previewScale = useMemo(() => {
    const maxW = 284;
    const maxH = 220;
    const scale = Math.min(maxW / activeImageSize.width, maxH / activeImageSize.height, 1);
    return Math.max(scale, 0.1);
  }, [activeImageSize.height, activeImageSize.width]);
  const previewWidth = Math.max(120, Math.round(activeImageSize.width * previewScale));
  const previewHeight = Math.max(80, Math.round(activeImageSize.height * previewScale));

  useEffect(() => {
    if (!activeImageId || imageControls.length === 0) return;
    setImageSelectionsById((prev) => {
      const existing = prev[activeImageId] || {};
      const next = { ...existing };
      imageControls.forEach((control) => {
        if (!next[control.id]) {
          next[control.id] = control.current || control.options[0]?.value || '';
        }
      });
      return { ...prev, [activeImageId]: next };
    });
  }, [activeImageId, imageControls]);

  const handleImageControlChange = useCallback((controlId, value) => {
    if (!activeImageId) return;
    setImageSelectionsById((prev) => {
      const current = prev[activeImageId] || {};
      return {
        ...prev,
        [activeImageId]: {
          ...current,
          [controlId]: value,
        },
      };
    });
  }, [activeImageId]);

  const handleImageRegenerate = useCallback(() => {
    if (!activeImageArtifact || !onRefineImage) return;
    onRefineImage({
      artifact: activeImageArtifact,
      controls: imageControls,
      selections: activeImageSelections,
      basePrompt:
        String(activeImageArtifact?.meta?.base_prompt || '').trim() ||
        String(activeImageArtifact?.prompt || '').trim(),
    });
  }, [activeImageArtifact, activeImageSelections, imageControls, onRefineImage]);

  useEffect(() => {
    if (!activeImageId) return;
    const canvas = maskDrawCanvasRef.current;
    if (!canvas) return;
    canvas.width = activeImageSize.width;
    canvas.height = activeImageSize.height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    setImageEditInstruction('');
    setHasMaskById((prev) => ({ ...prev, [activeImageId]: false }));
    setIsMaskDrawing(false);
  }, [activeImageId, activeImageSize.height, activeImageSize.width]);

  const drawMaskAt = useCallback((event) => {
    const canvas = maskDrawCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (event.clientX - rect.left) * (canvas.width / rect.width);
    const y = (event.clientY - rect.top) * (canvas.height / rect.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.95)';
    ctx.lineWidth = Math.max(6, imageBrushSize);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y);
  }, [imageBrushSize]);

  const handleMaskPointerDown = useCallback((event) => {
    const canvas = maskDrawCanvasRef.current;
    if (!canvas || !activeImageId) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (canvas.width / rect.width);
    const y = (event.clientY - rect.top) * (canvas.height / rect.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const radius = Math.max(3, imageBrushSize / 2);
    ctx.fillStyle = 'rgba(56, 189, 248, 0.95)';
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x, y);
    setIsMaskDrawing(true);
    setHasMaskById((prev) => ({ ...prev, [activeImageId]: true }));
    if (canvas.setPointerCapture) {
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch (_err) {
        // Ignore pointer capture failures.
      }
    }
  }, [activeImageId, imageBrushSize]);

  const handleMaskPointerMove = useCallback((event) => {
    if (!isMaskDrawing) return;
    event.preventDefault();
    event.stopPropagation();
    drawMaskAt(event);
  }, [drawMaskAt, isMaskDrawing]);

  const stopMaskDrawing = useCallback((event) => {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const canvas = maskDrawCanvasRef.current;
    if (!canvas) {
      setIsMaskDrawing(false);
      return;
    }
    if (event && canvas.hasPointerCapture && canvas.hasPointerCapture(event.pointerId)) {
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch (_err) {
        // Ignore pointer capture failures.
      }
    }
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.beginPath();
    }
    setIsMaskDrawing(false);
  }, []);

  const handleClearMask = useCallback(() => {
    const canvas = maskDrawCanvasRef.current;
    if (!canvas || !activeImageId) return;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    setHasMaskById((prev) => ({ ...prev, [activeImageId]: false }));
    setIsMaskDrawing(false);
  }, [activeImageId]);

  const buildMaskDataUrl = useCallback(() => {
    const drawCanvas = maskDrawCanvasRef.current;
    if (!drawCanvas) return '';
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = drawCanvas.width;
    maskCanvas.height = drawCanvas.height;
    const ctx = maskCanvas.getContext('2d');
    if (!ctx) return '';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(drawCanvas, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    return maskCanvas.toDataURL('image/png');
  }, []);

  const handleApplyRegionEdit = useCallback(() => {
    if (!activeImageArtifact || !onRefineImage) return;
    const maskDataUrl = buildMaskDataUrl();
    onRefineImage({
      mode: 'inpaint',
      artifact: activeImageArtifact,
      controls: imageControls,
      selections: activeImageSelections,
      basePrompt:
        String(activeImageArtifact?.meta?.base_prompt || '').trim() ||
        String(activeImageArtifact?.prompt || '').trim(),
      instruction: imageEditInstruction,
      maskDataUrl,
    });
  }, [
    activeImageArtifact,
    activeImageSelections,
    buildMaskDataUrl,
    imageControls,
    imageEditInstruction,
    onRefineImage,
  ]);

  const handleSimulateCode = useCallback(async (artifact) => {
    const artifactId = artifact?.uid || artifact?.id;
    if (!artifactId || !artifact?.code) {
      return;
    }
    setSimulatingCodeId(artifactId);
    try {
      const result = await simulateCode({
        code: String(artifact.code || ''),
        language: String(artifact.language || ''),
      });
      setCodeSimResult({
        artifactId,
        artifactName: String(artifact.name || 'Code Artifact'),
        ok: Boolean(result?.ok),
        language: String(result?.language || artifact.language || 'text'),
        stdout: String(result?.stdout || ''),
        stderr: String(result?.stderr || ''),
        note: String(result?.note || ''),
        exitCode: Number.isFinite(Number(result?.exit_code)) ? Number(result.exit_code) : 0,
        updatedAt: new Date().toLocaleTimeString(),
      });
    } catch (err) {
      setCodeSimResult({
        artifactId,
        artifactName: String(artifact.name || 'Code Artifact'),
        ok: false,
        language: String(artifact.language || 'text'),
        stdout: '',
        stderr: String(err?.message || 'Code simulation failed'),
        note: '',
        exitCode: 1,
        updatedAt: new Date().toLocaleTimeString(),
      });
    } finally {
      setSimulatingCodeId(null);
    }
  }, []);

  const handleCodeSimDragStart = useCallback((event) => {
    if (!codeSimWindowRef.current || !canvasFlowRef.current) {
      return;
    }
    const windowRect = codeSimWindowRef.current.getBoundingClientRect();
    dragCodeSimRef.current = {
      offsetX: event.clientX - windowRect.left,
      offsetY: event.clientY - windowRect.top,
    };
    setIsDraggingCodeSim(true);
    event.preventDefault();
    event.stopPropagation();
  }, []);

  useEffect(() => {
    if (!isDraggingCodeSim) {
      return undefined;
    }

    const onPointerMove = (event) => {
      if (!dragCodeSimRef.current || !canvasFlowRef.current || !codeSimWindowRef.current) {
        return;
      }

      const flowRect = canvasFlowRef.current.getBoundingClientRect();
      const winRect = codeSimWindowRef.current.getBoundingClientRect();
      const maxLeft = Math.max(0, flowRect.width - winRect.width);
      const maxTop = Math.max(0, flowRect.height - winRect.height);

      const rawLeft = event.clientX - flowRect.left - dragCodeSimRef.current.offsetX;
      const rawTop = event.clientY - flowRect.top - dragCodeSimRef.current.offsetY;
      const left = Math.max(0, Math.min(rawLeft, maxLeft));
      const top = Math.max(0, Math.min(rawTop, maxTop));

      setCodeSimWindowPos({ left, top });
    };

    const onPointerUp = () => {
      setIsDraggingCodeSim(false);
      dragCodeSimRef.current = null;
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [isDraggingCodeSim]);

  const onNodesChange = useCallback(
    (changes) => {
      setNodes((prev) => {
        const next = applyNodeChanges(changes, prev);
        const manualPositionIds = new Set();
        const manualSizeIds = new Set();

        changes.forEach((change) => {
          if (change.type === 'position' && change.dragging) {
            manualPositionIds.add(change.id);
          }
          if (change.type === 'dimensions' && change.resizing) {
            manualSizeIds.add(change.id);
          }
        });

        if (manualPositionIds.size === 0 && manualSizeIds.size === 0) {
          return next;
        }

        return next.map((node) => {
          if (!manualPositionIds.has(node.id) && !manualSizeIds.has(node.id)) {
            return node;
          }
          return {
            ...node,
            data: {
              ...node.data,
              ...(manualPositionIds.has(node.id) ? { manualPosition: true } : null),
              ...(manualSizeIds.has(node.id) ? { manualSize: true } : null),
            },
          };
        });
      });
    },
    [setNodes]
  );

  useEffect(() => {
    const handleMessage = (event) => {
      const payload = event?.data;
      if (!payload || payload.__artifactPreview !== true) return;
      if (typeof payload.artifactId !== 'string') return;
      if (typeof payload.height !== 'number') return;

      const nextHeight = Math.max(
        NODE_MIN_HEIGHT,
        Math.min(Math.round(payload.height), 1600)
      );

      setAutoHeights((prev) => {
        if (prev[payload.artifactId] === nextHeight) {
          return prev;
        }
        return { ...prev, [payload.artifactId]: nextHeight };
      });
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    const columnOffsets = Array.from({ length: NODE_COLUMNS }, () => 0);

    setNodes((prev) => {
      const existing = new Map(prev.map((node) => [node.id, node]));
      const preferredById = new Map();
      const columnWidths = Array.from({ length: NODE_COLUMNS }, () => NODE_WIDTH);

      renderArtifacts.forEach((artifact, index) => {
        const id = artifact.uid || artifact.id;
        const current = existing.get(id);
        const manualSize = current?.data?.manualSize ?? false;

        let preferredWidth = NODE_WIDTH;
        let preferredHeight = NODE_HEIGHT;

        if (manualSize) {
          preferredWidth = Number(current?.style?.width) || NODE_WIDTH;
          preferredHeight = Number(current?.style?.height) || NODE_HEIGHT;
        } else if (artifact.type === 'loading') {
          preferredWidth = 500;
          preferredHeight = 230;
        } else if (artifact.type === 'html') {
          preferredHeight = autoHeights[id] ? Math.max(autoHeights[id], NODE_MIN_HEIGHT) : NODE_HEIGHT;
        } else if (artifact.type === 'image') {
          const parsed = parseImageSizeMeta(artifact);
          if (parsed) {
            preferredWidth = parsed.width;
            preferredHeight = parsed.height;
          }
        }

        preferredById.set(id, { width: preferredWidth, height: preferredHeight });
        const col = index % NODE_COLUMNS;
        columnWidths[col] = Math.max(columnWidths[col], preferredWidth);
      });

      const columnX = [];
      let runningX = 0;
      for (let col = 0; col < NODE_COLUMNS; col += 1) {
        columnX[col] = runningX;
        runningX += columnWidths[col] + NODE_GAP_X;
      }

      return renderArtifacts.map((artifact, index) => {
        const id = artifact.uid || artifact.id;
        const current = existing.get(id);
        const manualPosition = current?.data?.manualPosition ?? false;
        const manualSize = current?.data?.manualSize ?? false;
        const preferred = preferredById.get(id) || { width: NODE_WIDTH, height: NODE_HEIGHT };

        const col = index % NODE_COLUMNS;
        const heightForLayout = preferred.height;
        const yForLayout = columnOffsets[col];
        columnOffsets[col] = yForLayout + heightForLayout + NODE_GAP_Y;

        const computedPosition = {
          x: columnX[col],
          y: yForLayout,
        };

        const baseStyle = current?.style ?? { width: preferred.width, height: preferred.height };
        const nextStyle = manualSize
          ? baseStyle
          : {
              ...baseStyle,
              width: preferred.width,
              height: preferred.height,
            };

        return {
          id,
          type: 'artifact',
          dragHandle: '.artifact-drag-area',
          data: {
            artifact,
            hiddenParts: hiddenParts?.[id] || [],
            onSimulateCode: handleSimulateCode,
            simulatingCodeId,
            manualPosition,
            manualSize,
          },
          position: manualPosition ? current?.position ?? computedPosition : computedPosition,
          selected: current?.selected ?? false,
          style: nextStyle,
        };
      });
    });
  }, [autoHeights, handleSimulateCode, hiddenParts, renderArtifacts, setNodes, simulatingCodeId]);

  useEffect(() => {
    if (!activeArtifact) {
      return;
    }
    const activeId = activeArtifact.uid || activeArtifact.id;
    setNodes((prev) =>
      prev.map((node) => ({
        ...node,
        selected: node.id === activeId,
      }))
    );
  }, [activeArtifact, setNodes]);

  const onNodeClick = useCallback(
    (_event, node) => {
      if (node?.data?.artifact?.type === 'loading') {
        return;
      }
      if (node?.data?.artifact) {
        onSelect(node.data.artifact);
      }
    },
    [onSelect]
  );

  useEffect(() => {
    if (hasFitRef.current || nodes.length === 0 || !instanceRef.current) {
      return;
    }
    instanceRef.current.fitView({ padding: 0.2 });
    hasFitRef.current = true;
  }, [nodes.length]);

  return (
    <section className="panel canvas-panel">
      <header className="panel-header">
        <div>
          <h2>Canvas</h2>
          <p>Click a card to focus and scroll inside it. Click empty canvas to re-enable zoom.</p>
        </div>
        <div className="canvas-badge">
          {activeArtifact
            ? activeArtifact.type.toUpperCase()
            : loading
              ? 'PROCESSING'
              : generationIssue?.message
                ? 'NO OUTPUT'
                : 'EMPTY'}
        </div>
      </header>

      <div className="canvas-flow" ref={canvasFlowRef}>
        {!loading && generationIssue?.message && (
          <div className="canvas-issue-overlay" role="status" aria-live="polite">
            <strong>No output generated from the last prompt</strong>
            <p>{generationIssue.message}</p>
          </div>
        )}
        <ReactFlow
          style={{ width: '100%', height: '100%' }}
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onPaneClick={() => onSelect(null)}
          nodeTypes={nodeTypes}
          zoomOnScroll={!isNodeFocused}
          zoomOnPinch={!isNodeFocused}
          zoomOnDoubleClick={!isNodeFocused}
          panOnScroll={!isNodeFocused}
          preventScrolling={!isNodeFocused}
          onInit={(instance) => {
            instanceRef.current = instance;
            if (!hasFitRef.current && nodes.length > 0) {
              instance.fitView({ padding: 0.2 });
              hasFitRef.current = true;
            }
          }}
        >
          <Background gap={20} color="#e5e7eb" bgColor="#ffffff" />
          <MiniMap
            nodeColor={(node) => (node.selected ? '#38bdf8' : '#94a3b8')}
            maskColor="rgba(248, 250, 252, 0.7)"
          />
          <Controls showZoom={!isNodeFocused} showInteractive={!isNodeFocused} />
        </ReactFlow>

        {hasImageControls && (
          <aside
            className="image-control-window nowheel nopan"
            onWheel={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header className="image-control-header">
              <div>
                <h3>Image Controls</h3>
                <p>LLM-suggested prompt factors</p>
              </div>
            </header>
            <div className="image-control-body">
              {imageControls.map((control) => (
                <label key={control.id} className="image-control-field">
                  <span>{control.label}</span>
                  <select
                    value={activeImageSelections[control.id] || control.current}
                    onChange={(event) => handleImageControlChange(control.id, event.target.value)}
                    disabled={isImageUpdating}
                  >
                    {control.options.map((option) => (
                      <option key={`${control.id}-${option.value}`} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}

              <div className="image-edit-section">
                <div className="image-edit-title">Region Edit</div>
                <div className="image-edit-subtitle">Draw an area and describe what to add there.</div>
                <div
                  className="image-edit-canvas-wrap"
                  style={{ width: `${previewWidth}px`, height: `${previewHeight}px` }}
                >
                  <img
                    src={activeImageArtifact?.image}
                    alt={activeImageArtifact?.name || 'Editable preview'}
                    className="image-edit-preview"
                    style={{ width: `${previewWidth}px`, height: `${previewHeight}px` }}
                  />
                  <canvas
                    ref={maskDrawCanvasRef}
                    className="image-edit-draw-canvas"
                    style={{ width: `${previewWidth}px`, height: `${previewHeight}px` }}
                    onPointerDown={handleMaskPointerDown}
                    onPointerMove={handleMaskPointerMove}
                    onPointerUp={stopMaskDrawing}
                    onPointerCancel={stopMaskDrawing}
                    onPointerLeave={stopMaskDrawing}
                  />
                </div>
                <div className="image-edit-tools">
                  <label className="image-edit-brush">
                    <span>Brush</span>
                    <input
                      type="range"
                      min="10"
                      max="72"
                      value={imageBrushSize}
                      onChange={(event) => setImageBrushSize(Number(event.target.value) || 28)}
                      disabled={isImageUpdating}
                    />
                  </label>
                  <button
                    type="button"
                    className="image-control-btn image-control-btn-muted"
                    onClick={handleClearMask}
                    disabled={isImageUpdating || !hasMask}
                  >
                    Clear
                  </button>
                </div>
                <label className="image-edit-instruction">
                  <span>Instruction</span>
                  <textarea
                    value={imageEditInstruction}
                    onChange={(event) => setImageEditInstruction(event.target.value)}
                    placeholder="Add a subtle gold necklace in the marked area."
                    rows={3}
                    disabled={isImageUpdating}
                  />
                </label>
              </div>
            </div>
            <footer className="image-control-footer">
              <button
                type="button"
                className="image-control-btn image-control-btn-muted"
                onClick={handleImageRegenerate}
                disabled={isImageUpdating}
              >
                Regenerate
              </button>
              <button
                type="button"
                className="image-control-btn"
                onClick={handleApplyRegionEdit}
                disabled={isImageUpdating || !hasMask || !imageEditInstruction.trim()}
              >
                {isImageUpdating ? 'Applying…' : 'Apply Region Edit'}
              </button>
            </footer>
          </aside>
        )}

        {codeSimResult && (
          <aside
            ref={codeSimWindowRef}
            className="code-sim-window nowheel nopan"
            style={
              codeSimWindowPos
                ? { left: `${codeSimWindowPos.left}px`, top: `${codeSimWindowPos.top}px`, right: 'auto' }
                : { right: hasImageControls ? '340px' : '10px', top: '10px' }
            }
            onWheel={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header
              className={`code-sim-header ${isDraggingCodeSim ? 'dragging' : ''}`}
              onPointerDown={handleCodeSimDragStart}
            >
              <div>
                <h3>Simulation Output</h3>
                <p>{codeSimResult.artifactName} • {String(codeSimResult.language || '').toUpperCase()}</p>
              </div>
              <button
                type="button"
                className="code-sim-close"
                onClick={() => {
                  setCodeSimResult(null);
                  setIsDraggingCodeSim(false);
                }}
              >
                Close
              </button>
            </header>
            <div className="code-sim-body">
              <div className="code-sim-status">
                <span className={`code-sim-pill ${codeSimResult.ok ? 'is-ok' : 'is-fail'}`}>
                  {codeSimResult.ok ? 'Success' : 'Failed'}
                </span>
                <span className="code-sim-meta">Exit {codeSimResult.exitCode} • {codeSimResult.updatedAt}</span>
              </div>
              {codeSimResult.note && (
                <p className="code-sim-note">{codeSimResult.note}</p>
              )}
              {codeSimResult.stdout && (
                <>
                  <div className="code-sim-label">Stdout</div>
                  <pre className="code-sim-pre">{codeSimResult.stdout}</pre>
                </>
              )}
              {codeSimResult.stderr && (
                <>
                  <div className="code-sim-label">Stderr</div>
                  <pre className="code-sim-pre code-sim-pre-error">{codeSimResult.stderr}</pre>
                </>
              )}
              {!codeSimResult.stdout && !codeSimResult.stderr && (
                <p className="code-sim-note">No output was produced.</p>
              )}
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}
