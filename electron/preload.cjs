const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  onStateChange: (callback) => {
    const handler = (_, state, project) => callback(state, project)
    ipcRenderer.on('state-change', handler)
    return () => ipcRenderer.removeListener('state-change', handler)
  },
  setState: (state) => ipcRenderer.send('set-state', state),
  quit: () => ipcRenderer.send('quit'),
  getTheme: () => ipcRenderer.invoke('get-theme'),
  setTheme: (theme) => ipcRenderer.send('set-theme', theme),
  onThemeChange: (callback) => {
    const handler = (_, theme) => callback(theme)
    ipcRenderer.on('theme-change', handler)
    return () => ipcRenderer.removeListener('theme-change', handler)
  },
  getStyle: () => ipcRenderer.invoke('get-style'),
  setStyle: (style) => ipcRenderer.send('set-style', style),
  onStyleChange: (callback) => {
    const handler = (_, style) => callback(style)
    ipcRenderer.on('style-change', handler)
    return () => ipcRenderer.removeListener('style-change', handler)
  },
  focusApp: () => ipcRenderer.send('focus-app'),
  activateHost: () => ipcRenderer.send('activate-host'),
  getMute: () => ipcRenderer.invoke('get-mute'),
  setMute: (muted) => ipcRenderer.send('set-mute', muted),
  setWindowHeight: (h) => ipcRenderer.send('set-window-height', h),
  getProjects: () => ipcRenderer.invoke('get-projects'),
  getSelectedProject: () => ipcRenderer.invoke('get-selected-project'),
  selectProject: (name) => ipcRenderer.send('select-project', name),
  onProjectChange: (callback) => {
    const handler = (_, project) => callback(project)
    ipcRenderer.on('project-change', handler)
    return () => ipcRenderer.removeListener('project-change', handler)
  },
  getBalance: () => ipcRenderer.invoke('get-balance'),
  refreshBalance: () => ipcRenderer.send('refresh-balance'),
  setApiKey: (provider, key) => ipcRenderer.send('set-api-key', provider, key),
  getApiKey: (provider) => ipcRenderer.invoke('get-api-key', provider),
  onBalanceUpdate: (callback) => {
    const handler = (_, balance) => callback(balance)
    ipcRenderer.on('balance-update', handler)
    return () => ipcRenderer.removeListener('balance-update', handler)
  },
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
  openSettings: () => ipcRenderer.send('open-settings'),
  getBudget: (provider) => ipcRenderer.invoke('get-budget', provider),
  setBudget: (provider, amount) => ipcRenderer.send('set-budget', provider, amount),
})
