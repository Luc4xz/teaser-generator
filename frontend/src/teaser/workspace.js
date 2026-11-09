import { lockedParameters } from './locks.js';
import { conceptIsReady } from './concept.js';
// Core generation helpers: one paper + one request, with incremental image results.
export const API_BASE = (import.meta.env?.VITE_API_BASE_URL || '').replace(/\/+$/, '');
export function generationPayload(project) {
  return {
    paper: project.paper || '', title: '',
    parameter_locks: lockedParameters(project),
    previous_concept: project.scientificConcept || {},
    scientific_concept: conceptIsReady(project) ? project.scientificConcept : null,
    user_prompt: project.userPrompt ?? project.insight ?? '',
    preferences: project.preferences || '', reaction: '',
    factors: { insight: '', mechanism: '', audience: project.audience || '', keepFixed: project.preserve || '' },
    visual: { headline: '', analogy: '', rationale: '', representation: project.visual?.representation || 'illustrated', purpose: project.visual?.purpose || 'explain',
      tone: 'neutral', layout: project.visual?.layout || 'stacked', density: project.visual?.density || 'balanced' },
  };
}
export async function generateImages(project, count, onImage, request = fetch, onProgress = () => {}, pause = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const payload = generationPayload(project);
  if (!payload.paper.trim() && !payload.user_prompt.trim()) throw new Error('Upload a paper or describe the image you want to create.');
  if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error('Choose between 1 and 3 images.');
  // Sequential calls respect the free provider's cooldown and keep completed images
  // available even if a later request fails. Every image uses the same input snapshot.
  for (let i = 0; i < count; i += 1) {
    const response = await request(`${API_BASE}/api/teaser/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    let result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof result.detail === 'string' ? result.detail : Array.isArray(result.detail)
        ? result.detail.map(error => `${(error.loc || []).slice(1).join('.')}: ${error.msg}`).join('; ')
        : `Generation failed (HTTP ${response.status}). Please retry.`;
      throw new Error(detail);
    }
    let polls = 0;
    while (result.jobId && ['queued','rendering'].includes(result.status)) {
      if (++polls > 300) throw new Error('The image queue is taking too long. Please retry later.');
      onProgress(result);
      await pause(4000);
      const status = await request(`${API_BASE}/api/teaser/jobs/${encodeURIComponent(result.jobId)}`);
      result = await status.json().catch(() => ({}));
      if (!status.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Could not check image generation. Please retry.');
    }
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(result.image || '')) throw new Error('The provider returned no usable image. Please retry.');
    await onImage({ ...result, id: globalThis.crypto.randomUUID(), createdAt: new Date().toISOString(),
      userPrompt: payload.user_prompt, paperName: project.fileName || (payload.paper ? 'Pasted paper' : ''),
      sourceTitle: project.title || '', variant: i + 1 }, i + 1);
  }
}
export function downloadImage(item) {
  const extension = item.image.startsWith('data:image/png') ? 'png' : item.image.startsWith('data:image/webp') ? 'webp' : 'jpg';
  const link = document.createElement('a');
  link.href = item.image; link.download = `research-image-${item.variant || 1}.${extension}`; link.click();
}
