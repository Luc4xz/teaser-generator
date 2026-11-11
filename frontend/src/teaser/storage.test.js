import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, identifyProject } from './projects.js';
import { loadWorkspace, saveWorkspace, listProjects, loadProject, activateProject } from './storage.js';

test('existing workspace migrates and projects survive save, create, and reopen', async () => {
  const original = {
    schema: 2, paper: 'Original research paper', fileName: 'Research.pdf',
    scientificConcept: { core_claim: 'A saved claim' }, conceptConfirmed: true,
    parameterLocks: { paper: true }, conceptLocksBeforeDock: { paper: false },
    canvasImages: [{ id: 'version-1', image: 'data:image/png;base64,example', drawingBrief: 'Saved drawing prompt' }],
    activeCanvasId: 'version-1', pendingRun: null,
  };
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('research-illustration', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspace');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('workspace', 'readwrite');
      transaction.objectStore('workspace').put(original, 'current');
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
  });

  const migrated = await loadWorkspace();
  assert.ok(migrated.projectId);
  assert.equal(migrated.projectName, 'Research');
  for (const key of Object.keys(original)) assert.deepEqual(migrated[key], original[key]);
  assert.equal(identifyProject(migrated).projectId, migrated.projectId);
  assert.deepEqual(await loadProject(migrated.projectId), migrated);

  await saveWorkspace({ ...migrated, projectName: 'Renamed research' });
  let catalog = await listProjects();
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].name, 'Renamed research');
  assert.equal(catalog[0].versionCount, 1);
  assert.equal(catalog[0].conceptConfirmed, true);
  assert.equal('paper' in catalog[0], false);
  assert.equal('canvasImages' in catalog[0], false);

  const fresh = createProject('Second project');
  assert.notEqual(fresh.projectId, migrated.projectId);
  assert.notEqual(createProject().projectId, fresh.projectId);
  assert.equal(fresh.paper, '');
  assert.equal(fresh.conceptConfirmed, false);
  assert.deepEqual(fresh.canvasImages, []);
  assert.equal(fresh.pendingRun, null);
  const outgoing = { ...migrated, projectName: 'Final name', paper: 'Latest unsaved edits' };
  await activateProject(outgoing, fresh);
  assert.equal((await loadWorkspace()).projectId, fresh.projectId);
  const archived = await loadProject(migrated.projectId);
  assert.equal(archived.paper, outgoing.paper);
  assert.equal(archived.projectName, 'Final name');
  assert.deepEqual(archived.canvasImages, original.canvasImages);
  assert.deepEqual(archived.parameterLocks, original.parameterLocks);
  assert.deepEqual(archived.scientificConcept, original.scientificConcept);
  assert.equal(archived.activeCanvasId, 'version-1');

  await activateProject({ ...fresh, paper: 'Second paper' }, archived);
  assert.equal((await loadWorkspace()).projectId, archived.projectId);
  assert.equal((await loadProject(fresh.projectId)).paper, 'Second paper');
  catalog = await listProjects();
  assert.equal(catalog.length, 2);
  await assert.rejects(loadProject('missing'), /could not be found/);
  assert.equal((await loadWorkspace()).projectId, archived.projectId);
  await assert.rejects(saveWorkspace({ paper: 'No identity' }), /identity is missing/);
});
