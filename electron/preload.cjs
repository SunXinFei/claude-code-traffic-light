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
  getVolcCredentials: () => ipcRenderer.invoke('get-volc-credentials'),
  setVolcCredentials: (ak, sk) => ipcRenderer.send('set-volc-credentials', ak, sk),
  getSelectedProvider: () => ipcRenderer.invoke('get-selected-provider'),
  selectProvider: (p) => ipcRenderer.send('select-provider', p),

  // 多供应商余额查询（参考 cc-switch）
  providerList: () => ipcRenderer.invoke('provider-list'),
  getProviderConfig: (id) => ipcRenderer.invoke('get-provider-config', id),
  setProviderConfig: (id, cfg) => ipcRenderer.send('set-provider-config', id, cfg),

  // Claude 模型供应商切换（复刻 cc-switch）
  ccGetProviders: () => ipcRenderer.invoke('cc:get-providers'),
  ccGetCurrentProvider: () => ipcRenderer.invoke('cc:get-current-provider'),
  ccSwitchProvider: (id) => ipcRenderer.invoke('cc:switch-provider', id),
  ccSaveProvider: (provider) => ipcRenderer.invoke('cc:save-provider', provider),
  ccDeleteProvider: (id) => ipcRenderer.invoke('cc:delete-provider', id),
  ccGetLiveSettings: () => ipcRenderer.invoke('cc:get-live-settings'),
  ccImportFromLive: (name) => ipcRenderer.invoke('cc:import-from-live', name),
  onCcProvidersChanged: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('cc:providers-changed', handler)
    return () => ipcRenderer.removeListener('cc:providers-changed', handler)
  },
  onCcCurrentChanged: (callback) => {
    const handler = (_, id) => callback(id)
    ipcRenderer.on('cc:current-changed', handler)
    return () => ipcRenderer.removeListener('cc:current-changed', handler)
  },
})
