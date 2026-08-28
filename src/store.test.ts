import { describe, expect, it, vi } from "vitest";
import { assignSeq, capLogs, extractErrorLines, isAutoScroll, parseAutoScrollById, useStore } from "./store";
import type { LogLine, RawLogLine } from "./types";

function raw(text: string, stream: RawLogLine["stream"] = "out"): RawLogLine {
  return { ts: Date.now(), stream, text };
}

describe("assignSeq", () => {
  it("부여된 seq 는 startSeq 부터 1씩 증가한다", () => {
    const lines = [raw("a"), raw("b"), raw("c")];
    const result = assignSeq(lines, 1);
    expect(result.map((l) => l.seq)).toEqual([1, 2, 3]);
  });

  it("startSeq 가 1이 아니어도(예: clear 후 이어붙이기) 그 값부터 이어진다", () => {
    const result = assignSeq([raw("x"), raw("y")], 5);
    expect(result.map((l) => l.seq)).toEqual([5, 6]);
  });

  it("원본 필드(ts/stream/text)는 그대로 유지된다", () => {
    const line = raw("hello", "err");
    const [result] = assignSeq([line], 10);
    expect(result.ts).toBe(line.ts);
    expect(result.stream).toBe("err");
    expect(result.text).toBe("hello");
  });
});

describe("seq 는 capLogs(버퍼 잘림)에도 유지된다", () => {
  it("cap 으로 앞부분이 잘려도 남은 줄의 seq 번호는 그대로", () => {
    const numbered = assignSeq(
      Array.from({ length: 5 }, (_, i) => raw(`line${i}`)),
      1,
    );
    const capped = capLogs(numbered, 2);
    // 마지막 2개(line3, line4)만 남고, seq 는 인덱스 재계산 없이 원래 값(4, 5) 그대로.
    expect(capped.map((l) => l.seq)).toEqual([4, 5]);
  });

  it("maxLogLines=0(제한 없음)이면 자르지 않고 seq 도 그대로", () => {
    const numbered = assignSeq([raw("a"), raw("b")], 1);
    expect(capLogs(numbered, 0).map((l) => l.seq)).toEqual([1, 2]);
  });
});

describe("clear 후 이어붙이는 로그는 seq 1부터 다시 시작한다 (store.clearLogs 가 nextSeq 를 1로 리셋)", () => {
  it("clear(로그 비우기 + nextSeq=1 리셋) 시나리오를 재현", () => {
    // 1) 로그 3줄 도착 -> seq 1,2,3
    let logs: LogLine[] = assignSeq([raw("a"), raw("b"), raw("c")], 1);
    expect(logs.map((l) => l.seq)).toEqual([1, 2, 3]);

    // 2) clearLogs 호출 시뮬레이션: logs=[], nextSeq 를 1로 리셋
    logs = [];
    const nextSeqAfterClear = 1;

    // 3) clear 이후 새 로그 2줄 도착 -> seq 는 다시 1부터
    logs = assignSeq([raw("d"), raw("e")], nextSeqAfterClear);
    expect(logs.map((l) => l.seq)).toEqual([1, 2]);
  });
});

describe("extractErrorLines", () => {
  const base = (over: Partial<LogLine>): LogLine => ({
    ts: 0,
    stream: "out",
    text: "",
    seq: 0,
    ...over,
  });

  it("logLevel 이 error 인 줄만 뽑는다", () => {
    const logs: LogLine[] = [
      base({ seq: 1, text: "[INFO] ok" }),
      base({ seq: 2, text: "[ERROR] boom", stream: "err" }),
      base({ seq: 3, text: "[WARN] slow" }),
      base({ seq: 4, text: "ERR connection refused", stream: "err" }),
    ];
    const result = extractErrorLines(logs);
    expect(result.map((l) => l.seq)).toEqual([2, 4]);
  });

  it("sys 스트림은 ERROR 문구가 있어도 제외한다", () => {
    const logs: LogLine[] = [
      base({ seq: 1, text: "[ERROR] real error", stream: "err" }),
      base({ seq: 2, text: "ERROR from system log", stream: "sys" }),
    ];
    const result = extractErrorLines(logs);
    expect(result.map((l) => l.seq)).toEqual([1]);
  });

  it("에러가 없으면 빈 배열", () => {
    const logs: LogLine[] = [base({ seq: 1, text: "[INFO] fine" })];
    expect(extractErrorLines(logs)).toEqual([]);
  });
});

// jumpToLine 은 에러 패널 항목 클릭 -> LogPanel 의 useEffect([jumpTarget]) 트리거용.
// nonce 를 매번 올려야 "같은 줄 재클릭"도 값 변화로 감지되어 effect 가 재실행됨(seq 만 같으면 객체가 안 바뀐 걸로 오인될 수 있음).
describe("jumpToLine", () => {
  it("호출마다 nonce 가 1씩 증가하고, 같은 seq 재클릭도 다른 nonce 를 받는다", () => {
    useStore.setState({ jumpTarget: null });

    useStore.getState().jumpToLine("svc1", 3);
    expect(useStore.getState().jumpTarget).toEqual({ id: "svc1", seq: 3, nonce: 1 });

    // 같은 서비스/같은 줄을 다시 클릭 - seq 는 동일해도 nonce 는 증가해야 함.
    useStore.getState().jumpToLine("svc1", 3);
    const second = useStore.getState().jumpTarget;
    expect(second?.seq).toBe(3);
    expect(second?.nonce).toBe(2);

    // 다른 서비스/다른 줄로 점프해도 nonce 는 계속 이어서 증가.
    useStore.getState().jumpToLine("svc2", 7);
    expect(useStore.getState().jumpTarget).toEqual({ id: "svc2", seq: 7, nonce: 3 });
  });
});

// Auto-scroll 은 서비스별 Record<string, boolean> 로 관리 - 값이 없는 서비스는 기본 true(isAutoScroll 로 조회).
describe("autoScrollById", () => {
  it("저장된 값이 없는 서비스는 기본 true", () => {
    expect(isAutoScroll({}, "svc1")).toBe(true);
    expect(isAutoScroll({ svc2: false }, "svc1")).toBe(true); // 다른 id 값은 영향 없음
  });

  it("id 가 null 이면(선택된 서비스 없음) true", () => {
    expect(isAutoScroll({ svc1: false }, null)).toBe(true);
  });

  it("false 로 저장된 서비스는 false 를 그대로 반환", () => {
    expect(isAutoScroll({ svc1: false }, "svc1")).toBe(false);
  });

  it("setAutoScroll(id) 는 해당 id 만 바꾸고 다른 id 에 영향 없다", () => {
    useStore.setState({ autoScrollById: {} });

    useStore.getState().setAutoScroll("svc1", false);
    expect(useStore.getState().autoScrollById).toEqual({ svc1: false });
    expect(isAutoScroll(useStore.getState().autoScrollById, "svc2")).toBe(true); // 건드린 적 없으면 기본 true

    useStore.getState().setAutoScroll("svc2", false);
    expect(useStore.getState().autoScrollById).toEqual({ svc1: false, svc2: false });

    // svc1 을 다시 켜도 svc2 는 그대로.
    useStore.getState().setAutoScroll("svc1", true);
    expect(useStore.getState().autoScrollById).toEqual({ svc1: true, svc2: false });
  });

  it("setAutoScroll 은 localStorage 에 id->boolean 맵 전체를 JSON 으로 저장한다", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    try {
      useStore.setState({ autoScrollById: {} });
      useStore.getState().setAutoScroll("svc1", false);
      expect(JSON.parse(store.get("lbm.autoScrollById")!)).toEqual({ svc1: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// localStorage 가 없는 테스트 환경(jsdom 아님)에서는 파싱 함수를 직접 검증.
describe("parseAutoScrollById", () => {
  it("유효한 JSON 객체는 그대로 파싱된다", () => {
    expect(parseAutoScrollById(JSON.stringify({ svc1: false, svc2: true }))).toEqual({
      svc1: false,
      svc2: true,
    });
  });

  it("저장된 값이 없으면(null) 빈 객체", () => {
    expect(parseAutoScrollById(null)).toEqual({});
  });

  it("깨진 JSON 이면 빈 객체", () => {
    expect(parseAutoScrollById("{not valid json")).toEqual({});
  });

  it("객체가 아닌 JSON(배열/원시값)이면 빈 객체", () => {
    expect(parseAutoScrollById("[1,2,3]")).toEqual({});
    expect(parseAutoScrollById("42")).toEqual({});
    expect(parseAutoScrollById("null")).toEqual({});
  });

  it("boolean 이 아닌 값을 가진 필드는 걸러낸다", () => {
    expect(parseAutoScrollById(JSON.stringify({ svc1: false, svc2: "yes", svc3: 1 }))).toEqual({
      svc1: false,
    });
  });
});
