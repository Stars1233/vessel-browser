const os = require("os");
const path = require("path");

let wcId = 0;
let encryptionAvailable = true;

function createMockWebContents() {
  wcId += 1;
  let zoom = 0;
  let destroyed = false;
  let destroyedListener;
  let currentUrl = "about:blank";
  const ipcHandlers = new Map();
  const ipcListeners = new Map();
  const eventListeners = new Map();
  const loadedUrls = [];
  return {
    id: wcId,
    isDestroyed: () => destroyed,
    getURL: () => currentUrl,
    getTitle: () => "New Tab",
    session: {
      fromPartition: () => ({ setCertificateVerifyProc: () => {} }),
      setCertificateVerifyProc: () => {},
    },
    loadURL: (url) => {
      loadedUrls.push(url);
      return Promise.resolve();
    },
    loadFile: () => {},
    reload: () => {},
    getZoomLevel: () => zoom,
    setZoomLevel: (v) => { zoom = v; },
    setAudioMuted: () => {},
    isAudioMuted: () => false,
    isCurrentlyAudible: () => false,
    executeJavaScript: () => Promise.resolve({}),
    setWindowOpenHandler: () => {},
    on: (event, listener) => {
      const listeners = eventListeners.get(event) || [];
      listeners.push(listener);
      eventListeners.set(event, listeners);
    },
    once: (event, listener) => {
      if (event === "destroyed") {
        destroyedListener = listener;
      } else if (typeof listener === "function") {
        listener();
      }
    },
    removeListener: () => {},
    close: () => {
      if (destroyed) return;
      destroyed = true;
      destroyedListener?.();
    },
    copy: () => {},
    paste: () => {},
    cut: () => {},
    selectAll: () => {},
    send: () => {},
    _loadedUrls: loadedUrls,
    _emit: (event, ...args) => {
      if (event === "did-navigate" && typeof args[1] === "string") {
        currentUrl = args[1];
      }
      for (const listener of eventListeners.get(event) || []) listener(...args);
    },
    ipc: {
      handle: (channel, listener) => {
        ipcHandlers.set(channel, listener);
      },
      on: (channel, listener) => {
        ipcListeners.set(channel, listener);
      },
      _handlers: ipcHandlers,
      _listeners: ipcListeners,
    },
  };
}

function WebContentsView(opts) {
  const session = opts?.webPreferences?.session;
  this.webContents = createMockWebContents();
  this._backgroundColor = undefined;
  if (session) {
    this.webContents.session = session;
  }
  this.setBounds = () => {};
  this.setBackgroundColor = (color) => {
    this._backgroundColor = color;
  };
}

function createMockSession() {
  const cookieStore = [];
  const mockSession = {
    setUserAgent: () => {},
    getUserAgent: () => "Vessel Test",
    setCertificateVerifyProc: () => {},
    webRequest: { onBeforeRequest: () => {} },
    on: () => {},
    setPermissionCheckHandler: (handler) => {
      mockSession._permissionCheckHandler = handler;
    },
    setPermissionRequestHandler: (handler) => {
      mockSession._permissionRequestHandler = handler;
    },
    _permissionCheckHandler: undefined,
    _permissionRequestHandler: undefined,
    clearStorageData: () => {
      cookieStore.length = 0;
      return Promise.resolve();
    },
    clearCache: () => Promise.resolve(),
    cookies: {
      get: () => Promise.resolve(cookieStore.slice()),
      set: (details) => {
        const next = {
          name: details.name,
          value: details.value,
          domain: details.domain || new URL(details.url).hostname,
          path: details.path || "/",
          secure: !!details.secure,
          httpOnly: !!details.httpOnly,
          session: details.expirationDate == null,
          expirationDate: details.expirationDate,
          sameSite: details.sameSite,
          url: details.url,
        };
        const index = cookieStore.findIndex(
          (cookie) =>
            cookie.name === next.name &&
            cookie.domain === next.domain &&
            cookie.path === next.path,
        );
        if (index >= 0) {
          cookieStore[index] = next;
        } else {
          cookieStore.push(next);
        }
        return Promise.resolve();
      },
    },
  };
  return mockSession;
}

const defaultSession = createMockSession();
const ipcMainHandlers = new Map();
const ipcMainListeners = new Map();

module.exports = {
  app: {
    getPath: (name) => path.join(os.tmpdir(), `vessel-test-${name}`),
    getAppPath: () => process.cwd(),
    getVersion: () => "0.1.0-test",
  },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (str) => Buffer.from(str, "utf-8"),
    decryptString: (buf) => buf.toString("utf-8"),
    __setEncryptionAvailable: (value) => {
      encryptionAvailable = !!value;
    },
  },
  BaseWindow: class BaseWindow {
    constructor() {
      this.contentView = { addChildView: () => {}, removeChildView: () => {} };
      this._listeners = new Map();
      this._destroyed = false;
    }
    getContentSize() { return [1280, 800]; }
    on(event, listener) { this._listeners.set(event, listener); }
    show() { this._listeners.get("show")?.(); }
    close() {
      this._destroyed = true;
      this._listeners.get("closed")?.();
    }
    minimize() {}
    maximize() {}
    unmaximize() {}
    isMaximized() { return false; }
    isDestroyed() { return this._destroyed; }
  },
  WebContentsView,
  clipboard: { writeText: () => {} },
  Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
  MenuItem: class MenuItem {},
  ipcMain: {
    handle: (channel, listener) => {
      ipcMainHandlers.set(channel, listener);
    },
    on: (channel, listener) => {
      ipcMainListeners.set(channel, listener);
    },
    removeHandler: (channel) => {
      ipcMainHandlers.delete(channel);
    },
    removeListener: (channel, listener) => {
      if (ipcMainListeners.get(channel) === listener) {
        ipcMainListeners.delete(channel);
      }
    },
    _handlers: ipcMainHandlers,
    _listeners: ipcMainListeners,
  },
  session: {
    fromPartition: () => createMockSession(),
    defaultSession,
  },
};
