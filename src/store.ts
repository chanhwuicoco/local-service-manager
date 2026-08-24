import { create } from "zustand";
import { backend } from "./lib/backend";
import { resolveIncludeInAll, resolveKind } from "./lib/configDraft";
import type { AppConfig, GitInfo, LogLine, ServiceConfig, ServiceStatus } from "./types";

export interface ServiceRuntime {
  config: ServiceConfig;
  pid?: number;
  portOpen: boolean;
  lastExitCode?: number | null;
  git?: GitInfo;
  logs: LogLine[];
  unreadErrors: number;
}

export function deriveStatus(rt: ServiceRuntime): ServiceStatus {
  const hasChild = rt.pid != null;
  const kind = resolveKind(rt.config);
  // nginx 는 시작 직후 데몬화되어 추적 pid 가 금방 사라지는 게 정상이라 포트 기준으로 판단(pid 무관하게 열려있으면 running).
  // external(추적 안 되는데 포트만 열림) 상태는 nginx 에는 없음 — 그게 nginx 의 정상 동작 방식이라서.
  if (kind === "nginx") {
    if (rt.config.port != null) {
      if (rt.portOpen) return "running";
      if (hasChild) return "starting";
      return "stopped";
    }
    return hasChild ? "running" : "stopped";
  }
  // frontend 는 포트가 선택 입력 - dev 서버는 프로젝트 설정이 포트를 스스로 정하고 데몬화 없이 계속
  // 떠 있어서, 포트를 안 적었으면 pid 유무로만 판단(starting/external 은 포트가 있을 때만 의미 있음).
  if (kind === "frontend" && rt.config.port == null) {
    return hasChild ? "running" : "stopped";
  }
  if (hasChild && rt.portOpen) return "running";
  if (hasChild && !rt.portOpen) return "starting";
  if (!hasChild && rt.portOpen) return "external";
  return "stopped";
}

export function logLevel(text: string): "error" | "warn" | "debug" | "trace" | null {
  if (/\b(ERROR|ERR)\b/.test(text)) return "error";
  if (/\bWARN\b/.test(text)) return "warn";
  if (/\bDEBUG\b/.test(text)) return "debug";
  if (/\bTRACE\b/.test(text)) return "trace";
  return null;
}

/** maxLogLines(0=제한 없음) 기준으로 앞부분을 잘라냄. */
export function capLogs(logs: LogLine[], maxLogLines: number): LogLine[] {
  if (maxLogLines <= 0) return logs;
  return logs.length > maxLogLines ? logs.slice(logs.length - maxLogLines) : logs;
}

export interface ReconcileResult {
  order: string[];
  services: Record<string, ServiceRuntime>;
  selectedId: string | null;
}

/**
 * config 저장/재로딩 시 서비스 맵을 새 config 기준으로 재구성하는 순수 함수.
 * 같은 id 는 pid/로그/git 등 런타임 상태를 유지, 사라진 id 는 제거, 새 id 는 초기 상태로 추가.
 */
export function reconcileConfig(
  prevServices: Record<string, ServiceRuntime>,
  prevSelectedId: string | null,
  config: AppConfig,
): ReconcileResult {
  const order = config.services.map((s) => s.id);
  const services: Record<string, ServiceRuntime> = {};
  for (const svc of config.services) {
    const prev = prevServices[svc.id];
    services[svc.id] = prev
      ? { ...prev, config: svc, logs: capLogs(prev.logs, config.maxLogLines) }
      : { config: svc, portOpen: false, logs: [], unreadErrors: 0 };
  }
  const selectedId = prevSelectedId && services[prevSelectedId] ? prevSelectedId : (order[0] ?? null);
  return { order, services, selectedId };
}

function gitInfoEqual(a: GitInfo | undefined, b: GitInfo): boolean {
  return !!a && a.branch === b.branch && a.ahead === b.ahead && a.behind === b.behind && a.dirty === b.dirty;
}

const SIDEBAR_COLLAPSED_KEY = "lbm.sidebarCollapsed";
function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

interface Store {
  config: AppConfig | null;
  order: string[];
  services: Record<string, ServiceRuntime>;
  selectedId: string | null;
  search: string;
  autoScroll: boolean;
  closeModalOpen: boolean;
  sidebarCollapsed: boolean;
  manageModalOpen: boolean;
  ready: boolean;
  busy: Record<string, boolean>;
  startAllBusy: boolean;
  // 관리 모달의 "저장" 버튼 명시 저장에서만 씀(DnD 자동 저장은 매번 뜨면 시끄러워서 제외) - 모달이 이미
  // 닫힌 뒤에도 보여야 해서 모달 컴포넌트 로컬 상태가 아니라 앱 전역(항상 마운트된 곳에서 렌더)에 둠.
  toastMessage: string | null;
  toastKey: number;
  /** 서비스별 마지막 git fetch "완료" 시각(ms epoch) - ServiceHeader 의 "마지막 git fetch: N분 전" 표시용. */
  lastGitFetchAt: Record<string, number>;

  init: () => Promise<void>;
  select: (id: string) => void;
  setSearch: (v: string) => void;
  setAutoScroll: (v: boolean) => void;
  clearLogs: (id: string) => void;
  exportLogs: (id: string) => Promise<void>;
  toggleSidebar: () => void;
  openManageModal: () => void;
  closeManageModal: () => void;
  showToast: (message: string) => void;

  start: (id: string) => Promise<void>;
  stop: (id: string) => Promise<void>;
  restart: (id: string) => Promise<void>;
  killPort: (id: string) => Promise<void>;
  gitPull: (id: string) => Promise<void>;
  startAll: () => Promise<void>;
  stopAll: () => Promise<void>;
  pullAll: () => Promise<void>;

  reloadConfig: () => Promise<void>;
  saveConfig: (config: AppConfig) => Promise<void>;

  requestExit: () => Promise<void>;
  cancelExit: () => void;
  liveExit: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 모듈 스코프 타이머 상태: pollPorts/resyncPids 와 같은 패턴으로 init() 안에서 setInterval 로 등록되지만,
// git fetch 주기는 저장 후 재설정해야 해서 핸들을 밖에서 들고 있어야 함.
let gitFetchTimerId: ReturnType<typeof setInterval> | null = null;
let lastGitInfoRefreshAt = 0;
// 저장 완료 토스트 자동 소멸 타이머 - 연달아 showToast 가 호출되면(거의 없겠지만) 이전 타이머를 지우고 새로 잡음.
let toastTimerId: ReturnType<typeof setTimeout> | null = null;

export const useStore = create<Store>((set, get) => {
  // git 정보 없음이 이미 확정된 서비스(branch === "?")는 재조회·fetch·pull 대상에서 제외.
  // rt.git 이 아직 없으면(최초 1회도 안 함) 제외하지 않음 - init() 의 첫 조회가 그 "1회"임.
  // cwd 가 아예 비어있는 서비스(경로 미설정)는 물어볼 필요도 없이 바로 확정 - 한 번도 안 물어보고 완전 스킵.
  const hasConfirmedNoGit = (id: string): boolean => {
    const rt = get().services[id];
    if (!rt) return false;
    if (!rt.config.cwd.trim()) return true;
    return !!rt.git && rt.git.branch === "?";
  };

  // gitFetch 완료(성공 기준 - IPC 호출이 예외 없이 끝남) 시각 기록. 실제 git fetch 네트워크 실패는 Rust
  // 쪽에서 이미 "git fetch failed: ..." sys 로그로 남기고 있어(IPC 자체는 성공으로 끝남) 별도 구분 안 함.
  const recordGitFetchDone = (id: string) => {
    set((s) => ({ lastGitFetchAt: { ...s.lastGitFetchAt, [id]: Date.now() } }));
  };

  const fetchOneAndRecord = (id: string) => void backend.gitFetch(id).then(() => recordGitFetchDone(id));

  const startGitFetchTimer = (periodSec: number) => {
    if (gitFetchTimerId != null) {
      clearInterval(gitFetchTimerId);
      gitFetchTimerId = null;
    }
    if (periodSec > 0) {
      gitFetchTimerId = setInterval(
        () => get().order.forEach((id) => !hasConfirmedNoGit(id) && fetchOneAndRecord(id)),
        Math.max(periodSec, 5) * 1000,
      );
    }
  };

  // 네트워크 없는 로컬 git 정보(rev-parse/rev-list/status) 재조회. 다른 곳에서 pull/브랜치 변경해도
  // 30초 폴링 + 창 포커스 시 곧 반영되게. 값이 그대로면 set 생략해서 불필요한 리렌더 방지.
  // git 정보 없음이 확정된 폴더는 여기서도 제외(재시도 스팸 방지) - cwd 가 바뀌면 saveConfig 쪽에서 1회 다시 조회.
  const refreshAllGitInfo = async () => {
    lastGitInfoRefreshAt = Date.now();
    const ids = get().order.filter((id) => !hasConfirmedNoGit(id));
    if (ids.length === 0) return;
    const results = await Promise.all(ids.map(async (id) => ({ id, info: await backend.gitInfo(id) })));
    set((s) => {
      let changed = false;
      const next = { ...s.services };
      for (const { id, info } of results) {
        const rt = next[id];
        if (rt && !gitInfoEqual(rt.git, info)) {
          changed = true;
          next[id] = { ...rt, git: info };
        }
      }
      return changed ? { services: next } : {};
    });
  };

  return {
    config: null,
    order: [],
    services: {},
    selectedId: null,
    search: "",
    autoScroll: true,
    closeModalOpen: false,
    sidebarCollapsed: loadSidebarCollapsed(),
    manageModalOpen: false,
    ready: false,
    busy: {},
    startAllBusy: false,
    toastMessage: null,
    toastKey: 0,
    lastGitFetchAt: {},

    init: async () => {
      const config = await backend.getConfig();
      const order = config.services.map((s) => s.id);
      const services: Record<string, ServiceRuntime> = {};
      for (const svc of config.services) {
        services[svc.id] = { config: svc, portOpen: false, logs: [], unreadErrors: 0 };
      }
      set({ config, order, services, selectedId: order[0] ?? null });

      const pids = await backend.runningPids();
      set((s) => {
        const next = { ...s.services };
        for (const [id, pid] of Object.entries(pids)) {
          if (next[id]) next[id] = { ...next[id], pid };
        }
        return { services: next };
      });

      // cwd 미설정 서비스는 물어볼 필요 없이 완전 스킵(불필요한 IPC 호출 자체를 안 함).
      await Promise.all(
        order
          .filter((id) => services[id]?.config.cwd.trim())
          .map(async (id) => {
            const info = await backend.gitInfo(id);
            set((s) => ({ services: { ...s.services, [id]: { ...s.services[id], git: info } } }));
          }),
      );
      lastGitInfoRefreshAt = Date.now();

      // 앱 시작 시: git 정보가 확인된 서비스는 주기 타이머(startGitFetchTimer)를 기다리지 않고
      // 즉시 fetch 를 1회 먼저 실행 - 예전엔 setInterval 뿐이라 첫 fetch 가 주기 후에야 돌았음.
      for (const id of order) {
        const git = get().services[id]?.git;
        if (git != null && git.branch !== "?") fetchOneAndRecord(id);
      }

      backend.onLog(({ id, lines }) => {
        set((s) => {
          const rt = s.services[id];
          if (!rt) return {};
          const cap = s.config?.maxLogLines ?? 10000;
          const merged = [...rt.logs, ...lines];
          const capped = capLogs(merged, cap);
          const isSelected = s.selectedId === id;
          const newErrors = isSelected
            ? 0
            : rt.unreadErrors + lines.filter((l) => logLevel(l.text) === "error").length;
          return {
            services: { ...s.services, [id]: { ...rt, logs: capped, unreadErrors: newErrors } },
          };
        });
      });

      backend.onStatus((p) => {
        set((s) => {
          const rt = s.services[p.id];
          if (!rt) return {};
          if (p.kind === "started") {
            return {
              services: { ...s.services, [p.id]: { ...rt, pid: p.pid, lastExitCode: null } },
            };
          }
          return {
            services: { ...s.services, [p.id]: { ...rt, pid: undefined, lastExitCode: p.code } },
          };
        });
      });

      backend.onGit(({ id, info }) => {
        set((s) => {
          const rt = s.services[id];
          if (!rt) return {};
          return { services: { ...s.services, [id]: { ...rt, git: info } } };
        });
      });

      backend.onCloseRequested(() => set({ closeModalOpen: true }));

      let pollInFlight = false;
      const pollPorts = async () => {
        if (pollInFlight) return; // 이전 폴링이 아직 안 끝났으면 겹치지 않게 건너뜀
        pollInFlight = true;
        try {
          const { services: svcs } = get();
          const ports = Object.values(svcs)
            .map((r) => r.config.port)
            .filter((p): p is number => p != null);
          if (ports.length === 0) return;
          const open = await backend.checkPorts(ports);
          const current = get().services;
          let changed = false;
          const next = { ...current };
          for (const rt of Object.values(next)) {
            if (rt.config.port != null) {
              const newOpen = !!open[rt.config.port];
              if (newOpen !== rt.portOpen) {
                changed = true;
                next[rt.config.id] = { ...rt, portOpen: newOpen };
              }
            }
          }
          if (changed) set({ services: next }); // 변화 없으면 불필요한 리렌더 방지
        } finally {
          pollInFlight = false;
        }
      };
      void pollPorts();
      setInterval(pollPorts, 2000);

      // 안전망: status 이벤트를 놓쳐도(창 비활성 등) pid 를 주기적으로 재동기화.
      let resyncInFlight = false;
      const resyncPids = async () => {
        if (resyncInFlight) return;
        resyncInFlight = true;
        try {
          const pids = await backend.runningPids();
          const current = get().services;
          let changed = false;
          const next = { ...current };
          for (const id of Object.keys(next)) {
            const rt = next[id];
            const newPid = pids[id];
            if (newPid !== rt.pid) {
              changed = true;
              next[id] = { ...rt, pid: newPid };
            }
          }
          if (changed) set({ services: next });
        } finally {
          resyncInFlight = false;
        }
      };
      setInterval(resyncPids, 10000);

      startGitFetchTimer(config.gitFetchIntervalSec);

      // 로컬 git 정보는 네트워크 없이 30초마다, 그리고 창이 포커스를 얻을 때(직전 갱신 5초 이내면 생략) 재조회.
      setInterval(() => void refreshAllGitInfo(), 30000);
      window.addEventListener("focus", () => {
        if (Date.now() - lastGitInfoRefreshAt < 5000) return;
        void refreshAllGitInfo();
      });

      set({ ready: true });
    },

    select: (id) => {
      set((s) => {
        const rt = s.services[id];
        if (!rt) return { selectedId: id };
        return { selectedId: id, services: { ...s.services, [id]: { ...rt, unreadErrors: 0 } } };
      });
    },

    setSearch: (v) => set({ search: v }),
    setAutoScroll: (v) => set({ autoScroll: v }),

    clearLogs: (id) => {
      set((s) => {
        const rt = s.services[id];
        if (!rt) return {};
        return { services: { ...s.services, [id]: { ...rt, logs: [] } } };
      });
    },

    exportLogs: async (id) => {
      const rt = get().services[id];
      if (!rt) return;
      const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace("T", "-")
        .slice(0, 15);
      const name = `${rt.config.name}-${stamp}.log`;
      const content = rt.logs
        .map((l) => `${new Date(l.ts).toISOString()} [${l.stream}] ${l.text}`)
        .join("\n");
      await backend.exportLog(name, content);
    },

    toggleSidebar: () =>
      set((s) => {
        const next = !s.sidebarCollapsed;
        try {
          localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
        } catch {
          // localStorage 사용 불가 환경이면 그냥 메모리 상태만 유지
        }
        return { sidebarCollapsed: next };
      }),
    openManageModal: () => set({ manageModalOpen: true }),
    closeManageModal: () => set({ manageModalOpen: false }),
    // toastKey 를 매번 올려서 같은 문구가 연달아 떠도(예: 저장 두 번) React key 로 리마운트돼 fade 애니메이션이 처음부터 다시 재생됨.
    showToast: (message) => {
      if (toastTimerId != null) clearTimeout(toastTimerId);
      set((s) => ({ toastMessage: message, toastKey: s.toastKey + 1 }));
      toastTimerId = setTimeout(() => {
        set({ toastMessage: null });
        toastTimerId = null;
      }, 2000);
    },

    start: async (id) => {
      set((s) => ({ busy: { ...s.busy, [id]: true } }));
      try {
        const pid = await backend.startService(id);
        set((s) => {
          const rt = s.services[id];
          if (!rt) return {};
          return { services: { ...s.services, [id]: { ...rt, pid, lastExitCode: null } } };
        });
      } catch (e) {
        console.error(`start ${id} failed:`, e);
      } finally {
        set((s) => ({ busy: { ...s.busy, [id]: false } }));
      }
    },
    stop: async (id) => {
      set((s) => ({ busy: { ...s.busy, [id]: true } }));
      try {
        await backend.stopService(id);
      } catch (e) {
        console.error(`stop ${id} failed:`, e);
      } finally {
        set((s) => ({ busy: { ...s.busy, [id]: false } }));
      }
    },
    restart: async (id) => {
      set((s) => ({ busy: { ...s.busy, [id]: true } }));
      try {
        const pid = await backend.restartService(id);
        set((s) => {
          const rt = s.services[id];
          if (!rt) return {};
          return { services: { ...s.services, [id]: { ...rt, pid, lastExitCode: null } } };
        });
      } catch (e) {
        console.error(`restart ${id} failed:`, e);
      } finally {
        set((s) => ({ busy: { ...s.busy, [id]: false } }));
      }
    },
    killPort: async (id) => {
      const rt = get().services[id];
      if (!rt?.config.port) return;
      set((s) => ({ busy: { ...s.busy, [id]: true } }));
      try {
        await backend.killPort(id, rt.config.port);
      } catch (e) {
        console.error(`kill port for ${id} failed:`, e);
      } finally {
        set((s) => ({ busy: { ...s.busy, [id]: false } }));
      }
    },
    gitPull: async (id) => {
      try {
        await backend.gitPull(id);
      } catch (e) {
        console.error(`git pull ${id} failed:`, e);
      }
    },

    startAll: async () => {
      set({ startAllBusy: true });
      try {
        const { order, services, config } = get();
        const stagger = config?.startStaggerMs ?? 1500;
        for (const id of order) {
          const rt = services[id];
          if (!rt || rt.config.command === null) continue; // rt 없거나 git-only(LIB) 는 제외
          if (!rt.config.cwd.trim()) continue; // 경로 미설정 - 카드에서도 Start 버튼이 막혀있는 것과 동일하게 제외
          if (!resolveIncludeInAll(rt.config)) continue; // All 대상에서 개별 제외된 서비스
          const status = deriveStatus(rt);
          if (status === "running" || status === "starting") continue; // 이미 떠 있으면(nginx 포함) 건너뜀
          try {
            await backend.startService(id);
          } catch {
            // 이미 실행 중 등은 무시하고 다음으로
          }
          await sleep(stagger);
        }
      } finally {
        set({ startAllBusy: false });
      }
    },
    stopAll: async () => {
      const { order, services } = get();
      for (const id of order) {
        const rt = services[id];
        if (!rt || rt.config.command === null) continue;
        if (!resolveIncludeInAll(rt.config)) continue; // All 대상에서 개별 제외된 서비스
        const status = deriveStatus(rt);
        // nginx 는 추적 pid 없이 포트만 열려있어도 "실행 중"이므로 pid 대신 status 로 판단해야 Stop All 이 놓치지 않음.
        if (status !== "running" && status !== "starting") continue;
        try {
          await backend.stopService(id);
        } catch {
          // ignore
        }
      }
    },
    pullAll: async () => {
      const { order, services } = get();
      for (const id of order) {
        if (hasConfirmedNoGit(id)) continue; // git 정보 없는 폴더(예: nginx)는 pull 대상 제외
        const rt = services[id];
        if (rt && !resolveIncludeInAll(rt.config)) continue; // All 대상에서 개별 제외된 서비스
        try {
          await backend.gitPull(id);
        } catch {
          // ignore
        }
      }
    },

    reloadConfig: async () => {
      const config = await backend.reloadConfig();
      set((s) => {
        const { order, services, selectedId } = reconcileConfig(s.services, s.selectedId, config);
        return { config, order, services, selectedId };
      });
      startGitFetchTimer(config.gitFetchIntervalSec);
    },

    saveConfig: async (draft) => {
      const prev = get();
      const prevIds = new Set(Object.keys(prev.services));
      const saved = await backend.saveConfig(draft);
      const { order, services, selectedId } = reconcileConfig(prev.services, prev.selectedId, saved);
      set({ config: saved, order, services, selectedId });

      const addedIds = order.filter((id) => !prevIds.has(id));
      // cwd 가 바뀐 기존 서비스도 git 정보를 1회 다시 조회(예: nginx 로 바꿔서 git 정보 없음으로 확정되거나,
      // 반대로 git 저장소인 폴더로 바뀌었을 때 반영). 폴더가 안 바뀐 서비스는 굳이 다시 안 부름.
      const cwdChangedIds = order.filter((id) => {
        const prevRt = prev.services[id];
        return prevRt && prevRt.config.cwd !== services[id]?.config.cwd;
      });
      // cwd 가 여전히(또는 새로) 비어있는 서비스는 완전 스킵 - 물어볼 필요가 없음.
      const idsToRefresh = [...new Set([...addedIds, ...cwdChangedIds])].filter((id) => services[id]?.config.cwd.trim());
      await Promise.all(
        idsToRefresh.map(async (id) => {
          const info = await backend.gitInfo(id);
          set((s) => {
            const rt = s.services[id];
            if (!rt) return {};
            return { services: { ...s.services, [id]: { ...rt, git: info } } };
          });
          // 저장으로 새로(또는 다른 폴더로) git 저장소가 확인된 서비스는 이 시점에 fetch 1회 -
          // 이후는 주기 루틴이 알아서 커버하므로 여기선 한 번만.
          if (info.branch !== "?") fetchOneAndRecord(id);
        }),
      );

      startGitFetchTimer(saved.gitFetchIntervalSec);
    },

    requestExit: async () => {
      set({ closeModalOpen: false });
      await backend.stopAllAndExit();
    },
    cancelExit: () => set({ closeModalOpen: false }),
    liveExit: () => {
      set({ closeModalOpen: false });
      void backend.forceExit();
    },
  };
});
