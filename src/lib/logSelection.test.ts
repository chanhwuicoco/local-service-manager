import { describe, expect, it } from "vitest";
import { buildCopyText, countCopiedLines, selectionRange } from "./logSelection";
import type { LogLine } from "../types";

function line(seq: number, text: string): LogLine {
  return { ts: 0, stream: "out", text, seq };
}

const LINES: LogLine[] = [
  line(1, "a"),
  line(2, "b"),
  line(3, "c"),
  line(4, "d"),
  line(5, "e"),
];

describe("selectionRange", () => {
  it("sel 이 null 이면 null", () => {
    expect(selectionRange(null)).toBeNull();
  });

  it("anchor<focus 는 그대로 min/max", () => {
    expect(selectionRange({ anchor: 2, focus: 4 })).toEqual({ min: 2, max: 4 });
  });

  it("anchor>focus(역방향 드래그) 도 min/max 로 정규화", () => {
    expect(selectionRange({ anchor: 4, focus: 2 })).toEqual({ min: 2, max: 4 });
  });
});

describe("buildCopyText", () => {
  it("범위 내 줄의 text 만 번호·시각 없이 개행 join", () => {
    expect(buildCopyText(LINES, { anchor: 2, focus: 4 })).toBe("b\nc\nd");
  });

  it("검색으로 필터된 배열(seq 에 구멍이 있어도)을 기준으로 동작", () => {
    const filtered = [LINES[0], LINES[2], LINES[4]]; // seq 1,3,5 만 남은 상태
    expect(buildCopyText(filtered, { anchor: 1, focus: 5 })).toBe("a\nc\ne");
    // 범위가 필터로 사라진 seq(2,4) 를 건너뛰고 3만 포함되는지도 확인.
    expect(buildCopyText(filtered, { anchor: 2, focus: 4 })).toBe("c");
  });

  it("anchor>focus(역방향 드래그)도 동일한 범위로 복사", () => {
    expect(buildCopyText(LINES, { anchor: 4, focus: 2 })).toBe("b\nc\nd");
  });

  it("cap 으로 앞부분이 잘려 사라진 seq 는 남은 줄만으로 복사", () => {
    const capped = LINES.slice(2); // seq 1,2 가 cap 으로 잘려나간 상태(3,4,5만 남음)
    expect(buildCopyText(capped, { anchor: 1, focus: 4 })).toBe("c\nd");
  });

  it("sel 이 null 이면 빈 문자열", () => {
    expect(buildCopyText(LINES, null)).toBe("");
  });

  it("범위가 남은 줄과 전혀 겹치지 않으면 빈 문자열", () => {
    const capped = LINES.slice(3); // seq 4,5 만 남음
    expect(buildCopyText(capped, { anchor: 1, focus: 2 })).toBe("");
  });
});

describe("countCopiedLines", () => {
  it("빈 문자열은 0줄", () => {
    expect(countCopiedLines("")).toBe(0);
  });

  it("줄 수만큼 카운트", () => {
    expect(countCopiedLines("a\nb\nc")).toBe(3);
    expect(countCopiedLines("only-one")).toBe(1);
  });
});
