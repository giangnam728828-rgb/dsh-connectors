/**
 * A cheap "the vault changed" signal for the native panel.
 *
 * The panel can only refresh when something writes `vault.json`: a connect from
 * the web settings page, `dsh-connectors add`, or another process. `fs.watch`
 * is the obvious choice but it is not available on every filesystem the app
 * runs on, and the vault file may not exist yet on a fresh install. `watchFile`
 * polls one stat per interval, works for a missing file, and never keeps the
 * process alive — the right trade for a screen that is usually closed.
 *
 * Callers get a plain callback and an unsubscribe function; the interval is
 * short enough to feel immediate and long enough to cost nothing.
 */
import { unwatchFile, watchFile } from 'node:fs';

/**
 * Watch one file for changes.
 *
 * @param file - absolute path, may not exist yet.
 * @param onChange - called at most once per quiet period.
 * @param options - `interval` in milliseconds, `settle` debounce in milliseconds.
 * @returns an unsubscribe function; safe to call more than once.
 */
export function watchFileChanges(file, onChange, options = {}) {
  const interval = Number.isInteger(options.interval) && options.interval > 0 ? options.interval : 2000;
  const settle = Number.isInteger(options.settle) && options.settle >= 0 ? options.settle : 150;

  let timer;
  let closed = false;

  /** @param curr - the new stat. @param prev - the previous stat. */
  const listener = (curr, prev) => {
    if (closed) return;
    // watchFile fires once on subscribe; only a real change should refresh.
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size && curr.ino === prev.ino) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed) onChange();
    }, settle);
    if (typeof timer.unref === 'function') timer.unref();
  };

  try {
    watchFile(file, { persistent: false, interval }, listener);
  } catch {
    return () => {};
  }

  return () => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    try {
      unwatchFile(file, listener);
    } catch {
      // The process is going away; nothing to release.
    }
  };
}
