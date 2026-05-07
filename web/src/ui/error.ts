import { showModal } from './modal';

// Fire-and-forget error modal. Caller doesn't need to await dismissal.
export function showError(msg: string): void {
  showModal({
    title: 'エラー',
    message: msg,
    buttons: [{ label: 'OK', value: true, primary: true }],
  });
}
