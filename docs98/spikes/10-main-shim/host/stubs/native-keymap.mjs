// Stand-in for native-keymap (reads the OS keyboard layout): a US layout, no layout change events. getKeyMap() empty: the workbench then uses its built-in US key table.
export function getCurrentKeyboardLayout() { return process.platform === 'win32' ? { name: '00000409', id: '', text: 'US' } : { layout: 'us', model: 'pc105', variant: '', options: '', rules: 'evdev' }; }
export function getKeyMap() { return []; }
export function isISOKeyboard() { return false; }
export function onDidChangeKeyboardLayout(callback) { }
export default { getCurrentKeyboardLayout, getKeyMap, isISOKeyboard, onDidChangeKeyboardLayout };
