# agent/Dockerfile
# Container image for the monitoring agent.

FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "agent.py"]
