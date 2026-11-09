// Images exceed localStorage quickly. IndexedDB keeps version history across reloads.
let connection;
function database() {
  if(!connection) connection=new Promise((resolve,reject)=>{
    const request=indexedDB.open('research-illustration',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('workspace');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
  return connection;
}
export async function loadWorkspace() {
  const db=await database();
  return new Promise((resolve,reject)=>{
    const request=db.transaction('workspace').objectStore('workspace').get('current');
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
}
export async function saveWorkspace(project) {
  const db=await database();
  return new Promise((resolve,reject)=>{
    const transaction=db.transaction('workspace','readwrite');
    transaction.objectStore('workspace').put(project,'current');
    transaction.oncomplete=()=>resolve();transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error);
  });
}
