import type { LogLine } from "../types";

/** LogPanel 의 줄 범위 선택 상태 - seq 두 개(시작/현재)만 들고, 실제 범위는 min~max 로 계산. */
export interface LineRangeSelection {
  anchor: number;
  focus: number;
}

/** anchor/focus 순서(역방향 드래그 포함) 상관없이 항상 min<=max 범위로 정규화. */
export function selectionRange(sel: LineRangeSelection | null): { min: number; max: number } | null {
  if (!sel) return null;
  return { min: Math.min(sel.anchor, sel.focus), max: Math.max(sel.anchor, sel.focus) };
}

/** seq 오름차순 배열에서 seq>=target 인 첫 인덱스(이진 탐색) - 없으면 length. */
function lowerBound(lines: LogLine[], target: number): number {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid].seq < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 선택 범위(seq min~max) 안에 있는 줄의 text 만 개행으로 join(번호·시각 제외).
 * lines 는 호출부가 넘긴 배열 그대로 사용 - 검색 중이면 filtered(화면에 보이는 줄)만, cap 으로 잘려
 * 사라진 seq 는 애초에 배열에 없으므로 자동으로 제외됨. seq 는 단조 증가라 이진 탐색으로 시작점만 찾는다.
 */
export function buildCopyText(lines: LogLine[], sel: LineRangeSelection | null): string {
  const range = selectionRange(sel);
  if (!range) return "";
  const out: string[] = [];
  let i = lowerBound(lines, range.min);
  for (; i < lines.length && lines[i].seq <= range.max; i++) {
    out.push(lines[i].text);
  }
  return out.join("\n");
}

/** 복사 완료 토스트("복사됨 N줄")용 줄 수 계산 - 빈 텍스트는 0줄. */
export function countCopiedLines(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}
