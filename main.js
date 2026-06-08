const { app, BrowserWindow, shell } = require('electron');
const { createProxy } = require('./api-key-pool-proxy-enhanced');

let proxy;
let mainWindow;

async function createWindow() {
  proxy = createProxy();
  const { host, port } = proxy.appConfig.config;
  try {
    await proxy.start();
  } catch (error) {
    if (!String(error.message || '').includes('EADDRINUSE')) throw error;
    proxy = null;
  }

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 920,
    minHeight: 640,
    title: 'API Key Pool Proxy',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(`http://${host}:${port}/admin`);
}

app.whenReady().then(createWindow).catch(error => {
  console.error('[FATAL]', error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', async event => {
  if (!proxy) return;
  event.preventDefault();
  const current = proxy;
  proxy = null;
  await current.stop();
  app.exit(0);
});
