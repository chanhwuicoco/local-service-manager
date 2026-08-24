import { useEffect, useMemo, useRef } from "react";
import "./App.css";
import Header from "./components/Header";
import ServiceList from "./components/ServiceList";
import ServiceHeader from "./components/ServiceHeader";
import LogPanel from "./components/LogPanel";
import CloseModal from "./components/CloseModal";
import ServiceManageModal from "./components/ServiceManageModal";
import Toast from "./components/Toast";
import { useStore } from "./store";
import { backend } from "./lib/backend";
import { groupServiceIds, resolveKind, resolveKindOrder } from "./lib/configDraft";

function App() {
  const init = useStore((s) => s.init);
  const order = useStore((s) => s.order);
  const services = useStore((s) => s.services);
  const config = useStore((s) => s.config);
  const select = useStore((s) => s.select);
  const ready = useStore((s) => s.ready);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const initialized = useRef(false);
  const shownWindow = useRef(false);

  // 숫자키 1~9 선택은 사이드바에 실제 보이는 순서(kind 그룹핑 반영)와 일치해야 함.
  const displayOrder = useMemo(
    () =>
      groupServiceIds(
        order,
        (id) => (services[id] ? resolveKind(services[id].config) : null),
        resolveKindOrder(config?.kindOrder),
      ).flatMap((g) => g.ids),
    [order, services, config?.kindOrder],
  );

  useEffect(() => {
    // StrictMode 개발모드 이중 호출 방지 (init 이 이벤트 리스너를 두 번 등록하면 로그가 중복됨)
    if (initialized.current) return;
    initialized.current = true;
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 데이터 로딩까지 끝나 화면이 완전히 준비된 시점에만 창을 보여줌 - 흰 화면/빈 로딩 화면 노출 없이
  // 창이 뜨자마자 바로 완성된 화면이 보이게(tauri.conf.json 의 visible:false 와 짝).
  useEffect(() => {
    if (!ready || shownWindow.current) return;
    shownWindow.current = true;
    void backend.showMainWindow();
  }, [ready]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        document.getElementById("log-search-input")?.focus();
        return;
      }
      if (e.ctrlKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const target = document.activeElement;
        const isTyping = target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
        if (isTyping) return;
        const idx = Number(e.key) - 1;
        if (displayOrder[idx]) select(displayOrder[idx]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [displayOrder, select, toggleSidebar]);

  if (!ready) {
    return <div className="app-loading">불러오는 중...</div>;
  }

  return (
    <div className="app">
      <Header />
      <div className="body">
        <ServiceList />
        <main className="main">
          <ServiceHeader />
          <LogPanel />
        </main>
      </div>
      <CloseModal />
      <ServiceManageModal />
      <Toast />
    </div>
  );
}

export default App;
