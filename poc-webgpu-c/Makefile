# poc-webgpu-c — the "full WASM" POC: the WHOLE app (incl. WebGPU orchestration)
# in C, compiled to WASM via emcc + the emdawnwebgpu port. This is Option 2 from
# docs/poc-webgpu-design.md — the all-C counterpart to poc-webgpu/ (which keeps
# WebGPU in JS). It reuses ../poc-webgpu/core.c VERBATIM (the same host core:
# STEV decode, incremental frontier, brute-force invariant) and drives WebGPU
# from C against <webgpu/webgpu.h>.
#
# Deps: emscripten 4.0.10+ (emdawnwebgpu is a remote port, downloaded on first
# build). The two .evt.gz streams are bundled into MEMFS via --preload-file and
# gunzipped in C with zlib (-sUSE_ZLIB), so core.c's STEV decoder runs unchanged.
#
#   make            # build app.html + app.js + app.wasm + app.data
#   make serve      # from repo root (run ../ python http.server)
#   make clean

EMCC   := emcc
CORE   := ../poc-webgpu/core.c
PORT   := --use-port=emdawnwebgpu
DATA   := --preload-file ../data/pbp/hr.evt.gz@/data/pbp/hr.evt.gz \
          --preload-file ../data/pbp/sb.evt.gz@/data/pbp/sb.evt.gz
FLAGS  := -O2 -sUSE_ZLIB=1 -sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=0 \
          -sENVIRONMENT=web -sEXPORTED_FUNCTIONS=_main,_capture \
          -sEXPORTED_RUNTIME_METHODS=ccall

all: app.html

app.html: app.c $(CORE) shaders.h
	$(EMCC) app.c $(CORE) $(PORT) $(FLAGS) $(DATA) -o app.html

serve: all
	cd .. && python3 -m http.server 8000

clean:
	rm -f app.html app.js app.wasm app.data

.PHONY: all serve clean
