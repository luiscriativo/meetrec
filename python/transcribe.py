"""Transcrição local com faster-whisper.

Emite eventos JSON (um por linha) no stdout para o MeetRec acompanhar o progresso:
  {"type": "status", "message": "..."}
  {"type": "progress", "value": 0.42}
  {"type": "download", "received": 123, "total": 456}
  {"type": "done", "segments": N}
  {"type": "error", "message": "..."}

Com --download-only, só baixa o modelo (com progresso) e termina.
"""
import argparse
import fnmatch
import json
import os
import sys
import threading
import time

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
# Download HTTP comum em vez do Xet: os mesmos arquivos (conferido), mas o tamanho cresce
# aos poucos no disco e dá para mostrar o progresso em %
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

ALLOW = ["config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.*"]


def emit(**kw):
    sys.stdout.write(json.dumps(kw, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def download_with_progress(model, download_model):
    """Baixa com a função oficial do faster-whisper e mede o progresso pelo tamanho no cache."""
    from faster_whisper.utils import _MODELS
    from huggingface_hub import HfApi, constants

    repo = model if "/" in model else _MODELS.get(model, model)
    total = 0
    try:
        info = HfApi().model_info(repo, files_metadata=True)
        total = sum(s.size or 0 for s in info.siblings if any(fnmatch.fnmatch(s.rfilename, p) for p in ALLOW))
    except Exception:  # noqa: BLE001 — sem o total, mostra só os MB baixados
        pass
    blobs = os.path.join(constants.HF_HUB_CACHE, "models--" + repo.replace("/", "--"), "blobs")
    finished = threading.Event()

    def watch():
        while not finished.wait(0.5):
            got = 0
            try:
                for f in os.listdir(blobs):
                    try:
                        got += os.path.getsize(os.path.join(blobs, f))
                    except OSError:
                        pass
            except OSError:
                pass
            emit(type="download", received=got, total=total)

    threading.Thread(target=watch, daemon=True).start()
    try:
        download_model(model)
    finally:
        finished.set()
    emit(type="download", received=total, total=total)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input")
    ap.add_argument("--output")
    ap.add_argument("--model", default="small")
    ap.add_argument("--language", default="pt")
    ap.add_argument("--duration", type=float, default=0)
    ap.add_argument("--prompt", default="")
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--download-only", action="store_true")
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
            download_with_progress(a.model, download_model)
        except Exception as e:  # noqa: BLE001
            emit(type="error", code="download", message=f"Falha ao baixar o modelo: {e}")
            sys.exit(3)

    if a.download_only:
        emit(type="done", segments=0, elapsed=0)
        return
    if not a.input or not a.output:
        emit(type="error", message="Faltam --input e --output.")
        sys.exit(1)

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
