# syntax=docker/dockerfile:1.7
# Образ ML, профиль gpu (T-060). Собирается в CI из корня репозитория: docker build -f ml/Dockerfile .
# Разбор PDF (pdfium), OCR — ансамбль Tesseract (rus+eng), семантические якоря — ONNX без torch.
# Цель по умолчанию (runtime) — без GPU-зависимостей: ансамбль Tesseract, как на маке. Профиль gpu (ADR-0001, T-184) —
# цель `gpu` ниже: docker build --target gpu (T-230).
# Код принадлежит root и не пишется; /app/var — том api-data только на чтение (блобы по хешу), кэш — Redis.

ARG PYTHON_IMAGE=python:3.12-slim@sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9
# uv — с Docker Hub (тот же digest, что ghcr.io/astral-sh/uv): на раннере с устаревшим входом в ghcr pull падал «denied»
ARG UV_IMAGE=astral/uv:0.12.19@sha256:04d046b13e60d6bcec73cbc5e1cad25d680dea90c8573340950a0ac2d1aef424

FROM ${UV_IMAGE} AS uv

FROM ${PYTHON_IMAGE} AS build
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /src
COPY ml/pyproject.toml ml/uv.lock ml/
COPY ml/inspector_ml ml/inspector_ml
# T-083: ровно то, что в uv.lock (--locked падает, если lock разошёлся с pyproject); python образа, без загрузки своего
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_PYTHON_DOWNLOADS=never
RUN uv sync --locked --no-dev --no-editable --no-cache --extra semantic --extra cache \
      --project ml --python /usr/local/bin/python3

# Модель семантических якорей (OS-INSP-2.2.8) — ревизия Hugging Face и SHA-256 файлов закреплены;
# x86-вариант (avx2), на маке — arm64. ADD по URL с --checksum: сборка падает, если файл на сервере подменён. Порог SEM_MIN откалиброван на arm64: при выкатке перегнать semantic_bench.
FROM ${PYTHON_IMAGE} AS model
ARG HF=https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/resolve/e8f8c211226b894fcb81acc59f3b34ba3efd5f42
# hadolint ignore=DL3020
ADD --checksum=sha256:2c3387be76557bd40970cec13153b3bbf80407865484b209e655e5e4729076b8 ${HF}/tokenizer.json /opt/model/tokenizer.json
# hadolint ignore=DL3020
ADD --checksum=sha256:98a01d88b7de996cdea58c32ca71208c09968d143798814b2ea09d3439dc334f ${HF}/onnx/model_quint8_avx2.onnx /opt/model/onnx/model_quint8_avx2.onnx

# ───────────────────────── образ профиля gpu (T-230, OWASP-0210/0211/0219): docker build --target gpu -f ml/Dockerfile .
# OCR сканов на видеокарте — RapidOCR на ONNX Runtime CUDA. Рантайм CUDA 13 и cuDNN 9 приходят колёсами nvidia-* из
# uv.lock (onnxruntime-gpu[cuda,cudnn] 1.30.0 собран под CUDA 13.x + cuDNN 9, onnxruntime.preload_dlls), поэтому база —
# тот же python:3.12-slim, а не nvidia/cuda: хосту нужен только драйвер ≥ 580 и nvidia-container-toolkit (--gpus / devices).
# Tesseract в образ gpu не едет (в профиле gpu запрещён), opencv — только headless (rapidocr тянет opencv-python, тот же
# каталог cv2 — ставится без него), torch нет.
FROM ${PYTHON_IMAGE} AS build-gpu
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /src
COPY ml/pyproject.toml ml/uv.lock ml/
COPY ml/inspector_ml ml/inspector_ml
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_PYTHON_DOWNLOADS=never
RUN uv sync --locked --no-dev --no-editable --no-cache --extra gpu --extra cache \
      --no-install-package opencv-python --project ml --python /usr/local/bin/python3 \
 && /opt/venv/bin/python -c "import importlib.metadata as m, sys; d={x.metadata['Name'].lower() for x in m.distributions()}; bad=d & {'opencv-python','onnxruntime','torch','tesseract'}; sys.exit(f'лишнее в образе gpu: {bad}' if bad else 0)" \
 && /opt/venv/bin/python -c "import cv2, onnxruntime, rapidocr, tokenizers, yaml"

# Веса PP-OCR (ml/models.yaml → ocr_anchor.files): адрес и SHA-256 закреплены, сборка падает при подмене файла на сервере;
# в рантайме ничего не качается — ocr_gpu берёт Det/Cls/Rec.model_path из INSPECTOR_PPOCR_MODEL_DIR и сверяет хеш.
FROM ${PYTHON_IMAGE} AS ppocr
# hadolint ignore=DL3020
ADD --checksum=sha256:92078b7355007ccfffcd4c8cd441a3afd4538904d06881b29a155e1e679907c2 https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv6/det/PP-OCRv6_det_medium.onnx /opt/ppocr/PP-OCRv6_det_medium.onnx
# hadolint ignore=DL3020
ADD --checksum=sha256:54379ae5174d026780215fc748a7f31910dee36818e63d49e17dc598ecc82df7 https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv5/cls/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx /opt/ppocr/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx
# hadolint ignore=DL3020
ADD --checksum=sha256:08705d6721849b1347d26187f15a5e362c431963a2a62bfff4feac578c489aab https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv5/rec/eslav_PP-OCRv5_rec_mobile.onnx /opt/ppocr/eslav_PP-OCRv5_rec_mobile.onnx

FROM ${PYTHON_IMAGE} AS gpu
# hadolint ignore=DL3008,DL3005
RUN apt-get update \
 && apt-get -y upgrade \
 && apt-get install -y --no-install-recommends libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/* \
 && python -m pip uninstall -y pip setuptools wheel || true
COPY --from=build-gpu /opt/venv /opt/venv
COPY --from=model /opt/model /opt/model
COPY --from=ppocr /opt/ppocr /opt/ppocr
WORKDIR /app
COPY ml/inspector_ml ml/inspector_ml
COPY ml/serve.py ml/serve.py
COPY ml/models.yaml ml/models.yaml
COPY assets/fonts assets/fonts
# справочник норм для /norms/search (normsearch._seed_path ищет data/seed/norms.json вверх от модуля): без него подбор норм к гипотезам — 500 (T-233)
COPY data/seed/norms.json data/seed/norms.json
# код и веса — root, только чтение; писать можно лишь в тома (blobs — владелец как в образе API, ml-cache, readers)
RUN chown -R root:root /app /opt/venv /opt/model /opt/ppocr && chmod -R a+rX,a-w /app /opt/model /opt/ppocr \
 && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin inspector \
 && mkdir -p /app/var/blobs /app/var/ml-cache /app/var/readers \
 && chown 1000:1000 /app/var/blobs && chown 10001:10001 /app/var/ml-cache /app/var/readers
ENV PATH=/opt/venv/bin:$PATH PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    INSPECTOR_ROOT=/app INSPECTOR_EMBED_MODEL=/opt/model INSPECTOR_EMBED_FILE=onnx/model_quint8_avx2.onnx \
    INSPECTOR_PROFILE=gpu INSPECTOR_PPOCR_MODEL_DIR=/opt/ppocr INSPECTOR_MODELS_YAML=/app/ml/models.yaml \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility
ARG REVISION=unknown
LABEL org.opencontainers.image.revision=${REVISION} org.opencontainers.image.title="inspector-ml-gpu"
ENV INSPECTOR_REVISION=${REVISION}
USER 10001
WORKDIR /app/ml
EXPOSE 8811
HEALTHCHECK --interval=20s --timeout=8s --start-period=120s --retries=5 \
  CMD ["python", "-c", "import os,ssl,sys,urllib.request as u;e=os.environ;t=bool(e.get('INSPECTOR_ML_TLS_CERT'));ca=e.get('INSPECTOR_HEALTH_CA_FILE');c=(ssl.create_default_context(cafile=ca) if ca else ssl._create_unverified_context()) if t else None;c and ca and setattr(c,'check_hostname',False);b=u.urlopen(('https' if t else 'http')+'://127.0.0.1:8811/health',timeout=6,context=c).read();sys.exit(0 if b'\"status\":\"ok\"' in b else 1)"]
CMD ["python", "serve.py"]

# ───────────────────────── образ по умолчанию (последняя стадия): профиль dev/стенд на CPU, Tesseract
FROM ${PYTHON_IMAGE} AS runtime
# hadolint ignore=DL3008,DL3005
RUN apt-get update \
 && apt-get -y upgrade \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/* \
 && python -m pip uninstall -y pip setuptools wheel || true
COPY --from=build /opt/venv /opt/venv
COPY --from=model /opt/model /opt/model
WORKDIR /app
COPY ml/inspector_ml ml/inspector_ml
COPY ml/serve.py ml/serve.py
COPY assets/fonts assets/fonts
# справочник норм для /norms/search (normsearch._seed_path ищет data/seed/norms.json вверх от модуля): без него подбор норм к гипотезам — 500 (T-233)
COPY data/seed/norms.json data/seed/norms.json
# /app/var/blobs — точка монтирования тома api-blobs (ML читает, пишет API под uid 1000 = node в образе API). Пустой
# именованный том берёт владельца из образа того контейнера, что смонтировал его первым; ML может стартовать раньше API,
# поэтому владелец точки монтирования здесь тот же, что в образе API (compose.yml, HIGH-4).
# a+rX: файлы модели из ADD приходят с правами 600 — без этого uid 10001 их не читает (smoke на раннере, 2026-09-25)
RUN chown -R root:root /app /opt/venv /opt/model && chmod -R a+rX,a-w /app /opt/model \
 && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin inspector \
 && mkdir -p /app/var/blobs && chown 1000:1000 /app/var/blobs \
 # кэш разбора — постоянный том ml-cache: после перезапуска разобранный файл берётся из кэша (T-129)
 && mkdir -p /app/var/ml-cache && chown 10001:10001 /app/var/ml-cache
ENV PATH=/opt/venv/bin:$PATH PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    INSPECTOR_ROOT=/app INSPECTOR_EMBED_MODEL=/opt/model INSPECTOR_EMBED_FILE=onnx/model_quint8_avx2.onnx
ARG REVISION=unknown
LABEL org.opencontainers.image.revision=${REVISION} org.opencontainers.image.title="inspector-ml"
ENV INSPECTOR_REVISION=${REVISION}
USER 10001
WORKDIR /app/ml
EXPOSE 8811
# NFR-STAND: проверка живости — python стандартной библиотекой (urllib), без curl/wget в образе. Схема — по
# INSPECTOR_ML_TLS_CERT (как у serve.py). Корень доверия — INSPECTOR_HEALTH_CA_FILE (цепочка по CA стенда); не задан —
# проверка сертификата выключена ТОЛЬКО для этого запроса на 127.0.0.1 внутри контейнера (секретов он не несёт).
# start-period 120 с: первый импорт onnxruntime и модели на CPU мака небыстрый.
HEALTHCHECK --interval=20s --timeout=8s --start-period=120s --retries=5 \
  CMD ["python", "-c", "import os,ssl,sys,urllib.request as u;e=os.environ;t=bool(e.get('INSPECTOR_ML_TLS_CERT'));ca=e.get('INSPECTOR_HEALTH_CA_FILE');c=(ssl.create_default_context(cafile=ca) if ca else ssl._create_unverified_context()) if t else None;c and ca and setattr(c,'check_hostname',False);b=u.urlopen(('https' if t else 'http')+'://127.0.0.1:8811/health',timeout=6,context=c).read();sys.exit(0 if b'\"status\":\"ok\"' in b else 1)"]
# NFR-TLS-INTERNAL: serve.py — uvicorn с TLS 1.3 при заданных INSPECTOR_ML_TLS_CERT/KEY, иначе HTTP (dev, smoke)
CMD ["python", "serve.py"]
