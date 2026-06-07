# Native Vulkan (MoltenVK) POC — build, run, headless snapshot, validate.
# Deps (Homebrew): vulkan-headers vulkan-loader molten-vk glfw shaderc
#                   vulkan-validationlayers

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

SHADERS := shaders/accumulate.comp.spv shaders/points.vert.spv shaders/points.frag.spv

all: poc-vulkan $(SHADERS)

poc-vulkan: main.c
	clang $(CFLAGS) main.c -o $@ $(LDFLAGS)

shaders/%.spv: shaders/%
	glslc $< -o $@

run: all
	$(ICD) ./poc-vulkan

snapshot: all
	$(ICD) BL2D_SNAPSHOT=1 ./poc-vulkan
	@command -v sips >/dev/null && sips -s format png /tmp/poc-vulkan.bmp --out /tmp/poc-vulkan.png >/dev/null || true

validate: all
	$(ICD) $(VAL) ./poc-vulkan

clean:
	rm -f poc-vulkan $(SHADERS)

.PHONY: all run snapshot validate clean
