export type ServiceKind = "backend" | "frontend" | "lib" | "nginx";

export interface ServiceConfig {
  id: string;
  name: string;
  cwd: string;
  command: string | null;
  port: number | null;
  env: Record<string, string>;
  kind?: ServiceKind;
  /** 사이드바 접힘 레일 약칭(최대 3자). 없으면 이름에서 자동 유도. */
  short?: string;
  /** Start All/Stop All/Pull All 일괄 실행 포함 여부. 없으면(구 config) true 로 취급 - resolveIncludeInAll 참고. */
  includeInAll?: boolean;
}

export interface AppConfig {
  services: ServiceConfig[];
  startStaggerMs: number;
  gitFetchIntervalSec: number;
  maxLogLines: number;
  /** 사이드바 그룹(kind) 표시 순서(드래그로 변경). 항상 4개 다 있다고 가정하지 말 것 - resolveKindOrder 로 정규화해서 사용. */
  kindOrder: string[];
  /** git pull 방식: "merge"(기본 pull) | "rebase"(--rebase --autostash). 알 수 없는 값 방어는 resolvePullMode 로. */
  pullMode: string;
}

export type LogStream = "out" | "err" | "sys";

/** 백엔드 이벤트로 오는 원본 로그 줄(seq 없음) - store 의 append 시점에 서비스별 순번(seq)을 붙여 LogLine 이 됨. */
export interface RawLogLine {
  ts: number;
  stream: LogStream;
  text: string;
}

/** 화면 표시/검색/에러 패널 점프에 쓰는 로그 줄 - seq 는 서비스별 누적 순번(store.ts 의 assignSeq 참고). */
export interface LogLine extends RawLogLine {
  seq: number;
}

export interface GitInfo {
  branch: string;
  ahead: number;
  behind: number;
  dirty: boolean;
}

export interface LogEventPayload {
  id: string;
  lines: RawLogLine[];
}

export type StatusEventPayload =
  | { id: string; kind: "started"; pid: number }
  | { id: string; kind: "exited"; code: number | null };

export interface GitEventPayload {
  id: string;
  info: GitInfo;
}

export type ServiceStatus = "running" | "starting" | "external" | "stopped";

export interface PortCandidate {
  port: number;
  source: string;
}

export interface DirInfo {
  hasGradlew: boolean;
  hasMvnw: boolean;
  hasGradleBuild: boolean;
  hasPackageJson: boolean;
  npmHasDev: boolean;
  npmHasStart: boolean;
  hasNginxExe: boolean;
  suggestedCommand: string | null;
  portCandidates: PortCandidate[];
  gitBranch: string | null;
}
