export const STEPS = ['Give the brief', 'Confirm the factors', 'Review the draft', 'Refine & approve'];
export const FACTORS = [['insight', 'Insight'], ['mechanism', 'Mechanism'], ['audience', 'Audience'], ['keepFixed', 'Core claim + limits']];
export const VISUAL_FIELDS = [['headline', 'Headline'], ['analogy', 'Analogy'], ['rationale', 'Why this visual?'], ['layout', 'Composition'], ['tone', 'Palette'], ['density', 'Text emphasis']];
export function blankProject() {
  return { schema: 2, title: '', paper: '', fileName: '', insight: '', reaction: '', preserve: '', audience: '', preferences: '', factors: Object.fromEntries(FACTORS.map(([id]) => [id, ''])), visual: { headline: '', analogy: '', rationale: '', layout: 'stacked', tone: 'neutral', density: 'balanced' }, factorsReady: false, locked: false, meaningChecked: false, versions: [], activeVersion: null, pendingRevision: null, feedback: '', authorApproved: false, designerApproved: false, step: 0 };
}
export function migrateProject(raw) {
  const base = blankProject();
  if (raw?.schema === 2) return { ...base, ...raw, factors: { ...base.factors, ...raw.factors }, visual: { ...base.visual, ...raw.visual }, step: Math.max(0, Math.min(3, Number(raw.step) || 0)) };
  if (!raw || typeof raw !== 'object') return base;
  const f = raw.factors || {};
  return { ...base, title: raw.title || '', paper: raw.paper || '', fileName: raw.fileName || '', insight: f.finding || f.S2 || '', reaction: f.goal || f.A2 || raw.intent || '', preserve: f.evidence || f.S3 || '', audience: f.audience || f.A1 || '', preferences: raw.preferences || '', factors: { insight: f.finding || f.S2 || '', mechanism: f.question || f.S1 || '', audience: f.audience || f.A1 || '', keepFixed: f.evidence || f.S3 || '' }, visual: { ...base.visual, analogy: f.metaphor || f.V1 || '' }, legacyProject: raw };
}
export function briefReady(p) { return ['paper', 'insight', 'reaction', 'preserve', 'audience'].every(key => p[key].trim()); }
export function prepareFactors(p) {
  if (!briefReady(p)) throw new Error('Complete the paper and brief first.');
  return { ...p, factorsReady: true, locked: false, meaningChecked: false, factors: { ...p.factors, insight: p.insight, audience: p.audience, keepFixed: p.preserve }, visual: { ...p.visual, headline: p.visual.headline || p.insight }, authorApproved: false, designerApproved: false, step: 1 };
}
export function updateBrief(p, values) { return { ...p, ...values, factorsReady: false, locked: false, meaningChecked: false, authorApproved: false, designerApproved: false }; }
export function editFactor(p, id, value) { return { ...p, factors: { ...p.factors, [id]: value }, locked: false, meaningChecked: false, authorApproved: false, designerApproved: false }; }
export function readyForLock(p) { return p.factorsReady && FACTORS.every(([id]) => p.factors[id].trim()); }
export function signature(p) { return JSON.stringify([p.title, p.paper, p.reaction, p.preferences, p.factors, p.visual]); }
export function currentDraft(p) { return p.versions.find(v => v.id === p.activeVersion); }
export function draftIsCurrent(p) { const draft = currentDraft(p); return !!draft && p.locked && draft.signature === signature(p); }
export function canExport(p) { return draftIsCurrent(p) && !p.pendingDrawingPlan && !p.feedback.trim() && (!p.pendingRevision || JSON.stringify(p.pendingRevision) === JSON.stringify(p.visual)) && p.authorApproved && p.designerApproved; }
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
function wrap(value, width) {
  const lines = []; let line = '';
  // Split long unbroken strings as well as ordinary words to keep exports inside the canvas.
  for (const token of String(value).split(/\s+/).flatMap(word => word.match(new RegExp(`.{1,${width}}`, 'gu')) || [])) {
    if ((line + ' ' + token).length > width && line) { lines.push(line); line = ''; }
    line += (line ? ' ' : '') + token;
  }
  if (line) lines.push(line); return lines;
}
export function teaserSvg(p) {
  const colors = { neutral: ['#f6f6f4', '#292929', '#e2e2df'], sage: ['#f1f3eb', '#30483b', '#d8e0ca'], blue: ['#eff3f7', '#28405c', '#d5dfeb'] };
  const [bg, ink, soft] = colors[p.visual.tone] || colors.neutral;
  let y = 64; let elements = '';
  const text = (value, size, width, weight = 400, x = 48) => { for (const line of wrap(value, width)) { elements += `<text x="${x}" y="${y}" font-family="Arial,sans-serif" font-size="${size}" font-weight="${weight}" fill="${ink}">${escape(line)}</text>`; y += size * 1.5; } };
  text(p.title || 'RESEARCH TEASER', 12, 90, 700); y += 22;
  text(p.visual.headline || p.factors.insight, 31, 39, 700); y += 24;
  // The schematic is a layout preview of the author's brief, not a generated illustration.
  text('VISUAL CONCEPT / AUTHOR DIRECTION', 11, 90, 700); y += 8;
  const labelY = y; const ideaLines = wrap(p.visual.analogy, 62); const panelHeight = Math.max(76, ideaLines.length * 25 + 34);
  elements += `<rect x="48" y="${labelY - 8}" width="664" height="${panelHeight}" fill="${soft}"/>`;
  y += 20; text(p.visual.analogy, 17, 62, 400, 66); y = labelY + panelHeight + 30;
  const fields = p.visual.layout === 'finding-first' ? [['INSIGHT', p.factors.insight], ['HOW IT WORKS', p.factors.mechanism]] : [['HOW IT WORKS', p.factors.mechanism], ['INSIGHT', p.factors.insight]];
  for (const [label,value] of fields) { text(label, 11, 90, 700); y += 4; text(value, p.visual.density === 'insight-led' && label === 'INSIGHT' ? 25 : 18, p.visual.density === 'insight-led' && label === 'INSIGHT' ? 48 : 63); y += 23; }
  text('CORE CLAIM + LIMITS', 11, 90, 700); y += 4; text(p.factors.keepFixed, 15, 76); y += 20;
  text(`FOR ${p.factors.audience}`, 11, 90); y += 25;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 ${Math.ceil(y)}" role="img" aria-label="Author-curated teaser layout"><rect width="760" height="${Math.ceil(y)}" fill="${bg}"/>${elements}</svg>`;
}
export function changesBetween(before, after) {
  if (!before) return [{ field: 'Draft', before: '', after: 'First paper-grounded illustration' }];
  return [...FACTORS.map(([id,label]) => [label,before.factors[id],after.factors[id]]), ...VISUAL_FIELDS.map(([id,label]) => [label,before.visual[id],after.visual[id]])].filter(([,a,b]) => a !== b).map(([field,a,b]) => ({ field, before:a, after:b }));
}
export function hasGenerationInput(p) {
  return [p.paper, p.title, p.insight, p.reaction, p.preserve, p.audience, p.preferences, p.feedback,
    ...Object.values(p.factors), p.visual.headline, p.visual.analogy, p.visual.rationale].some(value => value?.trim());
}
function draftInputs(p, revisionVisual = null) {
  if (!hasGenerationInput(p)) throw new Error('Enter an idea, prompt, or paper to generate an image.');
  const previous = currentDraft(p);
  const visual = revisionVisual ? { ...p.visual, ...revisionVisual } : p.visual;
  const next = { ...p, visual, locked: true };
  const changes = changesBetween(previous, next);
  if (p.paper.length > 1000000) throw new Error(`Paper has ${p.paper.length.toLocaleString()} characters; the limit is 1,000,000. Remove appendices or references and retry.`);
  return { visual, next, changes };
}
async function callGenerationApi(path, p, visual, isRevision, request) {
  const response = await request(`${(import.meta.env?.VITE_API_BASE_URL || '').replace(/\/+$/, '')}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paper: p.paper, title: p.title, reaction: p.reaction, preferences: p.preferences,
      factors: { ...p.factors, insight: p.factorsReady ? (p.factors.insight || p.insight) : (p.insight || p.factors.insight), audience: p.factorsReady ? (p.factors.audience || p.audience) : (p.audience || p.factors.audience), keepFixed: p.factorsReady ? (p.factors.keepFixed || p.preserve) : (p.preserve || p.factors.keepFixed) }, visual, feedback: p.feedback,
      ...(path.endsWith('/generate') && drawingPlanIsCurrent(p) && p.pendingDrawingPlan?.planHash ? {reviewed_plan_hash:p.pendingDrawingPlan.planHash} : {}) }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof result.detail === 'string' ? result.detail : Array.isArray(result.detail)
      ? result.detail.map(error => `${(error.loc || []).filter(part => part !== 'body').join('.') || 'Request'}: ${error.msg || 'Invalid value'}`).join('; ')
      : `Generation request failed (HTTP ${response.status}). Check that the backend is running and retry.`;
    throw new Error(detail);
  }
  return result;
}
export function drawingPlanIsCurrent(p) {
  const plan = p.pendingDrawingPlan;
  return !!plan && plan.inputSignature === signature(p) && plan.feedback === p.feedback &&
    (!plan.isRevision || JSON.stringify(plan.visual) === JSON.stringify(p.pendingRevision || p.visual));
}
export async function prepareDrawingPlan(p, revisionVisual = null, request = fetch) {
  const { visual } = draftInputs(p, revisionVisual);
  const result = await callGenerationApi('/api/teaser/plan', p, visual, !!revisionVisual, request);
  if (!result.drawingBrief) throw new Error('The provider returned no evidence-based image plan.');
  return { ...p, pendingDrawingPlan: { ...result, inputSignature: signature(p), feedback: p.feedback,
    visual: { ...visual }, isRevision: !!revisionVisual }, authorApproved: false, designerApproved: false };
}
export async function generateReviewedDraft(p, request = fetch) {
  const visual = p.pendingDrawingPlan?.isRevision ? (p.pendingRevision || p.visual) : null;
  const result = await generateDraft(p, visual, request);
  return { ...result, pendingDrawingPlan: null };
}
export async function generateDraft(p, revisionVisual = null, request = fetch) {
  const { visual, next, changes } = draftInputs(p, revisionVisual);
  const result = await callGenerationApi('/api/teaser/generate', p, visual, !!revisionVisual, request);
  if (!result.image?.startsWith('data:image/')) throw new Error('The image API returned no illustration.');
  if (revisionVisual && p.feedback.trim()) changes.push({ field: 'Feedback', before: '', after: p.feedback });
  const draft = { id: p.versions.length + 1, createdAt: new Date().toISOString(), factors: { ...p.factors }, visual: { ...visual }, signature: signature(next), image: result.image, model: result.model, drawingBrief: result.drawingBrief, changes, instruction: revisionVisual ? p.feedback : '', source: result.source || 'ai-image', generationMode: result.generationMode, generationNotes: result.generationNotes, groundingPlan: result.groundingPlan, formatRepairApplied: result.formatRepairApplied, repairedFormatProblems: result.repairedFormatProblems, analysisMethod: result.analysisMethod, evidenceExcerpt: result.evidenceExcerpt, providerNote: result.providerNote };
  return { ...next, versions: [...p.versions,draft], activeVersion: draft.id, pendingDrawingPlan:null, pendingRevision:null, authorApproved:false, designerApproved:false, feedback:'', step:revisionVisual ? 3 : 2 };
}
