import { getCurrentWindow } from "@tauri-apps/api/window";
import { AreaSelectorOverlay } from "./components/AreaSelectorOverlay";
import { CursorHalo } from "./components/CursorHalo";
import { RecorderApp } from "./components/RecorderApp";
import { RecorderBar } from "./components/RecorderBar";
import "./App.css";

const label = getCurrentWindow().label;

// The overlay and the floating bar are transparent windows, so they have
// to drop the app-wide page background. Done before the first render
// rather than in an effect so it never paints opaque for a frame.
if (
  label === "area-selector" ||
  label === "recorder-bar" ||
  label === "cursor-halo"
) {
  document.documentElement.classList.add("transparent-window");
}

function App() {
  if (label === "area-selector") return <AreaSelectorOverlay />;
  if (label === "recorder-bar") return <RecorderBar />;
  if (label === "cursor-halo") return <CursorHalo />;
  return <RecorderApp />;
}

export default App;
