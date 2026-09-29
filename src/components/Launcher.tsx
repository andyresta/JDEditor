import { useTheme } from "../theme";

interface LauncherProps {
  onSelectRecord: () => void;
  onSelectEditor: () => void;
}

export function Launcher({ onSelectRecord, onSelectEditor }: LauncherProps) {
  const { theme, toggle } = useTheme();
  return (
    <main className="launcher">
      <button
        className="launcher-theme"
        onClick={toggle}
        title={theme === "dark" ? "Switch to light" : "Switch to dark"}
      >
        {theme === "dark" ? "☀" : "☾"}
      </button>
      <div className="launcher-header">
        <h1>JDEditor</h1>
        <p className="subtitle">What would you like to do?</p>
      </div>
      <div className="launcher-choices">
        <button className="launcher-card" onClick={onSelectRecord}>
          <span className="launcher-card-icon">🔴</span>
          <span className="launcher-card-title">Record</span>
          <span className="launcher-card-desc">
            Capture your screen, webcam and audio
          </span>
        </button>
        <button className="launcher-card" onClick={onSelectEditor}>
          <span className="launcher-card-icon">🎬</span>
          <span className="launcher-card-title">Editor</span>
          <span className="launcher-card-desc">
            Open the full-screen editor to review or import media
          </span>
        </button>
      </div>
    </main>
  );
}
