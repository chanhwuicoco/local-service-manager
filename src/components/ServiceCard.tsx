import { deriveStatus, type ServiceRuntime } from "../store";
import { resolveKind } from "../lib/configDraft";

const STATUS_EMOJI: Record<string, string> = {
  running: "🟢",
  starting: "🟡",
  external: "🔵",
  stopped: "🔴",
};

interface Props {
  rt: ServiceRuntime;
  selected: boolean;
  busy?: boolean;
  onSelect: (id: string) => void;
  onStartStop: (id: string) => void;
  onRestart: (id: string) => void;
  onGitPull: (id: string) => void;
  onKillPort: (id: string) => void;
}

// 2줄 컴팩트 카드: 1줄=상태+이름(좌) / 버튼 2x2 그리드(우), 2줄=Port | 브랜치 ⬇N 정보줄.
// git 정보가 없는 폴더(비 git repo)는 브랜치·pull 뱃지·Git Pull 버튼을 전부 숨김(kind 무관, "git 정보 없음" 조건).
export default function ServiceCard({ rt, selected, busy, onSelect, onStartStop, onRestart, onGitPull, onKillPort }: Props) {
  const gitOnly = rt.config.command === null;
  // nginx 는 ■ Stop 이 추적 pid 유무와 무관하게(포트 기반 폴백 포함) 전용 종료 시퀀스를 항상 타므로
  // Kill Port(일반 taskkill)는 불필요하고, 오히려 워커만 죽이고 마스터가 되살리는 오동작을 유발할 수 있어
  // nginx 카드에서는 아예 버튼 자체를 숨김.
  const isNginx = resolveKind(rt.config) === "nginx";
  const status = deriveStatus(rt);
  const isExternal = status === "external";
  // pid 유무가 아니라 status 로 판단 - nginx 는 시작 직후 데몬화되어 pid 가 사라져도(포트만 열림) 실행 중인
  // 게 정상이라, pid 기준이면 이미 켜진 nginx 에 ▶ 를 또 눌러 중복 실행되는 버그가 있었음.
  const isActive = status === "running" || status === "starting";
  const isBusy = !!busy;
  // 경로 미설정 서비스는 git 정보 조회 자체를 스킵하므로(store.ts) branch 가 항상 "?" 로 확정됨 -
  // hasGit 이 자연히 false 가 돼서 Git Pull 버튼도 별도 처리 없이 자동으로 숨겨짐.
  const noCwd = !rt.config.cwd.trim();
  const hasGit = rt.git != null && rt.git.branch !== "?";
  const behindCount = rt.git?.behind ?? 0;
  const ahead = rt.git && rt.git.ahead > 0 ? ` ↑${rt.git.ahead}` : "";

  const primaryIcon = isActive ? "■" : "▶";
  const primaryTitle = noCwd
    ? "경로를 먼저 설정하세요"
    : isExternal
      ? "포트를 다른 프로세스가 사용 중 — Kill Port 후 시작"
      : isActive
        ? "Stop"
        : "Start";
  const primaryDisabled = isBusy || isExternal || noCwd;

  return (
    <div
      className={`service-card${selected ? " selected" : ""}`}
      data-testid={`service-card-${rt.config.id}`}
      onClick={() => onSelect(rt.config.id)}
    >
      <div className="service-card-main">
        <div className="service-card-title">
          {!gitOnly && <span className="status-emoji">{STATUS_EMOJI[status]}</span>}
          <span className="service-name">{rt.config.name}</span>
          {rt.unreadErrors > 0 && (
            <span className="error-badge" data-testid={`error-badge-${rt.config.id}`}>
              {rt.unreadErrors}
            </span>
          )}
        </div>
        <div className="service-card-sub">
          {noCwd ? (
            <span className="cwd-missing-notice">경로 설정이 필요합니다</span>
          ) : (
            <>
              {rt.config.port != null && <span>Port {rt.config.port}</span>}
              {rt.config.port != null && hasGit && <span> | </span>}
              {hasGit && (
                <span>
                  {rt.git!.branch}
                  {ahead}
                  {behindCount > 0 && <span className="behind-badge"> ⬇{behindCount}</span>}
                </span>
              )}
              {status === "stopped" && rt.lastExitCode != null && rt.lastExitCode !== 0 && (
                <span className="exit-code"> exit {rt.lastExitCode}</span>
              )}
            </>
          )}
        </div>
      </div>

      <div className="service-card-actions">
        {!gitOnly && (
          <button
            data-testid={`card-startstop-${rt.config.id}`}
            title={primaryTitle}
            disabled={primaryDisabled}
            onClick={(e) => {
              e.stopPropagation();
              onStartStop(rt.config.id);
            }}
          >
            <span className={`btn-icon${isActive ? " btn-icon-stop" : ""}`}>{primaryIcon}</span>
          </button>
        )}
        {!gitOnly && (
          <button
            data-testid={`card-restart-${rt.config.id}`}
            title="Restart"
            disabled={isBusy || !isActive || noCwd}
            onClick={(e) => {
              e.stopPropagation();
              onRestart(rt.config.id);
            }}
          >
            ⟳
          </button>
        )}
        {hasGit && (
          <button
            data-testid={`card-gitpull-${rt.config.id}`}
            title="Git Pull"
            disabled={isBusy}
            onClick={(e) => {
              e.stopPropagation();
              onGitPull(rt.config.id);
            }}
          >
            ⬇
          </button>
        )}
        {!gitOnly && !isNginx && rt.config.port != null && (
          <button
            data-testid={`card-killport-${rt.config.id}`}
            title="Kill Port"
            disabled={isBusy || !rt.portOpen}
            onClick={(e) => {
              e.stopPropagation();
              onKillPort(rt.config.id);
            }}
          >
            ❌
          </button>
        )}
      </div>
    </div>
  );
}
