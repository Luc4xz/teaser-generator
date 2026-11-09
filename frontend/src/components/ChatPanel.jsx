import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

export default function ChatPanel({
  messages,
  input,
  onInputChange,
  onSend,
  loading,
  loadingStartedAt,
  loadingPhases,
  generationIssue,
  error,
}) {
  const inputRef = useRef(null);
  const [liveNow, setLiveNow] = useState(Date.now());

  const quickPrompts = [
    {
      label: 'Chart',
      prompt: 'Create an interactive sales bar chart with axes, legend, and tooltips.',
    },
    {
      label: 'Online Search',
      prompt: 'Show the latest 7-day weather for Seattle.',
    },
    {
      label: 'Image',
      prompt: 'Generate an image of a red fox in an autumn forest.',
    },
    {
      label: 'Text',
      prompt:
        'Act as a Draft Coach. Analyze this draft and return one structured text artifact with key points, risks, and prioritized action items. Draft: We propose a campus tutoring platform that matches students with peer mentors using schedule and topic preferences. The first pilot includes math and programming courses for first-year students. We expect better course completion, but we have limited mentor training and no clear long-term evaluation plan.',
    },
    {
      label: 'Code',
      prompt:
        'Create a runnable JavaScript code (no external imports) with sample output.',
    },
  ];

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      onSend();
    }
  };

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const maxHeight = 220;
    el.style.height = 'auto';
    const nextHeight = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [input]);

  useEffect(() => {
    if (!loading) return undefined;
    const timer = window.setInterval(() => setLiveNow(Date.now()), 700);
    return () => window.clearInterval(timer);
  }, [loading]);

  const liveElapsed = useMemo(() => {
    if (!loadingStartedAt) return 0;
    return Math.max(0, liveNow - loadingStartedAt);
  }, [liveNow, loadingStartedAt]);

  const phaseText = useMemo(() => {
    const phases = Array.isArray(loadingPhases) && loadingPhases.length
      ? loadingPhases
      : ['Analyzing your request', 'Planning artifacts', 'Generating components', 'Polishing output'];
    const index = Math.floor(liveElapsed / 2600) % phases.length;
    return phases[index];
  }, [liveElapsed, loadingPhases]);

  const dotCount = useMemo(() => ((Math.floor(liveElapsed / 380) % 3) + 1), [liveElapsed]);
  const loadingText = `${phaseText}${'.'.repeat(dotCount)}`;
  const issueSuggestions = Array.isArray(generationIssue?.suggestions)
    ? generationIssue.suggestions.slice(0, 3)
    : [];
  const hasIssue = Boolean(error || generationIssue);
  const suggestionLabel = (prompt, index) => {
    const firstLine = String(prompt || '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean);
    if (!firstLine) return `Try prompt ${index + 1}`;
    return firstLine.length > 52 ? `${firstLine.slice(0, 52)}...` : firstLine;
  };

  return (
    <section className="panel chat-panel">
      <header className="panel-header">
        <div>
          <h2>Chat Studio</h2>
          <p>Describe the UI or visualization you want to render.</p>
        </div>
        <div className={`status ${loading ? 'busy' : hasIssue ? 'error' : 'ready'}`}>
          <span className="status-dot" />
          <span className="status-text">{loading ? loadingText : hasIssue ? 'Needs Prompt' : 'Ready'}</span>
        </div>
      </header>

      <div className="chat-quick">
        {quickPrompts.map((item) => (
          <button
            key={item.label}
            type="button"
            className="chip"
            onClick={() => onInputChange(item.prompt)}
            title={item.prompt}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="chat-messages">
        {messages.map((message, index) => (
          <div
            key={`${message.role}-${index}`}
            className={`chat-message ${message.role}`}
          >
            <div className="chat-bubble">
              <div className="chat-role">{message.role}</div>
              <div className="chat-content">{message.content}</div>
            </div>
          </div>
        ))}
        {loading && (
          <div className="chat-message assistant pending">
            <div className="chat-bubble chat-bubble-pending">
              <div className="chat-role">assistant</div>
              <div className="chat-content">{phaseText}</div>
              <div className="chat-live-indicator" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="chat-input">
        <textarea
          ref={inputRef}
          className="chat-input-textarea"
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe what you want to see…"
          rows={2}
        />
        <div className="chat-actions">
          <div className="chat-hint">Press Enter to send • Shift+Enter for a new line</div>
          <button type="button" onClick={onSend} disabled={loading || !input.trim()}>
            {loading ? 'Working…' : 'Send'}
          </button>
        </div>
        {!loading && generationIssue && (
          <div className="chat-guidance" role="status" aria-live="polite">
            <div className="chat-guidance-title">No new canvas output generated</div>
            {generationIssue.caseLabel && (
              <div className="chat-guidance-case">Case: {generationIssue.caseLabel}</div>
            )}
            <p className="chat-guidance-text">{generationIssue.message}</p>
            {!!issueSuggestions.length && (
              <div className="chat-guidance-actions">
                {issueSuggestions.map((suggestion, index) => (
                  <button
                    key={`${index}-${suggestion.slice(0, 28)}`}
                    type="button"
                    className="chat-guidance-chip"
                    onClick={() => onInputChange(suggestion)}
                    title={suggestion}
                  >
                    {suggestionLabel(suggestion, index)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {error && <div className="chat-error">{error}</div>}
      </div>
    </section>
  );
}
