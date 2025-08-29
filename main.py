from fastapi import FastAPI, UploadFile, Form
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import cv2
import numpy as np
import io
import base64
import svgwrite
import ezdxf
import requests
from PIL import Image

app = FastAPI()

# Allow all origins for CORS. In production, restrict this to your
# frontend domain.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _arr_from_image(img: Image.Image) -> np.ndarray:
    """Convert a PIL image to a BGR OpenCV ndarray."""
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


def raster_to_svg_and_metrics(arr: np.ndarray, px_per_ft: float):
    """Vectorize a raster image into SVG and return basic metrics.

    This function detects edges and line segments via Canny and Hough
    transforms, constructs simple SVG line elements, and computes the
    approximate total length of wall centerlines in feet.
    """
    gray = cv2.cvtColor(arr, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    edges = cv2.Canny(blur, 60, 180)

    lines = cv2.HoughLinesP(
        edges,
        1,
        np.pi / 180,
        threshold=120,
        minLineLength=50,
        maxLineGap=8,
    )

    h, w = arr.shape[:2]
    svg = svgwrite.Drawing(size=(w, h))
    line_count = 0
    total_len_px = 0.0

    if lines is not None:
        for l in lines[:, 0]:
            x1, y1, x2, y2 = map(int, l)
            svg.add(
                svg.line(
                    (x1, y1),
                    (x2, y2),
                    stroke="black",
                    stroke_width=0.6,
                )
            )
            total_len_px += float(np.hypot(x2 - x1, y2 - y1))
            line_count += 1

    svg_str = svg.tostring()
    walls_len_ft = round(total_len_px / max(px_per_ft, 1e-6), 1)
    confidence = min(1.0, 0.2 + (line_count / 250.0))
    metrics = {"walls_len_ft": walls_len_ft, "line_count": line_count}
    return svg_str, metrics, confidence


@app.post("/vectorize_file")
async def vectorize_file(file: UploadFile, px_per_ft: float = Form(12.0)):
    """Upload an image file and return vectorization results."""
    img = Image.open(io.BytesIO(await file.read())).convert("RGB")
    arr = _arr_from_image(img)
    svg_str, metrics, conf = raster_to_svg_and_metrics(arr, px_per_ft)
    return JSONResponse(
        {
            "svg": base64.b64encode(svg_str.encode()).decode(),
            "metrics": metrics,
            "confidence": conf,
        }
    )


@app.post("/vectorize_url")
async def vectorize_url(image_url: str = Form(...), px_per_ft: float = Form(12.0)):
    """Fetch an image from a URL and return vectorization results."""
    resp = requests.get(image_url, timeout=20)
    resp.raise_for_status()
    img = Image.open(io.BytesIO(resp.content)).convert("RGB")
    arr = _arr_from_image(img)
    svg_str, metrics, conf = raster_to_svg_and_metrics(arr, px_per_ft)
    return JSONResponse(
        {
            "svg": base64.b64encode(svg_str.encode()).decode(),
            "metrics": metrics,
            "confidence": conf,
        }
    )