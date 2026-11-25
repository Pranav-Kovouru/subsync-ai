"""Small, dependency-free server for SubSync AI.

The browser never receives the provider API key.  Translation is intentionally
handled here so this file can later be replaced by a framework endpoint without
changing the frontend contract.
"""

from __future__ import annotations

import json
import os
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).parent
STATIC_DIR = ROOT / "static"


def load_local_env() -> None:
    """Load simple KEY=VALUE pairs for local development.

    Clears out old or placeholder values first so changes to .env take effect immediately.
    """
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    # Clear managed keys before reading .env
    for k in ("GEMINI_API_KEY", "GEMINI_MODEL", "OPENAI_API_KEY", "OPENAI_MODEL"):
        os.environ.pop(k, None)

    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        val = value.strip().strip("\"'")
        if val:
            os.environ[key.strip()] = val


load_local_env()
MAX_CUES = int(os.getenv("MAX_TRANSLATION_CUES", "120"))


def response_text(response: dict) -> str:
    """Extract text from a Responses API result without an SDK dependency."""
    if isinstance(response.get("output_text"), str):
        return response["output_text"]
    for item in response.get("output", []):
        for content in item.get("content", []):
            if content.get("type") == "output_text" and isinstance(content.get("text"), str):
                return content["text"]
    raise ValueError("The model returned no text output.")


def is_placeholder(key: str | None) -> bool:
    if not key:
        return True
    k = key.upper()
    return any(p in k for p in ("YOUR_", "PASTE_", "HERE", "EXAMPLE", "SK-PROJ-D4BZ"))


def translate_gemini(api_key: str, model: str, instructions: str, settings: dict, clean_segments: list[dict]) -> str:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    request_body = {
        "contents": [
            {
                "parts": [
                    {
                        "text": f"{instructions}\n\nSettings and subtitle segments:\n" + json.dumps({"settings": settings, "segments": clean_segments}, ensure_ascii=False)
                    }
                ]
            }
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": {
                "type": "OBJECT",
                "properties": {
                    "translations": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "id": {"type": "STRING"},
                                "text": {"type": "STRING"}
                            },
                            "required": ["id", "text"]
                        }
                    }
                },
                "required": ["translations"]
            }
        }
    }
    request = Request(
        url,
        data=json.dumps(request_body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=90) as remote:
            raw = json.loads(remote.read().decode("utf-8"))
        return raw["candidates"][0]["content"]["parts"][0]["text"]
    except HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:1000]
        try:
            err_json = json.loads(detail)
            msg = err_json.get("error", {}).get("message", detail)
            raise RuntimeError(f"Gemini API Error ({error.code}): {msg}") from error
        except Exception:
            raise RuntimeError(f"Gemini API Error ({error.code}): {detail}") from error
    except (URLError, KeyError, IndexError) as error:
        raise RuntimeError(f"Could not reach Gemini provider: {error}") from error


import urllib.parse

LANG_CODES = {
    "spanish": "es", "french": "fr", "german": "de", "italian": "it",
    "portuguese": "pt", "hindi": "hi", "japanese": "ja", "korean": "ko",
    "chinese": "zh-CN", "chinese (simplified)": "zh-CN", "chinese (traditional)": "zh-TW",
    "arabic": "ar", "russian": "ru", "dutch": "nl", "polish": "pl",
    "turkish": "tr", "vietnamese": "vi", "thai": "th", "indonesian": "id",
    "swedish": "sv", "greek": "el", "czech": "cs", "danish": "da",
    "finnish": "fi", "hungarian": "hu", "norwegian": "no", "ukrainian": "uk",
    "english": "en"
}


def translate_free(clean_segments: list[dict], target_lang: str, source_lang: str) -> list[dict]:
    """Free translation fallback using Google Translate web service."""
    tl = LANG_CODES.get(target_lang.lower().strip(), target_lang[:2].lower())
    sl = "auto"
    if source_lang and source_lang.lower() not in ("auto detect", "auto"):
        sl = LANG_CODES.get(source_lang.lower().strip(), source_lang[:2].lower())

    results = []
    for item in clean_segments:
        cue_id = str(item["id"])
        text = str(item["text"])
        url = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl={sl}&tl={tl}&dt=t&q={urllib.parse.quote(text)}"
        req = Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
        try:
            with urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                translated_parts = [part[0] for part in data[0] if part and part[0]]
                translated_text = "".join(translated_parts).strip()
                results.append({"id": cue_id, "text": translated_text or text})
        except Exception:
            results.append({"id": cue_id, "text": text})
    return results


def translate(payload: dict) -> list[dict]:
    load_local_env()
    gemini_key = os.getenv("GEMINI_API_KEY")
    gemini_model = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
    openai_key = os.getenv("OPENAI_API_KEY")
    openai_model = os.getenv("OPENAI_MODEL")

    has_valid_gemini = bool(gemini_key and not is_placeholder(gemini_key))
    has_valid_openai = bool(openai_key and openai_model and not is_placeholder(openai_key))

    segments = payload.get("segments", [])
    if not isinstance(segments, list) or not segments:
        raise ValueError("Add at least one subtitle cue before translating.")
    if len(segments) > MAX_CUES:
        raise ValueError(f"Translate no more than {MAX_CUES} cues at a time.")

    clean_segments = []
    for item in segments:
        cue_id, text = str(item.get("id", "")), str(item.get("text", "")).strip()
        if not cue_id or not text:
            raise ValueError("Every cue needs an id and text.")
        clean_segments.append({"id": cue_id, "text": text})

    target = str(payload.get("targetLanguage", "")).strip()
    source = str(payload.get("sourceLanguage", "Auto detect")).strip()
    if not target:
        raise ValueError("Choose a target language.")

    settings = {
        "source language": source,
        "target language": target,
        "tone": str(payload.get("tone", "Natural")),
        "glossary": str(payload.get("glossary", "None"))[:5000],
        "style guide": str(payload.get("styleGuide", "Keep concise and easy to read."))[:5000],
    }
    instructions = (
        "You are an expert audiovisual subtitle localizer. Translate subtitle cues faithfully "
        "and naturally. Preserve the exact cue id. Do not add timestamps, explanations, labels, "
        "or markdown. Adapt idioms and culturally specific phrasing for the target audience. "
        "Keep each cue concise, retain speaker labels and meaningful formatting, and honor the "
        "glossary exactly when applicable."
    )

    if has_valid_gemini:
        try:
            raw_text = translate_gemini(gemini_key, gemini_model, instructions, settings, clean_segments)
            data = json.loads(raw_text)
            translations = data.get("translations", [])
            expected_ids = {item["id"] for item in clean_segments}
            returned_ids = {str(item.get("id", "")) for item in translations}
            if returned_ids == expected_ids:
                return [{"id": str(item["id"]), "text": str(item["text"]).strip()} for item in translations]
        except Exception:
            # Fallback to free translator when Gemini key limit or error occurs
            return translate_free(clean_segments, target, source)

    if has_valid_openai:
        try:
            schema = {
                "type": "object",
                "properties": {
                    "translations": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {"id": {"type": "string"}, "text": {"type": "string"}},
                            "required": ["id", "text"],
                            "additionalProperties": False,
                        },
                    }
                },
                "required": ["translations"],
                "additionalProperties": False,
            }
            request_body = {
                "model": openai_model,
                "instructions": instructions,
                "input": json.dumps({"settings": settings, "segments": clean_segments}, ensure_ascii=False),
                "text": {
                    "format": {
                        "type": "json_schema",
                        "name": "subtitle_translations",
                        "strict": True,
                        "schema": schema,
                    }
                },
            }
            request = Request(
                "https://api.openai.com/v1/responses",
                data=json.dumps(request_body).encode("utf-8"),
                headers={"Authorization": f"Bearer {openai_key}", "Content-Type": "application/json"},
                method="POST",
            )
            with urlopen(request, timeout=90) as remote:
                raw = json.loads(remote.read().decode("utf-8"))
            raw_text = response_text(raw)
            data = json.loads(raw_text)
            translations = data.get("translations", [])
            expected_ids = {item["id"] for item in clean_segments}
            returned_ids = {str(item.get("id", "")) for item in translations}
            if returned_ids == expected_ids:
                return [{"id": str(item["id"]), "text": str(item["text"]).strip()} for item in translations]
        except Exception:
            return translate_free(clean_segments, target, source)

    # Automatic free translation fallback if no working API key is configured
    return translate_free(clean_segments, target, source)


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path == "/api/health":
            has_gemini = bool(os.getenv("GEMINI_API_KEY"))
            has_openai = bool(os.getenv("OPENAI_API_KEY") and os.getenv("OPENAI_MODEL"))
            provider = "gemini" if has_gemini else ("openai" if has_openai else "none")
            self.send_json(HTTPStatus.OK, {"ok": True, "translationConfigured": has_gemini or has_openai, "provider": provider})
            return
        if self.path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/translate":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 1_000_000:
                raise ValueError("Request is empty or too large.")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("Invalid request payload.")
            self.send_json(HTTPStatus.OK, {"translations": translate(payload)})
        except (ValueError, RuntimeError) as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except Exception:
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Unexpected server error."})

    def send_json(self, status: HTTPStatus, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    host = os.getenv("HOST", "127.0.0.1")
    httpd = ThreadingHTTPServer((host, port), AppHandler)
    print(f"SubSync AI running on http://{host}:{port}")
    httpd.serve_forever()
