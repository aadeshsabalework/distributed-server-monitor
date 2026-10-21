# api/Dockerfile
# Container image for the Flask REST API service.
#
# Build context MUST be the project root (compose.yaml sets context: .)
# so we can COPY the dashboard/ directory into the image alongside the API.

FROM python:3.12-slim

WORKDIR /app

# Install Python dependencies (layer-cached until requirements.txt changes)
COPY api/requirements.txt ./api/requirements.txt
RUN pip install --no-cache-dir -r api/requirements.txt

# Copy application source and the dashboard static files
COPY api/      ./api/
COPY dashboard/ ./dashboard/

# Run from the api sub-directory so relative imports work correctly
WORKDIR /app/api

EXPOSE 5000

# gunicorn with a single worker (SQLite prefers one writer at a time).
# --preload ensures init_db() runs once in the master process before forking.
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--preload", "app:app"]
