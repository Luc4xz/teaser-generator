import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchConversationDetail, restoreArtifactVersion } from '../api.js';

function extractParts(html) {
  if (!html) return [];
  const parts = new Set();
  const regex = /data-part\s*=\s*\"([^\"]+)\"/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    parts.add(match[1]);
  }
  return Array.from(parts).sort();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksLikeEditableChartHtml(code) {
  const lowered = String(code || '').toLowerCase();
  if (!lowered) return false;
  if (!lowered.includes('<svg') && !lowered.includes('<canvas')) return false;
  const hints = ['data-part="chart"', 'bar', 'line', 'tooltip', 'chart', 'plot', 'dataset', 'rows'];
  const score = hints.reduce((count, token) => (lowered.includes(token) ? count + 1 : count), 0);
  return score >= 2;
}

function normalizeChartRows(rows) {
  if (!Array.isArray(rows)) return null;
  const objectRows = rows.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
  if (!objectRows.length) return null;
  return objectRows;
}

function deriveChartColumns(rows) {
  if (!rows.length) return [];
  const keys = Object.keys(rows[0] || {});
  const first = keys.includes('label') ? ['label'] : [];
  const rest = keys.filter((key) => key !== 'label');
  return [...first, ...rest];
}

function extractChartDataSource(code) {
  const source = String(code || '');
  if (!source.trim()) return null;
  if (!looksLikeEditableChartHtml(source)) return null;

  const candidates = ['rows', 'data', 'dataset', 'points', 'series', 'days'];
  for (const variable of candidates) {
    const pattern = new RegExp(
      `(?:const|let|var)\\s+${escapeRegExp(variable)}\\s*=\\s*(\\[[\\s\\S]*?\\])\\s*;`,
      'm'
    );
    const match = source.match(pattern);
    if (!match || !match[1]) continue;
    try {
      const parsed = JSON.parse(match[1]);
      const rows = normalizeChartRows(parsed);
      if (!rows) continue;
      const columns = deriveChartColumns(rows);
      if (!columns.length) continue;
      return { variable, rows, columns };
    } catch (_err) {
      // ignore parse failures
    }
  }
  return null;
}

function replaceChartRowsInCode(code, variable, rows) {
  const pattern = new RegExp(
    `((?:const|let|var)\\s+${escapeRegExp(variable)}\\s*=\\s*)(\\[[\\s\\S]*?\\])(\\s*;)`,
    'm'
  );
  return String(code || '').replace(pattern, `$1${JSON.stringify(rows)}$3`);
}

function cloneRows(rows) {
  return (rows || []).map((row) => ({ ...row }));
}

function splitLines(text) {
  return String(text || '').replace(/\r\n/g, '\n').split('\n');
}

function buildLineDiff(beforeText, afterText) {
  const beforeLines = splitLines(beforeText);
  const afterLines = splitLines(afterText);
  const n = beforeLines.length;
  const m = afterLines.length;

  if (n * m > 160000) {
    return [
      ...beforeLines.map((line) => ({ type: 'remove', text: line })),
      ...afterLines.map((line) => ({ type: 'add', text: line })),
    ];
  }

  const dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      if (beforeLines[i - 1] === afterLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (beforeLines[i - 1] === afterLines[j - 1]) {
      ops.push({ type: 'same', text: beforeLines[i - 1] });
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.push({ type: 'remove', text: beforeLines[i - 1] });
      i -= 1;
    } else {
      ops.push({ type: 'add', text: afterLines[j - 1] });
      j -= 1;
    }
  }
  while (i > 0) {
    ops.push({ type: 'remove', text: beforeLines[i - 1] });
    i -= 1;
  }
  while (j > 0) {
    ops.push({ type: 'add', text: afterLines[j - 1] });
    j -= 1;
  }

  return ops.reverse();
}

function formatVersionDate(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return text;
  return parsed.toLocaleString();
}

function snapshotContentForItem(type, version) {
  if (!version || typeof version !== 'object') return '';
  if (type === 'text') return String(version.text || '');
  if (type === 'code' || type === 'html') return String(version.code || '');
  return '';
}

function ImageBeforeAfter({ before, after, leftLabel = '', rightLabel = '' }) {
  const [ratio, setRatio] = useState(50);

  useEffect(() => {
    setRatio(50);
  }, [before, after]);

  if (!before || !after) {
    return <div className="artifact-version-empty">Image comparison is unavailable for this version.</div>;
  }

  return (
    <div className="artifact-image-compare">
      <div className="artifact-image-compare-stage">
        <img src={before} alt="Before" className="artifact-image-compare-before" />
        <img
          src={after}
          alt="After"
          className="artifact-image-compare-after"
          style={{ clipPath: `inset(0 ${100 - ratio}% 0 0)` }}
        />
        <div className="artifact-image-compare-divider" style={{ left: `${ratio}%` }} />
      </div>
      <div className="artifact-image-compare-controls">
        <span>{leftLabel || 'Left'}</span>
        <input
          type="range"
          min={0}
          max={100}
          value={ratio}
          onChange={(event) => setRatio(Number(event.target.value))}
        />
        <span>{rightLabel || 'Right'}</span>
      </div>
    </div>
  );
}

function VersionTimelinePanel({
  item,
  versions,
  selectedVersionId,
  onSelectVersion,
  onRestoreVersion,
  restoring,
  loading,
  error,
}) {
  const orderedVersions = useMemo(
    () => [...versions].sort((a, b) => Number(a.version_number) - Number(b.version_number)),
    [versions]
  );

  const latestVersion = orderedVersions.length ? orderedVersions[orderedVersions.length - 1] : null;
  const selectedVersion = orderedVersions.find((entry) => String(entry.id) === String(selectedVersionId || ''))
    || latestVersion;

  const diffLines = useMemo(() => {
    if (!selectedVersion || !latestVersion) return [];
    if (!['text', 'code', 'html'].includes(item.type)) return [];
    const before = snapshotContentForItem(item.type, selectedVersion);
    const after = snapshotContentForItem(item.type, latestVersion);
    return buildLineDiff(before, after).slice(0, 260);
  }, [item.type, latestVersion, selectedVersion]);

  return (
    <div
      className="artifact-version-panel"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className="artifact-version-head">
        <strong>Version Timeline</strong>
        {loading ? <span>Loading...</span> : <span>{orderedVersions.length} versions</span>}
      </div>

      {error && <div className="artifact-version-error">{error}</div>}

      {!loading && !orderedVersions.length && (
        <div className="artifact-version-empty">No stored versions for this artifact yet.</div>
      )}

      {!!orderedVersions.length && (
        <>
          <div className="artifact-version-list">
            {orderedVersions.map((version) => {
              const isSelected = String(version.id) === String(selectedVersion?.id || '');
              const isLatest = String(version.id) === String(latestVersion?.id || '');
              return (
                <button
                  key={version.id}
                  type="button"
                  className={`artifact-version-chip ${isSelected ? 'selected' : ''}`}
                  onClick={() => onSelectVersion(version.id)}
                  title={formatVersionDate(version.created_at)}
                >
                  <span>v{version.version_number}</span>
                  <small>{String(version.operation || 'update').replace(/_/g, ' ')}</small>
                  {isLatest && <em>latest</em>}
                </button>
              );
            })}
          </div>

          {selectedVersion && (
            <div className="artifact-version-preview">
              <div className="artifact-version-preview-meta">
                <div>
                  <strong>Selected:</strong> v{selectedVersion.version_number}
                </div>
                <div>{formatVersionDate(selectedVersion.created_at)}</div>
              </div>

              {item.type === 'image' && (
                <ImageBeforeAfter
                  before={String(selectedVersion.image || '')}
                  after={String(latestVersion?.image || '')}
                  leftLabel={`v${Number(selectedVersion.version_number || 0)}`}
                  rightLabel={`v${Number(latestVersion?.version_number || 0)} (latest)`}
                />
              )}

              {['text', 'code', 'html'].includes(item.type) && (
                <div className="artifact-diff-wrap">
                  <div className="artifact-diff-head">Diff (selected vs latest)</div>
                  <pre className="artifact-diff-body">
                    {diffLines.map((line, index) => {
                      const marker = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
                      return (
                        <div key={`${index}-${line.type}`} className={`artifact-diff-line ${line.type}`}>
                          <span className="artifact-diff-marker">{marker}</span>
                          <span>{line.text || ' '}</span>
                        </div>
                      );
                    })}
                  </pre>
                </div>
              )}

              <div className="artifact-version-actions">
                <button
                  type="button"
                  className="artifact-edit"
                  onClick={() => onRestoreVersion(selectedVersion)}
                  disabled={restoring}
                >
                  {restoring ? 'Restoring...' : `Restore v${selectedVersion.version_number}`}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ChartDataEditor({ item, onUpdate }) {
  const source = useMemo(() => extractChartDataSource(item?.code), [item?.code]);
  const [rows, setRows] = useState(() => cloneRows(source?.rows || []));
  const [columns, setColumns] = useState(() => (Array.isArray(source?.columns) ? [...source.columns] : []));
  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);
  const syncFromLocalRef = useRef(false);

  useEffect(() => {
    if (syncFromLocalRef.current) {
      syncFromLocalRef.current = false;
      return;
    }
    setRows(cloneRows(source?.rows || []));
    setColumns(Array.isArray(source?.columns) ? [...source.columns] : []);
    setPast([]);
    setFuture([]);
  }, [item?.id, item?.uid, item?.code, source?.variable, source?.columns, source?.rows]);

  const numericColumns = useMemo(
    () =>
      new Set(
        (columns || []).filter((column) => {
          if (column === 'label') return false;
          return rows.every((row) => Number.isFinite(Number(row?.[column])));
        })
      ),
    [columns, rows]
  );

  const commitRows = useCallback(
    (nextRows, options = { pushHistory: true }) => {
      const safeRows = cloneRows(nextRows);
      if (options.pushHistory) {
        setPast((prev) => [...prev.slice(-29), cloneRows(rows)]);
        setFuture([]);
      }
      setRows(safeRows);
      if (!source?.variable) return;
      const nextCode = replaceChartRowsInCode(item.code, source.variable, safeRows);
      if (!nextCode || nextCode === item.code) return;
      syncFromLocalRef.current = true;
      onUpdate({ ...item, code: nextCode });
    },
    [item, onUpdate, rows, source?.variable]
  );

  const updateCell = useCallback(
    (rowIndex, column, value) => {
      if (rowIndex < 0 || rowIndex >= rows.length) return;
      const nextRows = rows.map((row, index) => {
        if (index !== rowIndex) return row;
        const next = { ...row };
        if (numericColumns.has(column)) {
          const parsed = Number(value);
          next[column] = Number.isFinite(parsed) ? parsed : 0;
        } else {
          next[column] = value;
        }
        return next;
      });
      commitRows(nextRows);
    },
    [commitRows, numericColumns, rows]
  );

  const addRow = useCallback(() => {
    if (!columns.length) return;
    const next = {};
    columns.forEach((column, index) => {
      if (numericColumns.has(column)) {
        next[column] = 0;
      } else if (column === 'label') {
        next[column] = `P${rows.length + 1}`;
      } else {
        next[column] = index === 0 ? `P${rows.length + 1}` : '';
      }
    });
    commitRows([...rows, next]);
  }, [columns, commitRows, numericColumns, rows]);

  const removeRow = useCallback(
    (rowIndex) => {
      if (rows.length <= 1) return;
      const nextRows = rows.filter((_, index) => index !== rowIndex);
      commitRows(nextRows);
    },
    [commitRows, rows]
  );

  const undo = useCallback(() => {
    if (!past.length) return;
    const previous = cloneRows(past[past.length - 1]);
    setPast((prev) => prev.slice(0, -1));
    setFuture((prev) => [cloneRows(rows), ...prev.slice(0, 29)]);
    commitRows(previous, { pushHistory: false });
  }, [commitRows, past, rows]);

  const redo = useCallback(() => {
    if (!future.length) return;
    const next = cloneRows(future[0]);
    setFuture((prev) => prev.slice(1));
    setPast((prev) => [...prev.slice(-29), cloneRows(rows)]);
    commitRows(next, { pushHistory: false });
  }, [commitRows, future, rows]);

  if (!source || !rows.length || !columns.length) return null;

  return (
    <div
      className="artifact-data-editor-inline"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className="artifact-data-editor-header">
        <strong>Edit Chart Data</strong>
        <span>{rows.length} rows</span>
      </div>
      <div className="artifact-data-editor-actions">
        <button
          type="button"
          className="artifact-data-btn artifact-data-btn-secondary"
          onClick={undo}
          disabled={!past.length}
        >
          Undo
        </button>
        <button
          type="button"
          className="artifact-data-btn artifact-data-btn-secondary"
          onClick={redo}
          disabled={!future.length}
        >
          Redo
        </button>
        <button
          type="button"
          className="artifact-data-btn"
          onClick={addRow}
        >
          Add Row
        </button>
      </div>
      <div className="artifact-data-table-wrap">
        <table className="artifact-data-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={`head-${column}`}>{column}</th>
              ))}
              <th> </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`}>
                {columns.map((column) => {
                  const cellValue = row?.[column] ?? '';
                  return (
                    <td key={`${rowIndex}-${column}`}>
                      <input
                        type={numericColumns.has(column) ? 'number' : 'text'}
                        value={String(cellValue)}
                        onChange={(event) => updateCell(rowIndex, column, event.target.value)}
                      />
                    </td>
                  );
                })}
                <td>
                  <button
                    type="button"
                    className="artifact-data-btn artifact-data-btn-remove"
                    onClick={() => removeRow(rowIndex)}
                    disabled={rows.length <= 1}
                  >
                    -
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ArtifactList({
  title,
  items,
  conversationId,
  activeId,
  onSelect,
  onToggleVisibility,
  isVisible,
  expandedId,
  onToggleExpand,
  onUpdate,
  hiddenParts,
  onTogglePart,
  isCollapsed,
  onToggleCollapse,
}) {
  const [dataEditorId, setDataEditorId] = useState(null);
  const [versionPanelId, setVersionPanelId] = useState(null);
  const [selectedVersionByArtifact, setSelectedVersionByArtifact] = useState({});
  const [historyByConversation, setHistoryByConversation] = useState({});
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [restoringByArtifact, setRestoringByArtifact] = useState({});
  const autoHistorySyncRef = useRef('');

  const activeHistory = conversationId ? historyByConversation[conversationId] : null;

  const ensureHistoryLoaded = useCallback(async (force = false) => {
    const safeConversationId = String(conversationId || '').trim();
    if (!safeConversationId) return;
    if (!force && historyByConversation[safeConversationId]) return;

    setHistoryLoading(true);
    setHistoryError('');
    try {
      const payload = await fetchConversationDetail(safeConversationId);
      setHistoryByConversation((prev) => ({ ...prev, [safeConversationId]: payload }));
    } catch (err) {
      setHistoryError(err?.message || 'Failed to load version history');
    } finally {
      setHistoryLoading(false);
    }
  }, [conversationId, historyByConversation]);

  const versionsForItem = useCallback(
    (item) => {
      const artifactDbId = String(item?.meta?.history?.artifact_db_id || '').trim();
      const logicalKey = String(item?.meta?.history?.logical_key || item?.id || '').trim();
      const currentVersionId = String(item?.meta?.history?.version_id || '').trim();
      const records = Array.isArray(activeHistory?.artifacts) ? activeHistory.artifacts : [];
      if (!records.length) return [];

      let match = records.find((entry) => String(entry?.id || '') === artifactDbId);
      if (!match && logicalKey) {
        match = records.find((entry) => String(entry?.logical_key || '').trim() === logicalKey);
      }
      if (!match && currentVersionId) {
        match = records.find((entry) =>
          Array.isArray(entry?.versions) && entry.versions.some((version) => String(version?.id || '') === currentVersionId)
        );
      }
      if (!match || !Array.isArray(match.versions)) return [];
      return [...match.versions].sort((a, b) => Number(a.version_number) - Number(b.version_number));
    },
    [activeHistory]
  );

  const openPanelItem = useMemo(() => {
    if (!versionPanelId) return null;
    return items.find((item) => (item.uid || item.id) === versionPanelId) || null;
  }, [items, versionPanelId]);

  const openPanelExpectedVersionId = String(openPanelItem?.meta?.history?.version_id || '').trim();
  const openPanelExpectedVersionNumber = Number(openPanelItem?.meta?.history?.version_number || 0);

  const openPanelVersions = useMemo(() => {
    if (!openPanelItem) return [];
    return versionsForItem(openPanelItem);
  }, [openPanelItem, versionsForItem]);

  const openPanelHasExpectedVersionId = useMemo(() => {
    if (!openPanelExpectedVersionId) return false;
    return openPanelVersions.some((version) => String(version?.id || '').trim() === openPanelExpectedVersionId);
  }, [openPanelExpectedVersionId, openPanelVersions]);

  const openPanelLatestKnownVersion = useMemo(
    () => openPanelVersions.reduce((max, version) => Math.max(max, Number(version?.version_number || 0)), 0),
    [openPanelVersions]
  );

  useEffect(() => {
    const safeConversationId = String(conversationId || '').trim();
    if (!safeConversationId || !versionPanelId || !openPanelItem) {
      autoHistorySyncRef.current = '';
      return;
    }

    const needsRefresh = (
      (openPanelExpectedVersionId && !openPanelHasExpectedVersionId)
      || (openPanelExpectedVersionNumber > 0 && openPanelExpectedVersionNumber > openPanelLatestKnownVersion)
    );

    if (!needsRefresh) {
      autoHistorySyncRef.current = '';
      return;
    }

    const syncKey = `${String(versionPanelId)}:${openPanelExpectedVersionId || `v${openPanelExpectedVersionNumber}`}`;
    if (autoHistorySyncRef.current === syncKey) return;
    autoHistorySyncRef.current = syncKey;
    void ensureHistoryLoaded(true);
  }, [
    conversationId,
    ensureHistoryLoaded,
    openPanelExpectedVersionId,
    openPanelExpectedVersionNumber,
    openPanelHasExpectedVersionId,
    openPanelItem,
    openPanelLatestKnownVersion,
    versionPanelId,
  ]);

  const openVersionPanel = useCallback(
    async (item, itemId) => {
      const nextOpen = versionPanelId !== itemId;
      setVersionPanelId((prev) => (prev === itemId ? null : itemId));
      if (!nextOpen) return;

      setSelectedVersionByArtifact((prev) => {
        if (prev[itemId]) return prev;
        const current = String(item?.meta?.history?.version_id || '').trim();
        if (!current) return prev;
        return { ...prev, [itemId]: current };
      });
      await ensureHistoryLoaded(true);
    },
    [ensureHistoryLoaded, versionPanelId]
  );

  const handleRestoreVersion = useCallback(
    async (item, selectedVersion) => {
      let artifactDbId = String(item?.meta?.history?.artifact_db_id || '').trim();
      const versionId = String(selectedVersion?.id || '').trim();
      if (!artifactDbId) {
        const logicalKey = String(item?.meta?.history?.logical_key || item?.id || '').trim();
        const records = Array.isArray(activeHistory?.artifacts) ? activeHistory.artifacts : [];
        let match = null;
        if (logicalKey) {
          match = records.find((entry) => String(entry?.logical_key || '').trim() === logicalKey) || null;
        }
        if (!match && versionId) {
          match = records.find((entry) =>
            Array.isArray(entry?.versions) && entry.versions.some((version) => String(version?.id || '') === versionId)
          ) || null;
        }
        artifactDbId = String(match?.id || '').trim();
      }
      if (!artifactDbId || !versionId) return;

      setRestoringByArtifact((prev) => ({ ...prev, [artifactDbId]: true }));
      setHistoryError('');
      try {
        const restored = await restoreArtifactVersion(artifactDbId, versionId);
        const snapshot = restored?.snapshot && typeof restored.snapshot === 'object' ? restored.snapshot : {};
        const historyMeta = {
          ...(item?.meta || {}),
          history: {
            ...(item?.meta?.history || {}),
            artifact_db_id: artifactDbId,
            logical_key: String(restored?.logical_key || item?.meta?.history?.logical_key || item.id || ''),
            version_id: String(restored?.version_id || ''),
            version_number: Number(restored?.version_number || 0),
          },
        };

        const updated = {
          ...item,
          meta: historyMeta,
          code: item.type === 'html' || item.type === 'code' ? String(snapshot.code || '') : item.code,
          text: item.type === 'text' ? String(snapshot.text || '') : item.text,
          image: item.type === 'image' ? String(snapshot.image || '') : item.image,
          prompt: item.type === 'image' ? String(snapshot.prompt || item.prompt || '') : item.prompt,
          language: item.type === 'code' ? String(snapshot.language || item.language || '') : item.language,
          description: String(snapshot.description || item.description || ''),
        };

        onUpdate(updated);
        onSelect(updated);

        const nextVersion = {
          id: String(restored?.version_id || ''),
          version_number: Number(restored?.version_number || 0),
          message_id: null,
          parent_version_id: String(restored?.parent_version_id || ''),
          operation: 'restore_version',
          prompt: String(snapshot.prompt || ''),
          code: snapshot.code || null,
          image: snapshot.image || null,
          text: snapshot.text || null,
          created_at: new Date().toISOString(),
          meta: snapshot.meta && typeof snapshot.meta === 'object' ? snapshot.meta : {},
        };

        const safeConversationId = String(conversationId || '').trim();
        if (safeConversationId) {
          setHistoryByConversation((prev) => {
            const detail = prev[safeConversationId];
            if (!detail || !Array.isArray(detail.artifacts)) return prev;
            const nextArtifacts = detail.artifacts.map((artifactRecord) => {
              if (String(artifactRecord?.id || '') !== artifactDbId) return artifactRecord;
              const existingVersions = Array.isArray(artifactRecord.versions) ? artifactRecord.versions : [];
              return {
                ...artifactRecord,
                latest_version_number: Number(restored?.version_number || artifactRecord.latest_version_number || 0),
                versions: [...existingVersions, nextVersion],
              };
            });
            return {
              ...prev,
              [safeConversationId]: {
                ...detail,
                artifacts: nextArtifacts,
              },
            };
          });
        }

        setSelectedVersionByArtifact((prev) => ({
          ...prev,
          [item.uid || item.id]: String(restored?.version_id || prev[item.uid || item.id] || ''),
        }));
      } catch (err) {
        setHistoryError(err?.message || 'Failed to restore version');
      } finally {
        setRestoringByArtifact((prev) => ({ ...prev, [artifactDbId]: false }));
      }
    },
    [activeHistory, conversationId, onSelect, onUpdate]
  );

  if (!items.length) {
    return null;
  }

  return (
    <section className="panel artifact-panel">
      <header className="panel-header">
        <h2>{title}</h2>
      </header>
      <div className="artifact-list">
        {items.map((item) => {
          const itemId = item.uid || item.id;
          const parts = extractParts(item.code);
          const hidden = hiddenParts[itemId] || [];
          const isExpanded = expandedId === itemId;
          const isDataExpanded = dataEditorId === itemId;
          const isVersionsExpanded = versionPanelId === itemId;
          const collapsed = isCollapsed(itemId);
          const promptClause = String(item?.meta?.prompt_clause || '').trim();
          const chartDataSource = item.type === 'html' ? extractChartDataSource(item.code) : null;
          const hasDataEditor = Boolean(chartDataSource && chartDataSource.rows?.length);
          const hasVersionHistory = Boolean(
            String(conversationId || '').trim()
            && (
              String(item?.meta?.history?.artifact_db_id || '').trim()
              || String(item?.meta?.history?.logical_key || item?.id || '').trim()
            )
          );
          const versions = versionsForItem(item);
          const selectedVersionId = selectedVersionByArtifact[itemId]
            || String(item?.meta?.history?.version_id || '').trim()
            || String(versions[versions.length - 1]?.id || '');
          const artifactDbId = String(item?.meta?.history?.artifact_db_id || '').trim();
          const restoring = Boolean(restoringByArtifact[artifactDbId]);

          return (
            <div
              key={itemId}
              role="button"
              tabIndex={0}
              className={`artifact-item ${activeId === itemId ? 'active' : ''}`}
              onClick={() => onSelect(item)}
              onDoubleClick={() => onToggleExpand(item)}
            >
              <div className="artifact-item-row">
                <div className="artifact-name">{item.name}</div>
                <div className="artifact-item-actions" onClick={(event) => event.stopPropagation()}>
                  <label className="artifact-toggle">
                    <input
                      type="checkbox"
                      checked={isVisible(itemId)}
                      onChange={() => onToggleVisibility(item)}
                    />
                    <span>Show</span>
                  </label>
                  <button
                    type="button"
                    className="artifact-collapse"
                    onClick={() => onToggleCollapse(item)}
                  >
                    {collapsed ? 'Expand' : 'Minimize'}
                  </button>
                </div>
              </div>

              {!collapsed && (
                <>
                  <div className="artifact-desc">{item.description || 'No description'}</div>
                  <div className="artifact-meta">{item.type.toUpperCase()}</div>
                  {promptClause && (
                    <div className="artifact-clause" title={promptClause}>
                      Prompt clause: {promptClause}
                    </div>
                  )}
                  <div className="artifact-edit-actions">
                    <button
                      type="button"
                      className="artifact-edit"
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleExpand(item);
                      }}
                    >
                      {isExpanded
                        ? (item.type === 'html' ? 'Close Style Editor' : 'Close Editor')
                        : (item.type === 'html' ? 'Edit Style' : 'Edit')}
                    </button>
                    {hasDataEditor && (
                      <button
                        type="button"
                        className="artifact-edit artifact-edit-secondary"
                        onClick={(event) => {
                          event.stopPropagation();
                          setDataEditorId((prev) => (prev === itemId ? null : itemId));
                        }}
                      >
                        {isDataExpanded ? 'Close Data Editor' : 'Edit Data'}
                      </button>
                    )}
                    {hasVersionHistory && (
                      <button
                        type="button"
                        className="artifact-edit artifact-edit-secondary"
                        onClick={(event) => {
                          event.stopPropagation();
                          openVersionPanel(item, itemId);
                        }}
                      >
                        {isVersionsExpanded ? 'Close Versions' : 'Versions'}
                      </button>
                    )}
                  </div>
                </>
              )}

              {!collapsed && isExpanded && (
                <div
                  className="artifact-editor-inline"
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  <div className="artifact-editor-grid">
                    <label>
                      Name
                      <input
                        type="text"
                        value={item.name}
                        onChange={(event) =>
                          onUpdate({ ...item, name: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Description
                      <input
                        type="text"
                        value={item.description || ''}
                        onChange={(event) =>
                          onUpdate({ ...item, description: event.target.value })
                        }
                      />
                    </label>
                  </div>

                  {item.type === 'html' && (
                    <>
                      {parts.length > 0 && (
                        <div className="artifact-editor-parts">
                          <div className="artifact-editor-title">Visible Sections</div>
                          <div className="artifact-editor-parts-list">
                            {parts.map((part) => (
                              <label key={part} className="artifact-editor-part">
                                <input
                                  type="checkbox"
                                  checked={!hidden.includes(part)}
                                  onChange={() => onTogglePart(item, part)}
                                />
                                <span>{part}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      )}
                      <label className="artifact-editor-code">
                        HTML Code
                        <textarea
                          value={item.code}
                          rows={10}
                          onChange={(event) =>
                            onUpdate({ ...item, code: event.target.value })
                          }
                        />
                      </label>
                    </>
                  )}

                  {item.type === 'text' && (
                    <label className="artifact-editor-code">
                      Text Content
                      <textarea
                        value={item.text || ''}
                        rows={8}
                        onChange={(event) =>
                          onUpdate({ ...item, text: event.target.value })
                        }
                      />
                    </label>
                  )}

                  {item.type === 'code' && (
                    <>
                      <label>
                        Language
                        <input
                          type="text"
                          value={item.language || ''}
                          onChange={(event) =>
                            onUpdate({ ...item, language: event.target.value })
                          }
                        />
                      </label>
                      <label className="artifact-editor-code">
                        Code
                        <textarea
                          value={item.code || ''}
                          rows={12}
                          onChange={(event) =>
                            onUpdate({ ...item, code: event.target.value })
                          }
                        />
                      </label>
                    </>
                  )}
                </div>
              )}

              {!collapsed && isDataExpanded && hasDataEditor && (
                <ChartDataEditor item={item} onUpdate={onUpdate} />
              )}

              {!collapsed && isVersionsExpanded && (
                <VersionTimelinePanel
                  item={item}
                  versions={versions}
                  selectedVersionId={selectedVersionId}
                  onSelectVersion={(versionId) => {
                    setSelectedVersionByArtifact((prev) => ({ ...prev, [itemId]: String(versionId || '') }));
                  }}
                  onRestoreVersion={(version) => handleRestoreVersion(item, version)}
                  restoring={restoring}
                  loading={historyLoading}
                  error={historyError}
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
