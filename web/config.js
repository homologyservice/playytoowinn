// Render server URL (no trailing slash).
window.P2W_API = "https://playytoowinn-2.onrender.com";
// open the connection to the server while the page is still loading (saves the TLS handshake on the first request)
try { const l = document.createElement('link'); l.rel = 'preconnect'; l.href = window.P2W_API; l.crossOrigin = ''; document.head.appendChild(l); } catch (e) {}
