import express from "express";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

const cache = new Map();
const CACHE_TIME_MS = 5 * 60 * 1000; // 5 minutos

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