import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { logLevel, useStore } from "../store";
import type { LogLine } from "../types";

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function levelClass(line: LogLine): string {
  if (line.stream === "sys") return "log-sys";
  const lvl = logLevel(line.text);
  return lvl ? `log-${lvl}` : "";
}

export default function LogPanel() {
  const selectedId = useStore((s) => s.selectedId);
  const services = useStore((s) => s.services);
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  const autoScroll = useStore((s) => s.autoScroll);
  const setAutoScroll = useStore((s) => s.setAutoScroll);
  const clearLogs = useStore((s) => s.clearLogs);
  const exportLogs = useStore((s) => s.exportLogs);

  const rt = selectedId ? services[selectedId] : undefined;
  const allLines = useMemo(() => rt?.logs ?? [], [rt]);
  const filtered = useMemo(() => {
    if (!search.trim()) return allLines;
    const q = search.toLowerCase();
    return allLines.filter((l) => l.text.toLowerCase().includes(q));
  }, [allLines, search]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20,
    overscan: 20,
  });

  useEffect(() => {
    if (autoScroll && filtered.length > 0) {
      virtualizer.scrollToIndex(filtered.length - 1, { align: "end" });
    }
  }, [filtered.length, autoScroll, virtualizer]);

  if (!rt) {
    return <div className="log-panel log-panel-empty" />;
  }

  return (
    <div className="log-panel">
      <div className="log-scroll" ref={parentRef} data-testid="log-scroll">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const line = filtered[item.index];
            return (
              <div
                key={item.key}
                className={`log-line ${levelClass(line)}`}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: item.size,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <span className="log-ts">{formatTime(line.ts)}</span> {line.text}
              </div>
            );
          })}
        </div>
      </div>
      <div className="log-toolbar">
        <input
          id="log-search-input"
          data-testid="log-search"
          type="text"
          placeholder="🔍 로그 검색..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button data-testid="log-clear" onClick={() => clearLogs(rt.config.id)}>
          Clear
        </button>
        <label className="autoscroll-label">
          <input
            type="checkbox"
            data-testid="log-autoscroll"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          Auto-scroll
        </label>
        <button data-testid="log-export" onClick={() => void exportLogs(rt.config.id)}>
          Export
        </button>
      </div>
    </div>
  );
}
