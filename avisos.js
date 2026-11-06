// avisos.js — Aviso dentro de la app («pop-up» al abrir).
//
// QUÉ ES (2026-11-06, Matías): una forma de comunicarle algo a los pilotos
// SIN sacar una versión nueva: una función nueva, «felices fiestas», etc.
// La app pide GET /aviso al abrir; si hay uno vigente y ese piloto todavía
// no lo cerró, lo muestra UNA vez (la app guarda los `id` ya vistos).
//
// CÓMO SE PUBLICA: Matías le pide el texto a Claude y Claude edita
// `avisos/aviso.json` en este repo (commit a main = deploy). Las imágenes van
// en `avisos/img/` y se sirven en /avisos/img/<archivo>. Para mandar uno
// NUEVO hay que cambiar el `id` (si se reusa, a quien ya lo cerró no le
// vuelve a aparecer). Para apagarlo: "activo": false.
//
// Formato de avisos/aviso.json:
// {
//   "id": "2026-12-fiestas",          // único por aviso
//   "activo": true,
//   "plataformas": ["ios", "android"], // o sólo una
//   "desde": "2026-12-20T00:00:00-03:00",  // opcional
//   "hasta": "2027-01-02T00:00:00-03:00",  // opcional
//   "titulo": "¡Felices fiestas!",       // opcional si hay imagen
//   "texto": "…",
//   "imagen": "fiestas.jpg",           // opcional: archivo en avisos/img o URL
//   "boton": { "texto": "Ver", "link": "https://…" }  // opcional
// }
//
// Se lee el archivo en cada pedido (es chico y llega pocas veces): así un
// cambio de JSON no depende de reiniciar nada más que el deploy.

import express from "express";
import { readFile } from "node:fs/promises";

const ARCHIVO = new URL("./avisos/aviso.json", import.meta.url);
const BASE_PUBLICA = "https://notam-api.onrender.com";
let pedidos = 0;
let ultimoError = null;

async function leer() {
  try {
    const txt = await readFile(ARCHIVO, "utf8");
    ultimoError = null;
    return JSON.parse(txt);
  } catch (e) {
    // Sin archivo = sin aviso. Un JSON roto se loguea y tampoco se muestra
    // nada: mejor ningún aviso que uno roto.
    if (e.code !== "ENOENT") {
      ultimoError = e.message;
      console.error(`[avisos] ${e.message}`);
    }
    return null;
  }
}

function vigente(a, plataforma, ahora = new Date()) {
  // Alcanza con título O imagen: un saludo puede ser sólo una foto
  // (Matías, 2026-11-06: «felices fiestas» vertical sin texto ni botón).
  if (!a || a.activo === false || !a.id || !(a.titulo || a.imagen)) return false;
  if (Array.isArray(a.plataformas) && plataforma &&
      !a.plataformas.includes(plataforma)) return false;
  if (a.desde && ahora < new Date(a.desde)) return false;
  if (a.hasta && ahora >= new Date(a.hasta)) return false;
  return true;
}

export function montar(app) {
  app.get("/aviso", async (req, res) => {
    pedidos++;
    const plataforma = String(req.query.plataforma || "").toLowerCase();
    const a = await leer();
    // Sin caché (2026-11-06): con max-age=300 el iPhone se quedaba con la
    // respuesta del aviso anterior y uno nuevo no aparecía. Es un JSON chico.
    res.set("Cache-Control", "no-store");
    if (!vigente(a, plataforma)) return res.json({ aviso: null });
    let imagen = a.imagen || null;
    if (imagen && !/^https?:\/\//.test(imagen)) {
      imagen = `${BASE_PUBLICA}/avisos/img/${encodeURIComponent(imagen)}`;
    }
    const boton = a.boton && a.boton.texto && a.boton.link
      ? { texto: String(a.boton.texto), link: String(a.boton.link) } : null;
    res.json({
      aviso: {
        id: String(a.id),
        titulo: a.titulo ? String(a.titulo) : "",
        texto: a.texto ? String(a.texto) : "",
        imagen,
        boton,
      },
    });
  });

  // Imágenes de los avisos. Una imagen que cambia es una imagen nueva con
  // otro nombre, como las fotos de aviones.
  app.use("/avisos/img", express.static(new URL("./avisos/img", import.meta.url).pathname, {
    maxAge: "30d", index: false, fallthrough: true,
  }));
}

export function estado() {
  return { pedidos, error: ultimoError };
}
