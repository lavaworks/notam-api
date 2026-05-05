import express from "express";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

const cache = new Map();
const CACHE_TIME_MS = 5 * 60 * 1000; // 5 minutos

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

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "NOTAM API",
    example: "/notams/MOR"
  });
});

app.get("/notams/:indicador", async (req, res) => {
  const indicador = req.params.indicador.toUpperCase();

  const cached = cache.get(indicador);

  if (cached && Date.now() - cached.timestamp < CACHE_TIME_MS) {
    return res.json({
      ...cached.data,
      cache: true
    });
  }

  try {
    const response = await fetch("https://ais.anac.gob.ar/notam/pib", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": "https://ais.anac.gob.ar/notam",
        "User-Agent": "NotamApi/1.0"
      },
      body: new URLSearchParams({
        indicador
      })
    });

    if (!response.ok) {
      throw new Error(`ANAC respondió con status ${response.status}`);
    }

    const html = await response.text();
    const notams = parseNotamHtml(html);

    const data = {
      source: "ANAC AIS",
      indicador,
      retrieved_at: new Date().toISOString(),
      count: notams.length,
      notams,
      warning: "Información de referencia. No reemplaza briefing oficial ARO-AIS."
    };

    cache.set(indicador, {
      timestamp: Date.now(),
      data
    });

    res.json({
      ...data,
      cache: false
    });
  } catch (error) {
    res.status(500).json({
      error: "No se pudieron obtener los NOTAM",
      detail: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
