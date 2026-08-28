import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { logLevel, useStore } from "../store";
import { formatTime, LOG_CLEAR_LABEL } from "../lib/configDraft";
import type { LogLine } from "../types";

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
  const jumpTarget = useStore((s) => s.jumpTarget);

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

  // 에러 패널 항목 클릭 -> 해당 줄로 스크롤 + 잠깐 하이라이트.
  const [highlightSeq, setHighlightSeq] = useState<number | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 처리 중인 jumpTarget.nonce - 검색어 때문에 filtered 에 없어서 재시도할 때도 auto-scroll 을
  // 매번 다시 끄지 않도록(이미 끈 채로 유지) nonce 단위로만 1회 처리했는지 기억.
  const pendingJumpNonceRef = useRef<number | null>(null);
  // 스크롤+하이라이트까지 이미 끝낸 nonce - 로그가 계속 스트리밍되면 filtered 참조가 300ms 마다 바뀌어
  // 이 effect 가 재실행되는데, 이 가드가 없으면 매번 하이라이트 타이머가 새로 리셋돼 영원히 안 꺼짐.
  const handledJumpNonceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!jumpTarget || !rt || jumpTarget.id !== rt.config.id) return;
    if (handledJumpNonceRef.current === jumpTarget.nonce) return; // 이미 처리 완료 - 새 로그 도착으로 인한 재실행 무시
    if (pendingJumpNonceRef.current !== jumpTarget.nonce) {
      pendingJumpNonceRef.current = jumpTarget.nonce;
      // 점프 직후 새 로그가 도착하면 auto-scroll 이 다시 바닥으로 튕겨버리므로 먼저 꺼야 함.
      setAutoScroll(false);
    }
    const idx = filtered.findIndex((l) => l.seq === jumpTarget.seq);
    if (idx === -1) {
      // 검색어에 걸려 안 보이는 줄일 수 있음 - 검색을 지우면 filtered 가 바뀌어 이 effect 가 재실행됨.
      if (search.trim()) setSearch("");
      return;
    }
    handledJumpNonceRef.current = jumpTarget.nonce;
    pendingJumpNonceRef.current = null;
    virtualizer.scrollToIndex(idx, { align: "center" });
    setHighlightSeq(jumpTarget.seq);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightSeq(null), 1500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTarget, filtered]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

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
                className={`log-line ${levelClass(line)}${line.seq === highlightSeq ? " log-line-highlight" : ""}`}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: item.size,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <span className="log-ln">{line.seq}</span>
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
        <button className="log-clear-btn" data-testid="log-clear" onClick={() => clearLogs(rt.config.id)}>
          {LOG_CLEAR_LABEL}
        </button>
      </div>
    </div>
  );
}
