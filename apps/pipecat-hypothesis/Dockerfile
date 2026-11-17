FROM ghcr.io/astral-sh/uv:0.13.7@sha256:96f40d3904aad8d0bd010539001d36c8e2188b981e1334471a90c4a1d93bb490 AS uv

FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df AS builder
COPY --from=uv /uv /usr/local/bin/uv
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml uv.lock ./
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev --no-editable

FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libsndfile1 libgomp1 ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 pipecat \
    && mkdir -p /data/logs && chown -R pipecat:pipecat /data
WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
COPY *.py ./
COPY audio/ ./audio/
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    PIPECAT_LOG_DIR=/data/logs XDG_CACHE_HOME=/tmp/cache LOGURU_LEVEL=INFO
USER pipecat
EXPOSE 8093
CMD ["python", "-m", "uvicorn", "service:app", "--host", "0.0.0.0", "--port", "8093", "--workers", "1", "--no-access-log"]
