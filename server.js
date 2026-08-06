// notam-api — server.js
//
// v3 (2026-08-06): la lista de lugares se lee de ANAC, ya no está hardcodeada.
//
// EL PROBLEMA QUE ARREGLA
// -----------------------
// La v2 tenía 61 indicadores fijos en el código y trataba cualquier fallo
// como error, conservando el dato viejo. Eso produjo dos bugs serios:
//
//  1. ANAC dice, textual, en su página: "El control de selección muestra
//     únicamente lugares que registran notams activos. Los lugares sin
//     novedades activas no se incluyen en la lista." O sea que pedir un
//     lugar sin novedades NO devuelve vacío: devuelve HTTP 500. La v2 lo
//     contaba como fallo, se quedaba con el NOTAM anterior y lo servía
//     como si siguiera vigente. Al detectarlo había datos de 13 días
//     presentados como actuales.
//
//  2. Al revés: ANAC publicaba 77 lugares con novedades activas y la app
//     sólo consultaba 61. Faltaban 33, casi todos de aviación general
//     —Saladillo, Las Flores, Pehuajó, Punta Indio, San Pedro, Balcarce—
//     y para esos la app respondía "sin NOTAM" habiendo NOTAM.
//
// LA SOLUCIÓN
// -----------
// Cada pasada se lee primero el selector de ANAC, que es la lista
// autoritativa del momento. De ahí salen tres estados bien distintos:
//
//   · está en la lista y se pudo scrapear  → NOTAMs
//   · NO está en la lista                  → ANAC no publica novedades
//   · está en la lista pero falló          → dato viejo, marcado stale
//
// El segundo caso es el que antes se confundía con el tercero.

import express from "express";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

const REFRESH_PAUSE_MS = 5 * 60 * 1000; // pausa entre pasadas completas
const DELAY_BETWEEN_MS = 1500;          // ANAC devuelve 500 si se le pega seguido
const LIST_URL = "https://ais.anac.gob.ar/notam";
const PIB_URL  = "https://ais.anac.gob.ar/notam/pib";

// ── Estado en memoria ────────────────────────────────────────────────────
const cache = new Map();          // indicador → { data, timestamp }
const scrapeErrors = new Map();   // indicador → último error real
let locations = new Map();        // indicador → nombre (lista viva de ANAC)
let locationsUpdatedAt = null;
const startedAt = Date.now();

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Lista de lugares con novedades activas ───────────────────────────────

async function fetchLocations() {
  const res = await fetch(LIST_URL, { headers: { "User-Agent": "NotamApi/3.0" } });
  if (!res.ok) throw new Error(`ANAC lista respondió ${res.status}`);

  const $ = cheerio.load(await res.text());
  const found = new Map();
  $("select option").each((_, o) => {
    const value = ($(o).attr("value") || "").trim();
    const text = $(o).text().replace(/\s+/g, " ").trim();
    if (value && value !== "Seleccione un lugar") found.set(value, text);
  });
  if (found.size === 0) throw new Error("no se encontró ninguna opción en el selector");
  return found;
}

// Si la lista falla se CONSERVA la anterior: quedarse sin lista sería peor
// que tenerla algo vieja, porque dejaría de scrapearse todo.
async function refreshLocations() {
  try {
    locations = await fetchLocations();
    locationsUpdatedAt = Date.now();
    console.log(`[locations] ${locations.size} lugares con novedades activas`);
  } catch (e) {
    console.error(`[locations] falló, se conserva la anterior: ${e.message}`);
  }
}

// ── Parser ───────────────────────────────────────────────────────────────

function parseNotamHtml(html) {
  const $ = cheerio.load(html);
  const notams = [];

  $("#pibdata tr").each((_, row) => {
    const place = $(row).find("td#place p")
      .map((_, p) => $(p).text().trim()).get().filter(Boolean);
    const info = $(row).find("td#info p")
      .map((_, p) => $(p).text().trim()).get().filter(Boolean);

    const numero = place[0] || null;
    const lugar = place[1] || null;
    const indicador = place[2]?.replace(/[()]/g, "") || null;
    const desde = info.find(t => t.startsWith("Desde:"))?.replace("Desde:", "").trim() || null;
    const hasta = info.find(t => t.startsWith("Hasta:"))?.replace("Hasta:", "").trim() || null;
    const texto = info
      .filter(t => !t.startsWith("Desde:") && !t.startsWith("Hasta:"))
      .join(" ").trim();

    if (numero || texto) notams.push({ numero, lugar, indicador, desde, hasta, texto });
  });

  return notams;
}

// ── Scraper ──────────────────────────────────────────────────────────────

async function scrapeNotams(indicador) {
  const response = await fetch(PIB_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "Referer": LIST_URL,
      "User-Agent": "NotamApi/3.0"
    },
    body: new URLSearchParams({ indicador })
  });
  if (!response.ok) throw new Error(`ANAC respondió con status ${response.status}`);

  const notams = parseNotamHtml(await response.text());
  return {
    source: "ANAC AIS",
    indicador,
    nombre: locations.get(indicador) || null,
    retrieved_at: new Date().toISOString(),
    count: notams.length,
    notams,
    warning: "Información de referencia. No reemplaza briefing oficial ARO-AIS."
  };
}

async function refreshOne(indicador) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      cache.set(indicador, { data: await scrapeNotams(indicador), timestamp: Date.now() });
      scrapeErrors.delete(indicador);
      return;
    } catch (error) {
      if (attempt === 2) {
        scrapeErrors.set(indicador, error.message);
        console.error(`[refresher] ${indicador}: ${error.message}`);
      } else {
        await sleep(5000);
      }
    }
  }
}

// ── Loop ─────────────────────────────────────────────────────────────────

async function refresherLoop() {
  while (true) {
    const t0 = Date.now();
    await refreshLocations();

    // Los lugares que YA NO están en la lista perdieron sus novedades: se
    // limpian del cache para no seguir sirviendo NOTAM vencidos.
    for (const ind of [...cache.keys()]) {
      if (!locations.has(ind)) {
        cache.delete(ind);
        scrapeErrors.delete(ind);
      }
    }

    for (const indicador of locations.keys()) {
      await refreshOne(indicador);
      await sleep(DELAY_BETWEEN_MS);
    }

    const secs = Math.round((Date.now() - t0) / 1000);
    console.log(`[refresher] pasada: ${locations.size} lugares en ${secs}s (${scrapeErrors.size} con error)`);
    await sleep(REFRESH_PAUSE_MS);
  }
}

// ── Endpoints ────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "NOTAM API", version: 3, example: "/notams/AER" });
});

app.get("/health", (req, res) => {
  const timestamps = [...cache.values()].map(e => e.timestamp);
  res.json({
    ok: true,
    version: 3,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    locations_activas: locations.size,
    locations_updated_s: locationsUpdatedAt
      ? Math.round((Date.now() - locationsUpdatedAt) / 1000) : null,
    cached: cache.size,
    oldest_cache_s: timestamps.length
      ? Math.round((Date.now() - Math.min(...timestamps)) / 1000) : null,
    scrape_errors: scrapeErrors.size,
    con_error: [...scrapeErrors.keys()]
  });
});

app.get("/locations", (req, res) => {
  res.json({
    count: locations.size,
    updated_at: locationsUpdatedAt ? new Date(locationsUpdatedAt).toISOString() : null,
    nota: "Sólo lugares con NOTAM activos. ANAC no lista los que no tienen novedades.",
    locations: [...locations].map(([indicador, nombre]) => ({ indicador, nombre }))
  });
});

app.get("/notams/:indicador", async (req, res) => {
  const indicador = req.params.indicador.toUpperCase();

  // Caso 1 — no está en la lista de ANAC.
  //
  // Es el caso que la v2 confundía con un fallo y por el que servía NOTAM
  // vencidos. Pero OJO con el otro extremo: tampoco se puede afirmar "no
  // hay NOTAM". Verificado el 2026-08-06 que ANAC publica novedades con
  // inicio futuro (Aeroparque tenía una que arrancaba 19 días después) y
  // aun así hubo un NOTAM real de Morón para el día siguiente que su sitio
  // no mostraba. La ausencia en ANAC NO garantiza ausencia de NOTAM.
  if (locations.size > 0 && !locations.has(indicador)) {
    return res.json({
      source: "ANAC AIS",
      indicador,
      retrieved_at: new Date().toISOString(),
      count: 0,
      notams: [],
      no_publicado_por_anac: true,
      nota: "ANAC no lista novedades activas para este lugar. Esto no garantiza que no existan: consultá ARO-AIS.",
      warning: "Información de referencia. No reemplaza briefing oficial ARO-AIS."
    });
  }

  // Caso 2 — está en la lista pero el loop todavía no llegó.
  if (!cache.has(indicador)) await refreshOne(indicador);

  const entry = cache.get(indicador);

  // Caso 3 — está en la lista y no se pudo obtener.
  if (!entry) {
    return res.status(502).json({
      error: "No se pudieron obtener los NOTAM",
      indicador,
      detail: scrapeErrors.get(indicador) || "sin datos"
    });
  }

  res.json({
    ...entry.data,
    cache: true,
    stale: scrapeErrors.has(indicador),
    cache_age_s: Math.round((Date.now() - entry.timestamp) / 1000)
  });
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  refresherLoop();
});
