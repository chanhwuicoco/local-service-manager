import { useEffect, useState } from "react";
import { useStore } from "../store";
import { backend } from "../lib/backend";
import type { AppConfig, DirInfo, ServiceConfig } from "../types";
import {
  GIT_FETCH_INTERVAL_OPTIONS,
  MAX_LOG_LINES_OPTIONS,
  RAIL_GROUP_LABEL,
  makeBlankService,
  normalizeForSave,
  resolveIncludeInAll,
  resolveKind,
  resolvePullMode,
  validateDraftConfig,
} from "../lib/configDraft";
import ServiceEditForm from "./ServiceEditForm";

interface DraftItem {
  key: string; // 기존 서비스는 로드 시점의 원래 id(편집해도 안 바뀜), 신규 서비스는 임시 키
  svc: ServiceConfig;
}

interface GeneralDraft {
  startStaggerMs: number;
  gitFetchIntervalSec: number;
  maxLogLines: number;
  pullMode: "merge" | "rebase";
}

export default function ServiceManageModal() {
  const open = useStore((s) => s.manageModalOpen);
  const closeManageModal = useStore((s) => s.closeManageModal);
  const config = useStore((s) => s.config);
  const services = useStore((s) => s.services);
  const saveConfig = useStore((s) => s.saveConfig);
  const reloadConfig = useStore((s) => s.reloadConfig);
  const sidebarSelectedId = useStore((s) => s.selectedId);
  const showToast = useStore((s) => s.showToast);

  const [tab, setTab] = useState<"services" | "general">("services");
  const [draftItems, setDraftItems] = useState<DraftItem[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [general, setGeneral] = useState<GeneralDraft>({ startStaggerMs: 1500, gitFetchIntervalSec: 300, maxLogLines: 10000, pullMode: "rebase" });
  const [dirInfoByKey, setDirInfoByKey] = useState<Record<string, DirInfo>>({});
  const [branchByKey, setBranchByKey] = useState<Record<string, string | null>>({});
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 모달을 열 때마다 현재 config 에서 새로 복제 — 취소 시 draft 는 그냥 버려짐.
  useEffect(() => {
    if (!open || !config) return;
    setDraftItems(config.services.map((s) => ({ key: s.id, svc: { ...s, env: { ...s.env } } })));
    // 모달을 열 때 사이드바에서 이미 선택돼 있던 서비스가 있으면(목록에 실제로 존재할 때만) 그대로
    // 선택된 상태로 열어 편집 폼이 바로 보이게 함 - 선택된 카드가 없으면 기존처럼 첫 번째 서비스.
    // sidebarSelectedId 는 effect deps 에 일부러 안 넣음(모달이 열려있는 동안 바뀌어도 draft 를 갈아엎지 않기 위함) -
    // "열리는 시점" 값만 의미가 있어 open/config 변화 때만 이 effect 가 재실행되면 충분함.
    const preselect =
      sidebarSelectedId && config.services.some((s) => s.id === sidebarSelectedId) ? sidebarSelectedId : (config.services[0]?.id ?? null);
    setSelectedKey(preselect);
    setGeneral({
      startStaggerMs: config.startStaggerMs,
      gitFetchIntervalSec: config.gitFetchIntervalSec,
      maxLogLines: config.maxLogLines,
      pullMode: resolvePullMode(config.pullMode),
    });
    setDirInfoByKey({});
    setBranchByKey({});
    setInspectError(null);
    setSaveError(null);
    setTab("services");
  }, [open, config]);

  const selectedIdx = draftItems.findIndex((it) => it.key === selectedKey);
  const selectedItem = selectedIdx >= 0 ? draftItems[selectedIdx] : null;

  // 폴더 옆 브랜치 readonly 표시: 선택된 항목이 바뀌거나 cwd 가 바뀌면(폴더 선택·직접 타이핑 모두) 자동 조회.
  // 타이핑 중 매 키 입력마다 git 을 부르지 않게 짧게 debounce. 모든 kind 공통(LIB 포함).
  // Hooks 규칙상 아래 "if (!open) return null" 보다 반드시 앞에 있어야 함.
  useEffect(() => {
    if (!open || !selectedItem) return;
    const key = selectedItem.key;
    const cwd = selectedItem.svc.cwd;
    if (!cwd.trim()) {
      setBranchByKey((m) => ({ ...m, [key]: null }));
      return;
    }
    const timer = setTimeout(() => {
      void backend
        .inspectDir(cwd)
        .then((info) => setBranchByKey((m) => ({ ...m, [key]: info.gitBranch })))
        .catch(() => setBranchByKey((m) => ({ ...m, [key]: null })));
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedItem?.key, selectedItem?.svc.cwd]);

  // Esc 로도 닫히게 - 취소/X 버튼과 완전히 동일한 처리(저장 없이 닫기, 저장 중엔 막음).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) {
        closeManageModal();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, saving, closeManageModal]);

  if (!open) return null;

  const isSelectedRunning = !!selectedItem && services[selectedItem.key]?.pid != null;

  const handleItemChange = (next: ServiceConfig) => {
    setDraftItems((items) => items.map((it) => (it.key === selectedKey ? { ...it, svc: next } : it)));
  };

  // All(Start/Stop/Pull All) 포함 여부 토글 - 선택된 항목이 아니라 목록의 아무 행이나 바로 바뀔 수 있어
  // handleItemChange 와 별개로 key 를 직접 받음.
  const handleToggleIncludeInAll = (key: string, checked: boolean) => {
    setDraftItems((items) => items.map((it) => (it.key === key ? { ...it, svc: { ...it.svc, includeInAll: checked } } : it)));
  };

  const move = (dir: -1 | 1) => {
    if (selectedIdx < 0) return;
    const j = selectedIdx + dir;
    if (j < 0 || j >= draftItems.length) return;
    setDraftItems((items) => {
      const next = items.slice();
      [next[selectedIdx], next[j]] = [next[j], next[selectedIdx]];
      return next;
    });
  };

  const addItem = () => {
    // id 는 makeBlankService() 안에서 UUID 로 한 번 발급되고 이후 불변 - draft key 로 그대로 재사용.
    const svc = makeBlankService();
    setDraftItems((items) => [...items, { key: svc.id, svc }]);
    setSelectedKey(svc.id);
  };

  const removeSelected = () => {
    if (!selectedItem || isSelectedRunning) return;
    const removedKey = selectedItem.key;
    const next = draftItems.filter((it) => it.key !== removedKey);
    setDraftItems(next);
    setSelectedKey(next[0]?.key ?? null);
    setDirInfoByKey((m) => {
      const { [removedKey]: _removed, ...rest } = m;
      return rest;
    });
    setBranchByKey((m) => {
      const { [removedKey]: _removed, ...rest } = m;
      return rest;
    });
  };

  const handlePickFolder = async () => {
    // 기존 cwd 가 있으면 그 폴더에서 dialog 가 열리게(없으면 기존 동작대로 마지막 위치).
    const path = await backend.pickFolder(selectedItem?.svc.cwd || undefined);
    if (path && selectedItem) {
      handleItemChange({ ...selectedItem.svc, cwd: path });
    }
  };

  const handleInspect = async () => {
    if (!selectedItem || !selectedItem.svc.cwd) return;
    const key = selectedItem.key;
    setInspecting(true);
    setInspectError(null);
    try {
      const info = await backend.inspectDir(selectedItem.svc.cwd);
      setDirInfoByKey((m) => ({ ...m, [key]: info }));
      setBranchByKey((m) => ({ ...m, [key]: info.gitBranch })); // 폴더 옆 브랜치 표시도 같이 최신화
      // 명령은 건드리지 않음(placeholder 가 대신함). kind 자동 세팅 + 포트는 비어있을 때만 후보로 채움.
      // 이미 LIB 전용으로 명시했으면(사용자 의도) 감지 결과로 덮어쓰지 않음.
      const next: ServiceConfig = { ...selectedItem.svc };
      if (resolveKind(next) !== "lib") {
        if (info.hasGradlew || info.hasMvnw) next.kind = "backend";
        else if (info.hasPackageJson) next.kind = "frontend";
        else if (info.hasNginxExe) next.kind = "nginx";
      }
      // portCandidates 는 이미 application-local.* 우선 정렬되어 있어 [0] 이 곧 최우선 후보.
      // 후보가 있으면 기존 값 여부와 무관하게 항상 최우선 후보로 덮어씀(칩 UI 없이 요약 줄의 출처 표시로 대체).
      if (info.portCandidates.length > 0) {
        next.port = info.portCandidates[0].port;
      }
      handleItemChange(next);
    } catch (e) {
      setInspectError(e instanceof Error ? e.message : String(e));
    } finally {
      setInspecting(false);
    }
  };

  const handleSave = async () => {
    // 삭제 버튼은 실행 중이면 이미 disabled 지만, 저장 시점에도 한 번 더 막아 안전하게.
    const draftKeys = new Set(draftItems.map((it) => it.key));
    const missingRunning = Object.entries(services)
      .filter(([id, rt]) => rt.pid != null && !draftKeys.has(id))
      .map(([id]) => id);
    if (missingRunning.length > 0) {
      setSaveError(`실행 중인 서비스는 삭제할 수 없습니다: ${missingRunning.join(", ")}`);
      return;
    }

    const nextConfig: AppConfig = {
      services: draftItems.map((it) => normalizeForSave(it.svc)),
      startStaggerMs: general.startStaggerMs,
      gitFetchIntervalSec: general.gitFetchIntervalSec,
      maxLogLines: general.maxLogLines,
      kindOrder: config?.kindOrder ?? ["backend", "frontend", "lib", "nginx"],
      pullMode: general.pullMode,
    };
    const err = validateDraftConfig(nextConfig);
    if (err) {
      setSaveError(err);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await saveConfig(nextConfig);
      closeManageModal();
      // 모달 저장 버튼 명시 저장에서만 토스트 - DnD 자동 저장(ServiceList.tsx)은 saveConfig 를 직접
      // 호출하지 이 handleSave 를 안 거치므로 매 드래그마다 뜨는 일은 없음.
      showToast("저장되었습니다");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" data-testid="manage-modal">
      <div className="modal manage-modal">
        <div className="manage-header">
          <h2>서비스 관리</h2>
          <div className="manage-header-right">
            <div className="manage-tabs">
              <button
                type="button"
                className={`tab-btn${tab === "services" ? " active" : ""}`}
                onClick={() => setTab("services")}
              >
                서비스 목록
              </button>
              <button
                type="button"
                className={`tab-btn${tab === "general" ? " active" : ""}`}
                onClick={() => setTab("general")}
              >
                일반 설정
              </button>
            </div>
            {/* 취소와 완전히 동일하게 저장 없이 닫기 - disabled 조건도 취소 버튼과 동일하게 저장 중엔 막음. */}
            <button
              type="button"
              className="modal-close-btn"
              title="닫기 (Esc)"
              aria-label="닫기"
              disabled={saving}
              onClick={closeManageModal}
            >
              ✕
            </button>
          </div>
        </div>

        <div className="manage-content">
        {tab === "services" ? (
          <div className="manage-body">
            <div className="manage-list-col">
              <div className="manage-list-col-header">
                <span className="manage-list-col-title">목록</span>
                <span className="manage-list-col-hint">All: Start · Stop · Pull All 대상</span>
              </div>
              <div className="manage-list">
                {draftItems.map((item) => {
                  const kind = resolveKind(item.svc);
                  const includeInAll = resolveIncludeInAll(item.svc);
                  return (
                    <div
                      key={item.key}
                      className={`manage-list-item${item.key === selectedKey ? " selected" : ""}`}
                      onClick={() => setSelectedKey(item.key)}
                    >
                      <span className="manage-list-kind">{RAIL_GROUP_LABEL[kind]}</span>
                      <span className="manage-list-name">{item.svc.name || "(이름 없음)"}</span>
                      {item.svc.port != null && <span className="manage-list-port">:{item.svc.port}</span>}
                      <span className="manage-batch-chips">
                        <button
                          type="button"
                          className={`batch-chip${includeInAll ? " active" : ""}`}
                          title={includeInAll ? "Start/Stop/Pull All 대상 포함" : "Start/Stop/Pull All 대상 제외"}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleIncludeInAll(item.key, !includeInAll);
                          }}
                        >
                          {includeInAll ? "✓ All" : "All"}
                        </button>
                      </span>
                    </div>
                  );
                })}
                {draftItems.length === 0 && <div className="manage-list-empty">서비스가 없습니다.</div>}
              </div>
              <div className="manage-list-actions">
                <button type="button" onClick={() => move(-1)} disabled={selectedIdx <= 0}>
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => move(1)}
                  disabled={selectedIdx < 0 || selectedIdx >= draftItems.length - 1}
                >
                  ▼
                </button>
                <button type="button" onClick={addItem}>
                  + 추가
                </button>
                <button
                  type="button"
                  onClick={removeSelected}
                  disabled={!selectedItem || isSelectedRunning}
                  title={isSelectedRunning ? "실행 중인 서비스는 중지 후 삭제" : undefined}
                >
                  삭제
                </button>
              </div>
            </div>

            <div className="manage-form-col">
              {selectedItem ? (
                <ServiceEditForm
                  key={selectedItem.key}
                  svc={selectedItem.svc}
                  branch={branchByKey[selectedItem.key] ?? null}
                  onChange={handleItemChange}
                  onPickFolder={() => void handlePickFolder()}
                  onInspect={() => void handleInspect()}
                  inspecting={inspecting}
                  inspectError={inspectError}
                  dirInfo={dirInfoByKey[selectedItem.key] ?? null}
                />
              ) : (
                <div className="manage-form-empty">왼쪽에서 서비스를 선택하거나 추가하세요.</div>
              )}
            </div>
          </div>
        ) : (
          <div className="general-settings">
            <label className="field">
              <span className="field-label">
                로그 최대 줄 수
                {general.maxLogLines === 0 && <span className="field-hint-inline"> (메모리 계속 증가)</span>}
              </span>
              <select
                value={general.maxLogLines}
                onChange={(e) => setGeneral((g) => ({ ...g, maxLogLines: Number(e.target.value) }))}
              >
                {MAX_LOG_LINES_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field-label">git fetch 주기</span>
              <select
                value={general.gitFetchIntervalSec}
                onChange={(e) => setGeneral((g) => ({ ...g, gitFetchIntervalSec: Number(e.target.value) }))}
              >
                {GIT_FETCH_INTERVAL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field-label">Start All 순차 간격 (ms)</span>
              <input
                type="number"
                min={0}
                step={100}
                value={general.startStaggerMs}
                onChange={(e) => setGeneral((g) => ({ ...g, startStaggerMs: Number(e.target.value) || 0 }))}
              />
            </label>

            <div className="field">
              <span className="field-label">Git Pull 방식</span>
              <div className="field-radio-group">
                <label className="radio-option">
                  <input
                    type="radio"
                    name="pull-mode"
                    checked={general.pullMode === "merge"}
                    onChange={() => setGeneral((g) => ({ ...g, pullMode: "merge" }))}
                  />
                  기본 (git pull)
                </label>
                <label className="radio-option">
                  <input
                    type="radio"
                    name="pull-mode"
                    checked={general.pullMode === "rebase"}
                    onChange={() => setGeneral((g) => ({ ...g, pullMode: "rebase" }))}
                  />
                  git pull --rebase --autostash
                </label>
              </div>
            </div>
          </div>
        )}
        </div>

        {saveError && <div className="manage-error">{saveError}</div>}

        <div className="manage-footer">
          <div className="manage-footer-links">
            <button type="button" className="link-btn" onClick={() => void backend.openConfigFile()}>
              config.json 직접 열기
            </button>
            <button type="button" className="link-btn" onClick={() => void reloadConfig()}>
              설정 다시 불러오기
            </button>
          </div>
          <div className="manage-footer-actions">
            <button type="button" onClick={closeManageModal} disabled={saving}>
              취소
            </button>
            <button type="button" onClick={() => void handleSave()} disabled={saving}>
              {saving ? "저장 중..." : "저장"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
