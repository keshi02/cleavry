// True on Apple platforms (Mac / iPad). Used to swap Cmd vs Ctrl in
// keyboard shortcut messages.
export function isMac(): boolean {
  return /Mac/.test(navigator.platform);
}
