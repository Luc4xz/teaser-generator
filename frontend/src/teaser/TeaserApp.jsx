import React, { useCallback, useEffect, useRef, useState } from 'react';
import { migrateProject } from './model.js';
import { readPaper } from './readPaper.js';
import { downloadImage } from './workspace.js';
import { inputSnapshot, startWorkflow, pollWorkflow, addVersion, startConceptRun, pollConceptRun, cancelRun, RunStoppedError } from './workflow.js';
import { loadWorkspace, saveWorkspace, listProjects, loadProject, activateProject } from './storage.js';
import { identifyProject, createProject } from './projects.js';
import WorkspaceDialog from './WorkspaceDialog.jsx';
import Icon from './StudioIcon.jsx';
import GenerationButton from './GenerationButton.jsx';
import FigureEditor from './FigureEditor.jsx';
import FigureReview, { ReviewBadge } from './FigureReview.jsx';
import { newFigureVersion } from './figure.js';
import WorkspaceColumns from './WorkspaceColumns.jsx';
import StudioTools, { boardContributors } from './StudioTools.jsx';
import { useStudioView } from './studio-navigation.js';
import { useStudioAppearance } from './studio-appearance.js';
import SettingsDialog from './SettingsDialog.jsx';
import ConceptPanel from './ConceptPanel.jsx';
import AuthGate from './AuthGate.jsx';
import { API_BASE } from './workspace.js';
import { authHeaders, checkSessionResponse } from './session.js';
import ConceptTrace from './ConceptTrace.jsx';
import { conceptIsReady, conceptSource } from './concept.js';
import RunProgress from './RunProgress.jsx';
import SnapshotCanvas from './SnapshotCanvas.jsx';
import Collaboration, {useBoard} from './Collaboration.jsx';
import './teaser.css';
import './studio-layout.css';
import './studio-theme.css';
import './figure.css';
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
export default function TeaserApp() {
  const [appearance,changeAppearance] = useStudioAppearance();
  return <AuthGate>{(session, setSession) => <TeaserWorkspace session={session} setSession={setSession}
    appearance={appearance} changeAppearance={changeAppearance}/>}</AuthGate>;
}
function TeaserWorkspace({session, setSession, appearance, changeAppearance}) {
  const [project,setProject] = useState(readProject);
  const [models,setModels] = useState({text:[],image:[]});
  const [modelStatus,setModelStatus] = useState('Loading models…');
  const [modelAttempt,setModelAttempt] = useState(0);
  const collaboration = useBoard(project,setProject,session);
  const layout = useRef(null);
  const [view,navigate] = useStudioView();
  const snapshotDetails = useRef(null);
  const conceptScroll = useRef(null);
  const [conceptOpen,setConceptOpen] = useState(true);
  const selectSnapshot = useCallback((id, focusDetails=false)=>{
    setSelectedId(id);
    setRefineOpen(false);
    if (focusDetails) layout.current?.revealPanel('concept',{scroll:false});
    requestAnimationFrame(()=>{
      const details = snapshotDetails.current;
      if (!details?.getClientRects().length) return;
      details.open = true;
      details.scrollIntoView({block:'start'});
      if (focusDetails) details.querySelector('summary')?.focus({preventScroll:true});
    });
  },[]);
  const [workspaceOpen,setWorkspaceOpen] = useState(false);
  const [settingsOpen,setSettingsOpen] = useState(false);
  const [workspaceProjects,setWorkspaceProjects] = useState([]);
  const [workspaceLoading,setWorkspaceLoading] = useState(false);
  const [workspaceBusy,setWorkspaceBusy] = useState(false);
  const [workspaceError,setWorkspaceError] = useState('');
  const workspaceOperation = useRef(false);
  const [activeKind,setActiveKind] = useState(null);
  const extracting = activeKind === 'concept';
  const busy = activeKind === 'image';
  const [conceptRun,setConceptRun] = useState(null);
  const conceptAttempt = useRef(null);
  const [run,setRun] = useState(null);
  const [storageReady,setStorageReady] = useState(false);
  const [feedback,setFeedback] = useState('');
  const [restartFrom,setRestartFrom] = useState('plan');
  const [editedPrompt,setEditedPrompt] = useState('');
  const [refineOpen,setRefineOpen] = useState(false);
  const [editFigureId,setEditFigureId] = useState(null);
  const [reviewFigureId,setReviewFigureId] = useState(null);
  const [briefParent,setBriefParent] = useState(null);
  const lastAttempt = useRef(null);
  const [uploading,setUploading] = useState(false);
  const [notice,setNotice] = useState('');
  const [saveStatus,setSaveStatus] = useState('saving');
  const [selectedId,setSelectedId] = useState(null);
  const [dragOver,setDragOver] = useState(false);
  const fileInput = useRef(null); const canvas = useRef(null); const dialog = useRef(null);
  const operation = useRef(null);
  const images = project.canvasImages || [];
  const contributors = boardContributors(images,session);
  const selected = images.find(item => item.id === (selectedId || project.activeCanvasId)) || images.at(-1);
  const editingFigure = images.find(item=>item.id === editFigureId);
  const reviewingFigure = images.find(item=>item.id === reviewFigureId);
  const reviewBySnapshot = new Map(collaboration.reviews.map(review=>[review.snapshotId,review]));
  const selectedReview = reviewBySnapshot.get(selected?.id);
  const disabled = busy || uploading || extracting || workspaceBusy || !storageReady;
  const conceptReady = conceptIsReady(project);
  const textModelReady = models.text.some(model=>model.id===project.textModel);
  const imageModelReady = models.image.some(model=>model.id===project.imageModel);
  useEffect(() => {
    if (!storageReady) return;
    let active = true;
    setModelStatus('Loading models…');
    fetch(`${API_BASE}/api/teaser/models`, {headers:authHeaders()}).then(async response => {
      checkSessionResponse(response);
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Could not load models.');
      if (!active) return;
      setModels(data.models);
      setModelStatus(data.models.text.length && data.models.image.length ? '' : 'Text and image models must be configured by your administrator.');
      setProject(prev => ({...prev,
        textModel:data.models.text.some(model=>model.id===prev.textModel) ? prev.textModel : data.defaults.text || '',
        imageModel:data.models.image.some(model=>model.id===prev.imageModel) ? prev.imageModel : data.defaults.image || ''}));
    }).catch(error=>{if(active)setModelStatus(error.message);});
    return ()=>{active=false;};
  }, [modelAttempt,session,storageReady,project.projectId]);
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
    if(storageReady && project.pendingRun && !operation.current) followRun(project.pendingRun);
  },[storageReady,project.projectId]);
  useEffect(()=>()=>{
    operation.current?.controller.abort();
    operation.current = null;
  },[]);
  function patch(values) { setProject(prev => ({...prev,...values})); }
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
    if(disabled || workspaceOperation.current || operation.current)return;
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
    setEditFigureId(null);
    setReviewFigureId(null);
    setConceptRun(null);conceptAttempt.current=null;
    setRun(null);
    lastAttempt.current = null;
    setSelectedId(null);
    setConceptOpen(true);
    if (snapshotDetails.current) snapshotDetails.current.open = false;
    conceptScroll.current?.scrollTo({top:0});
    setBriefParent(null);
    setRefineOpen(false);
    setFeedback('');
    setEditedPrompt('');
    setRestartFrom('plan');
    setDragOver(false);
    setNotice('');
    if (fileInput.current) fileInput.current.value = '';
    dialog.current?.close();
    document.querySelector('.input-scroll')?.scrollTo({top:0});
    canvas.current?.scrollTo({top:0});
    fileInput.current?.focus();
  }
  function trackOperation(kind,id=null) {
    if (operation.current) return null;
    const current = {kind,id,projectId:project.projectId,controller:new AbortController(),marker:Symbol()};
    operation.current = current;
    setActiveKind(kind);
    setNotice('');
    return current;
  }
  function finishOperation(current) {
    if (operation.current !== current) return;
    operation.current = null;
    setActiveKind(null);
  }
  function clearPendingRun(current) {
    if (current.kind !== 'image' || !current.id) return;
    setProject(previous=>previous.projectId === current.projectId && previous.pendingRun?.id === current.id
      ? {...previous,pendingRun:null} : previous);
  }
  function cancelBackend(current) {
    cancelRun(current.id).catch(()=>{
      const update = current.kind === 'concept' ? setConceptRun : setRun;
      update(previous=>previous?.stopMarker === current.marker
        ? {...previous,message:'Stopped here. The server did not confirm cancellation.'} : previous);
    });
  }
  function acceptStartedRun(current,id) {
    current.id = id;
    if (current.stopped) cancelBackend(current);
    return operation.current === current;
  }
  function stopGeneration() {
    const current = operation.current;
    if (!current) return;
    current.stopped = true;
    current.controller.abort();
    finishOperation(current);
    clearPendingRun(current);
    const stopped = {status:'cancelled',message:'Generation stopped.',stopMarker:current.marker};
    if (current.kind === 'concept') {
      conceptAttempt.current = null;
      setConceptRun(stopped);
    } else {
      lastAttempt.current = null;
      setRun(stopped);
    }
    if (current.id) cancelBackend(current);
  }
  async function followConcept(attempt, current=trackOperation('concept',attempt.id)) {
    if (!current) return;
    setConceptRun(previous=>previous?.status === 'interrupted' ? {...previous,status:'queued'} : previous);
    try {
      const concept = await pollConceptRun(attempt.id,setConceptRun,undefined,undefined,current.controller.signal);
      if (operation.current !== current) return;
      setProject(prev => conceptSource(prev) === attempt.source ? {...prev,scientificConcept:concept,conceptSource:attempt.source} : prev);
    } catch(error) {
      if (operation.current === current && !(error instanceof RunStoppedError)) {
        setConceptRun(prev=>prev?.status==='failed'?prev:{...prev,status:'interrupted',message:error.message});
      }
    } finally {finishOperation(current);}
  }
  async function analyzeConcept() {
    if (disabled || !textModelReady || !project.paper.trim()) return;
    const current = trackOperation('concept');
    if (!current) return;
    layout.current?.revealPanel('concept',{scroll:false});
    setConceptOpen(true);
    conceptScroll.current?.scrollTo({top:0});
    conceptAttempt.current=null;
    setConceptRun({status:'queued',message:'Submitting your paper for concept generation…',steps:[]});
    const snapshot = inputSnapshot(project);
    try {
      const started = await startConceptRun(snapshot);
      if (!acceptStartedRun(current,started.id)) return;
      const attempt = {id:started.id,source:conceptSource(snapshot)};
      conceptAttempt.current=attempt;setConceptRun(started);
      await followConcept(attempt,current);
    } catch(error) {
      if (operation.current === current) setConceptRun({status:'failed',message:error.message,steps:[]});
    } finally {finishOperation(current);}
  }
  async function upload(file) {
    if (!file || disabled) return;
    setUploading(true); setNotice('');
    try { const paper = await readPaper(file); patch({paper,fileName:file.name}); }
    catch(error) { setNotice(error.name === 'PasswordException' ? 'This PDF is password-protected. Choose an unlocked PDF or paste its text.' : error.message); }
    finally { setUploading(false); if(fileInput.current) fileInput.current.value = ''; }
  }
  async function followRun(attempt, current=trackOperation('image',attempt.id)) {
    if (!current) return;
    lastAttempt.current=attempt;
    setRun(previous=>!previous || previous.status === 'interrupted' ? {...previous,status:'queued'} : previous);
    try {
      const result=await pollWorkflow(attempt.id,setRun,undefined,undefined,current.controller.signal);
      if (operation.current !== current) return;
      setProject(prev=>addVersion(prev,result,attempt.snapshot,attempt.options,attempt.id));
      setSelectedId(null);setRefineOpen(false);setFeedback('');
    } catch(error) {
      if (operation.current !== current) return;
      if (error instanceof RunStoppedError) {
        clearPendingRun(current);
      } else {
        const message=error.message==='Failed to fetch'?'Connection interrupted. Your versions are safe; reconnect to this run.':error.message;
        setRun(prev=>prev?.status==='failed'?prev:{...prev,status:'interrupted',message});
      }
    } finally {finishOperation(current);}
  }
  async function begin(snapshot,options={}) {
    if(operation.current||uploading)return;
    if(!session || session.expiresAt <= Date.now()){setSession(null);return;}
    options={...options,creator:{userId:session.userId,displayName:session.displayName}};
    const current = trackOperation('image');
    if (!current) return;
    lastAttempt.current = {snapshot,options};
    setRun({status:'queued',message:'Starting a new version…',steps:[],artifacts:{}});
    try {
      const started=await startWorkflow(snapshot,options);
      if (!acceptStartedRun(current,started.id)) return;
      const attempt={id:started.id,snapshot,options};
      lastAttempt.current=attempt;setRun(started);
      setProject(prev=>({...prev,pendingRun:attempt}));
      await followRun(attempt,current);
    } catch(error) {
      if (operation.current === current) setRun({status:'failed',message:error.message});
    } finally {finishOperation(current);}
  }
  function generate(event) {event?.preventDefault();if(disabled || !textModelReady || !imageModelReady || !conceptReady)return;begin(inputSnapshot(project),{parentId:briefParent});}
  function openRefine() {setEditedPrompt(selected.drawingBrief||'');setFeedback('');setRestartFrom('plan');setRefineOpen(true);}
  function restoreBrief() {
    const snapshot=selected.inputSnapshot;
    if(!snapshot){setNotice('This older version has no saved input snapshot. Use the current paper and brief to start a new version.');return;}
    patch(inputSnapshot({...project,...snapshot,scientificConcept:snapshot.scientificConcept || null,conceptSource:snapshot.conceptSource || ''}));
    setBriefParent(selected.id);
    setRefineOpen(false);
    layout.current?.revealPanel('paper',{scroll:false});
    setConceptOpen(true);
    conceptScroll.current?.scrollTo({top:0,behavior:'smooth'});
    document.querySelector('.input-scroll')?.scrollTo({top:0,behavior:'smooth'});
  }
  function refine() {
    const snapshot=inputSnapshot(selected.inputSnapshot || project);
    begin({...snapshot,textModel:project.textModel,imageModel:project.imageModel},{parentId:selected.id,feedback,restartFrom,drawingPrompt:editedPrompt});
  }
  function retryRun() {
    const previous=lastAttempt.current;if(!previous)return;
    const prompt=run?.artifacts?.drawingPrompt;
    begin(previous.snapshot,prompt?{...previous.options,restartFrom:'render',drawingPrompt:prompt,feedback:''}:previous.options);
  }
  function saveFigureEdit(draft,image) {
    if (!editingFigure) return;
    const edited = newFigureVersion(editingFigure,draft,image,session,images.length+1);
    setProject(previous=>({
      ...previous, canvasImages:[...previous.canvasImages,{...edited,variant:previous.canvasImages.length+1}],
      activeCanvasId:edited.id,
    }));
    setEditFigureId(null);
    selectSnapshot(edited.id,true);
  }
  return <WorkspaceColumns ref={layout} canvasRef={canvas} canvasBusy={busy} view={view} onWorkspace={()=>navigate('workspace')}
    page={<StudioTools key={project.projectId} view={view} projectName={project.projectName} status={collaboration.status}
      reviews={collaboration.reviews} userId={session.userId} onReview={setReviewFigureId}
      images={images} contributors={contributors} onBack={()=>{
        navigate('workspace');
        layout.current?.revealPanel('canvas',{focus:true,smooth:true});
      }} onInspect={id=>{navigate('workspace');selectSnapshot(id,true);}}/>}
    header={
    <header className="workspace-header">
      <div className="studio-brand">
        <span className="studio-brand-icon"><Icon name="research" size={20}/></span>
        {view === 'workspace' ? <h1>Research illustration</h1> : <p>Research illustration</p>}
      </div>
      <div className="studio-topbar-actions">
        <button type="button" className="new-project-button" onClick={openWorkspace} disabled={disabled} aria-label="Workspace"
          title={`Workspace · ${project.projectName}`} aria-haspopup="dialog" aria-controls="workspace-dialog">
          <Icon name="folder" size={15}/><span className="studio-topbar-label">Workspace</span>
        </button>
        <button type="button" className="new-project-button studio-mode-toggle" role="switch"
          aria-label="Dark mode" aria-checked={appearance.mode === 'dark'}
          title={appearance.mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={event=>changeAppearance({mode:appearance.mode === 'dark' ? 'light' : 'dark'},event.currentTarget)}>
          <Icon name={appearance.mode === 'dark' ? 'sun' : 'moon'} size={16}/>
        </button>
        <Collaboration project={project} setProject={setProject} session={session} setSession={setSession} disabled={disabled}
          status={collaboration.status} onJoin={switched=>{
            if (switched) resetProjectView();
            navigate('workspace');
          }} onCreateBoard={collaboration.createSharedBoard}/>
        <button type="button" className="new-project-button" onClick={()=>setSettingsOpen(true)} disabled={disabled}
          aria-label="Settings" title="Settings" aria-haspopup="dialog" aria-controls="settings-dialog">
          <Icon name="settings" size={15}/><span className="studio-topbar-label">Settings</span>
        </button>
      </div>
    </header>
    } paper={
        <div className="input-form">
          <div className="input-scroll">
          <fieldset disabled={disabled}>
            <div className="source-artifact-row"><div className="paper-source-card">
            <div className="input-section-label"><label htmlFor="paper-file">Source paper</label></div>
            <input id="paper-file" ref={fileInput} type="file" accept=".pdf,.txt,.md" className="file-input" onChange={e=>upload(e.target.files[0])}/>
            <div className={`upload-zone ${dragOver?'drag-over':''} ${project.paper?'has-paper':''}`} onDragOver={e=>{e.preventDefault();if(!disabled)setDragOver(true);}} onDragLeave={()=>setDragOver(false)} onDrop={e=>{e.preventDefault();setDragOver(false);upload(e.dataTransfer.files[0]);}}>
              <button type="button" className="upload-target" onClick={()=>fileInput.current?.click()}>
                <span className="upload-icon"><Icon name={project.paper?'file':'upload'} size={25}/></span>
                <strong>{uploading?'Reading your paper…':project.fileName || (project.paper?'Pasted paper text':'Drop your paper here')}</strong>
                <span>{project.paper ? `${project.paper.length.toLocaleString()} characters extracted · Click to replace` : 'or browse files · up to 15 MB'}</span>
              </button>
              {project.paper && <button type="button" className="remove-paper" onClick={()=>patch({paper:'',fileName:''})} aria-label="Remove attached paper">×</button>}
            </div>
            </div></div>
            <details className="paper-text"><summary>{project.paper?'Review extracted paper text':'Or paste paper text'}</summary><textarea aria-label="Paper text" value={project.paper} rows={7} onChange={e=>patch({paper:e.target.value,fileName:''})} placeholder="Paste an abstract or paper text…"/><p>Check PDF extraction, especially equations and columns.</p></details>
        {briefParent && <p className="branch-note">Editing the brief from a saved version. Generate will create a new version.<button onClick={()=>setBriefParent(null)} type="button">Start independently</button></p>}
            <details className="brief-fields foldable-options" open>
              <summary>Image direction <span>(style & purpose)</span></summary>
              <div className="fold-content">
                <label className="brief-field">Representation (abstract or realistic)<select value={project.visual.representation || ''} onChange={e=>patch({visual:{...project.visual,representation:e.target.value}})}><option value=""></option><option value="abstract">Abstract — symbolic forms and visual metaphors</option><option value="illustrated">Illustrated — recognizable subjects, simplified</option><option value="realistic">Realistic — lifelike subjects and materials</option></select></label>
                <label className="brief-field">Purpose (explain or provoke thought)<select value={project.visual.purpose || ''} onChange={e=>patch({visual:{...project.visual,purpose:e.target.value}})}><option value=""></option><option value="explain">Explain — communicate relationships and information</option><option value="evoke">Provoke thought — one memorable insight or question</option><option value="balance">Balance — clear information with a visual hook</option></select></label>
                <div className="brief-selects">
                  <label className="brief-field">Composition<select value={project.visual.layout || ''} onChange={e=>patch({visual:{...project.visual,layout:e.target.value}})}><option value=""></option><option value="stacked">Vertical sequence</option><option value="split">Side-by-side comparison</option><option value="central">Central scene</option></select></label>
                  <label className="brief-field">Text in image<select value={project.visual.density || ''} onChange={e=>patch({visual:{...project.visual,density:e.target.value}})}><option value=""></option><option value="editable">Editable labels</option><option value="minimal">Minimal labels</option><option value="balanced">Headline + key labels</option><option value="none">No text</option></select></label>
                </div>
              </div>
            </details>
            <details className="brief-fields foldable-options">
              <summary>Audience & constraints <span>(optional)</span></summary>
              <div className="fold-content">
                <label className="brief-field">Intended audience<textarea rows={1} maxLength={6000} value={project.audience || ''} placeholder="For example: researchers outside this field" onChange={e=>patch({audience:e.target.value})}/></label>
                <label className="brief-field">Facts & limits to preserve<textarea rows={2} maxLength={6000} value={project.preserve || ''} placeholder="Essential claims, uncertainty, or caveats" onChange={e=>patch({preserve:e.target.value})}/></label>
                <label className="brief-field">Elements to include or avoid<textarea rows={2} maxLength={6000} value={project.preferences || ''} placeholder="Additional visual constraints, if needed" onChange={e=>patch({preferences:e.target.value})}/></label>
              </div>
            </details>
          </fieldset>
        {notice && <div className="workspace-notice" role="alert">{notice}<button type="button" aria-label="Dismiss message" onClick={()=>setNotice('')}>×</button></div>}
        {saveStatus==='error' && <p className="workspace-notice" role="status">Version history could not be saved on this device. Download your images before closing this tab.</p>}
          </div>
          <div className="input-actions">
            <RunProgress kind="concept" run={conceptRun} busy={extracting}
              onRetry={analyzeConcept} onReconnect={conceptAttempt.current ? ()=>followConcept(conceptAttempt.current) : undefined}/>
            <GenerationButton busy={extracting} disabled={disabled || !textModelReady || !project.paper.trim()} onClick={analyzeConcept} onStop={stopGeneration}>
              {extracting ? 'Generating concept…' : project.scientificConcept ? 'Regenerate concept' : 'Generate concept'}
            </GenerationButton>
          </div>
        </div>
    } concept={
      <>
        <div className="concept-scroll" ref={conceptScroll}>
        <ConceptPanel project={project} run={conceptRun} extracting={extracting} disabled={disabled} onChange={concept=>patch({scientificConcept:concept})} open={conceptOpen} onOpenChange={setConceptOpen}/>
        {!project.scientificConcept && !extracting && <p className="concept-column-empty">Upload a paper and click Generate concept in the left column. Your editable concept will appear here.</p>}
        {selected && <details ref={snapshotDetails} className="review-snapshot review-disclosure">
          <summary><span className="review-disclosure-title">Selected snapshot</span><span className="review-disclosure-status">Version {images.indexOf(selected)+1}</span></summary>
          <div className="review-snapshot-body">
            <article className="image-card"><div className="image-card-bar"><div><button type="button" onClick={()=>dialog.current?.showModal()} aria-label="Expand image"><Icon name="expand" size={17}/></button><button type="button" onClick={()=>downloadImage(selected)}><Icon name="download" size={17}/><span>Download</span></button></div></div><button type="button" className="canvas-image" onClick={()=>dialog.current?.showModal()} aria-label="View generated image at full size"><img src={selected.image} alt={selectedReview?.altText || selected.figure?.altText || selected.groundingPlan?.subject || selected.userPrompt || 'Generated research illustration'}/></button></article>
            <div className="figure-snapshot-controls">
              <div className="figure-snapshot-actions" role="group" aria-label="Snapshot actions">
                <button type="button" className="secondary-action" aria-label="Edit figure" onClick={()=>setEditFigureId(selected.id)} disabled={disabled}>
                  Edit<span className="snapshot-action-detail"> figure</span>
                </button>
                <button type="button" className="secondary-action" aria-label={selectedReview ? 'Open review' : 'Request review'} onClick={()=>setReviewFigureId(selected.id)} disabled={disabled}>
                  <span className="snapshot-action-full">{selectedReview ? 'Open review' : 'Request review'}</span><span className="snapshot-action-short">Review</span>
                </button>
                <button type="button" className="secondary-action" aria-label="Refine this version" disabled={disabled} onClick={openRefine}>
                  Refine<span className="snapshot-action-detail"> version</span>
                </button>
                <button type="button" className="secondary-action" aria-label="Revisit concept & brief" disabled={disabled} onClick={restoreBrief}>Revisit</button>
              </div>
              <div className="figure-snapshot-meta">
                {selectedReview && <ReviewBadge status={selectedReview.status}/>}
                <p>{selected.revisionFeedback ? `Revision: ${selected.revisionFeedback}` : 'Initial direction'}</p>
              </div>
            </div>
            {refineOpen && <section className="refinement-card" aria-label="Refine selected version">
              <h3>Improve version {images.indexOf(selected)+1}</h3>
              <label className="brief-field">Where should we restart?<select disabled={busy} value={restartFrom} onChange={e=>setRestartFrom(e.target.value)}><option value="plan">Visual plan — rethink what to show</option><option value="render">Drawing prompt — adjust the image direction</option></select></label>
              <label className="brief-field">What should change?<textarea disabled={busy} maxLength={6000} rows={3} value={feedback} onChange={e=>setFeedback(e.target.value)} placeholder="For example: emphasize the relationship between the two ideas; simplify the background."/></label>
              {restartFrom==='render' && <label className="brief-field">Edit the drawing prompt (custom edits are not structure-validated)<textarea disabled={busy} rows={5} maxLength={32000} value={editedPrompt} onChange={e=>setEditedPrompt(e.target.value)}/></label>}
              <p>Creates a new image from this version’s saved instructions and your feedback. It does not edit the existing pixels. Earlier versions stay available.</p>
              {!selected.inputSnapshot && <p>This older version has no saved brief; refinement uses the current paper and input.</p>}
              <div className="refinement-buttons"><button type="button" className="generate-button" disabled={disabled || !imageModelReady || (restartFrom==='plan'&&!textModelReady) || (restartFrom==='render'&&!editedPrompt.trim())} onClick={refine}>Create next version <Icon name="arrow"/></button><button type="button" disabled={busy} onClick={()=>setRefineOpen(false)}>Cancel</button></div>
            </section>}
            <ConceptTrace item={selected}/>
            <p className="canvas-footnote">{selected.paperName ? `Source: ${selected.paperName}` : 'Prompt-led generation'} · {selected.providerNote || 'AI-generated image. Review before use.'}</p>
          </div>
        </details>}
        </div>
        <div className="input-actions concept-actions">
          {!conceptReady && <p className="concept-action-hint">{project.scientificConcept ? 'Complete all concept fields. If the paper changed, regenerate the concept on the left.' : 'Generate a concept to continue.'}</p>}
          <RunProgress run={run} busy={busy} onRetry={lastAttempt.current ? retryRun : undefined}
            onReconnect={lastAttempt.current?.id ? ()=>followRun(lastAttempt.current) : undefined}/>
          <GenerationButton busy={busy} disabled={disabled || !textModelReady || !imageModelReady || !conceptReady} onClick={generate} onStop={stopGeneration}>
            {busy ? 'Generating image…' : 'Generate image'}
          </GenerationButton>
        </div>
      </>
    } canvas={
      <>
        <SnapshotCanvas images={images} selectedId={selected?.id} contributors={contributors}
          onSelect={selectSnapshot} onMoveMany={collaboration.moveMany}/>
      </>
    }>
    {resetColumnWidths=><>
    <WorkspaceDialog open={workspaceOpen} project={project} projects={workspaceProjects} loading={workspaceLoading} working={workspaceBusy} error={workspaceError} onSave={saveCurrentProject} onCreate={(name,currentName)=>switchProject(null,currentName,name)} onOpen={(id,currentName)=>switchProject(id,currentName)} onClose={()=>setWorkspaceOpen(false)}/>
    <SettingsDialog open={settingsOpen} session={session} project={project} models={models} status={modelStatus} disabled={disabled}
      appearance={appearance} changeAppearance={changeAppearance}
      onSwitchAccount={()=>setSession(null)} onResetLayout={resetColumnWidths} onSelect={(field,value)=>patch({[field]:value})}
      onReload={()=>setModelAttempt(value=>value+1)} onClose={()=>setSettingsOpen(false)}/>
    {editingFigure && <FigureEditor key={editingFigure.id} snapshot={editingFigure} images={images}
      onSave={saveFigureEdit} onClose={()=>setEditFigureId(null)}/>}
    {reviewingFigure && <FigureReview key={reviewingFigure.id} snapshot={reviewingFigure} number={images.indexOf(reviewingFigure)+1}
      review={reviewBySnapshot.get(reviewingFigure.id)} board={project.sharedBoardId} members={collaboration.members} session={session}
      onCreateBoard={collaboration.createSharedBoard} onChangeReview={collaboration.changeReview} onClose={()=>setReviewFigureId(null)}/>}
    <dialog className="image-dialog" ref={dialog} onClick={e=>{if(e.target===e.currentTarget)dialog.current.close();}}><button className="dialog-close" type="button" onClick={()=>dialog.current.close()} aria-label="Close expanded image">×</button>{selected && <img src={selected.image} alt={selected.groundingPlan?.subject || selected.userPrompt || 'Generated illustration'}/>}</dialog>
    </>}
  </WorkspaceColumns>;
}
