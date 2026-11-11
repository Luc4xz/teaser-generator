import LockedField, { ParameterLock } from './ParameterLock.jsx';
import { preserveLockedValues } from './locks.js';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { migrateProject } from './model.js';
import { readPaper } from './readPaper.js';
import { downloadImage } from './workspace.js';
import { inputSnapshot, startWorkflow, pollWorkflow, addVersion, startConceptRun, pollConceptRun } from './workflow.js';
import { loadWorkspace, saveWorkspace, listProjects, loadProject, activateProject } from './storage.js';
import { identifyProject, createProject } from './projects.js';
import WorkspaceDialog from './WorkspaceDialog.jsx';
import ConceptPanel from './ConceptPanel.jsx';
import ConceptDock from './ConceptDock.jsx';
import ConceptTrace from './ConceptTrace.jsx';
import { conceptIsReady, conceptSource, dockConcept, undockConcept } from './concept.js';
import RunProgress from './RunProgress.jsx';
import SnapshotCanvas from './SnapshotCanvas.jsx';
import Collaboration, {readSession, useBoard} from './Collaboration.jsx';
import './teaser.css';
const KEY = 'teaser-studio-project-v1';
function readProject() {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY));
    if (!stored) return createProject();
    const p = migrateProject(stored);
    // Keep old projects intact, but do not bring their chat/draft history into the canvas.
    return identifyProject({ ...p, userPrompt: p.userPrompt ?? p.insight ?? '', canvasImages: p.canvasImages || [] });
  } catch { return createProject(); }
}
function Icon({ name, size = 20 }) {
  const paths = {
    upload: <><path d="M12 16V4m-5 5 5-5 5 5"/><path d="M4 16v4h16v-4"/></>,
    file: <><path d="M14 3H5v18h14V8z"/><path d="M14 3v5h5M8 12h8M8 16h6"/></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
    expand: <path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/></>,
    link: <><path d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 -1)"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.image}</svg>;
}
export default function TeaserApp() {
  const [project,setProject] = useState(readProject);
  const [session,setSession] = useState(readSession);
  const collaboration = useBoard(project,setProject,session);
  const selectSnapshot = useCallback(id=>{setSelectedId(id);setRefineOpen(false);const inspector=document.querySelector('.snapshot-inspector');if(inspector)inspector.open=true;},[]);
  const [workspaceOpen,setWorkspaceOpen] = useState(false);
  const [workspaceProjects,setWorkspaceProjects] = useState([]);
  const [workspaceLoading,setWorkspaceLoading] = useState(false);
  const [workspaceBusy,setWorkspaceBusy] = useState(false);
  const [workspaceError,setWorkspaceError] = useState('');
  const workspaceOperation = useRef(false);
  const [extracting,setExtracting] = useState(false);
  const [conceptRun,setConceptRun] = useState(null);
  const conceptAttempt = useRef(null);
  const [busy,setBusy] = useState(false);
  const [run,setRun] = useState(null);
  const [storageReady,setStorageReady] = useState(false);
  const [feedback,setFeedback] = useState('');
  const [restartFrom,setRestartFrom] = useState('plan');
  const [editedPrompt,setEditedPrompt] = useState('');
  const [refineOpen,setRefineOpen] = useState(false);
  const [briefParent,setBriefParent] = useState(null);
  const lastAttempt = useRef(null);
  const [uploading,setUploading] = useState(false);
  const [notice,setNotice] = useState('');
  const [saveStatus,setSaveStatus] = useState('saving');
  const [selectedId,setSelectedId] = useState(null);
  const [conceptDragging,setConceptDragging] = useState(false);
  const [dragOver,setDragOver] = useState(false);
  const fileInput = useRef(null); const canvas = useRef(null); const dialog = useRef(null);
  const generating = useRef(false);
  const images = project.canvasImages || [];
  const selected = images.find(item => item.id === (selectedId || project.activeCanvasId)) || images.at(-1);
  const disabled = busy || uploading || extracting || workspaceBusy || !storageReady;
  const conceptReady = conceptIsReady(project);
  const conceptConfirmed = conceptReady && project.conceptConfirmed;
  useEffect(() => {
    let active=true;
    loadWorkspace().then(stored=>{if(active&&stored)setProject(identifyProject({...migrateProject(stored),userPrompt:stored.userPrompt||'',canvasImages:stored.canvasImages||[]}));})
      .catch(()=>{if(active)setSaveStatus('error');}).finally(()=>{if(active)setStorageReady(true);});
    return ()=>{active=false;};
  },[]);
  useEffect(() => {
    if (!storageReady) return;
    let active = true;
    setSaveStatus('saving');
    saveWorkspace(project).then(()=>{if(active)setSaveStatus('saved');}).catch(()=>{if(active)setSaveStatus('error');});
    return () => { active = false; };
  },[project,storageReady]);
  useEffect(() => {
    if(storageReady && project.pendingRun && !generating.current) followRun(project.pendingRun);
  },[storageReady,project.projectId]);
  function patch(values) { setProject(prev => preserveLockedValues({...prev,...values},prev)); }
  function toggleLock(name) {
    if(disabled)return;
    setProject(prev=>({...prev,parameterLocks:{...prev.parameterLocks,[name]:!prev.parameterLocks?.[name]}}));
  }
  const isLocked = name => !!project.parameterLocks?.[name];
  function confirmConcept() {
    if(disabled)return;
    setProject(prev=>dockConcept(prev));setConceptDragging(false);
    document.querySelector('.input-scroll')?.scrollTo({top:0,behavior:'smooth'});
  }
  function returnConcept() {
    if(disabled)return;
    setProject(prev=>undockConcept(prev));
    canvas.current?.scrollTo({top:0,behavior:'smooth'});
  }
  async function openWorkspace() {
    if(disabled || workspaceOperation.current)return;
    workspaceOperation.current=true;setWorkspaceOpen(true);setWorkspaceLoading(true);setWorkspaceBusy(true);setWorkspaceError('');
    try {await saveWorkspace(project);setWorkspaceProjects(await listProjects());}
    catch(error){setWorkspaceError(error.message || 'Could not load the workspace. Your current project is still open.');}
    finally{workspaceOperation.current=false;setWorkspaceLoading(false);setWorkspaceBusy(false);}
  }
  async function saveCurrentProject(name) {
    if(workspaceOperation.current)return false;
    workspaceOperation.current=true;setWorkspaceBusy(true);setWorkspaceError('');
    try {
      const next={...project,projectName:name.trim() || project.projectName};
      await saveWorkspace(next);setProject(next);setSaveStatus('saved');
      setWorkspaceProjects(await listProjects());return true;
    } catch(error){setWorkspaceError(error.message || 'Could not save this project.');return false;}
    finally{workspaceOperation.current=false;setWorkspaceBusy(false);}
  }
  async function switchProject(id, currentName, newName) {
    if(disabled || workspaceOperation.current || generating.current)return;
    workspaceOperation.current=true;setWorkspaceBusy(true);setWorkspaceError('');
    try {
      const incoming=id ? await loadProject(id) : createProject(newName?.trim() || `Untitled project ${workspaceProjects.length+1}`);
      const next=identifyProject({...migrateProject(incoming),userPrompt:incoming.userPrompt || '',canvasImages:incoming.canvasImages || []});
      await activateProject({...project,projectName:currentName.trim() || project.projectName},next);
      setProject(next);resetProjectView();setWorkspaceOpen(false);
    } catch(error){setWorkspaceError(error.message || 'Could not switch projects. Your current project is still open.');}
    finally{workspaceOperation.current=false;setWorkspaceBusy(false);}
  }
  function resetProjectView() {
    setConceptRun(null);conceptAttempt.current=null;
    setRun(null);
    lastAttempt.current = null;
    setSelectedId(null);
    setBriefParent(null);
    setRefineOpen(false);
    setFeedback('');
    setEditedPrompt('');
    setRestartFrom('plan');
    setDragOver(false);
    setConceptDragging(false);
    setNotice('');
    if (fileInput.current) fileInput.current.value = '';
    dialog.current?.close();
    document.querySelector('.input-scroll')?.scrollTo({top:0});
    canvas.current?.scrollTo({top:0});
    fileInput.current?.focus();
  }
  async function followConcept(attempt) {
    setExtracting(true);setNotice('');
    try {
      const concept = await pollConceptRun(attempt.id,setConceptRun);
      setProject(prev => conceptSource(prev) === attempt.source ? preserveLockedValues({...prev,scientificConcept:concept,conceptSource:attempt.source},prev) : prev);
    } catch(error) {
      setConceptRun(prev=>prev?.status==='failed'?prev:{...prev,status:'interrupted',message:error.message});
    } finally {setExtracting(false);}
  }
  async function analyzeConcept() {
    if (disabled || project.conceptConfirmed || !project.paper.trim()) return;
    setExtracting(true);setNotice('');conceptAttempt.current=null;
    setConceptRun({status:'queued',message:'Submitting your paper for concept generation…',steps:[]});
    const snapshot = inputSnapshot(project);
    try {
      const started = await startConceptRun(snapshot);
      const attempt = {id:started.id,source:conceptSource(snapshot)};
      conceptAttempt.current=attempt;setConceptRun(started);
      await followConcept(attempt);
    } catch(error) {
      setConceptRun({status:'failed',message:error.message,steps:[]});
      setExtracting(false);
    }
  }
  async function upload(file) {
    if (!file || disabled || isLocked('paper')) return;
    setUploading(true); setNotice('');
    try { const paper = await readPaper(file); patch({paper,fileName:file.name}); }
    catch(error) { setNotice(error.name === 'PasswordException' ? 'This PDF is password-protected. Choose an unlocked PDF or paste its text.' : error.message); }
    finally { setUploading(false); if(fileInput.current) fileInput.current.value = ''; }
  }
  async function followRun(attempt) {
    generating.current=true;setBusy(true);lastAttempt.current=attempt;
    try {
      const result=await pollWorkflow(attempt.id,setRun);
      setProject(prev=>addVersion(prev,result,attempt.snapshot,attempt.options,attempt.id));
      setSelectedId(null);setRefineOpen(false);setFeedback('');
    } catch(error) {
      const message=error.message==='Failed to fetch'?'Connection interrupted. Your versions are safe; reconnect to this run.':error.message;
      setNotice(message);
      setRun(prev=>prev?.status==='failed'?prev:{...prev,status:'interrupted',message});
    } finally {generating.current=false;setBusy(false);}
  }
  async function begin(snapshot,options={}) {
    if(generating.current||uploading||extracting)return;
    if(!session || session.expiresAt <= Date.now()){setNotice('Sign in before generating an image so its creator is recorded.');return;}
    options={...options,creator:{userId:session.userId,displayName:session.displayName}};
    generating.current=true;setBusy(true);setNotice('');
    setRun({status:'queued',message:'Starting a new version…',steps:[],artifacts:{}});
    try {
      const started=await startWorkflow(snapshot,options);
      const attempt={id:started.id,snapshot,options};
      lastAttempt.current=attempt;setRun(started);
      setProject(prev=>({...prev,pendingRun:attempt}));
      await followRun(attempt);
    } catch(error) {setNotice(error.message);generating.current=false;setBusy(false);}
  }
  function generate(event) {event?.preventDefault();if(disabled || !conceptConfirmed)return;begin(inputSnapshot(project),{parentId:briefParent});}
  function openRefine() {setEditedPrompt(selected.drawingBrief||'');setFeedback('');setRestartFrom('plan');setRefineOpen(true);}
  function restoreBrief() {
    const snapshot=selected.inputSnapshot;
    if(!snapshot){setNotice('This older version has no saved input snapshot. Use the current paper and brief to start a new version.');return;}
    setProject(prev=>{const editable=undockConcept(prev);return preserveLockedValues({...editable,...snapshot,conceptConfirmed:false,conceptLocksBeforeDock:null,scientificConcept:snapshot.scientificConcept || null,conceptSource:snapshot.conceptSource || ''},editable);});setBriefParent(selected.id);setRefineOpen(false);canvas.current?.scrollTo({top:0,behavior:'smooth'});
    document.querySelector('.input-scroll')?.scrollTo({top:0,behavior:'smooth'});
  }
  function refine() {
    const snapshot=preserveLockedValues(selected.inputSnapshot || inputSnapshot(project),project);
    begin(snapshot,{parentId:selected.id,feedback,restartFrom,drawingPrompt:editedPrompt});
  }
  function retryRun() {
    const previous=lastAttempt.current;if(!previous)return;
    const prompt=run?.artifacts?.drawingPrompt;
    begin(previous.snapshot,prompt?{...previous.options,restartFrom:'render',drawingPrompt:prompt,feedback:''}:previous.options);
  }
  return <div className="core-studio">
    <header className="workspace-header panel-header">
      <div className="panel-header-left"><h1 id="input-heading">Illustrate your paper</h1><button type="button" className="new-project-button" onClick={openWorkspace} disabled={disabled} title={`Workspace · ${project.projectName}`} aria-haspopup="dialog">Workspace</button></div>
      <div className="panel-header-right"><h2 id="canvas-heading">Shared idea canvas</h2>{images.length > 0 && <span className="canvas-count">{`${images.length} version${images.length>1?'s':''}`}</span>}</div>
    </header>
    <main className="core-workspace">
      <section className="input-panel" aria-labelledby="input-heading">
        <div className="input-form">
          <div className="input-scroll">
          <Collaboration project={project} setProject={setProject} session={session} setSession={setSession} disabled={disabled} status={collaboration.status} onJoin={resetProjectView}/>
          <fieldset disabled={disabled}>
            <div className="source-artifact-row"><div className="paper-source-card">
            <div className="input-section-label"><label htmlFor="paper-file">Source paper</label><ParameterLock label="Source paper" locked={isLocked('paper')} disabled={disabled} onToggle={()=>toggleLock('paper')}/></div>
            <input id="paper-file" disabled={isLocked('paper')} ref={fileInput} type="file" accept=".pdf,.txt,.md" className="file-input" onChange={e=>upload(e.target.files[0])}/>
            <div className={`upload-zone ${dragOver?'drag-over':''} ${project.paper?'has-paper':''}`} onDragOver={e=>{e.preventDefault();if(!disabled&&!isLocked('paper'))setDragOver(true);}} onDragLeave={()=>setDragOver(false)} onDrop={e=>{e.preventDefault();setDragOver(false);upload(e.dataTransfer.files[0]);}}>
              <button type="button" className="upload-target" disabled={isLocked('paper')} onClick={()=>fileInput.current?.click()}>
                <span className="upload-icon"><Icon name={project.paper?'file':'upload'} size={25}/></span>
                <strong>{uploading?'Reading your paper…':project.fileName || (project.paper?'Pasted paper text':'Drop your paper here')}</strong>
                <span>{project.paper ? `${project.paper.length.toLocaleString()} characters extracted · Click to replace` : 'or browse files · up to 15 MB'}</span>
              </button>
              {project.paper && <button type="button" className="remove-paper" disabled={isLocked('paper')} onClick={()=>patch({paper:'',fileName:''})} aria-label="Remove attached paper">×</button>}
            </div>
            </div></div>
            <details className="paper-text"><summary>{project.paper?'Review extracted paper text':'Or paste paper text'}</summary><textarea aria-label="Paper text" disabled={isLocked('paper')} value={project.paper} rows={7} onChange={e=>patch({paper:e.target.value,fileName:''})} placeholder="Paste an abstract or paper text…"/><p>Check PDF extraction, especially equations and columns.</p></details>
        {briefParent && <p className="branch-note">Editing the brief from a saved version. Generate will create a new version.<button onClick={()=>setBriefParent(null)} type="button">Start independently</button></p>}
            <details className="brief-fields foldable-options" open>
              <summary>Image direction <span>(style & purpose)</span></summary>
              <div className="fold-content">
                <p>Choose how the image should look and what it should do.</p>
                <LockedField name="visual.representation" label="Representation (abstract or realistic)" locks={project.parameterLocks} onToggle={toggleLock} disabled={disabled}><select value={project.visual.representation || ''} onChange={e=>patch({visual:{...project.visual,representation:e.target.value}})}><option value=""></option><option value="abstract">Abstract — symbolic forms and visual metaphors</option><option value="illustrated">Illustrated — recognizable subjects, simplified</option><option value="realistic">Realistic — lifelike subjects and materials</option></select></LockedField>
                <LockedField name="visual.purpose" label="Purpose (explain or provoke thought)" locks={project.parameterLocks} onToggle={toggleLock} disabled={disabled}><select value={project.visual.purpose || ''} onChange={e=>patch({visual:{...project.visual,purpose:e.target.value}})}><option value=""></option><option value="explain">Explain — communicate relationships and information</option><option value="evoke">Provoke thought — one memorable insight or question</option><option value="balance">Balance — clear information with a visual hook</option></select></LockedField>
                <div className="brief-selects">
                  <LockedField name="visual.layout" label="Composition" locks={project.parameterLocks} onToggle={toggleLock} disabled={disabled}><select value={project.visual.layout || ''} onChange={e=>patch({visual:{...project.visual,layout:e.target.value}})}><option value=""></option><option value="stacked">Vertical sequence</option><option value="split">Side-by-side comparison</option><option value="central">Central scene</option></select></LockedField>
                  <LockedField name="visual.density" label="Text in image" locks={project.parameterLocks} onToggle={toggleLock} disabled={disabled}><select value={project.visual.density || ''} onChange={e=>patch({visual:{...project.visual,density:e.target.value}})}><option value=""></option><option value="minimal">Minimal labels</option><option value="balanced">Headline + key labels</option><option value="none">No text</option></select></LockedField>
                </div>
              </div>
            </details>
            <details className="brief-fields foldable-options">
              <summary>Audience & constraints <span>(optional)</span></summary>
              <div className="fold-content">
                <LockedField name="audience" label="Intended audience" locks={project.parameterLocks} onToggle={toggleLock} disabled={disabled}><textarea rows={1} maxLength={6000} value={project.audience || ''} placeholder="For example: researchers outside this field" onChange={e=>patch({audience:e.target.value})}/></LockedField>
                <LockedField name="preserve" label="Facts & limits to preserve" locks={project.parameterLocks} onToggle={toggleLock} disabled={disabled}><textarea rows={2} maxLength={6000} value={project.preserve || ''} placeholder="Essential claims, uncertainty, or caveats" onChange={e=>patch({preserve:e.target.value})}/></LockedField>
                <LockedField name="preferences" label="Elements to include or avoid" locks={project.parameterLocks} onToggle={toggleLock} disabled={disabled}><textarea rows={2} maxLength={6000} value={project.preferences || ''} placeholder="Additional visual constraints, if needed" onChange={e=>patch({preferences:e.target.value})}/></LockedField>
              </div>
            </details>
          </fieldset>
        {notice && <div className="workspace-notice" role="alert">{notice}<button type="button" aria-label="Dismiss message" onClick={()=>setNotice('')}>×</button></div>}
        {saveStatus==='error' && <p className="workspace-notice" role="status">Version history could not be saved on this device. Download your images before closing this tab.</p>}
          </div>
          <div className="input-actions">
            <button className="generate-button gradient-button" disabled={disabled || !conceptConfirmed} type="button" onClick={generate} aria-busy={busy}><span className="gradient-button-label">{busy ? 'Generating image…' : 'Generate image'}</span><Icon name="arrow"/></button>
          </div>
        </div>
      </section>
      <section className="concept-column" aria-label="Generate concept">
        <div className="column-title"><span>02 / CONCEPT</span><h2>Generate concept</h2><p>Review the science. Shape your next direction.</p></div>
            <button type="button" className={`secondary-action generate-concept-button ${!disabled && project.paper.trim() && !conceptReady && !project.conceptConfirmed ? 'concept-next-step' : ''}`}  disabled={disabled || project.conceptConfirmed || !project.paper.trim()} onClick={analyzeConcept}>{extracting ? 'Generating concept…' : project.conceptConfirmed ? 'Concept locked' : project.scientificConcept ? 'Regenerate concept' : 'Generate concept'}</button>
            {!conceptConfirmed && <p className="concept-action-hint">{conceptReady ? 'Confirm the reviewed concept to lock its values.' : project.conceptConfirmed ? 'Unlock the concept to update it for the changed source.' : project.paper.trim() ? 'Next: click Generate concept, then review it below.' : 'Upload or paste a paper to enable concept generation.'}</p>}
            <ConceptPanel project={project} run={conceptRun} onRetry={analyzeConcept} onReconnect={()=>conceptAttempt.current&&followConcept(conceptAttempt.current)} extracting={extracting} disabled={disabled} onChange={concept=>patch({scientificConcept:concept})} onToggleLock={toggleLock} onConfirm={confirmConcept} onDragState={setConceptDragging}/>
        {!project.scientificConcept && !extracting && <p className="concept-column-empty">Upload a paper, then generate its scientific concepts. Review and adjust each value before creating an image.</p>}
        {project.conceptConfirmed && <ConceptDock project={project} disabled={disabled} dragging={conceptDragging} onConfirm={confirmConcept} onReturn={returnConcept}/>}
      </section>
      <section className="canvas-panel" ref={canvas} aria-labelledby="canvas-heading" aria-busy={busy}>
        <div className="board-toolbar"><span>{images.length} snapshots · {new Set(images.map(s=>s.creator?.userId).filter(Boolean)).size} contributors</span><span>Drag to arrange · scroll to zoom</span></div>
        {run && run.status!=='complete' && <RunProgress run={run} busy={busy} onRetry={retryRun} onReconnect={()=>lastAttempt.current&&followRun(lastAttempt.current)}/>}
        <SnapshotCanvas images={images} selectedId={selected?.id} onSelect={selectSnapshot} onMove={collaboration.move}/>
        <details className="snapshot-inspector"><summary>Selected snapshot · details & iteration</summary>


        {selected ? <div className="selected-version">
          <div className="version-detail">
          <article className="image-card"><div className="image-card-bar"><span>VERSION {images.indexOf(selected)+1}</span><div><button type="button" onClick={()=>dialog.current?.showModal()} aria-label="Expand image"><Icon name="expand" size={17}/></button><button type="button" onClick={()=>downloadImage(selected)}><Icon name="download" size={17}/><span>Download</span></button></div></div><button type="button" className="canvas-image" onClick={()=>dialog.current?.showModal()} aria-label="View generated image at full size"><img src={selected.image} alt={selected.groundingPlan?.subject || selected.userPrompt || 'Generated research illustration'}/></button></article>
          <div className="version-actions"><button type="button" className="secondary-action" disabled={disabled} onClick={openRefine}>Refine this version ↻</button><button type="button" disabled={disabled} onClick={restoreBrief}>Revisit concept & brief</button><span>{selected.revisionFeedback ? `Revision: ${selected.revisionFeedback}` : 'Initial direction'}</span></div>
          {refineOpen && <section className="refinement-card" aria-label="Refine selected version">
            <h3>Improve version {images.indexOf(selected)+1}</h3>
            <label className="brief-field">Where should we restart?<select disabled={busy} value={restartFrom} onChange={e=>setRestartFrom(e.target.value)}><option value="plan">Visual plan — rethink what to show</option><option value="render">Drawing prompt — adjust the image direction</option></select></label>
            <label className="brief-field">What should change?<textarea disabled={busy} maxLength={6000} rows={3} value={feedback} onChange={e=>setFeedback(e.target.value)} placeholder="For example: emphasize the relationship between the two ideas; simplify the background."/></label>
            {restartFrom==='render' && <label className="brief-field">Edit the drawing prompt (custom edits are not structure-validated)<textarea disabled={busy} rows={5} maxLength={32000} value={editedPrompt} onChange={e=>setEditedPrompt(e.target.value)}/></label>}
            <p>Creates a new image from this version’s saved instructions and your feedback. It does not edit the existing pixels. Earlier versions stay available.</p>
            {!selected.inputSnapshot && <p>This older version has no saved brief; refinement uses the current paper and input.</p>}
            <div className="refinement-buttons"><button type="button" className="generate-button" disabled={disabled || (restartFrom==='render'&&!editedPrompt.trim())} onClick={refine}>Create next version <Icon name="arrow"/></button><button type="button" disabled={busy} onClick={()=>setRefineOpen(false)}>Cancel</button></div>
          </section>}
          <ConceptTrace item={selected}/>
          {selected.workflowSteps && <details className="version-process"><summary>Completed workflow for this version</summary><ol>{selected.workflowSteps.map(step=><li key={step.id}>{step.label} · {step.status}</li>)}</ol></details>}
          <p className="canvas-footnote">{selected.paperName ? `Source: ${selected.paperName}` : 'Prompt-led generation'} · {selected.providerNote || 'AI-generated image. Review before use.'}</p>
          </div>
        </div> : <div className={`canvas-empty ${project.scientificConcept || extracting ? 'with-concept' : ''}`}><div className="empty-art" aria-hidden="true"><div className="empty-paper"><span/><span/><span/><span/></div><span className="empty-connector">↗</span><div className="empty-picture"><Icon name="image" size={45}/></div></div><h3>Your illustrations will appear here</h3><p>Generate an image from your paper and prompt.<br/>Each result includes its visual rationale and available paper evidence.</p><div className="empty-caption"><span>Paper</span><span>→</span><span>Image</span><span>→</span><span>Explanation</span></div></div>}
        </details>
      </section>
    </main>
    {workspaceOpen && <WorkspaceDialog project={project} projects={workspaceProjects} loading={workspaceLoading} working={workspaceBusy} error={workspaceError} onSave={saveCurrentProject} onCreate={(name,currentName)=>switchProject(null,currentName,name)} onOpen={(id,currentName)=>switchProject(id,currentName)} onClose={()=>setWorkspaceOpen(false)}/>}
    <dialog className="image-dialog" ref={dialog} onClick={e=>{if(e.target===e.currentTarget)dialog.current.close();}}><button className="dialog-close" type="button" onClick={()=>dialog.current.close()} aria-label="Close expanded image">×</button>{selected && <img src={selected.image} alt={selected.groundingPlan?.subject || selected.userPrompt || 'Generated illustration'}/>}</dialog>
  </div>;
}
