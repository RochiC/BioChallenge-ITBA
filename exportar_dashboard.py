"""Prepara los datos del dashboard (parte 2) a partir del motor de cálculo (parte 1).

Uso:  python exportar_dashboard.py
Después abrir dashboard/index.html con doble clic (funciona sin internet).

Para cada paciente genera dashboard/data/p_<id>.js con:
  - tablas por lesión y control (volumen, diámetros, ubicación, clasificación, cambio)
  - superficies 3D de cada lesión (realce / necrosis), mapa de cambio y contorno de la cabeza
  - el corte axial donde se mide el diámetro RANO-BM, con contornos y la línea del diámetro
"""
import base64
import io
import json
import math
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy import ndimage
from skimage import measure

import atlas
import lesion_3d as L

DASH = Path(__file__).resolve().parent / "dashboard"
DATA = DASH / "data"

COLUMNAS = ["n_estudio", "dia", "lesion", "total_cm3", "realce_cm3", "necrosis_cm3", "necrosis_pct",
            "vol_min_cm3", "vol_max_cm3", "diam_rano_mm", "diam_perp_mm", "diam_3d_mm", "medible_rano",
            "cortes_axiales", "corte_rano", "esfericidad", "vol_esfera_diam_cm3", "error_diam_vs_vol_pct",
            "centro_x_mm", "centro_y_mm", "centro_z_mm", "corte_axial_centro", "hemisferio", "region_aprox",
            "rano_p1", "rano_p2", "mni_x", "mni_y", "mni_z", "volumen_confiable", "diam_realce_mm", "indice_esfericidad", "clase_volumen_rango", "crecido_cm3", "reducido_cm3", "estable_cm3", "crece_hacia", "estado",
            "cambio_vs_anterior_pct", "cambio_vs_basal_pct", "cambio_vs_nadir_pct", "clase_volumen",
            "clase_volumen_huang", "clase_diametro", "desacuerdo", "cambio_concluyente", "crec_pct_por_mes",
            "dias_duplicar_o_mitad"]


def limpio(o):
    """Convierte tipos de numpy / NaN / infinito a algo que JSON entienda."""
    if isinstance(o, dict):
        return {k: limpio(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [limpio(v) for v in o]
    if isinstance(o, np.generic):
        o = o.item()
    if isinstance(o, float) and not math.isfinite(o):
        return None
    if isinstance(o, float):
        return round(o, 4)
    return o


def malla(binaria, r, suavizado=0.6):
    m = L.malla(binaria, r["affine"], r["zooms"], r["offset"], suavizado)
    if m is None:
        return None
    v, f = m
    return dict(x=np.round(v[:, 0], 1).tolist(), y=np.round(v[:, 1], 1).tolist(), z=np.round(v[:, 2], 1).tolist(),
                i=f[:, 0].tolist(), j=f[:, 1].tolist(), k=f[:, 2].tolist())


def malla_cabeza(r):
    """Superficie suave del cerebro del paciente (contorno aproximado, sin cuero cabelludo) como referencia."""
    ref = r["ref"]
    m = ndimage.binary_fill_holes(ref["cerebro"])
    suave = ndimage.gaussian_filter(np.pad(m, 2).astype(np.float32), 1.2)
    vert, caras, _, _ = measure.marching_cubes(suave, 0.5)
    v = L.a_mm((vert - 2) * ref["paso"], r["affine"])
    return dict(x=np.round(v[:, 0], 1).tolist(), y=np.round(v[:, 1], 1).tolist(), z=np.round(v[:, 2], 1).tolist(),
                i=caras[:, 0].tolist(), j=caras[:, 1].tolist(), k=caras[:, 2].tolist())


ALFAS = (0.2, 0.4, 0.6, 0.8)   # cuadros intermedios entre dos controles


def distancia_con_signo(m, zooms, lejos):
    """Distancia (mm) al borde de la lesión: negativa adentro, positiva afuera."""
    if not m.any():
        return np.full(m.shape, lejos, np.float32)
    return (ndimage.distance_transform_edt(~m, sampling=zooms)
            - ndimage.distance_transform_edt(m, sampling=zooms)).astype(np.float32)


def malla_distancia(sd, r, desplaz):
    """Superficie donde la distancia con signo vale 0 (el borde de la lesión interpolada)."""
    if sd.min() >= 0:
        return None
    vert, caras, _, _ = measure.marching_cubes(np.pad(-sd, 1, constant_values=-1e3), level=0.0)
    v = L.a_mm(vert - 1 + desplaz, r["affine"])
    return dict(x=np.round(v[:, 0], 1).tolist(), y=np.round(v[:, 1], 1).tolist(), z=np.round(v[:, 2], 1).tolist(),
                i=caras[:, 0].tolist(), j=caras[:, 1].tolist(), k=caras[:, 2].tolist())


def transicion(r, k):
    """Cuadros intermedios entre el control k y el k+1: se interpola la distancia con signo de cada
    máscara, así la lesión cambia de forma de manera gradual (crece, se achica, aparece o desaparece)."""
    A, B = r["ids"][k] > 0, r["ids"][k + 1] > 0
    An, Bn = A & (r["mascaras"][k] == 2), B & (r["mascaras"][k + 1] == 2)
    caja = ndimage.find_objects((A | B).astype(np.uint8))
    if not caja:
        return []
    caja = tuple(slice(max(c.start - 4, 0), c.stop + 4) for c in caja[0])
    desplaz = r["offset"] + np.array([c.start for c in caja])
    lejos = float(np.max(np.array(A[caja].shape) * r["zooms"]))
    sa, sb = (distancia_con_signo(x[caja], r["zooms"], lejos) for x in (A, B))
    na, nb = (distancia_con_signo(x[caja], r["zooms"], lejos) for x in (An, Bn))
    cuadros = []
    for a in ALFAS:
        cuadros.append(dict(alfa=a, total=malla_distancia((1 - a) * sa + a * sb, r, desplaz),
                            necrosis=malla_distancia((1 - a) * na + a * nb, r, desplaz)))
    return cuadros


def corte_png(t1, ids_k, mascara_k, num, fila, r, margen_mm=18):
    """Imagen del corte axial donde se mide el diámetro RANO-BM (convención radiológica:
    la derecha del paciente queda a la izquierda de la pantalla)."""
    off, zooms = r["offset"], r["zooms"]
    z = int(fila["corte_rano"])
    zc = z - off[2]
    les = ids_k[:, :, zc] == num
    xs, ys = np.nonzero(les)
    mx, my = int(margen_mm / zooms[0]), int(margen_mm / zooms[1])
    x0, x1 = max(xs.min() + off[0] - mx, 0), min(xs.max() + off[0] + mx + 1, t1.shape[0])
    y0, y1 = max(ys.min() + off[1] - my, 0), min(ys.max() + off[1] + my + 1, t1.shape[1])
    # lado cuadrado para que todas las imágenes tengan el mismo aspecto
    lado = max(x1 - x0, y1 - y0)
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    x0, x1 = max(cx - lado // 2, 0), min(cx + lado // 2, t1.shape[0])
    y0, y1 = max(cy - lado // 2, 0), min(cy + lado // 2, t1.shape[1])
    corte = t1[x0:x1, y0:y1, z]
    lo, hi = np.percentile(t1[:, :, z], [1, 99.5])

    def recorte(etiqueta):
        full = np.zeros(t1.shape[:2], bool)
        sub = (ids_k[:, :, zc] == num) & (np.isin(mascara_k[:, :, zc], etiqueta))
        full[off[0]:off[0] + sub.shape[0], off[1]:off[1] + sub.shape[1]] = sub
        return full[x0:x1, y0:y1]

    fig, ax = plt.subplots(figsize=(3.4, 3.4), dpi=120)
    ax.imshow(corte.T, cmap="gray", origin="lower", vmin=lo, vmax=hi, aspect=zooms[1] / zooms[0],
              interpolation="bilinear")
    for etiqueta, color in (((1, 2), "#3E9C78"), ((2,), "#C0504A")):
        m = recorte(etiqueta)
        if m.any():
            for c in measure.find_contours(np.pad(m, 1).astype(float), 0.5):
                ax.plot(c[:, 0] - 1, c[:, 1] - 1, color=color, lw=1.4)
    inv = np.linalg.inv(r["affine"])
    p = [inv @ np.r_[np.array(fila[k], float), 1] for k in ("rano_p1", "rano_p2")]
    ax.plot([p[0][0] - x0, p[1][0] - x0], [p[0][1] - y0, p[1][1] - y0], color="#E3A21A", lw=2,
            solid_capstyle="round", marker="o", ms=3.5)
    ax.invert_xaxis()
    ax.set_axis_off()
    ax.text(0.03, 0.5, "D", color="white", transform=ax.transAxes, fontsize=8, va="center", alpha=0.8)
    ax.text(0.97, 0.5, "I", color="white", transform=ax.transAxes, fontsize=8, va="center", ha="right", alpha=0.8)
    ax.text(0.5, 0.97, "A", color="white", transform=ax.transAxes, fontsize=8, ha="center", va="top", alpha=0.8)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", pad_inches=0, facecolor="black")
    plt.close(fig)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def construir_datos(r, info, trat):
    """Arma todo lo que necesita el dashboard a partir del resultado del motor (procesar_paciente).
    info: dict con datos del paciente (pueden faltar); trat: tabla de tratamientos (puede estar vacía)."""
    est, tabla, rano = r["estudios"], r["tabla"], r["rano"]
    pid = r["pid"]
    controles = []
    for k, f in enumerate(est.itertuples()):
        ids_k, m_k = r["ids"][k], r["mascaras"][k]
        t1 = L.abrir(f.archivo_imagen).get_fdata(dtype=np.float32)
        filas = tabla[(tabla.n_estudio == f.n_estudio) & (tabla.total_cm3 > 0)]
        lesiones = []
        for _, fila in filas.iterrows():
            num = int(fila.lesion[1:])
            comp = ids_k == num
            d = {c: fila.get(c) for c in COLUMNAS}
            d["malla_realce"] = malla(comp & (m_k == 1), r)
            d["malla_necrosis"] = malla(comp & (m_k == 2), r)
            d["corte_img"] = corte_png(t1, ids_k, m_k, num, fila, r)
            lesiones.append(d)
        cambio = None
        if k > 0:
            ahora, antes = ids_k > 0, r["ids"][k - 1] > 0
            cambio = dict(crecido=malla(ahora & ~antes, r, 0.4), reducido=malla(antes & ~ahora, r, 0.4),
                          estable=malla(ahora & antes, r, 0.4))
        rr = rano[rano.n_estudio == f.n_estudio].iloc[0].to_dict()
        hacia_siguiente = transicion(r, k) if k < len(est) - 1 else []
        controles.append(dict(n_estudio=f.n_estudio, dia=f.dia, equipo=getattr(f, "equipo", None),
                              campo_T=getattr(f, "campo_T", None), lesiones=lesiones, cambio=cambio, rano=rr,
                              transicion=hacia_siguiente))
        print(f"  control {f.n_estudio}: {len(lesiones)} lesión(es)")

    serie = tabla[["n_estudio", "dia", "lesion", "total_cm3", "vol_min_cm3", "vol_max_cm3", "diam_rano_mm",
                   "estado"]].to_dict("records")
    ultimo = rano.iloc[-1]
    resumen = dict(
        paciente_id=pid, n_lesiones=int(tabla[tabla.total_cm3 > 0].lesion.nunique()) if len(tabla) else 0,
        n_controles=len(est), dia_inicio=int(est.dia.min()), dia_fin=int(est.dia.max()),
        rano_ultimo=ultimo.rano_bm, vol_ultimo=ultimo.volumetrico,
        lesiones_nuevas=int((tabla.estado == "NUEVA").sum()), vol_actual=float(ultimo.suma_vol_cm3), **info)
    datos = dict(resumen=resumen, controles=controles, serie=serie,
                 tratamientos=trat.drop(columns=["paciente_id"], errors="ignore").to_dict("records"),
                 cabeza=malla_cabeza(r), avisos=r["avisos"],
                 # para ubicar al paciente dentro del cerebro de referencia (vista "Ubicación en el cerebro")
                 mapeo=dict(p_min=r["ref"]["caja_cerebro"]["minimo"].tolist(), p_max=r["ref"]["caja_cerebro"]["maximo"].tolist(),
                            t_min=atlas.plantilla()["minimo"].tolist(), t_max=atlas.plantilla()["maximo"].tolist()))
    return limpio(datos)


def exportar(pid):
    r = L.procesar_paciente(pid)
    pac = L.pacientes[L.pacientes.paciente_id == pid].iloc[0]
    info = dict(sexo=pac.sexo, edad=int(pac.edad_primera_rm), tumor_primario=pac.tumor_primario)
    datos = construir_datos(r, info, L.tratamientos[L.tratamientos.paciente_id == pid])
    texto = json.dumps(datos, ensure_ascii=False, separators=(",", ":"))
    (DATA / f"p_{pid}.js").write_text(
        f"window.DATOS=window.DATOS||{{}};window.DATOS[{json.dumps(pid)}]={texto};", encoding="utf-8")
    return datos["resumen"]


if __name__ == "__main__":
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "atlas.js").write_text("window.ATLAS=" + json.dumps(atlas.mallas_regiones()) + ";window.ATLAS_VOL="
                                   + json.dumps(atlas.volumen_regiones()) + ";", encoding="utf-8")
    indice = []
    for pid in L.pacientes.paciente_id:
        indice.append(exportar(pid))
    (DATA / "indice.js").write_text("window.INDICE=" + json.dumps(indice, ensure_ascii=False) + ";", encoding="utf-8")
    print(f"\nListo. Abrí {DASH / 'index.html'}")
