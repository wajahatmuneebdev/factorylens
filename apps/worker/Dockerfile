FROM ghcr.io/astral-sh/uv:0.13.7@sha256:96f40d3904aad8d0bd010539001d36c8e2188b981e1334471a90c4a1d93bb490 AS uv

FROM python:3.12.16-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df AS build

COPY --from=uv /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy
WORKDIR /app

COPY apps/worker/pyproject.toml apps/worker/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY apps/worker/src src
RUN uv sync --frozen --no-dev --no-editable

FROM python:3.12.16-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df

RUN apt-get update && \
    apt-get install --yes --no-install-recommends ffmpeg=7:5.1.9-0+deb12u1 && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --system --gid 10001 factorylens && \
    useradd --system --uid 10001 --gid factorylens --home-dir /app factorylens

ARG IMAGE_VERSION
ARG SOURCE_REVISION
RUN test -n "$IMAGE_VERSION" && test -n "$SOURCE_REVISION"

LABEL org.opencontainers.image.title="factorylens-worker" \
      org.opencontainers.image.description="FactoryLens media processing worker" \
      org.opencontainers.image.source="https://github.com/wajahatmuneebdev/factorylens" \
      org.opencontainers.image.version="$IMAGE_VERSION" \
      org.opencontainers.image.revision="$SOURCE_REVISION"

ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    WORKER_HOST=0.0.0.0 \
    WORKER_PORT=8080
WORKDIR /app

COPY --from=build --chown=factorylens:factorylens /app/.venv .venv

USER factorylens
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2).read()"

CMD ["factorylens-worker"]
