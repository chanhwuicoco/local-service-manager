import { useMemo } from "react";
import { extractErrorLines, useStore } from "../store";
import { formatTime } from "../lib/configDraft";

/** 사이드바 오른쪽 짝 - 선택 서비스의 에러 로그만 모아 보여주고 클릭하면 LogPanel 에서 해당 줄로 점프. */
export default function ErrorPanel() {
  const selectedId = useStore((s) => s.selectedId);
  const services = useStore((s) => s.services);
  const open = useStore((s) => s.errorPanelOpen);
  const toggleErrorPanel = useStore((s) => s.toggleErrorPanel);
  const jumpToLine = useStore((s) => s.jumpToLine);

  const rt = selectedId ? services[selectedId] : undefined;
  const errorLines = useMemo(() => (rt ? extractErrorLines(rt.logs) : []), [rt]);

  return (
    <aside className={`error-panel${open ? " open" : ""}`}>
      <div className="error-panel-header">
        <span>에러 목록 ({errorLines.length})</span>
        <button type="button" className="error-panel-close" onClick={toggleErrorPanel} title="닫기">
          ×
        </button>
      </div>
      <div className="error-panel-list">
        {errorLines.length === 0 ? (
          <div className="error-panel-empty">감지된 에러 없음</div>
        ) : (
          errorLines.map((line) => (
            <button
              key={line.seq}
              type="button"
              className="error-item"
              data-testid="error-item"
              title={line.text}
              onClick={() => rt && jumpToLine(rt.config.id, line.seq)}
            >
              <span className="error-item-seq">#{line.seq}</span>
              <span className="error-item-time">{formatTime(line.ts)}</span>
              <span className="error-item-text">{line.text}</span>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
