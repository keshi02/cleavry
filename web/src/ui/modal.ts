// Custom modal that replaces native confirm() / alert(). Returns a
// promise resolving with the chosen button's `value`. Esc and backdrop
// behavior follow native confirm: Esc cancels (returns the LAST
// button's value, which by convention is the cancel/secondary action).
//
// Usage:
//   const choice = await showModal({
//     title: '削除しますか？',
//     message: '元に戻せません',
//     buttons: [
//       { label: '削除', value: 'ok', primary: true },
//       { label: 'キャンセル', value: 'cancel' },
//     ],
//   });

export interface ModalButton<T = unknown> {
  label: string;
  value: T;
  primary?: boolean;
}

export interface ModalOptions<T = unknown> {
  title?: string;
  message?: string;
  buttons?: ModalButton<T>[];
}

export function showModal<T = unknown>(opts: ModalOptions<T> = {}): Promise<T> {
  const {
    title = '',
    message = '',
    buttons = [{ label: 'OK', value: true as unknown as T, primary: true }],
  } = opts;

  return new Promise<T>(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'app-modal-overlay';
    const box = document.createElement('div');
    box.className = 'app-modal-box';

    if (title) {
      const t = document.createElement('h3');
      t.className = 'app-modal-title';
      t.textContent = title;
      box.appendChild(t);
    }
    if (message) {
      const m = document.createElement('div');
      m.className = 'app-modal-message';
      m.textContent = message;
      box.appendChild(m);
    }

    const row = document.createElement('div');
    row.className = 'app-modal-buttons';
    let firstFocus: HTMLButtonElement | null = null;

    buttons.forEach(b => {
      const btn = document.createElement('button');
      btn.textContent = b.label;
      if (b.primary) {
        btn.classList.add('primary');
        if (!firstFocus) firstFocus = btn;
      }
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.onclick = () => close(b.value);
      row.appendChild(btn);
    });
    box.appendChild(row);
    overlay.appendChild(box);

    function close(value: T): void {
      document.removeEventListener('keydown', onKey, true);
      overlay.parentNode?.removeChild(overlay);
      resolve(value);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        close(buttons[buttons.length - 1].value);
      } else if (e.key === 'Enter' && firstFocus) {
        e.preventDefault(); e.stopPropagation();
        close((buttons.find(b => b.primary) || buttons[0]).value);
      }
    }
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    firstFocus?.focus();
  });
}
