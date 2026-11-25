FROM python:3.12-slim

WORKDIR /app
COPY server.py ./
COPY static ./static

ENV PORT=8000
ENV HOST=0.0.0.0
EXPOSE 8000

CMD ["python", "server.py"]
