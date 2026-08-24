import { useStore } from "../store";

export default function Header() {
  const startAll = useStore((s) => s.startAll);
  const stopAll = useStore((s) => s.stopAll);
  const pullAll = useStore((s) => s.pullAll);
  const startAllBusy = useStore((s) => s.startAllBusy);
  const openManageModal = useStore((s) => s.openManageModal);

  return (
    <header className="header">
      <h1>Local Service Manager</h1>
      <div className="header-actions">
        <button className="header-btn header-btn-text" data-testid="start-all" disabled={startAllBusy} onClick={() => void startAll()}>
          <span className="btn-icon">▶</span>
          <span>Start All</span>
        </button>
        <button className="header-btn header-btn-text" data-testid="stop-all" onClick={() => void stopAll()}>
          <span className="btn-icon btn-icon-stop">■</span>
          <span>Stop All</span>
        </button>
        <button className="header-btn header-btn-text" data-testid="pull-all" onClick={() => void pullAll()}>
          <span className="btn-icon">⬇</span>
          <span>Pull All</span>
        </button>
        <button className="header-btn header-btn-icon" data-testid="settings-btn" title="서비스 관리" onClick={openManageModal}>
          ⚙
        </button>
      </div>
    </header>
  );
}
