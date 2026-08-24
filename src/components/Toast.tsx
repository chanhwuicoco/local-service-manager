import { useStore } from "../store";

// 관리 모달 "저장" 버튼 명시 저장 성공 시에만 뜨는 소형 다크 토스트. 모달이 닫힌 뒤에도 보여야 해서
// 모달과 별개로 App 루트에 항상 마운트해둠 - toastMessage 가 store 에서 자동으로 null 이 되면 사라짐.
// key={toastKey} 로 매번 리마운트시켜서 같은 문구가 연달아 떠도 fade 애니메이션이 처음부터 재생되게 함.
export default function Toast() {
  const message = useStore((s) => s.toastMessage);
  const toastKey = useStore((s) => s.toastKey);

  if (!message) return null;

  return (
    <div className="toast" key={toastKey} data-testid="save-toast" role="status" aria-live="polite">
      {message}
    </div>
  );
}
