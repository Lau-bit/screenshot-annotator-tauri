const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke;
const dialog = tauri?.dialog;

if (!invoke || !dialog) {
  console.error('Tauri API is not available.');
}

window.annotatorAPI = {
  readClipboardImage: () => invoke('read_clipboard_image'),
  readImageFile: (filePath) => invoke('read_image_file', { filePath }),
  writeClipboardImage: (dataURL) => invoke('write_clipboard_image', { dataUrl: dataURL }),
  saveFile: (opts) => invoke('save_file', { filePath: opts.path, dataUrl: opts.dataURL }),
  saveFileAs: async ({ dataURL, defaultName }) => {
    const filePath = await dialog.save({
      title: 'Save Screenshot As',
      defaultPath: defaultName || 'screenshot.png',
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });
    if (!filePath) return null;
    const ok = await invoke('save_file', { filePath, dataUrl: dataURL });
    return ok ? filePath : null;
  },
  pickFolder: () => dialog.open({
    title: 'Select Save Folder',
    directory: true,
    multiple: false,
  }),
  openFolder: (folderPath) => invoke('open_folder', { folderPath }),
  pickImages: (folderPath) => dialog.open({
    title: 'Open Images',
    defaultPath: folderPath || undefined,
    multiple: true,
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff'] }],
  }),
  ensureFolder: (folderPath) => invoke('ensure_folder', { folderPath }),
  getDefaultSaveFolder: () => invoke('get_default_save_folder'),
  getSettings: () => invoke('get_settings'),
  setSettings: (data) => invoke('set_settings', { data }),
  saveWindowShape: () => invoke('save_window_shape'),
  setWindowSquareCorners: (square) => invoke('set_window_square_corners', { square }),
};
