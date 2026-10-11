"""Cerebro de referencia (plantilla MNI152, incluida en nilearn) dividido en regiones.

Las resonancias del dataset no traen ubicación anatómica. Para nombrar la región de cada lesión:
  1. se toma la caja que ocupa el cerebro del paciente en su propia resonancia;
  2. la posición de la lesión dentro de esa caja (0..1 en cada eje) se lleva a la misma posición
     relativa dentro del cerebro de referencia;
  3. ahí se lee la región (lóbulo y hemisferio).
Es una ubicación aproximada (no es un registro anatómico), pero es la misma para la tabla y para la vista 3D.
"""
from functools import lru_cache

import numpy as np
from nilearn import datasets
from scipy import ndimage

REGIONES = ["Frontal", "Parietal", "Temporal", "Occipital", "Profunda", "Cerebelo", "Tronco"]
NOMBRE_LARGO = {
    "Frontal": "lóbulo frontal", "Parietal": "lóbulo parietal", "Temporal": "lóbulo temporal",
    "Occipital": "lóbulo occipital", "Profunda": "región profunda (ganglios basales / tálamo)",
    "Cerebelo": "cerebelo", "Tronco": "tronco encefálico",
}


def _region(x, y, z):
    """Región según coordenadas MNI (mm). Límites aproximados de los lóbulos."""
    if z < -18 and y < -40:
        return "Cerebelo"
    if z < -18 and abs(x) < 14:
        return "Tronco"
    if abs(x) < 22 and -30 < y < 12 and -12 < z < 18:
        return "Profunda"
    if y < -72:
        return "Occipital"
    if z < 2 and abs(x) > 26 and y < 18:
        return "Temporal"
    if y > -16:
        return "Frontal"
    return "Parietal"


@lru_cache(maxsize=1)
def plantilla():
    """Máscara del cerebro de referencia y mapa de regiones (código = región*2 + hemisferio)."""
    img = datasets.load_mni152_brain_mask(resolution=2)
    cerebro = img.get_fdata() > 0.5
    aff = img.affine
    idx = np.argwhere(cerebro)
    mm = idx @ aff[:3, :3].T + aff[:3, 3]
    x, y, z = mm.T
    # mismas reglas que _region, aplicadas a todos los vóxeles a la vez (las primeras tienen prioridad)
    reglas = [(z < -18) & (y < -40), (z < -18) & (abs(x) < 14), (abs(x) < 22) & (-30 < y) & (y < 12) & (-12 < z) & (z < 18),
              y < -72, (z < 2) & (abs(x) > 26) & (y < 18), y > -16]
    nombres = ["Cerebelo", "Tronco", "Profunda", "Occipital", "Temporal", "Frontal"]
    region = np.select(reglas, [REGIONES.index(n) for n in nombres], default=REGIONES.index("Parietal"))
    etiquetas = np.full(cerebro.shape, -1, np.int16)
    etiquetas[tuple(idx.T)] = region * 2 + (x >= 0)
    return dict(cerebro=cerebro, etiquetas=etiquetas, affine=aff, minimo=mm.min(0), maximo=mm.max(0))


def a_plantilla(c_mm, caja_paciente):
    """Lleva un punto (mm del paciente) a la misma posición relativa en el cerebro de referencia."""
    p = plantilla()
    rel = (np.asarray(c_mm) - caja_paciente["minimo"]) / (caja_paciente["maximo"] - caja_paciente["minimo"])
    return p["minimo"] + rel * (p["maximo"] - p["minimo"])


def region_de(c_mm, caja_paciente, margen_mm=5):
    """(hemisferio, región) de un punto del paciente, leyendo el cerebro de referencia."""
    p = plantilla()
    m = a_plantilla(c_mm, caja_paciente)
    v = np.round(np.linalg.inv(p["affine"]) @ np.r_[m, 1])[:3].astype(int)
    v = np.clip(v, 0, np.array(p["cerebro"].shape) - 1)
    cod = p["etiquetas"][tuple(v)]
    if cod < 0:  # cayó apenas afuera del cerebro: se toma la región más cercana
        _, ind = ndimage.distance_transform_edt(p["etiquetas"] < 0, return_indices=True)
        cod = p["etiquetas"][tuple(ind[:, v[0], v[1], v[2]])]
    region = REGIONES[cod // 2]
    if abs(m[0]) < margen_mm:
        lado = "línea media"
    else:
        lado = "hemisferio derecho" if m[0] > 0 else "hemisferio izquierdo"
    return lado, NOMBRE_LARGO[region], region, m


def volumen_regiones():
    """Mapa de regiones del cerebro de referencia como bytes (región*2+hemisferio+1; 0 = fuera del cerebro),
    para dibujar los cortes sagital, coronal y axial en el dashboard."""
    import base64
    p = plantilla()
    datos = (p["etiquetas"].astype(np.int16) + 1).astype(np.uint8)
    return dict(forma=list(datos.shape), affine=p["affine"].tolist(), regiones=REGIONES,
                datos=base64.b64encode(datos.tobytes(order="C")).decode())


def mallas_regiones():
    """Superficies 3D de cada región del cerebro de referencia (para el dashboard)."""
    from skimage import measure
    p = plantilla()
    aff = p["affine"]
    salida = {}
    for cod in range(len(REGIONES) * 2):
        m = p["etiquetas"] == cod
        if m.sum() < 20:
            continue
        suave = ndimage.gaussian_filter(np.pad(m, 2).astype(np.float32), 1.0)
        vert, caras, _, _ = measure.marching_cubes(suave, 0.5)
        v = (vert - 2) @ aff[:3, :3].T + aff[:3, 3]
        nombre = f"{REGIONES[cod // 2]}|{'derecho' if cod % 2 else 'izquierdo'}"
        salida[nombre] = dict(x=np.round(v[:, 0], 1).tolist(), y=np.round(v[:, 1], 1).tolist(),
                              z=np.round(v[:, 2], 1).tolist(), i=caras[:, 0].tolist(), j=caras[:, 1].tolist(),
                              k=caras[:, 2].tolist())
    # contorno completo del cerebro (una sola superficie suave, sin los cortes entre regiones)
    suave = ndimage.gaussian_filter(np.pad(p["cerebro"], 2).astype(np.float32), 1.2)
    vert, caras, _, _ = measure.marching_cubes(suave, 0.5)
    v = (vert - 2) @ aff[:3, :3].T + aff[:3, 3]
    salida["_cerebro"] = dict(x=np.round(v[:, 0], 1).tolist(), y=np.round(v[:, 1], 1).tolist(), z=np.round(v[:, 2], 1).tolist(),
                              i=caras[:, 0].tolist(), j=caras[:, 1].tolist(), k=caras[:, 2].tolist())
    return salida
