import type { AppConfig, ServiceConfig, ServiceKind } from "../types";

// gradlew bootRun 은 서비스마다 Gradle 데몬 JVM 이 상주해 메모리 낭비 - jar 빌드 후 java -jar 로
// 실행하면 뜬 뒤엔 앱 JVM 하나만 남음. && 로 단계 순차 실행되고 {jar} 는 build/libs 산출물로 치환됨(Rust process.rs).
export const BACKEND_COMMAND = "gradlew.bat bootJar --no-daemon && java -jar {jar} --spring.profiles.active=local";
export const FRONTEND_COMMAND = "npm run dev";
export const NGINX_COMMAND = "nginx.exe";
/** kind=frontend 선택 시 안내용 placeholder 포트(값은 자동 커밋하지 않음 — 환경 감지가 실제 후보로 채울 수 있게). */
export const FRONTEND_DEFAULT_PORT = 8090;
export const FRONTEND_DEFAULT_CWD = "C:/Workspace/FE_LIB";

/** id 는 사용자에게 보이지도 편집되지도 않음 — 생성 시 UUID 를 한 번 발급하고 이후 이름이 바뀌어도 불변. */
export function makeBlankService(): ServiceConfig {
  return { id: crypto.randomUUID(), name: "", cwd: "", command: "", port: null, env: {} };
}

/** short 미입력 시 기본 약칭: '_'/'-' 마지막 구분자 뒤 앞 3자, 없으면 이름 앞 3자. 대문자화 안 함. */
export function deriveShort(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  const lastSep = Math.max(trimmed.lastIndexOf("_"), trimmed.lastIndexOf("-"));
  const base = lastSep >= 0 ? trimmed.slice(lastSep + 1) : trimmed;
  return base.slice(0, 3);
}

/** kind 없는 기존 config 호환: command/port 둘 다 null 이면 lib(LIB), 그 외 없으면 backend. */
export function resolveKind(svc: ServiceConfig): ServiceKind {
  if (svc.kind) return svc.kind;
  if (svc.command == null && svc.port == null) return "lib";
  return "backend";
}

/** includeInAll 없는 기존 config 호환: 없으면 true(현행 동작)로 취급. */
export function resolveIncludeInAll(svc: ServiceConfig): boolean {
  return svc.includeInAll ?? true;
}

/** 저장 직전 정규화: kind 가 lib 이면 command/port 를 null 로 강제(기존 LIB 전용 판정과 호환). */
export function normalizeForSave(svc: ServiceConfig): ServiceConfig {
  if (resolveKind(svc) === "lib") {
    return { ...svc, command: null, port: null };
  }
  return svc;
}

/** 실제 실행에 쓰일 명령: 값이 있으면 그 값, 비어있으면 kind 기본값, LIB 전용이면 null. Rust effective_command 와 동일 규칙. */
export function effectiveCommand(svc: ServiceConfig): string | null {
  const kind = resolveKind(svc);
  if (kind === "lib") return null;
  if (svc.command != null && svc.command.trim() !== "") return svc.command;
  if (kind === "frontend") return FRONTEND_COMMAND;
  if (kind === "nginx") return NGINX_COMMAND;
  return BACKEND_COMMAND;
}

/** `KEY=VALUE` 줄 단위 텍스트 <-> env record 상호 변환. */
export function envTextToRecord(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    result[key] = line.slice(idx + 1).trim();
  }
  return result;
}

export function envRecordToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/**
 * 저장 전 프론트 검증(Rust save_config 의 validate_config 와 동일 규칙).
 * 통과하면 null, 아니면 사용자에게 보여줄 에러 메시지.
 */
export function validateDraftConfig(config: AppConfig): string | null {
  const seen = new Set<string>();
  for (const s of config.services) {
    if (!s.name.trim()) return `이름은 필수입니다 (id: ${s.id || "?"})`;
    if (!s.id.trim()) return `id는 필수입니다 (이름: ${s.name})`;
    if (seen.has(s.id)) return `id가 중복되었습니다: ${s.id}`;
    seen.add(s.id);
    // 경로 미설정 서비스는 아직 "설정 중"인 상태로 보고 port/command 검증을 면제(이름/id 만 지킴) -
    // 관리 모달은 전체 서비스를 한 번에 검증하므로, 안 그러면 서비스 1개만 채워 저장하려 해도 나머지
    // 빈 기본 서비스들의 포트 필수 정책에 걸려 저장 자체가 막힘. 폴더를 채우면 기존 정책 그대로 적용.
    if (!s.cwd.trim()) continue;
    if (s.command == null) {
      if (s.port != null) return `${s.name}: LIB 전용 서비스는 포트를 비워야 합니다`;
    } else {
      // 명령이 비어있어도 kind 기본값으로 해석되므로(Rust effective_command 대응) 더 이상 에러가 아님.
      // frontend 는 포트가 선택 입력 - dev 서버는 프로젝트 설정이 포트를 스스로 정하고 데몬화 없이
      // 계속 떠 있어서 pid 기준으로 상태 판단이 가능함. backend/nginx 는 여전히 필수.
      const kind = resolveKind(s);
      if (s.port != null && (s.port < 1 || s.port > 65535)) {
        return `${s.name}: 포트는 1~65535 범위여야 합니다`;
      }
      if (kind !== "frontend" && s.port == null) {
        return `${s.name}: 포트는 1~65535 범위여야 합니다`;
      }
    }
  }
  return null;
}

/** 사이드바 그룹 표시 기본(고정) 순서 - config.kindOrder 가 없거나 비정상일 때 폴백. */
export const KIND_GROUP_ORDER: ServiceKind[] = ["backend", "frontend", "lib", "nginx"];
export const KIND_GROUP_LABEL: Record<ServiceKind, string> = {
  backend: "BACKEND",
  frontend: "FRONTEND",
  lib: "LIB",
  nginx: "NGINX",
};
/** 접힘 레일(56px, 좁음)용 축약 그룹 라벨. */
export const RAIL_GROUP_LABEL: Record<ServiceKind, string> = {
  backend: "BE",
  frontend: "FE",
  lib: "LIB",
  nginx: "NGX",
};

/** config.kindOrder(문자열 배열, 드래그로 자유롭게 바뀜)를 정규화: 모르는 값 제거, 중복 제거,
 * 빠진 kind 는 기본 고정 순서로 뒤에 보충해서 항상 4개 다 있는 유효한 순서를 보장. */
export function resolveKindOrder(kindOrder: string[] | undefined): ServiceKind[] {
  const valid = (kindOrder ?? []).filter((k): k is ServiceKind => (KIND_GROUP_ORDER as string[]).includes(k));
  const deduped = [...new Set(valid)];
  const missing = KIND_GROUP_ORDER.filter((k) => !deduped.includes(k));
  return [...deduped, ...missing];
}

/** "merge" 만 특별 취급, 그 외(undefined/오타 포함)는 전부 안전한 기본값 "rebase" - Rust 쪽
 * pull_args_for_mode 의 폴백 규칙과 동일하게 맞춤. */
export function resolvePullMode(pullMode: string | undefined): "merge" | "rebase" {
  return pullMode === "merge" ? "merge" : "rebase";
}

/** id 목록을 kind 순서(기본은 고정 순서, config.kindOrder 를 정규화해 넘기면 그 순서)로 그룹핑.
 * 그룹 내부는 원래(config) 순서 유지, 빈 그룹은 생략. */
export function groupServiceIds(
  order: string[],
  kindOf: (id: string) => ServiceKind | null,
  kindOrder: ServiceKind[] = KIND_GROUP_ORDER,
): { kind: ServiceKind; ids: string[] }[] {
  const buckets: Record<ServiceKind, string[]> = { backend: [], frontend: [], lib: [], nginx: [] };
  for (const id of order) {
    const kind = kindOf(id);
    if (kind) buckets[kind].push(id);
  }
  return kindOrder.map((kind) => ({ kind, ids: buckets[kind] })).filter((g) => g.ids.length > 0);
}

/**
 * draggedKind 를 order 안에서 targetKind 가 "현재(원본 배열 기준) 차지한 자리"로 정확히 옮김(슬롯 차지 방식).
 * dragged 를 뺀 축소 배열에서 target 의 인덱스를 다시 찾아 그 자리에 넣으면(예전 버그) 아래쪽 이동(원래
 * 인덱스 i < target 인덱스 j)에서 target 인덱스가 이미 한 칸 당겨진 상태라 삽입 위치가 한 칸 모자라짐
 * (맨 끝에 못 감, 바로 다음 자리는 no-op 으로 오판됨). 그래서 반드시 "원본 배열에서의 targetKind 인덱스"를
 * 먼저 구해서 그 값 그대로 삽입 인덱스로 써야 i<j, i>j 양쪽 다 dragged 의 최종 위치가 정확히 j 가 됨.
 * draggedKind===targetKind(자기 자신) 를 포함해 order 에 없는 kind 가 섞이면 원본 그대로 반환.
 */
// "그 자리를 차지한다" 슬롯 방식 순서 재계산 - 섹션(그룹 헤더) DnD 와 카드 DnD 가 공유하는 단일 순수 함수.
// 핵심 규칙(off-by-one 버그 수정 포인트): target 의 인덱스는 dragged 를 제거하기 "전" 원본 배열 기준으로
// 구해야 함 - 제거 후(축소 배열) 인덱스를 쓰면 아래 방향 이동이 한 칸 못 미침.
export function moveToSlot<T>(order: T[], dragged: T, target: T): T[] {
  const targetIdx = order.indexOf(target);
  if (targetIdx < 0 || !order.includes(dragged)) return order;
  const without = order.filter((item) => item !== dragged);
  without.splice(targetIdx, 0, dragged);
  return without;
}

/** kind 배열 전용 얇은 래퍼 - 섹션 DnD 호출부의 기존 이름/시그니처 유지용. */
export function moveKindToSlot(order: ServiceKind[], draggedKind: ServiceKind, targetKind: ServiceKind): ServiceKind[] {
  return moveToSlot(order, draggedKind, targetKind);
}

export const MAX_LOG_LINES_OPTIONS = [
  { value: 0, label: "제한 없음" },
  { value: 10000, label: "10000줄" },
  { value: 5000, label: "5000줄" },
  { value: 1000, label: "1000줄" },
];

export const GIT_FETCH_INTERVAL_OPTIONS = [
  { value: 0, label: "끔" },
  { value: 60, label: "1분" },
  { value: 300, label: "5분" },
  { value: 600, label: "10분(기본)" },
  { value: 900, label: "15분" },
];

/** git fetch 완료 후 경과 시간을 "방금 전"/"N분 전" 문구로 - 1분 미만은 "방금 전". */
export function formatMinutesAgo(fetchedAtMs: number, nowMs: number): string {
  const diffMin = Math.floor((nowMs - fetchedAtMs) / 60000);
  if (diffMin < 1) return "방금 전";
  return `${diffMin}분 전`;
}
