import type {
  AppConfig,
  DirInfo,
  GitEventPayload,
  GitInfo,
  LogEventPayload,
  LogLine,
  ServiceConfig,
  StatusEventPayload,
} from "../types";
import { effectiveCommand } from "./configDraft";

export interface Backend {
  getConfig(): Promise<AppConfig>;
  showMainWindow(): Promise<void>;
  reloadConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<AppConfig>;
  openConfigFile(): Promise<void>;
  inspectDir(cwd: string): Promise<DirInfo>;
  pickFolder(defaultPath?: string): Promise<string | null>;
  startService(id: string): Promise<number>;
  stopService(id: string): Promise<void>;
  restartService(id: string): Promise<number>;
  runningPids(): Promise<Record<string, number>>;
  stopAllAndExit(): Promise<void>;
  forceExit(): Promise<void>;
  gitInfo(id: string): Promise<GitInfo>;
  gitFetch(id: string): Promise<GitInfo>;
  gitPull(id: string): Promise<GitInfo>;
  checkPorts(ports: number[]): Promise<Record<number, boolean>>;
  killPort(id: string, port: number): Promise<void>;
  exportLog(defaultName: string, content: string): Promise<boolean>;
  onLog(cb: (p: LogEventPayload) => void): () => void;
  onStatus(cb: (p: StatusEventPayload) => void): () => void;
  onGit(cb: (p: GitEventPayload) => void): () => void;
  onCloseRequested(cb: () => void): () => void;
}

/** 실제 Tauri 백엔드: invoke/listen 으로 Rust 커맨드·이벤트에 연결. */
function createTauriBackend(): Backend {
  // 정적 임포트 시 브라우저(mock 모드)에서도 번들되지만 window.__TAURI_INTERNALS__ 없이는 호출되지 않음.
  const core = import("@tauri-apps/api/core");
  const event = import("@tauri-apps/api/event");
  const dialog = import("@tauri-apps/plugin-dialog");

  const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
    (await core).invoke<T>(cmd, args);

  const on = <T>(name: string, cb: (payload: T) => void): (() => void) => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    event.then((e) => {
      if (cancelled) return;
      e.listen<T>(name, (ev) => cb(ev.payload)).then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  };

  return {
    getConfig: () => invoke("get_config"),
    showMainWindow: () => invoke("show_main_window"),
    reloadConfig: () => invoke("reload_config"),
    saveConfig: (config) => invoke("save_config", { config }),
    openConfigFile: () => invoke("open_config_file"),
    inspectDir: (cwd) => invoke("inspect_dir", { cwd }),
    pickFolder: async (defaultPath) => {
      const { open } = await dialog;
      // 기존 cwd 가 있으면 그 폴더에서 dialog 를 열어줌(없으면 기존처럼 마지막 위치).
      const result = await open({ directory: true, defaultPath: defaultPath || undefined });
      return typeof result === "string" ? result : null;
    },
    startService: (id) => invoke("start_service", { id }),
    stopService: (id) => invoke("stop_service", { id }),
    restartService: (id) => invoke("restart_service", { id }),
    runningPids: () => invoke("running_pids"),
    stopAllAndExit: () => invoke("stop_all_and_exit"),
    forceExit: () => invoke("force_exit"),
    gitInfo: (id) => invoke("git_info", { id }),
    gitFetch: (id) => invoke("git_fetch", { id }),
    gitPull: (id) => invoke("git_pull", { id }),
    checkPorts: (ports) => invoke("check_ports", { ports }),
    killPort: (id, port) => invoke("kill_port", { id, port }),
    exportLog: async (defaultName, content) => {
      const { save } = await dialog;
      const path = await save({ defaultPath: defaultName });
      if (!path) return false;
      await invoke("write_text_file", { path, content });
      return true;
    },
    onLog: (cb) => on("log", cb),
    onStatus: (cb) => on("status", cb),
    onGit: (cb) => on("git", cb),
    onCloseRequested: (cb) => on("close-requested", () => cb()),
  };
}

const now = () => Date.now();

function defaultConfig(): AppConfig {
  const gradle = "gradlew.bat bootRun --args=--spring.profiles.active=local";
  const svc = (
    id: string,
    name: string,
    cwd: string,
    command: string | null,
    port: number | null,
    kind?: ServiceConfig["kind"],
  ): ServiceConfig => ({ id, name, cwd, command, port, env: {}, kind });
  return {
    services: [
      svc("cms", "BE_CMS", "C:/Workspace/BE_CMS", gradle, 8190, "backend"),
      svc("portal", "BE_PORTAL", "C:/Workspace/BE_PORTAL", gradle, 8192, "backend"),
      svc("fms", "BE_FMS", "C:/Workspace/BE_FMS", gradle, 8193, "backend"),
      svc("bms", "BE_BMS", "C:/Workspace/BE_BMS", gradle, 8195, "backend"),
      svc("lib", "BE_LIB", "C:/Workspace/BE_LIB", null, null, "lib"),
      svc("nginx1", "NGINX", "C:/nginx", "nginx.exe", 8080, "nginx"),
      // 포트 선택 입력 프론트 dev 서버(포트 미설정) 재현/회귀 확인용 - pid 기준으로만 상태 판단돼야 함.
      svc("fe1", "FE_LIB", "C:/Workspace/FE_LIB", "npm run dev", null, "frontend"),
      // 새 기본 서비스(빈 값) 재현/회귀 확인용 - cwd 없으면 카드 2줄째 안내 문구 + 버튼 disabled 로 나와야 함.
      svc("empty1", "FE_ECC", "", "", null, "frontend"),
    ],
    startStaggerMs: 1500,
    gitFetchIntervalSec: 600,
    maxLogLines: 10000,
    kindOrder: ["backend", "frontend", "lib", "nginx"],
    pullMode: "rebase",
  };
}

const MOCK_LOG_SAMPLES: Array<{ stream: "out" | "err"; text: string }> = [
  { stream: "out", text: "[INFO] handling GET /api/health" },
  { stream: "out", text: "[INFO] 배치 작업 큐 처리 완료 (3건)" },
  { stream: "out", text: "[DEBUG] cache hit ratio 0.92" },
  { stream: "err", text: "[WARN] slow query 812ms: select * from board" },
  { stream: "err", text: "[ERROR] Failed to query cache: connection refused (Redis)" },
  { stream: "out", text: "[TRACE] tx committed id=884213" },
];

/** 브라우저(Playwright 등)에서 UI 개발/검증용으로 쓰는 가짜 백엔드. */
function createMockBackend(): Backend {
  const config = defaultConfig();
  const listeners = {
    log: new Set<(p: LogEventPayload) => void>(),
    status: new Set<(p: StatusEventPayload) => void>(),
    git: new Set<(p: GitEventPayload) => void>(),
    close: new Set<() => void>(),
  };
  // nginx1: 외부에서 이미 켜진 nginx 재현용 - pid 추적 없이 포트만 열려있는 상태(실사용 버그 재현/회귀 확인용).
  // fe1: 포트 선택 입력 프론트(port:null) - pid 만으로 running 판단돼야 함(회귀 확인용).
  const pids: Record<string, number> = { cms: 41001, bms: 18455, fe1: 55001 };
  const portOpen: Record<string, boolean> = { cms: true, bms: true, nginx1: true };
  const gitInfoById: Record<string, GitInfo> = {
    cms: { branch: "main", ahead: 0, behind: 0, dirty: false },
    portal: { branch: "main", ahead: 0, behind: 0, dirty: false },
    fms: { branch: "feature/fms-batch", ahead: 1, behind: 0, dirty: true },
    bms: { branch: "dev", ahead: 0, behind: 2, dirty: false },
    lib: { branch: "main", ahead: 0, behind: 0, dirty: false },
    nginx1: { branch: "?", ahead: 0, behind: 0, dirty: false },
    fe1: { branch: "main", ahead: 0, behind: 0, dirty: false },
    // 실제 Rust compute_git_info 가 cwd 없으면 항상 돌려주는 "정보 없음" 상태와 동일하게 맞춤.
    empty1: { branch: "?", ahead: 0, behind: 0, dirty: false },
  };
  let sampleCursor = 0;
  const timers: Record<string, ReturnType<typeof setInterval>> = {};
  const startTimers: Record<string, ReturnType<typeof setTimeout>> = {};

  const emitLog = (id: string, lines: LogLine[]) => {
    listeners.log.forEach((cb) => cb({ id, lines }));
  };
  const emitGit = (id: string) => {
    listeners.git.forEach((cb) => cb({ id, info: gitInfoById[id] }));
  };

  const startStreaming = (id: string) => {
    stopStreaming(id);
    timers[id] = setInterval(() => {
      const sample = MOCK_LOG_SAMPLES[sampleCursor % MOCK_LOG_SAMPLES.length];
      sampleCursor += 1;
      emitLog(id, [{ ts: now(), stream: sample.stream, text: sample.text }]);
    }, 300);
  };
  const stopStreaming = (id: string) => {
    if (timers[id]) {
      clearInterval(timers[id]);
      delete timers[id];
    }
  };

  // 초기 상태: cms/bms 는 이미 실행 중으로 시작(목업과 동일한 화면 재현용).
  startStreaming("cms");
  startStreaming("bms");

  return {
    getConfig: async () => config,
    showMainWindow: async () => {}, // 브라우저(mock) 는 이미 보이는 상태라 무해
    reloadConfig: async () => config,
    saveConfig: async (next) => {
      // 실행 중인 서비스가 사라지지 않게 mock 런타임 맵도 새 id 목록에 맞춰 정리.
      config.services = next.services;
      config.startStaggerMs = next.startStaggerMs;
      config.gitFetchIntervalSec = next.gitFetchIntervalSec;
      config.maxLogLines = next.maxLogLines;
      config.kindOrder = next.kindOrder;
      config.pullMode = next.pullMode;
      const ids = new Set(next.services.map((s) => s.id));
      for (const id of Object.keys(pids)) {
        if (!ids.has(id)) delete pids[id];
      }
      for (const svc of next.services) {
        if (!gitInfoById[svc.id]) {
          gitInfoById[svc.id] = { branch: "main", ahead: 0, behind: 0, dirty: false };
        }
      }
      return config;
    },
    openConfigFile: async () => {},
    inspectDir: async (cwd) => {
      // nginx 폴더 환경 감지 흐름 검증용: cwd 에 "nginx" 가 들어가면 nginx.exe/conf 감지 형태로 응답(실물 Rust 출력과 동일 shape).
      if (cwd.toLowerCase().includes("nginx")) {
        return {
          hasGradlew: false,
          hasMvnw: false,
          hasGradleBuild: false,
          hasPackageJson: false,
          npmHasDev: false,
          npmHasStart: false,
          hasNginxExe: true,
          suggestedCommand: "nginx.exe",
          portCandidates: [{ port: 80, source: "nginx.conf" }],
          gitBranch: null,
        };
      }
      return {
        hasGradlew: true,
        hasMvnw: false,
        hasGradleBuild: true,
        hasPackageJson: false,
        npmHasDev: false,
        npmHasStart: false,
        hasNginxExe: false,
        suggestedCommand: "gradlew.bat bootRun --args=--spring.profiles.active=local",
        portCandidates: [
          { port: 8199, source: "application-local.yml" },
          { port: 8090, source: "application.yml" },
        ],
        gitBranch: cwd.includes("mock") ? null : "main",
      };
    },
    // defaultPath 가 오면 그대로 돌려줘서(사용자가 그 폴더를 그대로 골랐다고 가정) 검증에서 확인 가능하게 함.
    pickFolder: async (defaultPath) => defaultPath || "C:/Workspace/mock-new-service",
    startService: async (id) => {
      if (pids[id]) throw new Error(`${id} already running`);
      const svc = config.services.find((s) => s.id === id);
      const cmd = svc ? effectiveCommand(svc) : null;
      if (!svc || cmd == null) throw new Error(`${id} has no command`);
      const pid = 30000 + Math.floor(Math.random() * 9000);
      pids[id] = pid;
      emitLog(id, [{ ts: now(), stream: "sys", text: `▶ start: ${cmd}  (${svc.cwd})` }]);
      listeners.status.forEach((cb) => cb({ id, kind: "started", pid }));
      startTimers[id] = setTimeout(() => {
        delete startTimers[id];
        portOpen[id] = true;
        startStreaming(id);
      }, 500);
      return pid;
    },
    stopService: async (id) => {
      // start() 이후 500ms 안에 stop() 이 오면 대기 중인 시작 타이머부터 취소해야
      // stop 이후에 뒤늦게 streaming 이 켜져서 영영 안 멈추는 레이스를 막을 수 있음.
      if (startTimers[id]) {
        clearTimeout(startTimers[id]);
        delete startTimers[id];
      }
      stopStreaming(id);
      delete pids[id];
      portOpen[id] = false;
      emitLog(id, [{ ts: now(), stream: "sys", text: "■ exited (code 0)" }]);
      listeners.status.forEach((cb) => cb({ id, kind: "exited", code: 0 }));
    },
    restartService: async function (id) {
      await this.stopService(id);
      return this.startService(id);
    },
    runningPids: async () => ({ ...pids }),
    stopAllAndExit: async () => {
      Object.keys(pids).forEach(stopStreaming);
    },
    forceExit: async () => {},
    gitInfo: async (id) => gitInfoById[id],
    gitFetch: async (id) => gitInfoById[id],
    gitPull: async (id) => {
      emitLog(id, [{ ts: now(), stream: "sys", text: "── git pull ──" }]);
      emitLog(id, [{ ts: now(), stream: "sys", text: "Already up to date." }]);
      emitGit(id);
      return gitInfoById[id];
    },
    checkPorts: async (ports) => {
      const result: Record<number, boolean> = {};
      for (const p of ports) {
        const svc = config.services.find((s) => s.port === p);
        result[p] = svc ? !!portOpen[svc.id] : false;
      }
      return result;
    },
    killPort: async (id, port) => {
      const killedPid = pids[id];
      portOpen[id] = false;
      stopStreaming(id);
      delete pids[id];
      emitLog(id, [{ ts: now(), stream: "sys", text: `kill port ${port} → killed PID ${killedPid ?? "?"}` }]);
    },
    exportLog: async (defaultName) => {
      // eslint-disable-next-line no-console
      console.info("[mock] export log:", defaultName);
      return true;
    },
    onLog: (cb) => {
      listeners.log.add(cb);
      return () => listeners.log.delete(cb);
    },
    onStatus: (cb) => {
      listeners.status.add(cb);
      return () => listeners.status.delete(cb);
    },
    onGit: (cb) => {
      listeners.git.add(cb);
      return () => listeners.git.delete(cb);
    },
    onCloseRequested: (cb) => {
      listeners.close.add(cb);
      return () => listeners.close.delete(cb);
    },
  };
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const backend: Backend = isTauri() ? createTauriBackend() : createMockBackend();
