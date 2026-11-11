// Full projects stay in IndexedDB; the catalog contains lightweight summaries only.
import { identifyProject, projectSummary } from './projects.js';
let connection;
function database() {
  if(!connection) connection=new Promise((resolve,reject)=>{
    const request=indexedDB.open('research-illustration',2);
    request.onupgradeneeded=()=>{
      const db=request.result;
      for(const name of ['workspace','projects','projectIndex']) {
        if(!db.objectStoreNames.contains(name))db.createObjectStore(name);
      }
      // Preserve the single-workspace format when upgrading existing users.
      const transaction=request.transaction;
      const old=transaction.objectStore('workspace').get('current');
      old.onsuccess=()=>{
        if(!old.result)return;
        const project=identifyProject(old.result);
        const updatedAt=project.updatedAt || new Date().toISOString();
        transaction.objectStore('workspace').put(project,'current');
        transaction.objectStore('projects').put(project,project.projectId);
        transaction.objectStore('projectIndex').put(projectSummary(project,updatedAt),project.projectId);
      };
    };
    request.onsuccess=()=>{
      const db=request.result;
      db.onversionchange=()=>{db.close();connection=null;};
      resolve(db);
    };
    request.onerror=()=>{connection=null;reject(request.error);};
    request.onblocked=()=>{connection=null;reject(new Error('Close other tabs of this app, then reopen Workspace to finish upgrading project storage.'));};
  });
  return connection;
}
function completed(transaction) {
  return new Promise((resolve,reject)=>{
    transaction.oncomplete=()=>resolve();
    transaction.onerror=()=>reject(transaction.error);
    transaction.onabort=()=>reject(transaction.error || new Error('Project save was interrupted.'));
  });
}
function writeProject(transaction, project) {
  const saved={...project,updatedAt:new Date().toISOString()};
  transaction.objectStore('projects').put(saved,project.projectId);
  transaction.objectStore('projectIndex').put(projectSummary(saved,saved.updatedAt),project.projectId);
  return saved;
}
export async function loadWorkspace() {
  const db=await database();
  return new Promise((resolve,reject)=>{
    const request=db.transaction('workspace').objectStore('workspace').get('current');
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
}
export async function saveWorkspace(project) {
  if(!project.projectId)throw new Error('Project identity is missing. Reopen the workspace.');
  const db=await database();
  const transaction=db.transaction(['workspace','projects','projectIndex'],'readwrite');
  const done=completed(transaction);
  transaction.objectStore('workspace').put(writeProject(transaction,project),'current');
  await done;
}
export async function listProjects() {
  const db=await database();
  return new Promise((resolve,reject)=>{
    const request=db.transaction('projectIndex').objectStore('projectIndex').getAll();
    request.onsuccess=()=>resolve(request.result.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)));
    request.onerror=()=>reject(request.error);
  });
}
export async function loadProject(id) {
  const db=await database();
  return new Promise((resolve,reject)=>{
    const request=db.transaction('projects').objectStore('projects').get(id);
    request.onsuccess=()=>request.result ? resolve(request.result) : reject(new Error('This project could not be found. Refresh the workspace and try again.'));
    request.onerror=()=>reject(request.error);
  });
}
export async function activateProject(current, next) {
  const db=await database();
  const transaction=db.transaction(['workspace','projects','projectIndex'],'readwrite');
  const done=completed(transaction);
  // Save the outgoing project and activate the incoming one in a single transaction.
  writeProject(transaction,current);
  transaction.objectStore('workspace').put(writeProject(transaction,next),'current');
  await done;
}
