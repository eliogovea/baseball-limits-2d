# Native Vulkan (MoltenVK) POC — build, run, headless snapshot, validate.
# Deps (Homebrew): vulkan-headers vulkan-loader molten-vk glfw shaderc
#                   vulkan-validationlayers
#
# This is the SPRING twin of ../poc-vulkan: the point cloud now glides between
# states via a GPU critically-damped spring pass, and the Pareto frontier is
# recomputed every frame by a GPU O(n^2) skyline pass from those smoothed
# positions (instead of the CPU incremental frontier the baseline used). See
# ../docs/gpu-spring-skyline-design.md for the full design.

BREW := $(shell brew --prefix)
VKVL := $(shell brew --prefix vulkan-validationlayers)

CFLAGS  := -std=c11 -O2 -Wall -Wextra -I$(BREW)/include
LDFLAGS := -L$(BREW)/lib -lglfw -lvulkan -lz -Wl,-rpath,$(BREW)/lib

# MoltenVK is a portability driver: tell the loader where its ICD manifest is.
ICD := VK_ICD_FILENAMES=$(BREW)/etc/vulkan/icd.d/MoltenVK_icd.json \
       VK_DRIVER_FILES=$(BREW)/etc/vulkan/icd.d/MoltenVK_icd.json

# The validation layer's manifest names its dylib by bare filename, so the
# dynamic loader also needs DYLD_LIBRARY_PATH.
VAL := VK_LAYER_PATH=$(VKVL)/share/vulkan/explicit_layer.d \
       DYLD_LIBRARY_PATH=$(BREW)/lib BL2D_VALIDATE=1

# Two new compute shaders vs the baseline: spring.comp (motion) and skyline.comp
# (per-frame GPU Pareto frontier). accumulate/points/line are unchanged in spirit
# (points.vert now reads the smoothed pos[] buffer instead of the raw counters).
SHADERS := shaders/accumulate.comp.spv shaders/spring.comp.spv shaders/skyline.comp.spv \
           shaders/points.vert.spv shaders/points.frag.spv \
           shaders/line.vert.spv shaders/line.frag.spv

all: poc-vulkan-spring $(SHADERS)

poc-vulkan-spring: main.c
	clang $(CFLAGS) main.c -o $@ $(LDFLAGS)

shaders/%.spv: shaders/%
	glslc $< -o $@

run: all
	$(ICD) ./poc-vulkan-spring

snapshot: all
	$(ICD) BL2D_SNAPSHOT=1 ./poc-vulkan-spring
	@command -v sips >/dev/null && sips -s format png /tmp/poc-vulkan-spring.bmp --out /tmp/poc-vulkan-spring.png >/dev/null || true

validate: all
	$(ICD) $(VAL) ./poc-vulkan-spring

clean:
	rm -f poc-vulkan-spring $(SHADERS)

.PHONY: all run snapshot validate clean
