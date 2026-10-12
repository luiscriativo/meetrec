"""Transcrição local com faster-whisper.

Emite eventos JSON (um por linha) no stdout para o MeetRec acompanhar o progresso:
  {"type": "status", "message": "..."}
  {"type": "progress", "value": 0.42}
  {"type": "done", "segments": N}
  {"type": "error", "message": "..."}
"""
import argparse
import json
import os
import sys
import time

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")


def emit(**kw):
    sys.stdout.write(json.dumps(kw, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--model", default="small")
    ap.add_argument("--language", default="pt")
    ap.add_argument("--duration", type=float, default=0)
    ap.add_argument("--prompt", default="")
    ap.add_argument("--threads", type=int, default=0)
    a = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
        from faster_whisper.utils import download_model
    except Exception as e:  # noqa: BLE001
        emit(type="error", code="missing", message=f"faster-whisper não está instalado: {e}")
        sys.exit(2)

    try:
        download_model(a.model, local_files_only=True)
    except Exception:  # noqa: BLE001
        emit(type="status", code="downloading", message=f"Baixando o modelo '{a.model}' (só na primeira vez)…")
        try:
            download_model(a.model)
        except Exception as e:  # noqa: BLE001
            emit(type="error", code="download", message=f"Falha ao baixar o modelo: {e}")
            sys.exit(3)

    emit(type="status", code="loading", message=f"Carregando modelo '{a.model}'…")
    threads = a.threads or max(1, (os.cpu_count() or 4) // 2)
    try:
        model = WhisperModel(a.model, device="auto", compute_type="int8", cpu_threads=threads)
    except Exception:  # noqa: BLE001
        model = WhisperModel(a.model, device="cpu", compute_type="int8", cpu_threads=threads)

    emit(type="status", code="transcribing", message="Transcrevendo…")
    t0 = time.time()
    segments, info = model.transcribe(
        a.input,
        language=a.language or None,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        beam_size=5,
        initial_prompt=a.prompt or None,
        condition_on_previous_text=False,
    )
    total = a.duration or getattr(info, "duration", 0) or 0
    out = []
    for s in segments:
        text = s.text.strip()
        if not text:
            continue
        out.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": text})
        if total:
            emit(type="progress", value=min(0.999, s.end / total), elapsed=round(time.time() - t0, 1))
        emit(type="segment", start=round(s.start, 2), end=round(s.end, 2), text=text)

    with open(a.output, "w", encoding="utf-8") as f:
        json.dump({"language": info.language, "segments": out}, f, ensure_ascii=False)
    emit(type="done", segments=len(out), elapsed=round(time.time() - t0, 1))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        emit(type="error", message=str(e))
        sys.exit(1)
