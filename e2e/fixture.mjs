import {createServer} from "node:https";
import {readFileSync, statSync, createReadStream} from "node:fs";
const CUES = [[1.0, 3.5, "No sabía que estabas aquí."], [4.0, 6.5, "¿Qué estás buscando?"], [7.0, 9.5, "Ya lo sé."]];
const driver = (render) => `<script>const CUES=${JSON.stringify(CUES)};const v=document.querySelector("video");let last=null;
function loop(){const t=v.currentTime;const c=CUES.find(([a,b])=>t>=a&&t<b);const text=c?c[2]:"";if(text!==last){last=text;(${render})(text)}requestAnimationFrame(loop)}loop();</script>`;
const youtube = `<!doctype html><html><head><meta charset="utf-8"><title>Clase de español - YouTube</title><style>#movie_player{position:relative;width:960px;height:540px;background:#000}video{width:100%;height:100%}.ytp-caption-window-container{position:absolute;left:0;right:0;bottom:40px;text-align:center}.ytp-caption-segment{background:rgba(0,0,0,.75);color:#fff;font-size:26px}</style></head><body>
<div id="title"><h1>Clase de español</h1></div>
<div id="movie_player" class="html5-video-player"><div class="html5-video-container"><video class="html5-main-video" src="/scene.mp4" playsinline></video></div>
<div class="ytp-caption-window-container" id="ytp-caption-window-container"></div></div>
${driver(`(text)=>{const c=document.getElementById("ytp-caption-window-container");c.innerHTML=text?'<div class="caption-window"><span class="captions-text"><span class="caption-visual-line"><span class="ytp-caption-segment"></span></span></span></div>':"";if(text)c.querySelector(".ytp-caption-segment").textContent=text}`)}</body></html>`;
const netflix = `<!doctype html><html><head><meta charset="utf-8"><title>Netflix</title><style>.watch-video--player-view{position:relative;width:960px;height:540px;background:#000}video{width:100%;height:100%}.player-timedtext{position:absolute;inset:auto 0 40px 0;text-align:center;color:#fff;font-size:26px}</style></head><body>
<div class="watch-video"><div class="watch-video--player-view"><div data-uia="video-title"><h4>La casa</h4><span>E1 Pilot</span></div><video src="/scene.mp4" playsinline></video><div class="player-timedtext"></div></div></div>
<script>navigator.requestMediaKeySystemAccess("org.w3.clearkey",[{initDataTypes:["cenc"],videoCapabilities:[{contentType:'video/mp4; codecs="avc1.42E01E"'}]}]).then(a=>a.createMediaKeys()).then(k=>document.querySelector("video").setMediaKeys(k)).then(()=>{window.protectedReady=true},e=>{window.protectedReady="error: "+e})</script>
${driver(`(text)=>{const c=document.querySelector(".player-timedtext");c.innerHTML=text?'<div class="player-timedtext-text-container"><span><span></span></span></div>':"";if(text)c.querySelector("span span").textContent=text}`)}</body></html>`;
const other = `<!doctype html><html><body><p id="x">plain page</p></body></html>`;
createServer({key: readFileSync("key.pem"), cert: readFileSync("cert.pem")}, (req, res) => {
  const url = new URL(req.url, "https://x");
  if (url.pathname === "/scene.mp4") {
    const size = statSync("scene.mp4").size; const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    if (m) { const s = +m[1], e = m[2] ? +m[2] : size - 1; res.writeHead(206, {"content-type": "video/mp4", "content-range": `bytes ${s}-${e}/${size}`, "accept-ranges": "bytes", "content-length": e - s + 1}); return createReadStream("scene.mp4", {start: s, end: e}).pipe(res); }
    res.writeHead(200, {"content-type": "video/mp4", "accept-ranges": "bytes", "content-length": size}); return createReadStream("scene.mp4").pipe(res);
  }
  const host = req.headers.host ?? "";
  const body = host.includes("netflix") && /^\/watch\/\d+/.test(url.pathname) ? netflix : host.includes("youtube") && url.pathname === "/watch" ? youtube : other;
  res.writeHead(200, {"content-type": "text/html; charset=utf-8"}); res.end(body);
}).listen(4443, "127.0.0.1", () => console.log("fixture on 4443"));
