import { getCurrentWindow } from "@tauri-apps/api/window";
import { AreaSelectorOverlay } from "./components/AreaSelectorOverlay";
import { RecorderApp } from "./components/RecorderApp";
import "./App.css";

function App() {
  const isOverlay = getCurrentWindow().label === "area-selector";
  return isOverlay ? <AreaSelectorOverlay /> : <RecorderApp />;
}

export default App;
