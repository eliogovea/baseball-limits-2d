# poc-webgpu — build the WASM core (poc-vulkan's host logic, GPU-agnostic).
# Deps: emscripten (emsdk, or `brew install emscripten`). The WebGPU layer is
# JS (main.js); this only compiles core.c → core.js + core.wasm. The built
# artifacts are committed so the page serves from a plain static server.
#
#   make            # build core.js + core.wasm
#   make serve      # python3 -m http.server from the repo root (run from ..)
#   make clean

EMCC := emcc
CFLAGS := -O2 -Wall -Wextra
EMFLAGS := \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createCore \
  -sENVIRONMENT=web -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_FUNCTIONS=_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString,HEAPU8,HEAPU16,HEAPU32,HEAPF32

all: core.js

core.js: core.c
	$(EMCC) core.c $(CFLAGS) $(EMFLAGS) -o core.js

# Serve from the repo root so data/pbp/*.evt.gz resolves (this page lives at
# /poc-webgpu/). Open http://localhost:8000/poc-webgpu/.
serve: all
	cd .. && python3 -m http.server 8000

clean:
	rm -f core.js core.wasm

.PHONY: all serve clean
