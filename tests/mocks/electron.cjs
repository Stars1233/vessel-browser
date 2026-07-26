const os = require("os");
const path = require("path");

let wcId = 0;
let encryptionAvailable = true;

function createMockWebContents() {
  wcId += 1;
  let zoom = 0;
  let destroyed = false;
  let destroyedListener;
  const ipcHandlers = new Map();
  const ipcListeners = new Map();
  return {
    id: wcId,
    isDestroyed: () => destroyed,
    getURL: () => "about:blank",
    getTitle: () => "New Tab",
    session: {
      fromPartition: () => ({ setCertificateVerifyProc: () => {} }),
      setCertificateVerifyProc: () => {},
    },
    loadURL: () => {},
    loadFile: () => {},
    reload: () => {},
    getZoomLevel: () => zoom,
    setZoomLevel: (v) => { zoom = v; },
    setAudioMuted: () => {},
    isAudioMuted: () => false,
    isCurrentlyAudible: () => false,
    executeJavaScript: () => Promise.resolve({}),
    setWindowOpenHandler: () => {},
    on: () => {},
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
  return {
    setUserAgent: () => {},
    getUserAgent: () => "Vessel Test",
    setCertificateVerifyProc: () => {},
    webRequest: { onBeforeRequest: () => {} },
    on: () => {},
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
}

const defaultSession = createMockSession();
const ipcMainHandlers = new Map();
const ipcMainListeners = new Map();

module.exports = {
  app: {
    getPath: (name) => path.join(os.tmpdir(), `vessel-test-${name}`),
    getAppPath: () => process.cwd(),
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
