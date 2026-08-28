import { describe, expect, it } from "vitest";
import { formatMinutesAgo, LOG_CLEAR_LABEL, moveKindToSlot, moveToSlot, validateDraftConfig } from "./configDraft";
import type { AppConfig, ServiceConfig, ServiceKind } from "../types";

const ORDER: ServiceKind[] = ["backend", "frontend", "lib", "nginx"];

describe("moveKindToSlot", () => {
  // 4개 그룹 x 모든 (i,j) i!=j 조합(12개) 전수 검증: dragged 가 정확히 target 의 "원본 인덱스" 로 가야 함.
  for (let i = 0; i < ORDER.length; i++) {
    for (let j = 0; j < ORDER.length; j++) {
      if (i === j) continue;
      it(`moves index ${i} (${ORDER[i]}) to exactly index ${j} (${ORDER[j]})'s original slot`, () => {
        const dragged = ORDER[i];
        const target = ORDER[j];
        const result = moveKindToSlot(ORDER, dragged, target);

        // dragged 가 정확히 j 위치에 와야 함(이게 "슬롯 차지"의 핵심 - 예전 버그는 아래 방향에서 한 칸 모자랐음).
        expect(result.indexOf(dragged)).toBe(j);
        // 원소 집합은 그대로 유지(유실/중복 없음).
        expect([...result].sort()).toEqual([...ORDER].sort());
        // i !== j 인 모든 조합은 반드시 순서가 바뀌어야 함(예전 버그: 특정 인접 케이스가 no-op 으로 오판됨).
        expect(result).not.toEqual(ORDER);
      });
    }
  }

  it("dragging onto itself is a true no-op (only self case)", () => {
    for (const kind of ORDER) {
      expect(moveKindToSlot(ORDER, kind, kind)).toEqual(ORDER);
    }
  });

  it("returns original order when target kind is not present", () => {
    const result = moveKindToSlot(["backend", "lib"], "backend", "nginx" as ServiceKind);
    expect(result).toEqual(["backend", "lib"]);
  });

  it("returns original order when dragged kind is not present", () => {
    const result = moveKindToSlot(["backend", "lib"], "nginx" as ServiceKind, "backend");
    expect(result).toEqual(["backend", "lib"]);
  });

  // 사용자가 실제로 재현한 시나리오: nginx 가 2번째(index 1)일 때.
  describe("user-reported scenario: nginx is 2nd of [backend, nginx, lib, frontend]", () => {
    const order: ServiceKind[] = ["backend", "nginx", "lib", "frontend"];

    it("nginx onto the 4th (last) group actually reaches last place", () => {
      const result = moveKindToSlot(order, "nginx", "frontend");
      expect(result).toEqual(["backend", "lib", "frontend", "nginx"]);
    });

    it("nginx onto the 3rd group is a real move, not a no-op", () => {
      const result = moveKindToSlot(order, "nginx", "lib");
      expect(result).toEqual(["backend", "lib", "nginx", "frontend"]);
      expect(result).not.toEqual(order);
    });

    it("nginx onto the 1st group (upward) still works as before", () => {
      const result = moveKindToSlot(order, "nginx", "backend");
      expect(result).toEqual(["nginx", "backend", "lib", "frontend"]);
    });
  });
});

// ServiceList.tsx 의 카드 DnD 는 moveKindToSlot 이 아니라 이 제네릭 moveToSlot 을 서비스 id 플랫 배열(order)에
// 그대로 적용함(섹션과 동일한 슬롯 방식으로 통일) - 다른 kind 카드가 사이사이 섞여 있어도 같은 kind 카드끼리의
// 상대 순서 재계산이 올바른지가 핵심(호출부는 같은 kind 끼리만 부르도록 걸러주지만, 함수 자체는 배열 전체 기준).
describe("moveToSlot (generic - card DnD over a flat mixed-kind id array)", () => {
  // backend: b1,b2,b3 / nginx: n1 하나만 사이에 끼워 넣어 "다른 그룹이 사이에 있어도" 같은 그룹 내 재배치가
  // 올바른지 검증. 카드 4개 x 모든 (i,j) i!=j 조합 전수 검증.
  const FLAT = ["b1", "n1", "b2", "b3"]; // backend 서브시퀀스: b1,b2,b3 (n1 은 무관한 다른 그룹)
  const BACKEND_IDS = ["b1", "b2", "b3"];

  for (const dragged of BACKEND_IDS) {
    for (const target of BACKEND_IDS) {
      if (dragged === target) continue;
      it(`card ${dragged} dropped onto ${target} takes exactly ${target}'s original slot`, () => {
        const result = moveToSlot(FLAT, dragged, target);
        expect(result.indexOf(dragged)).toBe(FLAT.indexOf(target));
        expect([...result].sort()).toEqual([...FLAT].sort());
        expect(result).not.toEqual(FLAT);
        // n1(다른 그룹)의 플랫 배열상 절대 인덱스는 이동 방향에 따라 밀릴 수 있지만(무관한 통과객),
        // backend 서브시퀀스(그룹 필터링 후 렌더링되는 실제 순서) 안에서의 상대 순서만 정확하면 됨 -
        // 이건 아래 개별 시나리오 테스트에서 필터링된 결과로 직접 확인함.
        const backendSubsequence = result.filter((id) => BACKEND_IDS.includes(id));
        expect(backendSubsequence.indexOf(dragged)).toBe(
          FLAT.filter((id) => BACKEND_IDS.includes(id)).indexOf(target),
        );
      });
    }
  }

  it("card dropped onto itself is a true no-op", () => {
    for (const id of BACKEND_IDS) {
      expect(moveToSlot(FLAT, id, id)).toEqual(FLAT);
    }
  });

  it("moving the first card down past a middle card works (regression: 'middle card move fails' report)", () => {
    // order 상 b1(0) 을 b2(2, n1 을 사이에 두고) 위로 드롭 - 중간 카드 이동 시나리오.
    const result = moveToSlot(FLAT, "b1", "b2");
    expect(result).toEqual(["n1", "b2", "b1", "b3"]);
  });

  it("moving a later card up onto an earlier middle card works", () => {
    const result = moveToSlot(FLAT, "b3", "b2");
    expect(result).toEqual(["b1", "n1", "b3", "b2"]);
  });
});

// 새 기본 서비스(빈 값) 정책: cwd 는 더 이상 필수가 아님 - Rust check_cwds_exist 완화와 짝을 맞춤.
describe("validateDraftConfig allows empty cwd", () => {
  const baseSvc = (overrides: Partial<ServiceConfig>): ServiceConfig => ({
    id: "a",
    name: "A",
    cwd: "",
    command: "",
    port: 3000,
    env: {},
    kind: "backend",
    ...overrides,
  });
  const cfg = (services: ServiceConfig[]): AppConfig => ({
    services,
    startStaggerMs: 1500,
    gitFetchIntervalSec: 300,
    maxLogLines: 10000,
    kindOrder: ["backend", "frontend", "lib", "nginx"],
    pullMode: "rebase",
  });

  it("passes validation with an empty cwd as long as name/id rules are met", () => {
    const result = validateDraftConfig(cfg([baseSvc({ cwd: "" })]));
    expect(result).toBeNull();
  });

  // 경로 미설정 서비스는 port/command 검증 자체가 면제됨(이번 수정의 핵심) - 관리 모달은 전체 서비스를
  // 한 번에 검증하므로, 그렇지 않으면 서비스 1개만 채워 저장하려 해도 나머지 빈 기본 서비스들의 포트
  // 필수 정책에 걸려 저장 자체가 막히는 문제가 있었음.
  it("allows saving with an unset (empty cwd) backend service even without a port", () => {
    const result = validateDraftConfig(cfg([baseSvc({ cwd: "", port: null })]));
    expect(result).toBeNull();
  });

  it("allows saving when only one of several unset default services is filled in", () => {
    const filled = baseSvc({ id: "cms", name: "BE_CMS", cwd: "C:/x", port: 8190 });
    const stillEmpty = [
      baseSvc({ id: "portal", name: "BE_PORTAL", cwd: "", port: null }),
      baseSvc({ id: "fms", name: "BE_FMS", cwd: "", port: null }),
      baseSvc({ id: "nginx1", name: "nginx", cwd: "", port: null, kind: "nginx" }),
    ];
    const result = validateDraftConfig(cfg([filled, ...stillEmpty]));
    expect(result).toBeNull();
  });

  it("still requires a port once cwd is filled in for a backend service", () => {
    const result = validateDraftConfig(cfg([baseSvc({ cwd: "C:/x", port: null })]));
    expect(result).not.toBeNull();
  });

  it("still requires a port once cwd is filled in for an nginx service", () => {
    const result = validateDraftConfig(cfg([baseSvc({ cwd: "C:/x", port: null, kind: "nginx" })]));
    expect(result).not.toBeNull();
  });

  it("lib service with a filled-in cwd still rejects a port", () => {
    const result = validateDraftConfig(cfg([baseSvc({ cwd: "C:/x", command: null, port: 3000, kind: "lib" })]));
    expect(result).not.toBeNull();
  });
});

describe("formatMinutesAgo", () => {
  it("shows '방금 전' when under a minute has passed", () => {
    expect(formatMinutesAgo(1000, 1000)).toBe("방금 전");
    expect(formatMinutesAgo(1000, 1000 + 30_000)).toBe("방금 전");
    expect(formatMinutesAgo(1000, 1000 + 59_999)).toBe("방금 전");
  });

  it("shows '1분 전' once a full minute has passed", () => {
    expect(formatMinutesAgo(0, 60_000)).toBe("1분 전");
    expect(formatMinutesAgo(0, 89_000)).toBe("1분 전");
  });

  it("floors to whole minutes for larger gaps", () => {
    expect(formatMinutesAgo(0, 125_000)).toBe("2분 전");
    expect(formatMinutesAgo(0, 10 * 60_000)).toBe("10분 전");
  });

  it("falls back to '방금 전' when now is somehow before the fetch time (clock skew)", () => {
    expect(formatMinutesAgo(10_000, 0)).toBe("방금 전");
  });
});

// LogPanel 툴바의 로그 지우기 버튼은 이 상수를 그대로 렌더링함 - 컴포넌트 렌더링 없이도 레이블 값을 검증.
describe("LOG_CLEAR_LABEL", () => {
  it("is the English label 'Log Clear' (음역 대신 원어 그대로)", () => {
    expect(LOG_CLEAR_LABEL).toBe("Log Clear");
  });
});
