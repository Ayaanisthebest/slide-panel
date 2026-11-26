const { BrowserWindow, ipcMain } = require("electron");

function createInputPromptWindow({
  title,
  heading,
  initialValue,
  placeholder = "",
  saveLabel = "Save",
}) {
  return new Promise((resolve) => {
    const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const submitChannel = `slidepanel:prompt-submit:${nonce}`;
    const cancelChannel = `slidepanel:prompt-cancel:${nonce}`;

    const promptWindow = new BrowserWindow({
      width: 520,
      height: 180,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: "Change URL",
      alwaysOnTop: true,
      modal: false,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    const promptHtml = `
      <!DOCTYPE html>
      <html>
        <body style="font-family:-apple-system,system-ui,sans-serif;margin:20px;">
          <h3 style="margin-top:0;">${heading.replace(/</g, "&lt;")}</h3>
          <input id="urlInput" type="text" value="${initialValue.replace(
            /"/g,
            "&quot;"
          )}" placeholder="${placeholder.replace(
            /"/g,
            "&quot;"
          )}" style="width:100%;padding:8px;font-size:14px;box-sizing:border-box;" autofocus />
          <div style="margin-top:12px;display:flex;justify-content:flex-end;gap:8px;">
            <button id="cancelBtn" style="padding:6px 12px;">Cancel</button>
            <button id="saveBtn" style="padding:6px 12px;">${saveLabel.replace(
              /</g,
              "&lt;"
            )}</button>
          </div>
          <script>
            const { ipcRenderer } = require("electron");
            const input = document.getElementById("urlInput");
            const submit = () => ipcRenderer.send("${submitChannel}", input.value);
            document.getElementById("saveBtn").addEventListener("click", submit);
            document.getElementById("cancelBtn").addEventListener("click", () => ipcRenderer.send("${cancelChannel}"));
            input.addEventListener("keydown", (event) => {
              if (event.key === "Enter") submit();
              if (event.key === "Escape") ipcRenderer.send("${cancelChannel}");
            });
            input.select();
          </script>
        </body>
      </html>
    `;

    const cleanup = () => {
      ipcMain.removeAllListeners(submitChannel);
      ipcMain.removeAllListeners(cancelChannel);
      if (!promptWindow.isDestroyed()) {
        promptWindow.close();
      }
    };

    ipcMain.once(submitChannel, (_event, value) => {
      cleanup();
      resolve(value);
    });

    ipcMain.once(cancelChannel, () => {
      cleanup();
      resolve(null);
    });

    promptWindow.on("closed", () => resolve(null));
    promptWindow.setTitle(title);
    promptWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(promptHtml)}`);
    promptWindow.once("ready-to-show", () => promptWindow.show());
  });
}

module.exports = { createInputPromptWindow };
