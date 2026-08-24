import { useState } from "react";
import { deriveStatus, useStore, type ServiceRuntime } from "../store";
import { KIND_GROUP_LABEL, RAIL_GROUP_LABEL, deriveShort, groupServiceIds, moveToSlot, resolveKind, resolveKindOrder } from "../lib/configDraft";
import type { ServiceKind } from "../types";
import ServiceCard from "./ServiceCard";

const STATUS_EMOJI: Record<string, string> = {
  running: "🟢",
  starting: "🟡",
  external: "🔵",
  stopped: "🔴",
};

export default function ServiceList() {
  const order = useStore((s) => s.order);
  const services = useStore((s) => s.services);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const start = useStore((s) => s.start);
  const stop = useStore((s) => s.stop);
  const restart = useStore((s) => s.restart);
  const killPort = useStore((s) => s.killPort);
  const gitPull = useStore((s) => s.gitPull);
  const busy = useStore((s) => s.busy);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);

  // 카드 드래그 상태 - 섹션과 동일한 "그 자리를 차지한다" 슬롯 방식(밀어내기), before/after 삽입 라인 없음.
  const [draggedCardId, setDraggedCardId] = useState<string | null>(null);
  const [cardHoverId, setCardHoverId] = useState<string | null>(null);
  // 그룹 헤더 드래그 상태 - "그 자리를 차지한다" 방식: 올려놓은 그룹의 자리로 이동(밀어내기), before/after 없음.
  const [draggedSectionKind, setDraggedSectionKind] = useState<ServiceKind | null>(null);
  const [sectionHoverKind, setSectionHoverKind] = useState<ServiceKind | null>(null);

  const kindOf = (id: string) => {
    const rt = services[id];
    return rt ? resolveKind(rt.config) : null;
  };
  const kindOrder = resolveKindOrder(config?.kindOrder);
  const groups = groupServiceIds(order, kindOf, kindOrder);

  // 실제 계산은 pure 함수(moveToSlot, configDraft.ts 에서 단위테스트로 전수 검증됨)로 위임 - 카드는
  // order(전체 서비스 id 플랫 배열) 기준으로 계산하되, 호출부에서 같은 그룹(kind) 카드끼리만 걸러서 부름.
  const computeCardOrder = (targetId: string): string[] => {
    if (draggedCardId == null) return order;
    return moveToSlot(order, draggedCardId, targetId);
  };

  // 다른 그룹 카드 위 드롭은 애초에 호출 안 됨(호출부에서 kindOf 비교로 막음) - 결과가 현재와 같으면 no-op.
  const isMeaningfulCardTarget = (targetId: string): boolean => {
    if (!draggedCardId || draggedCardId === targetId) return false;
    const next = computeCardOrder(targetId);
    return next.some((id, i) => id !== order[i]);
  };

  const moveCardTo = (targetId: string) => {
    if (!config || !draggedCardId) return;
    const next = computeCardOrder(targetId);
    const newServices = next.map((id) => services[id]?.config).filter((c): c is NonNullable<typeof c> => !!c);
    void saveConfig({ ...config, services: newServices });
  };

  // 실제 계산은 pure 함수(moveToSlot, configDraft.ts 에서 단위테스트로 전수 검증됨)로 위임 -
  // 여기선 draggedSectionKind 가 null 인 미드래그 상태만 방어.
  const computeSectionOrder = (targetKind: ServiceKind): ServiceKind[] => {
    if (draggedSectionKind == null) return kindOrder;
    return moveToSlot(kindOrder, draggedSectionKind, targetKind);
  };

  // 결과가 현재 순서와 똑같으면(자기 자신 위 등) no-op - 아무 표시도 하지 않음.
  const isMeaningfulSectionTarget = (targetKind: ServiceKind): boolean => {
    if (!draggedSectionKind || draggedSectionKind === targetKind) return false;
    const next = computeSectionOrder(targetKind);
    return next.some((k, i) => k !== kindOrder[i]);
  };

  const moveSectionTo = (targetKind: ServiceKind) => {
    if (!config || !draggedSectionKind) return;
    const next = computeSectionOrder(targetKind);
    void saveConfig({ ...config, kindOrder: next });
  };

  const clearCardDrag = () => {
    setDraggedCardId(null);
    setCardHoverId(null);
  };
  const clearSectionDrag = () => {
    setDraggedSectionKind(null);
    setSectionHoverKind(null);
  };

  return (
    <aside className={`sidebar${collapsed ? " collapsed" : ""}`}>
      <div className="sidebar-header">
        {!collapsed && <div className="sidebar-title">SERVICES</div>}
        <button
          className="sidebar-toggle"
          data-testid="sidebar-toggle"
          title={collapsed ? "펼치기 (Ctrl+B)" : "접기 (Ctrl+B)"}
          onClick={toggleSidebar}
        >
          {collapsed ? "▶" : "◀"}
        </button>
      </div>
      {collapsed ? (
        // 접힘 레일에는 DnD 없음(요구사항) - 기존 그대로.
        <div className="rail-list">
          {groups.map((group, gi) => (
            <div className="rail-group" key={group.kind}>
              {gi > 0 && <div className="rail-group-divider" aria-hidden="true" />}
              <div className="rail-group-label">{RAIL_GROUP_LABEL[group.kind]}</div>
              {group.ids.map((id) => renderRailItem(id, services[id], id === selectedId, select))}
            </div>
          ))}
        </div>
      ) : (
        <div className="card-list">
          {groups.map((group) => {
            const isSectionDropTarget = isMeaningfulSectionTarget(group.kind);
            return (
              <div
                key={group.kind}
                className={`card-group${sectionHoverKind === group.kind ? " section-drop-target" : ""}`}
                // 섹션 드롭 존은 그룹 전체(헤더+카드들) - "그 자리를 차지한다" 방식이라 위치 계산 없이
                // 이 그룹 위에 놓으면 무조건 이 그룹의 자리로 이동. 결과가 현재와 같으면(no-op) 아예
                // 반응하지 않아서(preventDefault 를 안 함) 하이라이트도 안 뜨고 드롭도 안 먹음.
                onDragOver={(e) => {
                  if (!isSectionDropTarget) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setSectionHoverKind(group.kind);
                }}
                onDragLeave={(e) => {
                  // 그룹 내부(자식)로 이동하는 것도 dragleave 를 유발하므로, 실제로 이 그룹 밖으로
                  // 나갈 때만(relatedTarget 이 이 그룹 밖) 하이라이트를 지움 - 안 그러면 깜빡거림.
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    setSectionHoverKind((k) => (k === group.kind ? null : k));
                  }
                }}
                onDrop={(e) => {
                  if (!isSectionDropTarget) return;
                  e.preventDefault();
                  moveSectionTo(group.kind);
                  clearSectionDrag();
                }}
              >
                <div
                  className={`card-group-label${draggedSectionKind === group.kind ? " dragging" : ""}`}
                  draggable
                  title="드래그해서 그룹 순서 변경"
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", group.kind);
                    setDraggedSectionKind(group.kind);
                  }}
                  onDragEnd={clearSectionDrag}
                >
                  <span className="drag-handle" aria-hidden="true">
                    ⠿
                  </span>
                  {KIND_GROUP_LABEL[group.kind]}
                </div>
                {group.ids.map((id) => {
                  const rt = services[id];
                  if (!rt) return null;
                  const isCardDropTarget = draggedCardId != null && kindOf(draggedCardId) === group.kind && isMeaningfulCardTarget(id);
                  return (
                    <div
                      key={id}
                      className={`card-drag-wrap${draggedCardId === id ? " dragging" : ""}${cardHoverId === id ? " drop-target" : ""}`}
                      draggable
                      onDragStart={(e) => {
                        // 카드 버튼(시작/정지/재시작/pull/kill 등) 위에서 드래그가 시작되면 취소 - 클릭 판정과 안 겹치게.
                        if ((e.target as HTMLElement).closest(".service-card-actions")) {
                          e.preventDefault();
                          return;
                        }
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", id);
                        setDraggedCardId(id);
                      }}
                      onDragOver={(e) => {
                        // 다른 그룹(kind) 카드 위로는 드롭 불가 - preventDefault 를 안 해서 브라우저가 자연히 막고,
                        // 이벤트는 그대로 버블링돼서 위쪽 그룹의 섹션 드롭 핸들러로 넘어감(섹션 드래그 중일 때만 반응).
                        // 결과가 현재와 같은 no-op(자기 자신 등) 도 마찬가지로 반응 안 함 - 하이라이트/드롭 둘 다 없음.
                        if (!isCardDropTarget) return;
                        e.preventDefault();
                        e.stopPropagation();
                        e.dataTransfer.dropEffect = "move";
                        setCardHoverId(id);
                      }}
                      onDragLeave={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                          setCardHoverId((h) => (h === id ? null : h));
                        }
                      }}
                      onDrop={(e) => {
                        if (!isCardDropTarget) return;
                        e.preventDefault();
                        e.stopPropagation();
                        moveCardTo(id);
                        clearCardDrag();
                      }}
                      onDragEnd={clearCardDrag}
                    >
                      <ServiceCard
                        rt={rt}
                        selected={id === selectedId}
                        busy={!!busy[id]}
                        onSelect={select}
                        onStartStop={(sid) => {
                          const target = services[sid];
                          if (!target) return;
                          // pid 유무가 아니라 status 로 판단(nginx 는 포트만 열려도 running) - ServiceCard 의
                          // 아이콘/타이틀 표시와 반드시 같은 기준을 써야 "▶ 표시인데 실제로는 stop 됨" 같은 불일치가 없음.
                          const status = deriveStatus(target);
                          if (status === "running" || status === "starting") void stop(sid);
                          else void start(sid);
                        }}
                        onRestart={(sid) => void restart(sid)}
                        onGitPull={(sid) => void gitPull(sid)}
                        onKillPort={(sid) => void killPort(sid)}
                      />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}

function renderRailItem(id: string, rt: ServiceRuntime | undefined, selected: boolean, select: (id: string) => void) {
  if (!rt) return null;
  const gitOnly = rt.config.command === null;
  const status = deriveStatus(rt);
  const behind = rt.git?.behind ?? 0;
  const abbrev = (rt.config.short?.trim() || deriveShort(rt.config.name)).slice(0, 3);
  return (
    <button
      key={id}
      type="button"
      className={`rail-item${selected ? " selected" : ""}`}
      title={rt.config.name}
      data-testid={`rail-item-${id}`}
      onClick={() => select(id)}
    >
      {!gitOnly && <span className="status-emoji">{STATUS_EMOJI[status]}</span>}
      <span className={`rail-initials${abbrev.length >= 3 ? " rail-initials-3" : ""}`}>{abbrev}</span>
      {behind > 0 && (
        <span className="rail-dot" aria-hidden="true">
          ↓
        </span>
      )}
    </button>
  );
}
