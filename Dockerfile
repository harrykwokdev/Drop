FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV DROP_HOST=0.0.0.0 \
    DROP_PORT=5001 \
    PYTHONUNBUFFERED=1

EXPOSE 5001

VOLUME ["/app/uploads", "/app/chunks"]

CMD ["python", "app.py"]
