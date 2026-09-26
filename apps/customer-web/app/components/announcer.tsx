/**
 * A live region that exists before it has anything to say.
 *
 * The rule a live region has to follow is that it must be in the document
 * *before* its content changes. One that is mounted at the same moment as the
 * words inside it is announced inconsistently: the browser has nothing to diff
 * against, and the behaviour differs between screen reader and browser pairs.
 * `Announcer` is mounted empty on the page's first render and written into
 * afterwards, which is the arrangement the specification actually guarantees.
 *
 * `ClubStatus` is the other shape — a `role="status"` that appears already
 * filled — and it is correct for the states it is used for, because those are
 * first-paint states that a screen reader reads in document order anyway. It is
 * not correct for a result that arrives *after* the customer did something, and
 * so the two cases are handled two different ways on purpose:
 *
 *   - A refusal or a half-finished action is promoted to `role="alert"`, which
 *     is announced on insertion. See the login and register status boxes.
 *   - A quiet result that needs a persistent region — a filter answering with a
 *     different set of rows — gets this.
 *
 * `message` therefore has to be information the visible page does not already
 * state. A visually hidden *copy* of a sentence the customer can see is read a
 * second time by anyone who browses the page after the announcement, which
 * undoes the fix: the row count in the history page is announced because
 * nothing on screen shows it, and a status that merely repeated the empty-state
 * text would not be.
 *
 * It reuses `club-sr-only`, so it is available to assistive technology and
 * invisible on screen, and it holds no height, so nothing on the page moves when
 * it appears. Nothing here ever unmounts, so a message cannot be removed before
 * it has had the chance to be read.
 */
export function Announcer({ message }: { message: string }) {
  return (
    <p className="club-sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </p>
  );
}
