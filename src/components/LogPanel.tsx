import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { logLevel, useStore } from "../store";
import { formatTime, LOG_CLEAR_LABEL } from "../lib/configDraft";
import { buildCopyText, countCopiedLines, selectionRange, type LineRangeSelection } from "../lib/logSelection";
import type { LogLine } from "../types";

// 가장자리 자동 스크롤 트리거 폭(px)과 프레임당 최대 스크롤량(px).
const AUTOSCROLL_EDGE_PX = 24;
const AUTOSCROLL_MAX_STEP_PX = 20;

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

  const showToast = useStore((s) => s.showToast);

  // 줄 범위 선택 - 가상 스크롤이라 브라우저 드래그 선택이 스크롤 중 끊기므로 seq(anchor/focus) 두 개만으로
  // 앱이 직접 범위를 관리한다(store 가 아니라 LogPanel 로컬 상태 - 선택은 이 화면에만 필요).
  const [sel, setSel] = useState<LineRangeSelection | null>(null);
  const [rangeDragActive, setRangeDragActive] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const selRange = selectionRange(sel);

  const anchorSeqRef = useRef<number | null>(null);
  const rangeDragActiveRef = useRef(false);
  const pointerRef = useRef({ x: 0, y: 0 });
  const rafIdRef = useRef<number | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  // 드래그로 만든 선택 직후(mouseup)에 이어지는 click(빈 공간 판정)이 방금 만든 선택을 지우지 않게 하는 1회성 플래그.
  const suppressClickClearRef = useRef(false);

  // 서비스 전환 시 진행 중이던 드래그를 정리하고 선택/메뉴를 리셋.
  useEffect(() => {
    dragCleanupRef.current?.();
    setSel(null);
    setRangeDragActive(false);
    setCtxMenu(null);
  }, [selectedId]);

  // 언마운트 시 드래그 중이었다면 document 리스너/rAF 루프 정리.
  useEffect(() => {
    return () => dragCleanupRef.current?.();
  }, []);

  // 선택이 사라지면(위 리셋 포함) 열려있던 컨텍스트 메뉴도 같이 닫음.
  useEffect(() => {
    if (!sel) setCtxMenu(null);
  }, [sel]);

  // 컨텍스트 메뉴는 바깥 클릭/Escape 로 닫음.
  useEffect(() => {
    if (!ctxMenu) return;
    const onDocMouseDown = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  const copySelection = (target: LineRangeSelection) => {
    const text = buildCopyText(filtered, target);
    const n = countCopiedLines(text);
    if (n === 0) return;
    navigator.clipboard
      .writeText(text)
      .then(() => showToast(`복사됨 ${n}줄`))
      .catch(() => {
        // 클립보드 권한 없음 등은 조용히 무시 - 선택 자체는 그대로 유지.
      });
  };

  // 좌클릭이 줄 위에서 시작될 때만 드래그 후보로 기록. 같은 줄 안에서 안 움직이면(단순 클릭) 브라우저의
  // 부분 텍스트 선택을 그대로 살리기 위해 mousedown 시점엔 아직 sel 을 만들지 않는다.
  const handleMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    suppressClickClearRef.current = false; // 이전 제스처의 플래그가 click 없이 남아있었다면 새 제스처 시작 시 정리
    const lineEl = (e.target as HTMLElement).closest<HTMLElement>("[data-seq]");
    if (!lineEl) return;
    const seq = Number(lineEl.dataset.seq);

    if (e.shiftKey && sel) {
      // Shift+클릭: anchor 는 유지하고 focus 만 클릭한 줄로 갱신(바로 확정).
      anchorSeqRef.current = sel.anchor;
      setSel({ anchor: sel.anchor, focus: seq });
      rangeDragActiveRef.current = true;
      setRangeDragActive(true);
    } else {
      anchorSeqRef.current = seq;
    }

    const stopAutoScrollLoop = () => {
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };

    // 범위 모드 중 매 프레임: 가장자리 자동 스크롤 + 스크롤로 새로 렌더된 줄로 focus 갱신을 한 rAF 루프에서 처리
    // (mousemove 이벤트마다 setState 하지 않고 여기서만 하므로 자연스럽게 프레임당 1회로 배치됨).
    const tick = () => {
      if (!rangeDragActiveRef.current) {
        rafIdRef.current = null;
        return;
      }
      const container = parentRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const y = pointerRef.current.y;
        let dy = 0;
        if (y < rect.top + AUTOSCROLL_EDGE_PX) {
          const dist = Math.max(0, rect.top + AUTOSCROLL_EDGE_PX - y);
          dy = -Math.min(AUTOSCROLL_MAX_STEP_PX, Math.ceil((dist / AUTOSCROLL_EDGE_PX) * AUTOSCROLL_MAX_STEP_PX));
        } else if (y > rect.bottom - AUTOSCROLL_EDGE_PX) {
          const dist = Math.max(0, y - (rect.bottom - AUTOSCROLL_EDGE_PX));
          dy = Math.min(AUTOSCROLL_MAX_STEP_PX, Math.ceil((dist / AUTOSCROLL_EDGE_PX) * AUTOSCROLL_MAX_STEP_PX));
        }
        if (dy !== 0) container.scrollTop += dy;
      }
      const el = document.elementFromPoint(pointerRef.current.x, pointerRef.current.y) as HTMLElement | null;
      const lineUnder = el?.closest<HTMLElement>("[data-seq]");
      if (lineUnder) {
        const newSeq = Number(lineUnder.dataset.seq);
        setSel((prev) => (prev && prev.focus !== newSeq ? { ...prev, focus: newSeq } : prev));
      }
      rafIdRef.current = requestAnimationFrame(tick);
    };

    const startAutoScrollLoop = () => {
      if (rafIdRef.current == null) rafIdRef.current = requestAnimationFrame(tick);
    };
    if (rangeDragActiveRef.current) startAutoScrollLoop(); // shift+클릭으로 이미 범위 모드에 들어간 경우

    const onMove = (ev: MouseEvent) => {
      pointerRef.current = { x: ev.clientX, y: ev.clientY };
      if (rangeDragActiveRef.current) return; // 진입 후엔 tick() 이 매 프레임 처리 - 여기선 좌표만 갱신
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const lineUnder = el?.closest<HTMLElement>("[data-seq]");
      if (!lineUnder) return;
      const newSeq = Number(lineUnder.dataset.seq);
      if (anchorSeqRef.current == null || newSeq === anchorSeqRef.current) return;
      // 시작 줄과 다른 줄로 넘어감 -> 범위 모드 진입(브라우저 기본 선택은 지움).
      window.getSelection()?.removeAllRanges();
      setSel({ anchor: anchorSeqRef.current, focus: newSeq });
      rangeDragActiveRef.current = true;
      setRangeDragActive(true);
      startAutoScrollLoop();
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      stopAutoScrollLoop();
      if (rangeDragActiveRef.current) {
        rangeDragActiveRef.current = false;
        setRangeDragActive(false);
        suppressClickClearRef.current = true; // 뒤이은 click 이 방금 만든 선택을 지우지 않게
        // click 이 log-scroll 밖(예: 툴바)에서 끝나 여기로 안 오는 경우를 대비한 안전망 - 정상 케이스에선
        // click 이 이 태스크 안에서 동기적으로 먼저 소비하므로 아래 타이머보다 항상 먼저 실행된다.
        setTimeout(() => {
          suppressClickClearRef.current = false;
        }, 0);
      }
      anchorSeqRef.current = null;
      dragCleanupRef.current = null;
    };

    dragCleanupRef.current = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      stopAutoScrollLoop();
      rangeDragActiveRef.current = false;
      anchorSeqRef.current = null;
      dragCleanupRef.current = null;
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // 줄이든 빈 공간이든 드래그 없는 단순 클릭이면 선택 해제(에디터/터미널 공통 동작).
  // 드래그 직후 mouseup 에 이어지는 click 은 suppressClickClearRef 로 제외, Shift+클릭(focus 확장)도 제외.
  const handleContainerClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (suppressClickClearRef.current) {
      suppressClickClearRef.current = false;
      return;
    }
    if (e.shiftKey) return; // shift+클릭 경로는 이미 suppress 로 걸러지지만 방어적으로 한 번 더 막음
    setSel(null);
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      if (sel) setSel(null);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      if (!sel) return; // 선택 없으면 브라우저 기본(부분 텍스트) 복사 그대로 둠
      e.preventDefault();
      copySelection(sel);
    }
  };

  const handleContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!sel) return; // 선택 없으면 Tauri WebView 기본 메뉴 그대로
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  if (!rt) {
    return <div className="log-panel log-panel-empty" />;
  }

  return (
    <div className="log-panel">
      <div
        className={`log-scroll${rangeDragActive ? " log-scroll-no-select" : ""}`}
        ref={parentRef}
        data-testid="log-scroll"
        tabIndex={-1}
        onMouseDown={handleMouseDown}
        onClick={handleContainerClick}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const line = filtered[item.index];
            const isHighlight = line.seq === highlightSeq;
            const isSelected = !isHighlight && !!selRange && line.seq >= selRange.min && line.seq <= selRange.max;
            return (
              <div
                key={item.key}
                data-seq={line.seq}
                className={`log-line ${levelClass(line)}${isHighlight ? " log-line-highlight" : isSelected ? " log-line-selected" : ""}`}
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
      {ctxMenu && sel && (
        <div
          className="log-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          // 바깥 클릭으로 닫히는 document 리스너보다 먼저 열려서 자기 자신 클릭에 안 걸림 - 그래도 버블링 차단은 안전망으로 유지.
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              copySelection(sel);
              setCtxMenu(null);
            }}
          >
            복사 ({countCopiedLines(buildCopyText(filtered, sel))}줄)
          </button>
        </div>
      )}
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
        <button
          className="log-clear-btn"
          data-testid="log-clear"
          onClick={() => {
            clearLogs(rt.config.id);
            setSel(null);
          }}
        >
          {LOG_CLEAR_LABEL}
        </button>
      </div>
    </div>
  );
}
