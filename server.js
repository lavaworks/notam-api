// notam-api — server.js
//
// v2: scrapeo proactivo en background + respuesta siempre desde cache.
//
// Antes: cada request a /notams/:indicador scrapeaba ANAC (con cache 5 min).
// Ahora: un loop interno scrapea TODAS las locations en ronda continua y los
// endpoints leen de memoria → respuesta en milisegundos, siempre.
// Si un indicador todavía no está cacheado (recién arrancó el server),
// se scrapea on-demand una sola vez como fallback.

import express from "express";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

// ── Configuración del refresher ──────────────────────────────────────────
const REFRESH_PAUSE_MS = 5 * 60 * 1000; // pausa entre pasadas completas
const DELAY_BETWEEN_MS = 1500;          // pausa entre locations (ANAC devuelve
                                        // 500 si se le pega muy seguido)

const locations = [
  { indicador: "AER", nombre: "AEROPARQUE J. NEWBERY", tipo: "AERODROMO" },
  { indicador: "---", nombre: "AVISOS A TODAS LAS FIRS", tipo: "TODAS_LAS_FIRS" },
  { indicador: "-VF", nombre: "AVISOS FIR COMODORO", tipo: "FIR" },
  { indicador: "-CF", nombre: "AVISOS FIR CORDOBA", tipo: "FIR" },
  { indicador: "-EF", nombre: "AVISOS FIR EZEIZA", tipo: "FIR" },
  { indicador: "-MF", nombre: "AVISOS FIR MENDOZA", tipo: "FIR" },
  { indicador: "-RR", nombre: "AVISOS FIR RESISTENCIA", tipo: "FIR" },
  { indicador: "BCA", nombre: "BAHIA BLANCA/CTE ESPORA", tipo: "AERODROMO" },
  { indicador: "BGI", nombre: "BERAZATEGUI/ALAS DE MALVINAS", tipo: "AERODROMO" },
  { indicador: "CAT", nombre: "CATAMARCA", tipo: "AERODROMO" },
  { indicador: "IGU", nombre: "CATARATAS DEL IGUAZU / M. C. E. KRAUSE", tipo: "AERODROMO" },
  { indicador: "CLN", nombre: "COLON/ENTRE RIOS", tipo: "AERODROMO" },
  { indicador: "CRV", nombre: "COMODORO RIVADAVIA/GRAL. E. MOSCONI", tipo: "AERODROMO" },
  { indicador: "CDU", nombre: "CONCEPCIÓN DEL URUGUAY", tipo: "AERODROMO" },
  { indicador: "DIA", nombre: "CONCORDIA/COMODORO PIERRESTEGUI", tipo: "AERODROMO" },
  { indicador: "ESC", nombre: "CORDOBA/ESCUELA DE AVIACION MILITAR", tipo: "AERODROMO" },
  { indicador: "CBA", nombre: "CORDOBA/ING. AER. A. L. V. TARAVELLA", tipo: "AERODROMO" },
  { indicador: "CRR", nombre: "CORRIENTES", tipo: "AERODROMO" },
  { indicador: "ECA", nombre: "EL CALAFATE", tipo: "AERODROMO" },
  { indicador: "PAL", nombre: "EL PALOMAR", tipo: "AERODROMO" },
  { indicador: "EPZ", nombre: "ESPERANZA", tipo: "AERODROMO" },
  { indicador: "ESQ", nombre: "ESQUEL/BRIGADIER GENERAL ANTONIO PARODI", tipo: "AERODROMO" },
  { indicador: "EZE", nombre: "EZEIZA/MINISTRO PISTARINI", tipo: "AERODROMO" },
  { indicador: "FSA", nombre: "FORMOSA", tipo: "AERODROMO" },
  { indicador: "GPI", nombre: "GENERAL PICO", tipo: "AERODROMO" },
  { indicador: "GOY", nombre: "GOYA", tipo: "AERODROMO" },
  { indicador: "JUJ", nombre: "JUJUY/GOBERNADOR GUZMAN", tipo: "AERODROMO" },
  { indicador: "PDA", nombre: "JUJUY/PUERTA DE AVALOS", tipo: "AERODROMO" },
  { indicador: "PTA", nombre: "LA PLATA", tipo: "AERODROMO" },
  { indicador: "LAR", nombre: "LA RIOJA/CAP. VICENTE A. ALMONACID", tipo: "AERODROMO" },
  { indicador: "MLG", nombre: "MALARGÜE", tipo: "AERODROMO" },
  { indicador: "MDP", nombre: "MAR DEL PLATA/ASTOR PIAZZOLLA", tipo: "AERODROMO" },
  { indicador: "MAT", nombre: "MATANZA", tipo: "AERODROMO" },
  { indicador: "DOZ", nombre: "MENDOZA/EL PLUMERILLO", tipo: "AERODROMO" },
  { indicador: "MOR", nombre: "MORON/ PRESIDENTE RIVADAVIA", tipo: "AERODROMO" },
  { indicador: "PAR", nombre: "PARANA/GRAL. URQUIZA", tipo: "AERODROMO" },
  { indicador: "LIB", nombre: "PASO DE LOS LIBRES", tipo: "AERODROMO" },
  { indicador: "DRY", nombre: "PUERTO MADRYN/EL TEHUELCHE", tipo: "AERODROMO" },
  { indicador: "ILM", nombre: "QUILMES", tipo: "AERODROMO" },
  { indicador: "SIS", nombre: "RESISTENCIA", tipo: "AERODROMO" },
  { indicador: "TRC", nombre: "RIO CUARTO/AREA DE MATERIAL", tipo: "AERODROMO" },
  { indicador: "GAL", nombre: "RIO GALLEGOS/PILOTO CIVIL N. FERNANDEZ", tipo: "AERODROMO" },
  { indicador: "GRA", nombre: "RIO GRANDE", tipo: "AERODROMO" },
  { indicador: "ROS", nombre: "ROSARIO/ ISLAS MALVINAS", tipo: "AERODROMO" },
  { indicador: "SAL", nombre: "SALTA", tipo: "AERODROMO" },
  { indicador: "BAR", nombre: "SAN CARLOS DE BARILOCHE", tipo: "AERODROMO" },
  { indicador: "FDO", nombre: "SAN FERNANDO", tipo: "AERODROMO" },
  { indicador: "JUA", nombre: "SAN JUAN", tipo: "AERODROMO" },
  { indicador: "UIS", nombre: "SAN LUIS/BRIGADIER MAYOR D. CESAR RAUL OJEDA", tipo: "AERODROMO" },
  { indicador: "CHP", nombre: "SAN MARTIN DE LOS ANDES/AVIADOR C. CAMPOS", tipo: "AERODROMO" },
  { indicador: "SNY", nombre: "SAN NICOLAS DE LOS ARROYOS", tipo: "AERODROMO" },
  { indicador: "SRA", nombre: "SAN RAFAEL/S. A. SANTIAGO GERMANO", tipo: "AERODROMO" },
  { indicador: "SVO", nombre: "SANTA FE/SAUCE VIEJO", tipo: "AERODROMO" },
  { indicador: "OSA", nombre: "SANTA ROSA", tipo: "AERODROMO" },
  { indicador: "DIO", nombre: "TANDIL/COMANDANTE EDUARDO A. OLIVERO", tipo: "AERODROMO" },
  { indicador: "TRH", nombre: "TERMAS DE RIO HONDO", tipo: "AERODROMO" },
  { indicador: "TRE", nombre: "TRELEW/ALMIRANTE ZAR", tipo: "AERODROMO" },
  { indicador: "TUC", nombre: "TUCUMAN/TEN. BENJAMIN MATIENZO", tipo: "AERODROMO" },
  { indicador: "USU", nombre: "USHUAIA/MALVINAS ARGENTINAS", tipo: "AERODROMO" },
  { indicador: "VIE", nombre: "VIEDMA/GOBERNADOR CASTELLO", tipo: "AERODROMO" },
  { indicador: "VMR", nombre: "VILLA MARIA/AEROPUERTO REGIONAL", tipo: "AERODROMO" }
];

const validIndicators = new Set(locations.map(item => item.indicador));

// ── Cache en memoria ─────────────────────────────────────────────────────
// indicador → { data, timestamp }   (data = respuesta lista para servir)
const cache = new Map();
// indicador → mensaje del último error de scrapeo (si falló)
const scrapeErrors = new Map();
const startedAt = Date.now();

// ── Parser (sin cambios) ─────────────────────────────────────────────────

function parseNotamHtml(html) {
  const $ = cheerio.load(html);
  const notams = [];

  $("#pibdata tr").each((_, row) => {
    const place = $(row)
      .find("td#place p")
      .map((_, p) => $(p).text().trim())
      .get()
      .filter(Boolean);

    const info = $(row)
      .find("td#info p")
      .map((_, p) => $(p).text().trim())
      .get()
      .filter(Boolean);

    const numero = place[0] || null;
    const lugar = place[1] || null;
    const indicador = place[2]?.replace(/[()]/g, "") || null;

    const desde = info
      .find(t => t.startsWith("Desde:"))
      ?.replace("Desde:", "")
      .trim() || null;

    const hasta = info
      .find(t => t.startsWith("Hasta:"))
      ?.replace("Hasta:", "")
      .trim() || null;

    const texto = info
      .filter(t => !t.startsWith("Desde:") && !t.startsWith("Hasta:"))
      .join(" ")
      .trim();

    if (numero || texto) {
      notams.push({
        numero,
        lugar,
        indicador,
        desde,
        hasta,
        texto
      });
    }
  });

  return notams;
}

// ── Scraper de UN indicador ──────────────────────────────────────────────

async function scrapeNotams(indicador) {
  const response = await fetch("https://ais.anac.gob.ar/notam/pib", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "Referer": "https://ais.anac.gob.ar/notam",
      "User-Agent": "NotamApi/2.0"
    },
    body: new URLSearchParams({ indicador })
  });

  if (!response.ok) {
    throw new Error(`ANAC respondió con status ${response.status}`);
  }

  const html = await response.text();
  const notams = parseNotamHtml(html);

  return {
    source: "ANAC AIS",
    indicador,
    retrieved_at: new Date().toISOString(),
    count: notams.length,
    notams,
    warning: "Información de referencia. No reemplaza briefing oficial ARO-AIS."
  };
}

// Scrapea un indicador y actualiza el cache. ANAC devuelve 500 de forma
// intermitente, así que ante un fallo se reintenta UNA vez tras 2 s.
// Si vuelve a fallar, se conserva el dato anterior (stale) y se registra
// el error; la próxima pasada del loop vuelve a intentar.
async function refreshOne(indicador) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const data = await scrapeNotams(indicador);
      cache.set(indicador, { data, timestamp: Date.now() });
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

// ── Loop de refresco en background ───────────────────────────────────────
// Pasada completa por las 61 locations (en serie, con pausa) → espera
// REFRESH_PAUSE_MS → repite. Nunca se superponen dos pasadas.

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function refresherLoop() {
  while (true) {
    const t0 = Date.now();
    for (const loc of locations) {
      await refreshOne(loc.indicador);
      await sleep(DELAY_BETWEEN_MS);
    }
    const secs = Math.round((Date.now() - t0) / 1000);
    console.log(`[refresher] pasada completa: ${locations.length} locations en ${secs}s (${scrapeErrors.size} errores)`);
    await sleep(REFRESH_PAUSE_MS);
  }
}

// ── Endpoints ────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "NOTAM API",
    example: "/notams/MOR"
  });
});

// Para keep-alive (UptimeRobot) y monitoreo.
app.get("/health", (req, res) => {
  const timestamps = [...cache.values()].map(e => e.timestamp);
  res.json({
    ok: true,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    locations: locations.length,
    cached: cache.size,
    oldest_cache_s: timestamps.length
      ? Math.round((Date.now() - Math.min(...timestamps)) / 1000)
      : null,
    scrape_errors: scrapeErrors.size
  });
});

app.get("/locations", (req, res) => {
  res.json({
    count: locations.length,
    locations
  });
});

app.get("/notams/:indicador", async (req, res) => {
  const indicador = req.params.indicador.toUpperCase();

  if (!validIndicators.has(indicador)) {
    return res.status(400).json({
      error: "Indicador inválido",
      indicador,
      message: "El indicador no existe en la lista de lugares soportados.",
      available_endpoint: "/locations"
    });
  }

  // Fallback: si el loop todavía no llegó a este indicador (server recién
  // despierto), scrapear on-demand una vez.
  if (!cache.has(indicador)) {
    await refreshOne(indicador);
  }

  const entry = cache.get(indicador);

  if (!entry) {
    // Ni el loop ni el on-demand pudieron obtenerlo.
    return res.status(500).json({
      error: "No se pudieron obtener los NOTAM",
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
  // Arrancar el scrapeo proactivo (no bloquea el listen).
  refresherLoop();
});
