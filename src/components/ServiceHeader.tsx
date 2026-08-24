import { useEffect, useState, type ReactNode } from "react";
import { deriveStatus, useStore } from "../store";
import { formatMinutesAgo } from "../lib/configDraft";

const STATUS_EMOJI: Record<string, string> = {
  running: "🟢",
  starting: "🟡",
  external: "🔵",
  stopped: "🔴",
};

export default function ServiceHeader() {
  const selectedId = useStore((s) => s.selectedId);
  const services = useStore((s) => s.services);
  const lastGitFetchAt = useStore((s) => s.lastGitFetchAt);

  // "마지막 git fetch: N분 전" 문구가 시간 경과에 따라 갱신되도록(값 자체는 안 바뀌어도) 30초마다 강제 리렌더.
  // Hooks 규칙상 아래 "if (!rt) return" 보다 반드시 앞에 있어야 함.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => forceTick((n) => n + 1), 30000);
    return () => clearInterval(timer);
  }, []);

  const rt = selectedId ? services[selectedId] : undefined;
  if (!rt) {
    return <div className="service-header service-header-empty">서비스를 선택하세요</div>;
  }

  const gitOnly = rt.config.command === null;
  const status = deriveStatus(rt);
  const hasGit = rt.git != null && rt.git.branch !== "?";
  const behindCount = rt.git?.behind ?? 0;
  const ahead = rt.git && rt.git.ahead > 0 ? ` ↑${rt.git.ahead}` : "";
  // git 정보 없는 서비스는 fetch 시각 자체가 의미 없어 미표시. 아직 한 번도 fetch 안 됐으면(값 없음)도 미표시.
  const fetchedAt = hasGit && selectedId ? lastGitFetchAt[selectedId] : undefined;

  // git 정보 없는 폴더(비 git repo)는 branch 항목 자체를 안 넣음 - 안내 문구도 없이 조용히 생략.
  const metaParts: { key: string; node: ReactNode }[] = [];
  if (rt.config.port != null) metaParts.push({ key: "port", node: <>Port: {rt.config.port}</> });
  if (rt.pid != null) metaParts.push({ key: "pid", node: <>PID: {rt.pid}</> });
  if (hasGit) {
    metaParts.push({
      key: "branch",
      node: (
        <>
          Branch: {rt.git!.branch}
          {behindCount > 0 && <span className="behind-count"> ↓{behindCount}</span>}
          {ahead}
        </>
      ),
    });
  }

  return (
    <div className="service-header">
      <div className="service-header-title">
        {!gitOnly && <span className="status-emoji">{STATUS_EMOJI[status]}</span>}
        <span className="service-name">{rt.config.name}</span>
        {metaParts.length > 0 && (
          <span className="service-header-meta">
            (
            {metaParts.map((p, i) => (
              <span key={p.key}>
                {p.node}
                {i < metaParts.length - 1 && " | "}
              </span>
            ))}
            )
          </span>
        )}
        {fetchedAt != null && (
          <span className="service-header-fetch-time">마지막 git fetch: {formatMinutesAgo(fetchedAt, Date.now())}</span>
        )}
      </div>
    </div>
  );
}
