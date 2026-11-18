import React, { useState } from 'react';
import StudioDialog from './StudioDialog.jsx';
import { copyBoardInvite } from './Collaboration.jsx';
import { downloadApprovedFigure, figureLayerName, MAX_ALT_LENGTH, MAX_CAPTION_LENGTH, REVIEW_STATUS_LABEL } from './figure.js';

export function ReviewBadge({status}) {
  return <span className="figure-review-badge" data-status={status || 'draft'}>{REVIEW_STATUS_LABEL[status] || 'Draft'}</span>;
}

export default function FigureReview({
  snapshot, number, review, board, members, session, onCreateBoard, onChangeReview, onClose,
}) {
  const [reviewer,setReviewer] = useState('');
  const [caption,setCaption] = useState(typeof snapshot.figure?.caption === 'string' ? snapshot.figure.caption : '');
  const [altText,setAltText] = useState(typeof snapshot.figure?.altText === 'string' ? snapshot.figure.altText : '');
  const [message,setMessage] = useState('');
  const [working,setWorking] = useState(false);
  const [status,setStatus] = useState('');
  const [error,setError] = useState('');
  const author = snapshot.creator?.userId === session.userId;
  const isReviewer = review?.reviewerId === session.userId;
  const canComment = review?.status === 'pending' && (isReviewer || review.authorId === session.userId);
  const candidates = members.filter(member=>member.id !== session.userId);
  const references = (Array.isArray(snapshot.figure?.layers) ? snapshot.figure.layers : [])
    .filter(layer=>typeof layer?.reference === 'string' && layer.reference.trim());

  async function perform(action, done) {
    if (working) return;
    setWorking(true);
    setStatus('');
    setError('');
    try {
      await action();
      if (done) done();
    } catch (failure) { setError(failure.message || 'Could not update the review.'); }
    finally { setWorking(false); }
  }

  function submitRequest(event) {
    event.preventDefault();
    if (!reviewer || !caption.trim() || !altText.trim()) return;
    perform(()=>onChangeReview(snapshot,'',{reviewer_id:reviewer,caption:caption.trim(),alt_text:altText.trim()}));
  }
  function sendComment() {
    if (!message.trim()) return;
    perform(()=>onChangeReview(snapshot,'/comments',{message:message.trim()}),()=>setMessage(''));
  }
  function decide(decision) {
    perform(()=>onChangeReview(snapshot,'/decision',{decision,message:message.trim()}),()=>setMessage(''));
  }

  return <StudioDialog id="figure-review" open title={review ? 'Figure review' : 'Request review'}
    description={`Version ${number}`} onClose={onClose} working={working} className="figure-review-dialog">
    <div className="figure-review-preview"><img src={snapshot.image}
      alt={review?.altText || snapshot.figure?.altText || 'Selected figure'}/></div>
    {references.length > 0 && <details className="figure-review-references">
      <summary>Paper references</summary>
      <ul>{references.map((layer,index)=><li key={layer.id || index}>
        <strong>{figureLayerName(layer)}</strong> · {layer.reference}
      </li>)}</ul>
    </details>}
    {review ? <>
      <div className="figure-review-heading">
        <ReviewBadge status={review.status}/>
        <p>Reviewer: {review.reviewerName}</p>
      </div>
      <dl className="figure-reviewed-text">
        <dt>Caption</dt><dd>{review.caption}</dd>
        <dt>Alt text</dt><dd>{review.altText}</dd>
      </dl>
      {review.comments.length > 0 && <ul className="figure-review-comments" aria-label="Review comments">{review.comments.map(comment=>
        <li key={comment.id}><strong>{comment.authorName}</strong>
          <time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time><p>{comment.text}</p>
        </li>)}</ul>}
      {canComment && <>
        <label className="figure-review-comment">Review comment<textarea rows={3} maxLength={2000} disabled={working}
          value={message} onChange={event=>setMessage(event.target.value)}/></label>
        <div className="figure-dialog-actions">
          <button type="button" className="secondary-action" disabled={working || !message.trim()} onClick={sendComment}>Post comment</button>
          {isReviewer && <>
            <button type="button" className="secondary-action" disabled={working} onClick={()=>decide('changes_requested')}>Request changes</button>
            <button type="button" className="figure-primary-action" disabled={working} onClick={()=>decide('approved')}>Approve version</button>
          </>}
        </div>
      </>}
      {review.status === 'approved' && <div className="figure-dialog-actions">
        <button type="button" className="figure-primary-action" disabled={working}
          onClick={()=>perform(()=>downloadApprovedFigure(snapshot,review),()=>setStatus('Approved figure downloaded.'))}>Export approved figure</button>
      </div>}
    </> : !author ? <p className="studio-tool-empty">Save an edited version as your own snapshot before requesting review.</p> :
      !board ? <div className="figure-review-invite">
        <p>Create a shared board, then invite a coauthor to review this version.</p>
        <button type="button" className="figure-primary-action" disabled={working} onClick={()=>perform(onCreateBoard)}>Create shared board</button>
      </div> : <>
        <div className="figure-review-invite">
          {!candidates.length && <p>Invite a coauthor. They’ll appear in the reviewer list after opening the board.</p>}
          <button type="button" className="secondary-action" disabled={working}
            onClick={()=>perform(()=>copyBoardInvite(board),()=>setStatus('Invite link copied.'))}>Copy invite link</button>
        </div>
        <form className="figure-review-form" onSubmit={submitRequest}>
          <label>Reviewer<select value={reviewer} required disabled={working || !candidates.length} onChange={event=>setReviewer(event.target.value)}>
            <option value="">Choose a coauthor</option>
            {candidates.map(member=><option key={member.id} value={member.id}>{member.name}</option>)}
          </select></label>
          <label>Caption<textarea rows={2} value={caption} required disabled={working} maxLength={MAX_CAPTION_LENGTH}
            onChange={event=>setCaption(event.target.value)}/></label>
          <label>Alt text<textarea rows={2} value={altText} required disabled={working} maxLength={MAX_ALT_LENGTH}
            onChange={event=>setAltText(event.target.value)}/></label>
          <div className="figure-dialog-actions">
            <button type="submit" className="figure-primary-action" disabled={working || !reviewer || !caption.trim() || !altText.trim()}>Send review request</button>
          </div>
        </form>
      </>}
    {status && <p className="figure-review-message" role="status">{status}</p>}
    {error && <p className="workspace-manager-error" role="alert">{error}</p>}
  </StudioDialog>;
}
