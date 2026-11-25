# SubSync AI

SubSync AI is a subtitle-localization web app. Its essential input is a timed subtitle file (`.srt` or `.vtt`); a video is optional and remains in the browser only for preview.

## Included in this first deployable version

- `.srt` and `.vtt` import, including timestamp preservation
- Manual subtitle entry and editing
- Source/target language, tone, glossary, and style-guide controls
- Server-side LLM translation with an OpenAI API key kept off the client
- Quality checks for missing text, long lines, reading speed, and overlaps
- Subtitle export as SRT or VTT
- Optional local video preview with subtitles overlaid
- Browser local draft recovery

## Run locally

Python 3.11+ is the only dependency.

```powershell
Copy-Item .env.example .env
# Set OPENAI_API_KEY and OPENAI_MODEL in .env
python server.py
```

Open `http://localhost:8000`.

The application reads environment variables directly. For local Windows use, set them before starting the server or use your deployment provider's secret manager. The sample `.env` is deliberately not auto-loaded, so it cannot accidentally be deployed or exposed.

## Deploy

The included `Dockerfile` deploys on any container host. Configure these environment secrets in the host:

- `OPENAI_API_KEY` — required to translate
- `OPENAI_MODEL` — required; select a model enabled for your OpenAI project
- `PORT` — optional; defaults to `8000`
- `HOST` — local default is `127.0.0.1`; Docker uses `0.0.0.0`

Example:

```powershell
docker build -t subsync-ai .
docker run -p 8000:8000 -e OPENAI_API_KEY -e OPENAI_MODEL subsync-ai
```

## Important production additions

Before opening this app to the public, put authentication, per-user rate limiting, usage/cost limits, durable project storage, and privacy/retention policies in front of the translation endpoint. The current app does not store uploads server-side; project data lives in the browser until the user exports it.
