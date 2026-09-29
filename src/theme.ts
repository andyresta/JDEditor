/** Light or dark, and who decides.
 *
 * The app has always had both themes; what it did not have was a say in
 * which one. They were written as `prefers-color-scheme` rules, so the
 * editor followed whatever Windows had been told, and someone editing at
 * night on a machine set to light had no way to turn the lights down.
 *
 * The rules are keyed off a `data-theme` attribute on <html> now. This
 * module is the only thing that writes it: it resolves the preference —
 * which may be "follow the system" — and keeps it in step when the system
 * changes underneath. There is exactly one copy of the dark values in
 * each stylesheet, and no `@media` block that could drift away from them.
 */

import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";
export type Theme = "light" | "dark";

/** Where the choice is kept. Not in the project file: which theme someone
 * edits in is a property of the person and the room they are sitting in,
 * not of the film, and opening a colleague's project should not repaint
 * the app. */
const KEY = "jd-theme";

const query = () =>
  typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

export function readChoice(): ThemeChoice {
  try {
    const kept = window.localStorage.getItem(KEY);
    if (kept === "light" || kept === "dark" || kept === "system") return kept;
  } catch {
    // Private mode, cleared storage, a webview with storage switched off:
    // none of that is worth failing over. Following the system is a fine
    // answer when nothing has been said.
  }
  return "system";
}

/** What that choice actually amounts to right now. */
export function resolve(choice: ThemeChoice): Theme {
  if (choice === "light" || choice === "dark") return choice;
  return query()?.matches ? "dark" : "light";
}

/** Tells the window frame which theme it is in.
 *
 * The bar across the top with the title and the close button is drawn by
 * Windows, not by this app, so no stylesheet can reach it — a dark editor
 * under a white title bar is the one part that would never follow. Tauri
 * can pass the preference down to the system, which is what this does.
 *
 * Deliberately not awaited and deliberately not silent: it is a nicety
 * rather than a requirement, and a window that refuses should say so in
 * the console rather than leave someone wondering why one strip stayed
 * pale. Imported when needed so that anything running this module outside
 * Tauri — a test page, for instance — simply never asks. */
function tellTheWindow(theme: Theme): void {
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(theme))
    .catch((err) => console.error("could not set the window theme", err));
}

/** Paints it. The attribute is always one of the two real themes, never
 * "system": the stylesheets should not have to know that following the
 * system is even a possibility. */
export function apply(choice: ThemeChoice): Theme {
  const theme = resolve(choice);
  document.documentElement.dataset.theme = theme;
  tellTheWindow(theme);
  return theme;
}

export function saveChoice(choice: ThemeChoice): Theme {
  try {
    window.localStorage.setItem(KEY, choice);
  } catch {
    // It will still take effect for this session; it just won't be
    // remembered. Better than refusing to change at all.
  }
  return apply(choice);
}

/** Calls back when the system's own setting changes, so "follow the
 * system" keeps meaning that after the app has started. Returns the
 * unsubscribe. */
export function watchSystem(onChange: () => void): () => void {
  const media = query();
  if (!media) return () => {};
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** The theme as it stands, and the way to change it.
 *
 * Shared so that every button offering the choice — the editor's top bar,
 * the recorder's title bar, the launcher — is the same switch rather than
 * three that have to be kept in agreement.
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => resolve(readChoice()));

  // The inline script in index.html sets the attribute before the first
  // paint, but it cannot reach the window frame — Tauri's API is not
  // loaded that early. So the frame is told once, here, as soon as
  // anything is on screen.
  useEffect(() => {
    tellTheWindow(theme);
    // Once on mount: every later change goes through `apply`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While nothing has been chosen, "follow the system" has to go on
  // meaning that — not only at startup.
  useEffect(() => {
    if (readChoice() !== "system") return;
    return watchSystem(() => setTheme(apply("system")));
  }, [theme]);

  return {
    theme,
    toggle: () => setTheme(saveChoice(theme === "dark" ? "light" : "dark")),
  };
}
