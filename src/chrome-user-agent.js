/**
 * Many web apps block or break streaming/APIs when they see "Electron" in the UA.
 * Advertise as standard Chrome using this build's Chromium version.
 */
function getChromeLikeUserAgent() {
  const chrome = process.versions.chrome || "120.0.0.0";
  if (process.platform === "darwin") {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
  }
  if (process.platform === "win32") {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

function applyChromeLikeUserAgent(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }
  try {
    webContents.setUserAgent(getChromeLikeUserAgent());
  } catch {
    // ignore
  }
}

module.exports = { getChromeLikeUserAgent, applyChromeLikeUserAgent };
