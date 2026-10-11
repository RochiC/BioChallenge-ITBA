"""Servidor local del dashboard.

Uso:  python servidor.py      (o doble clic en INICIAR.bat)  → abre http://localhost:8000

- Muestra el dashboard (carpeta dashboard/) con los casos de ejemplo ya exportados.
- Recibe los estudios que carga el médico (T1 con contraste + segmentación de cada control),
  los procesa con el motor de lesion_3d.py y guarda el análisis en el historial (carpeta historial/).
"""
import json
import re
import tempfile
import threading
import traceback
import uuid
import webbrowser
from datetime import datetime
from pathlib import Path

import nibabel as nib
import pandas as pd
from flask import Flask, abort, jsonify, request, send_from_directory
from werkzeug.utils import secure_filename

import lesion_3d as L
from exportar_dashboard import construir_datos

RAIZ = Path(__file__).resolve().parent
DASH = RAIZ / "dashboard"
HISTORIAL = RAIZ / "historial"          # análisis guardados (no se suben a GitHub)
SUBIDAS = Path(tempfile.gettempdir()) / "biochallenge_subidas"
PUERTO = 8000

app = Flask(__name__, static_folder=None)


@app.after_request
def permitir_local(resp):
    # permite que la página abierta con doble clic (file://) consulte al servidor
    resp.headers["Access-Control-Allow-Origin"] = "*"
    return resp


@app.get("/")
def inicio():
    return send_from_directory(DASH, "index.html")


@app.get("/<path:ruta>")
def estaticos(ruta):
    return send_from_directory(DASH, ruta)


@app.get("/api/estado")
def estado():
    return jsonify(ok=True)


@app.get("/api/historial")
def historial():
    items = []
    for f in sorted(HISTORIAL.glob("*.resumen.json"), reverse=True):
        items.append(json.loads(f.read_text(encoding="utf-8")))
    return jsonify(items)


@app.get("/api/paciente/<id_>")
def paciente(id_):
    f = HISTORIAL / f"{secure_filename(id_)}.json"
    if not f.exists():
        abort(404)
    return app.response_class(f.read_text(encoding="utf-8"), mimetype="application/json")


def _archivo_notas(clave):
    return HISTORIAL / "notas" / f"{secure_filename(clave) or 'sin-nombre'}.json"


def _leer_notas(clave):
    f = _archivo_notas(clave)
    if not f.exists():
        return []
    d = json.loads(f.read_text(encoding="utf-8"))
    if isinstance(d, dict):  # formato anterior: una sola nota
        return [dict(id="anterior", texto=d.get("texto", ""), fecha=d.get("fecha"))] if d.get("texto") else []
    return d


def _guardar_notas(clave, notas):
    f = _archivo_notas(clave)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(notas, ensure_ascii=False), encoding="utf-8")


@app.get("/api/notas/<clave>")
def leer_notas(clave):
    return jsonify(_leer_notas(clave))


@app.post("/api/notas/<clave>")
def agregar_nota(clave):
    texto = str((request.get_json(silent=True) or {}).get("texto", "")).strip()[:5000]
    notas = _leer_notas(clave)
    if texto:
        notas.append(dict(id=uuid.uuid4().hex[:8], texto=texto, fecha=datetime.now().strftime("%d/%m/%Y %H:%M")))
        _guardar_notas(clave, notas)
    return jsonify(notas)


@app.delete("/api/notas/<clave>/<id_>")
def borrar_nota(clave, id_):
    notas = [n for n in _leer_notas(clave) if n.get("id") != id_]
    _guardar_notas(clave, notas)
    return jsonify(notas)


class ErrorCarga(Exception):
    pass


@app.post("/api/analizar")
def analizar():
    try:
        meta = json.loads(request.form.get("meta", "{}"))
        controles = meta.get("controles", [])
        if not controles:
            raise ErrorCarga("No se recibió ningún control.")
        # por las dudas, se ignora la carpeta que algunos navegadores agregan al nombre
        archivos = {f.filename.replace("\\", "/").split("/")[-1]: f for f in request.files.getlist("archivos")}
        carpeta = SUBIDAS / uuid.uuid4().hex
        carpeta.mkdir(parents=True)
        nombre = (meta.get("nombre") or "").strip() or "Paciente"

        filas, forma = [], None
        for n, c in enumerate(sorted(controles, key=lambda c: c["dia"]), start=1):
            rutas = {}
            for clave in ("imagen", "mascara"):
                archivo = c.get(clave)
                if archivo not in archivos:
                    raise ErrorCarga(f"Falta el archivo {archivo!r} del control {n}.")
                destino = carpeta / f"{n:02d}_{clave}_{secure_filename(archivo)}"
                archivos[archivo].save(destino)
                rutas[clave] = destino
            try:
                img, seg = nib.load(rutas["imagen"]), nib.load(rutas["mascara"])
            except Exception:
                raise ErrorCarga(f"Control {n}: no se pudo leer el archivo como NIfTI.")
            if img.shape[:3] != seg.shape[:3]:
                raise ErrorCarga(f"Control {n}: la imagen y la segmentación tienen tamaños distintos.")
            if forma is None:
                forma = seg.shape[:3]
            elif seg.shape[:3] != forma:
                raise ErrorCarga("Las resonancias no comparten la misma grilla: tienen que estar corregistradas "
                                 "(misma posición y tamaño en todos los controles).")
            filas.append(dict(paciente_id=nombre, n_estudio=n, dia=int(c["dia"]),
                              archivo_imagen=str(rutas["imagen"]), archivo_mascara=str(rutas["mascara"]),
                              equipo=None, campo_T=None, spacing_x_mm=float("nan"),
                              spacing_y_mm=float("nan"), spacing_z_mm=float("nan")))
        est = pd.DataFrame(filas)
        r = L.procesar_paciente(nombre, est=est)
        if r["tabla"].empty:
            raise ErrorCarga("Las segmentaciones no tienen ninguna lesión marcada (valores 1 o 2).")

        ahora = datetime.now()
        id_ = ahora.strftime("%Y%m%d-%H%M%S-") + (re.sub(r"[^a-z0-9]+", "-", nombre.lower()).strip("-") or "estudio")
        info = dict(cargado=True, id=id_, fecha_carga=ahora.strftime("%d/%m/%Y %H:%M"))
        datos = construir_datos(r, info, pd.DataFrame())
        HISTORIAL.mkdir(exist_ok=True)
        (HISTORIAL / f"{id_}.json").write_text(json.dumps(datos, ensure_ascii=False), encoding="utf-8")
        (HISTORIAL / f"{id_}.resumen.json").write_text(json.dumps(datos["resumen"], ensure_ascii=False), encoding="utf-8")
        return jsonify(datos)
    except ErrorCarga as e:
        return jsonify(error=str(e)), 400
    except Exception as e:  # cualquier otro problema: se informa sin tirar el servidor
        traceback.print_exc()
        return jsonify(error=f"No se pudieron procesar los archivos ({type(e).__name__}: {e})."), 500


if __name__ == "__main__":
    url = f"http://localhost:{PUERTO}"
    print(f"\nHerramienta abierta en {url}  (dejá esta ventana abierta; Ctrl+C para cerrar)\n")
    threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=PUERTO, debug=False, threaded=True)
