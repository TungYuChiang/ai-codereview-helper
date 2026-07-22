// export.js -- two clipboard-only exports (never writes a file). Split out
// of app.js as a pure move (see state.js's header comment).
//
// Buttons live in the top bar, appended after the stats badge (whose
// margin-left: auto already pushes everything from that point on to the
// right edge -- see style.css). navigator.clipboard.writeText() is tried
// first; if it throws (permission denied, insecure context, or simply
// unavailable) a fallback panel with a select-all-able textarea is shown
// instead, with the reason.

import { appState, createEl, topbarEl, appEl, bodyEl } from './state.js';
import { api, clearError, showError } from './api.js';

// -- Wording ---------------------------------------------------------------
// "複製", not "匯出": these buttons write to the clipboard and never touch the
// filesystem. The spec settled that deliberately ("都複製到剪貼簿，不寫檔"),
// so "匯出" was promising a file that never arrives.
//
// "Comment" / "Note", not "疑問" / "筆記": the buttons that *create* these are
// labelled "+ Comment" and "+ Note", and one concept should not carry two
// vocabularies depending on which end of it you are looking at. It also drops
// a claim that was simply untrue -- "疑問" asserts every entry is a question,
// but a comment is just as often a suggestion.
//
// Still short, for the original reason: full labels were the single biggest
// contributor to the top bar wrapping onto a second row once repo/branch
// names got realistically long. Visible text is trimmed, `title` holds the
// long form for hover, and `aria-label` carries it as the accessible name so
// screen readers lose nothing.
const exportGroupEl = createEl('div', { className: 'topbar-group export-group' });
const exportClaudeBtnEl = createEl('button', { className: 'export-btn', text: '複製 Comment' });
exportClaudeBtnEl.type = 'button';
exportClaudeBtnEl.title = '複製我的 Comment（給 Claude）';
exportClaudeBtnEl.setAttribute('aria-label', '複製我的 Comment（給 Claude）');
const exportMarkdownBtnEl = createEl('button', { className: 'export-btn', text: '複製 Note' });
exportMarkdownBtnEl.type = 'button';
exportMarkdownBtnEl.title = '複製筆記（Markdown，含 Comment 與 Note）';
exportMarkdownBtnEl.setAttribute('aria-label', '複製筆記（Markdown，含 Comment 與 Note）');
exportGroupEl.append(exportClaudeBtnEl, exportMarkdownBtnEl);
topbarEl.appendChild(exportGroupEl);

exportClaudeBtnEl.addEventListener('click', () => handleExportClick('claude', exportClaudeBtnEl));
exportMarkdownBtnEl.addEventListener('click', () => handleExportClick('markdown', exportMarkdownBtnEl));

async function handleExportClick(format, btnEl) {
  if (!appState.repo || !appState.base || !appState.target) return;
  clearError();

  let text;
  try {
    text = await api.exportReview(appState.repo, appState.base, appState.target, format);
  } catch (err) {
    showError(err.message);
    return;
  }

  await copyToClipboardWithFeedback(text, btnEl);
}

async function copyToClipboardWithFeedback(text, btnEl) {
  const originalText = btnEl.textContent;
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      throw new Error('clipboard API not available in this browser context');
    }
    await navigator.clipboard.writeText(text);
    hideClipboardFallback();
    btnEl.textContent = '已複製';
    btnEl.classList.add('copied');
    btnEl.disabled = true;
    setTimeout(() => {
      btnEl.textContent = originalText;
      btnEl.classList.remove('copied');
      btnEl.disabled = false;
    }, 1600);
  } catch (err) {
    showClipboardFallback(text, err);
  }
}

let clipboardFallbackEl = null;

function ensureClipboardFallbackEl() {
  if (clipboardFallbackEl) return clipboardFallbackEl;
  clipboardFallbackEl = createEl('div', { className: 'clipboard-fallback' });
  clipboardFallbackEl.hidden = true;
  // Same band as #error-banner -- inserted right before #body so it reads
  // as a persistent, full-width notice rather than a floating overlay.
  appEl.insertBefore(clipboardFallbackEl, bodyEl);
  return clipboardFallbackEl;
}

function showClipboardFallback(text, err) {
  const el = ensureClipboardFallbackEl();
  el.textContent = '';
  el.hidden = false;

  const reason = err && err.message ? err.message : 'clipboard access was blocked';
  el.appendChild(
    createEl('p', {
      className: 'clipboard-fallback-reason',
      text: `Couldn't copy to the clipboard automatically (${reason}). Select all and copy manually:`,
    }),
  );

  const textarea = document.createElement('textarea');
  textarea.className = 'clipboard-fallback-textarea';
  textarea.readOnly = true;
  textarea.rows = 8;
  textarea.value = text;
  el.appendChild(textarea);

  const closeBtn = createEl('button', { className: 'comment-btn', text: 'Close' });
  closeBtn.type = 'button';
  closeBtn.addEventListener('click', hideClipboardFallback);
  el.appendChild(closeBtn);

  textarea.focus();
  textarea.select();
}

function hideClipboardFallback() {
  if (clipboardFallbackEl) clipboardFallbackEl.hidden = true;
}
