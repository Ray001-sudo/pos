# =============================================================================
# Python AI Analytics Dockerfile
# =============================================================================
FROM python:3.12-slim AS final

WORKDIR /app

RUN addgroup --system analytics && adduser --system --ingroup analytics analytics

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=analytics:analytics analytics_service.py .

USER analytics

CMD ["python", "-u", "analytics_service.py"]
