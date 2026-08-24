import { useStore } from "../store";

export default function CloseModal() {
  const open = useStore((s) => s.closeModalOpen);
  const requestExit = useStore((s) => s.requestExit);
  const cancelExit = useStore((s) => s.cancelExit);
  const liveExit = useStore((s) => s.liveExit);

  if (!open) return null;

  return (
    <div className="modal-backdrop" data-testid="close-modal">
      <div className="modal">
        <p>실행 중인 서비스가 있습니다. 어떻게 할까요?</p>
        <div className="modal-buttons">
          <button data-testid="modal-stop-and-exit" onClick={() => void requestExit()}>
            모두 종료 후 나가기
          </button>
          <button data-testid="modal-leave-running" onClick={liveExit}>
            살려두고 나가기
          </button>
          <button data-testid="modal-cancel" onClick={cancelExit}>
            취소
          </button>
        </div>
      </div>
    </div>
  );
}
