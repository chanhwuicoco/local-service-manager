import { useState } from "react";
import type { DirInfo, ServiceConfig, ServiceKind } from "../types";
import {
  BACKEND_COMMAND,
  FRONTEND_COMMAND,
  FRONTEND_DEFAULT_CWD,
  FRONTEND_DEFAULT_PORT,
  NGINX_COMMAND,
  deriveShort,
  envRecordToText,
  envTextToRecord,
  resolveKind,
} from "../lib/configDraft";

// 환경 감지 결과를 버튼 옆 한 줄 요약으로. 포트는 현재 값과 후보 목록을 매칭해 출처를 붙임.
// 브랜치는 폴더 옆에 항상 별도 표시되므로 여기 요약에서는 제외.
function buildInspectSummary(info: DirInfo, currentPort: number | null): string {
  const kindLabel = info.hasGradlew || info.hasMvnw ? "백엔드" : info.hasPackageJson ? "프론트" : info.hasNginxExe ? "nginx" : "유형 미검출";
  const candidate = info.portCandidates.find((c) => c.port === currentPort);
  const portText = currentPort == null ? "포트 미검출" : candidate ? `포트 ${currentPort}(${candidate.source})` : `포트 ${currentPort}`;
  return `${kindLabel} · ${portText}`;
}

interface Props {
  svc: ServiceConfig;
  /** 폴더의 git 브랜치(readonly 표시용). 조회 전/git 저장소 아니면 null. */
  branch: string | null;
  onChange: (next: ServiceConfig) => void;
  onPickFolder: () => void;
  onInspect: () => void;
  inspecting: boolean;
  inspectError: string | null;
  dirInfo: DirInfo | null;
}

// key={item.key} 로 선택이 바뀔 때마다 새로 마운트되므로, env 원문 텍스트는 여기 로컬 state 로만 관리해도
// (record 로 즉시 변환 왕복 시 "KEY=" 처럼 미완성 줄이 사라지는 문제 없이) 안전함.
export default function ServiceEditForm({ svc, branch, onChange, onPickFolder, onInspect, inspecting, inspectError, dirInfo }: Props) {
  const [envText, setEnvText] = useState(() => envRecordToText(svc.env));
  const kind: ServiceKind = resolveKind(svc);
  const gitOnly = kind === "lib";
  const kindDefaultCommand = kind === "frontend" ? FRONTEND_COMMAND : kind === "nginx" ? NGINX_COMMAND : BACKEND_COMMAND;

  // 유형 전환은 kind 값만 바꿈(명령/포트는 건드리지 않고, LIB 은 필드 자체를 숨김 + 저장 시 normalizeForSave 가 정리).
  // LIB 에서 벗어날 때 command 가 null 로 남아있으면(과거 LIB 전용 데이터) 입력 가능하게 "" 로 되돌림.
  // 포트는 여기서 기본값을 즉시 확정하지 않음 - placeholder 로만 안내하고, 실제 값은 사용자 입력/환경 감지가 채우게 해서
  // "이미 값이 있어서 환경 감지가 안 덮어씀" 충돌을 피함(과거 프론트 기본포트 즉시커밋으로 환경 감지가 막히던 버그의 근본 원인).
  const handleKindChange = (nextKind: ServiceKind) => {
    const next: ServiceConfig = { ...svc, kind: nextKind };
    if (nextKind !== "lib" && next.command == null) {
      next.command = "";
    }
    if (nextKind === "frontend" && !next.cwd.trim()) {
      next.cwd = FRONTEND_DEFAULT_CWD;
    }
    onChange(next);
  };

  return (
    <div className="edit-form">
      <div className="field-pair">
        <label className="field">
          <span className="field-label">이름 *</span>
          <input type="text" value={svc.name} onChange={(e) => onChange({ ...svc, name: e.target.value })} />
        </label>

        <label className="field">
          <span className="field-label">
            약칭 <span className="field-hint-inline">(사이드바 접힘 시, 최대 3자)</span>
          </span>
          <input
            type="text"
            maxLength={3}
            placeholder={deriveShort(svc.name) || "예: CMS"}
            value={svc.short ?? ""}
            onChange={(e) => {
              const v = e.target.value.slice(0, 3);
              onChange({ ...svc, short: v === "" ? undefined : v });
            }}
          />
        </label>
      </div>

      <label className="field">
        <span className="field-label">폴더</span>
        <div className="field-row">
          <input type="text" value={svc.cwd} onChange={(e) => onChange({ ...svc, cwd: e.target.value })} />
          <button type="button" onClick={onPickFolder}>
            폴더 선택
          </button>
          {/* LIB 은 감지할 게 브랜치뿐인데 브랜치는 옆에 항상 표시되므로 환경 감지 버튼 자체가 불필요.
              폴더가 비어있으면(disabled 조건에 이미 포함) 뭘 감지할 대상이 없어서도 막힘. */}
          {!gitOnly && (
            <button type="button" onClick={onInspect} disabled={!svc.cwd.trim() || inspecting}>
              {inspecting ? "감지 중..." : "환경 감지"}
            </button>
          )}
          <span className="branch-label">현재 Branch</span>
          <input type="text" className="branch-readonly" readOnly title="Git 브랜치" value={branch ?? "-"} />
        </div>
        {!svc.cwd.trim() && <div className="field-cwd-notice">경로 설정이 필요합니다</div>}
        {inspectError && <div className="field-error">{inspectError}</div>}
        {dirInfo && <div className="field-hint">{buildInspectSummary(dirInfo, svc.port)}</div>}
      </label>

      <div className="field">
        <span className="field-label">유형</span>
        <div className="field-radio-group">
          <label className="radio-option">
            <input
              type="radio"
              name="service-kind"
              checked={kind === "backend"}
              onChange={() => handleKindChange("backend")}
            />
            백엔드
          </label>
          <label className="radio-option">
            <input
              type="radio"
              name="service-kind"
              checked={kind === "frontend"}
              onChange={() => handleKindChange("frontend")}
            />
            프론트
          </label>
          <label className="radio-option">
            <input type="radio" name="service-kind" checked={kind === "lib"} onChange={() => handleKindChange("lib")} />
            LIB
          </label>
          <label className="radio-option">
            <input
              type="radio"
              name="service-kind"
              checked={kind === "nginx"}
              onChange={() => handleKindChange("nginx")}
            />
            nginx
          </label>
        </div>
      </div>

      {!gitOnly && (
        <>
          <label className="field">
            <span className="field-label">
              실행 명령 <span className="field-hint-inline">(비워두면 유형 기본값)</span>
            </span>
            <input
              type="text"
              placeholder={kindDefaultCommand}
              value={svc.command ?? ""}
              onChange={(e) => onChange({ ...svc, command: e.target.value })}
            />
          </label>

          <label className="field">
            <span className="field-label">
              포트{kind === "frontend" ? <span className="field-hint-inline"> (선택)</span> : " *"}
            </span>
            <input
              type="number"
              min={1}
              max={65535}
              placeholder={kind === "frontend" ? String(FRONTEND_DEFAULT_PORT) : undefined}
              value={svc.port ?? ""}
              onChange={(e) => onChange({ ...svc, port: e.target.value === "" ? null : Number(e.target.value) })}
            />
          </label>

          <label className="field">
            <span className="field-label">환경변수 (KEY=VALUE, 줄바꿈으로 구분)</span>
            <textarea
              rows={4}
              value={envText}
              onChange={(e) => {
                setEnvText(e.target.value);
                onChange({ ...svc, env: envTextToRecord(e.target.value) });
              }}
            />
          </label>
        </>
      )}
    </div>
  );
}
