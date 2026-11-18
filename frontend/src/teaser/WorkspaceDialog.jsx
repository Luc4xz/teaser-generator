import React, {useLayoutEffect,useRef,useState} from 'react';
import StudioDialog from './StudioDialog.jsx';

export default function WorkspaceDialog({open,project,projects,loading,working,error,onSave,onCreate,onOpen,onClose}) {
  const wasOpen=useRef(false);
  const [name,setName]=useState(project.projectName);
  const [newName,setNewName]=useState('');
  const [query,setQuery]=useState('');
  const [saved,setSaved]=useState(false);
  useLayoutEffect(()=>{
    if (open && !wasOpen.current) {
      setName(project.projectName);
      setNewName('');
      setQuery('');
      setSaved(false);
    }
    wasOpen.current=open;
  },[open,project.projectName]);
  const items=projects.filter(item=>`${item.name} ${item.fileName}`.toLowerCase().includes(query.toLowerCase()));
  return <StudioDialog id="workspace-dialog" open={open} title="Workspace" description="Your projects, saved on this browser and device." working={working} onClose={onClose}>
      <section className="workspace-current"><label htmlFor="workspace-project-name">Current project</label><form onSubmit={async event=>{event.preventDefault();setSaved(false);if(await onSave(name))setSaved(true);}}><input id="workspace-project-name" value={name} onChange={event=>{setName(event.target.value);setSaved(false);}} maxLength={100} disabled={working} required/><button className="secondary-action" disabled={working || !name.trim()} type="submit">Save project</button></form><p role="status">{saved?'Project saved.':'Changes autosave. Your paper, concept, settings, and image versions stay together.'}</p></section>
      <section className="workspace-create"><form onSubmit={event=>{event.preventDefault();onCreate(newName,name);}}><input aria-label="New project name" placeholder="Name a new project" maxLength={100} value={newName} onChange={event=>setNewName(event.target.value)} disabled={working}/><button type="submit" className="secondary-action" disabled={working}>+ New project</button></form><p>Your current project is saved before switching.</p></section>
      {error && <p className="workspace-manager-error" role="alert">{error}</p>}
      <div className="workspace-list-heading"><h3>Saved projects <span>{projects.length}</span></h3><input type="search" aria-label="Search saved projects" placeholder="Search projects" value={query} onChange={event=>setQuery(event.target.value)}/></div>
      {loading ? <p role="status">Loading projects…</p> : <ul className="workspace-project-list">{items.map(item=><li key={item.id}><div className="workspace-project-info"><strong>{item.name}</strong><p>{item.fileName || 'No paper yet'} · {item.versionCount} image {item.versionCount===1?'version':'versions'}{item.hasConcept ? ' · Concept saved' : ''}</p><time dateTime={item.updatedAt}>Saved {new Date(item.updatedAt).toLocaleString()}</time></div>{item.id===project.projectId ? <span className="workspace-current-badge">Current</span> : <button type="button" className="secondary-action" disabled={working} onClick={()=>onOpen(item.id,name)}>Open</button>}</li>)}</ul>}
      {!loading&&!items.length&&<p className="workspace-list-empty">{query?'No matching projects.':'Save your first project to see it here.'}</p>}
  </StudioDialog>;
}
