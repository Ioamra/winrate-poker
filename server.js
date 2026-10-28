/* Mini serveur du projet, sans aucune dépendance.

   Usage :   node server.js        puis ouvrir http://localhost:8080
             PORT=3000 node server.js   pour changer de port

   - sert les fichiers du dossier (index.html, style.css, script.js, results/…)
   - GET  /api/ping                 indique à la page que le serveur est là
   - POST /api/results/<donnes>     écrit results/<donnes>.json après vérification
*/
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { validateResults, formatResultsFile } = require("./script.js");

const ROOT = __dirname;
const RESULTS = path.join(ROOT, "results");
const PORT = Number(process.env.PORT) || 8080;
const MAX_BODY = 1024 * 1024; // un jeu de résultats fait ~30 Ko

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(
    typeof body === "string" || Buffer.isBuffer(body)
      ? body
      : JSON.stringify(body),
  );
}

function serveFile(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.normalize(
    path.join(ROOT, urlPath === "/" ? "index.html" : urlPath),
  );
  if (!file.startsWith(ROOT + path.sep))
    return send(res, 403, { error: "accès refusé" });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: "introuvable" });
    send(
      res,
      200,
      data,
      TYPES[path.extname(file)] || "application/octet-stream",
    );
  });
}

function saveResults(req, res, trials) {
  let body = "",
    tooBig = false;
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY) {
      tooBig = true;
      req.destroy();
    }
  });
  req.on("end", () => {
    if (tooBig) return send(res, 413, { error: "contenu trop gros" });
    let set;
    try {
      set = JSON.parse(body);
    } catch (e) {
      return send(res, 400, { error: "JSON illisible" });
    }
    if (set.trials !== trials)
      return send(res, 400, { error: "le nombre de donnes ne correspond pas" });
    const problem = validateResults(set);
    if (problem) return send(res, 400, { error: problem });

    // Écriture dans un fichier temporaire puis renommage : jamais de fichier à moitié écrit
    fs.mkdirSync(RESULTS, { recursive: true });
    const target = path.join(RESULTS, trials + ".json");
    const tmp = target + ".tmp";
    fs.writeFileSync(tmp, formatResultsFile(set));
    fs.renameSync(tmp, target);
    console.log(
      new Date().toLocaleString("fr-FR") +
        " · results/" +
        trials +
        ".json enregistré",
    );
    send(res, 200, { ok: true, file: "results/" + trials + ".json" });
  });
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x").pathname;
    if (url === "/api/ping" && req.method === "GET")
      return send(res, 200, { ok: true });
    const m = url.match(/^\/api\/results\/(\d+)$/);
    if (m && req.method === "POST") return saveResults(req, res, Number(m[1]));
    if (req.method === "GET" || req.method === "HEAD")
      return serveFile(req, res);
    send(res, 405, { error: "méthode non prise en charge" });
  })
  .listen(PORT, () => {
    console.log("Équités préflop : http://localhost:" + PORT);
  });
