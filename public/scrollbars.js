// scrollbars.js -- reveal a scrollbar while its surface is being scrolled,
// hide it again once that surface goes quiet. The visual half lives in
// style.css's ui-scrollbars block; this file only owns the `.is-scrolling`
// class that block keys off.
//
// Why any JS at all: CSS can express "show on hover" but has no selector for
// "is currently scrolling". VSCode's behaviour -- the thumb appears the
// instant the wheel moves, whether or not the pointer is over the pane, and
// goes away a beat after you stop -- needs the scroll event.

// How long a surface keeps its scrollbar after the last scroll event.
//
// Momentum scrolling on a trackpad keeps emitting events for a while after
// the fingers lift, so anything under roughly half a second flickers the
// thumb off and back on mid-glide. Much longer and it stops reading as a
// response to scrolling at all -- it just looks like a scrollbar that is
// sometimes there. 700ms clears the momentum tail and still feels tied to
// the gesture.
const IDLE_MS = 700;

// Element -> pending hide timer. WeakMap rather than a Map so a scroll
// container torn down by a re-render (the change-point pane replaces its
// whole subtree on every /api/diff) is not held alive by this file. A stale
// timer on a detached node is harmless: it fires, removes a class from an
// element nobody can see, and drops.
const hideTimers = new WeakMap();

// Scroll does not bubble, so a listener on document only sees these events in
// the capture phase. That one capturing listener is also why nothing here has
// to know which elements scroll: #tree-pane, #main-pane, every .diff-side,
// and any scrollable UI added later are all covered without registering
// anything. The alternative -- a listener per scroll container -- would need
// re-attaching after each re-render of the change-point pane.
document.addEventListener(
  'scroll',
  (event) => {
    const el = event.target;

    // A scroll of the document itself arrives with `document` as the target,
    // which has no classList. The app's panes are all element-level
    // scrollers so this is mostly defensive, but a stray document scroll
    // would otherwise throw on every wheel tick.
    if (!(el instanceof Element)) return;

    el.classList.add('is-scrolling');

    const pending = hideTimers.get(el);
    if (pending !== undefined) clearTimeout(pending);

    hideTimers.set(
      el,
      setTimeout(() => {
        el.classList.remove('is-scrolling');
        hideTimers.delete(el);
      }, IDLE_MS),
    );
  },
  // capture is required (scroll does not bubble). passive says this handler
  // never calls preventDefault, which lets the browser start scrolling
  // without waiting to find out.
  { capture: true, passive: true },
);
