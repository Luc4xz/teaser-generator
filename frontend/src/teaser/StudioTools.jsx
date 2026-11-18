import React, { useEffect, useRef, useState } from 'react';
import Icon from './StudioIcon.jsx';
import { ReviewBadge } from './FigureReview.jsx';
import { studioHref } from './studio-navigation.js';

export function boardContributors(images, session) {
  const contributors = new Map();
  if (session) {
    contributors.set(session.userId, {
      id:session.userId, name:session.displayName || session.username || 'You', current:true, versions:[],
    });
  }
  images.forEach((image,index)=>{
    const id = image.creator?.userId || 'legacy';
    if (!contributors.has(id)) {
      contributors.set(id,{id,name:image.creator?.displayName || 'Unknown contributor',versions:[]});
    }
    contributors.get(id).versions.push({id:image.id,number:index+1});
  });
  return [...contributors.values()];
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0,2).map(part=>Array.from(part)[0]).join('').toLocaleUpperCase() || '?';
}

export function ContributorAvatar({person}) {
  const palette = Array.from(String(person.id)).reduce((sum,character)=>sum+character.codePointAt(0),0)%5;
  return <span className={`studio-avatar avatar-tone-${palette}`} aria-hidden="true">{initials(person.name)}</span>;
}

export function CanvasAvatars({contributors}) {
  const people = contributors.filter(person=>person.id !== 'legacy');
  if (!people.length) return null;
  const overflow = people.length - 5;
  const names = people.map(person=>person.current ? `${person.name} (you)` : person.name).join(', ');
  return <a className="canvas-avatars" href={studioHref('controlCenter')} title={names}
    aria-label={`Collaborator contributions: ${names}`}>
    {people.slice(0,5).map(person=><ContributorAvatar key={person.id} person={person}/>)}
    {overflow > 0 && <span className="studio-avatar avatar-overflow" aria-hidden="true">+{overflow}</span>}
  </a>;
}

export default function StudioTools({view, projectName, status, images, contributors, reviews=[], userId, onReview, onBack, onInspect}) {
  const [draft,setDraft] = useState('');
  const [messages,setMessages] = useState([]);
  const [contributor,setContributor] = useState('');
  const page = useRef(null);
  const heading = useRef(null);
  const historyHeading = useRef(null);
  const chatLog = useRef(null);

  useEffect(()=>{
    if (view === 'workspace') return;
    page.current?.scrollTo({top:0});
    const target = view === 'history' ? historyHeading.current : heading.current;
    if (view === 'history') target?.scrollIntoView({block:'nearest'});
    target?.focus({preventScroll:true});
  },[view]);

  useEffect(()=>{
    if (view === 'chat' && chatLog.current) chatLog.current.scrollTop = chatLog.current.scrollHeight;
  },[messages,view]);

  if (view === 'workspace') return null;
  const isChat = view === 'chat';
  const title = isChat ? 'AI Chat' : 'Control Center';
  const numbers = new Map(images.map((item,index)=>[item.id,index+1]));
  const reviewById = new Map(reviews.map(review=>[review.snapshotId,review]));
  const reviewEntries = reviews.filter(review=>numbers.has(review.snapshotId)).sort((left,right)=>{
    const assigned = review=>review.reviewerId === userId && review.status === 'pending';
    return Number(assigned(right))-Number(assigned(left));
  });
  const history = [...images].reverse().sort((left,right)=>(Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0));
  const contributingPeople = contributors.filter(person=>person.versions.length);
  const filter = contributingPeople.some(person=>person.id === contributor) ? contributor : '';
  const entries = filter ? history.filter(item=>(item.creator?.userId || 'legacy') === filter) : history;

  function send(event) {
    event.preventDefault();
    const message = draft.trim();
    if (!message) return;
    setMessages(previous=>[...previous,message]);
    setDraft('');
  }

  return <main key={isChat ? 'chat' : 'control-center'} className="studio-page" ref={page} aria-labelledby="studio-page-title">
    <div className="studio-page-shell">
      <header className="studio-page-header">
        <div>
          <p className="studio-page-project">{projectName}</p>
          <h1 id="studio-page-title" ref={heading} tabIndex={-1}>{title}</h1>
          {isChat ? <p className="studio-page-description">Draft messages about your paper or image. This preview does not generate replies.</p> :
            status && <p className="studio-page-description" role="status">{status}</p>}
        </div>
        <a className="new-project-button studio-return-link" href={studioHref('workspace')} onClick={event=>{
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onBack();
        }}><Icon name="arrow" size={14}/> Back to canvas</a>
      </header>
      {isChat ? <section className="studio-page-card studio-chat-page" aria-label="Chat preview">
        <div className="studio-chat-log" ref={chatLog} role="log" aria-label="Chat messages">
          {messages.length ? messages.map((message,index)=><p className="studio-chat-message" key={index}>{message}</p>) :
            <p className="studio-tool-empty">Try drafting a question about your paper or image.</p>}
        </div>
        <form className="studio-chat-form" onSubmit={send}>
          <textarea aria-label="Chat message" placeholder="Write a message…" rows={2} maxLength={4000} value={draft}
            onChange={event=>setDraft(event.target.value)}/>
          <button type="submit" className="secondary-action" disabled={!draft.trim()}><Icon name="send" size={15}/> Send</button>
        </form>
      </section> : <>
        <dl className="studio-page-metrics">
          <div><dt>Contributors</dt><dd>{contributingPeople.filter(person=>person.id !== 'legacy').length}</dd></div>
          <div><dt>Saved versions</dt><dd>{images.length}</dd></div>
          <div><dt>Refinements</dt><dd>{images.filter(item=>item.parentVersionId).length}</dd></div>
        </dl>
        <section className="studio-page-card figure-review-queue" aria-labelledby="studio-reviews-title">
          <h2 id="studio-reviews-title">Figure reviews</h2>
          {reviewEntries.length ? <ul className="studio-activity-list">{reviewEntries.map(review=>
            <li key={review.snapshotId}>
              <div className="studio-activity-info">
                <strong>Version {numbers.get(review.snapshotId)}</strong>
                <p>{review.reviewerId === userId && review.status === 'pending' ? 'Assigned to you' : `Reviewer: ${review.reviewerName}`}</p>
              </div>
              <ReviewBadge status={review.status}/>
              <button className="secondary-action" type="button" onClick={()=>onReview(review.snapshotId)}>Open review</button>
            </li>)}</ul> : <p className="studio-tool-empty">Review requests appear here when you send a version to a coauthor.</p>}
        </section>
        <div className="studio-dashboard">
          <section className="studio-page-card" aria-labelledby="studio-contributions-title">
            <h2 id="studio-contributions-title">Collaborator contributions</h2>
            <ul className="studio-activity-list">{contributors.map(person=>{
              const latest = person.versions.at(-1);
              const count = person.versions.length;
              return <li key={person.id}>
                <ContributorAvatar person={person}/>
                <div className="studio-activity-info">
                  <strong>{person.name}{person.current && ' (you)'}</strong>
                  <p>{count} {count === 1 ? 'snapshot' : 'snapshots'}</p>
                </div>
                {latest && <button type="button" className="secondary-action" onClick={()=>onInspect(latest.id)}>View latest</button>}
              </li>;
            })}</ul>
          </section>
          <section className="studio-page-card" aria-labelledby="studio-history-title">
            <div className="studio-page-card-header">
              <h2 id="studio-history-title" ref={historyHeading} tabIndex={-1}>Modification history</h2>
              {contributingPeople.length > 1 && <label className="studio-history-filter">
                <span>Contributor</span>
                <select value={filter} onChange={event=>setContributor(event.target.value)}>
                  <option value="">Everyone</option>
                  {contributingPeople.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}
                </select>
              </label>}
            </div>
            {!entries.length ? <p className="studio-tool-empty">Saved versions will appear here after you generate an image.</p> :
              <ol className="studio-activity-list">{entries.map(item=>{
                const parent = numbers.get(item.parentVersionId);
                return <li key={item.id}>
                  {item.image ? <img className="studio-history-thumbnail" src={item.image} loading="lazy" alt=""/> :
                    <div className="studio-history-icon"><Icon name={item.parentVersionId ? 'history' : 'image'} size={17}/></div>}
                  <div className="studio-activity-info">
                    <strong>Version {numbers.get(item.id)} · {item.versionKind === 'figure_edit'
                      ? parent ? `Edited version ${parent}` : 'Edited figure'
                      : item.parentVersionId ? parent ? `Refined version ${parent}` : 'Refined snapshot' : 'Original snapshot'}</strong>
                    <p>{item.creator?.displayName || 'Unknown contributor'}{item.createdAt && <> · <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></>}</p>
                    {item.revisionFeedback && <p>{item.revisionFeedback}</p>}
                    {reviewById.has(item.id) && <p><ReviewBadge status={reviewById.get(item.id).status}/></p>}
                  </div>
                  <button type="button" className="secondary-action" onClick={()=>onInspect(item.id)}>Inspect</button>
                </li>;
              })}</ol>}
          </section>
        </div>
      </>}
    </div>
  </main>;
}
