// "Kodi Control stats" service add-on (service.kodicontrol): a small HTTP server inside Kodi that answers the
// dashboard in one request: GET /stats runs the app's fixed stats script, POST /rpc runs JSON-RPC in-process.
// Every request needs the token the app wrote to the add-on's profile folder; there is no other command access.
const ID = 'service.kodicontrol';
const VERSION = '1.0.0';

const addonXml = () => `<?xml version="1.0" encoding="UTF-8"?>
<addon id="${ID}" name="Kodi Control stats" version="${VERSION}" provider-name="Kodi Control">
  <requires><import addon="xbmc.python" version="3.0.0"/></requires>
  <extension point="xbmc.service" library="service.py"/>
  <extension point="xbmc.addon.metadata">
    <summary lang="en_GB">Fast dashboard data for the Kodi Control app</summary>
    <description lang="en_GB">Answers the Kodi Control dashboard (system stats and JSON-RPC) over HTTP on the local network. Requests need the app's token.</description>
    <platform>all</platform>
  </extension>
</addon>
`;

const servicePy = (script, port) => `# Written by Kodi Control. Reinstall from the app to change it.
import json, os, subprocess, threading, hmac, xbmc, xbmcaddon, xbmcvfs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = ${+port || 8099}
SCRIPT = ${JSON.stringify(script)}
PROFILE = xbmcvfs.translatePath('special://profile/addon_data/${ID}/')

def token():
    try:
        with open(os.path.join(PROFILE, 'token')) as f:
            return f.read().strip()
    except Exception:
        return ''

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def ok(self, code, body, ctype='application/json'):
        b = body.encode('utf-8') if isinstance(body, str) else body
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def authed(self):
        t = token()
        got = parse_qs(urlparse(self.path).query).get('t', [''])[0] or self.headers.get('X-Token', '')
        return bool(t) and hmac.compare_digest(t, got)

    def do_GET(self):
        p = urlparse(self.path).path
        if p == '/ping':
            return self.ok(200, json.dumps({'ok': True, 'version': '${VERSION}'}))
        if not self.authed():
            return self.ok(403, '{"error":"token"}')
        if p == '/stats':
            try:
                out = subprocess.run(SCRIPT, shell=True, capture_output=True, timeout=10).stdout.decode('utf-8', 'replace')
            except Exception as e:
                out = ''
            return self.ok(200, json.dumps({'raw': out}))
        self.ok(404, '{}')

    def do_POST(self):
        if not self.authed():
            return self.ok(403, '{"error":"token"}')
        if urlparse(self.path).path != '/rpc':
            return self.ok(404, '{}')
        n = int(self.headers.get('Content-Length', '0') or 0)
        body = self.rfile.read(n).decode('utf-8')
        self.ok(200, xbmc.executeJSONRPC(body))

srv = ThreadingHTTPServer(('0.0.0.0', PORT), H)
srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()
mon = xbmc.Monitor()
while not mon.abortRequested():
    if mon.waitForAbort(2):
        break
srv.shutdown()
srv.server_close()
`;

module.exports = { ID, VERSION, addonXml, servicePy };
